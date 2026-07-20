// Break remote MCP server — one Supabase Edge Function that is BOTH:
//   1. an MCP server over Streamable HTTP (JSON-RPC) — push + read Break data
//      (flashcards, deep dives, look-up-later).
//   2. a minimal OAuth 2.1 authorization server (discovery + DCR + authorize +
//      token, PKCE-enforced) so claude.ai (web) / Claude Desktop can connect.
//
// The host Claude is the client (billed to your subscription). Every data query
// runs AS the signed-in user via their Supabase session -> per-user RLS.
//
// Deployed with verify_jwt=false because it implements its own auth (OAuth
// bearer tokens + unauthenticated OAuth discovery endpoints).
//
// Cloned from Course+'s supabase/functions/mcp/index.ts. Shares the same suite
// Supabase project (xsmnfcmtbpeaccnyinkr); uses its OWN brk_mcp_* auth tables
// and its OWN function name (break-mcp) so it never collides with Course+.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// Public base URL of this function (used in OAuth metadata — hardcode so it
// can't be spoofed via Host header).
const BASE = Deno.env.get('MCP_BASE_URL') || `${SUPABASE_URL}/functions/v1/break-mcp`
// Only this email may ever mint a session. Single-tenant safety net.
const ALLOWED_EMAIL = (Deno.env.get('MCP_ALLOWED_EMAIL') || 'nates123@gmail.com').toLowerCase()
const READONLY = Deno.env.get('BREAK_MCP_READONLY') === '1'

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

// ── small utils ──
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))
async function sha256b64url(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return b64url(new Uint8Array(buf))
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'Access-Control-Expose-Headers': 'mcp-session-id, www-authenticate',
}
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } })
const isAllowedRedirect = (u: string) => {
  try {
    const h = new URL(u)
    if (h.protocol !== 'https:' && !(h.hostname === 'localhost' || h.hostname === '127.0.0.1')) return false
    return ['claude.ai', 'claude.com'].includes(h.hostname) ||
      h.hostname.endsWith('.claude.ai') || h.hostname.endsWith('.claude.com') ||
      h.hostname === 'localhost' || h.hostname === '127.0.0.1'
  } catch { return false }
}
const must = (e: any) => { if (e) throw new Error(e.message || String(e)) }

// ── data ops (take a user-scoped supabase client) ──
// user_id is filled by each table's `default auth.uid()`, so writes through the
// user-scoped client land under the signed-in user with no explicit user_id.
const ops: Record<string, (sb: any, a: any) => Promise<any>> = {
  // ── Look Up Later ──
  async push_look_up_later(sb, { question }) {
    if (!question || !String(question).trim()) throw new Error('question is required')
    const { data, error } = await sb.from('look_up_later')
      .insert({ question: String(question).trim() })
      .select('id,question,status,created_at').single()
    must(error); return data
  },
  async list_look_up_later(sb, { status = 'pending', limit = 50 }) {
    let q = sb.from('look_up_later').select('id,question,status,answer,tl_dr,created_at').order('created_at', { ascending: true }).limit(limit)
    if (status && status !== 'all') q = q.eq('status', status)
    const { data, error } = await q; must(error); return data || []
  },

  // ── Deep Dives ──
  async push_deep_dive(sb, { title, prompt = null, summary = null, keyPoints = [], source = 'Added via Claude (MCP)' }) {
    if (!title || !String(title).trim()) throw new Error('title is required')
    const key_points = Array.isArray(keyPoints)
      ? keyPoints.map((k: any) => (typeof k === 'string' ? { text: k } : k)).filter((k: any) => k && k.text)
      : []
    const { data, error } = await sb.from('deep_dives')
      .insert({
        title: String(title).trim(),
        prompt: prompt || `Explain ${String(title).trim()} from memory.`,
        summary: summary || null,
        key_points,
        source,
        status: 'active',
      })
      .select('id,title,summary,status,created_at').single()
    must(error); return data
  },
  async list_deep_dives(sb, { limit = 50 }) {
    const { data, error } = await sb.from('deep_dives')
      .select('id,title,summary,status,next_review,review_count,created_at')
      .order('created_at', { ascending: false }).limit(limit)
    must(error); return data || []
  },

  // ── Flashcards ──
  async push_flashcard(sb, { front, back, source = 'Added via Claude (MCP)' }) {
    if (!front || !String(front).trim()) throw new Error('front is required')
    if (!back || !String(back).trim()) throw new Error('back is required')
    const { data, error } = await sb.from('flashcards')
      .insert({ front: String(front).trim(), back: String(back).trim(), source })
      .select('id,front,back,next_review,created_at').single()
    must(error); return data
  },
  async push_flashcards(sb, { cards }) {
    if (!Array.isArray(cards) || !cards.length) throw new Error('cards must be a non-empty array of {front, back}')
    const rows = cards.map((c: any) => {
      if (!c?.front || !c?.back) throw new Error('each card needs front and back')
      return { front: String(c.front).trim(), back: String(c.back).trim(), source: c.source || 'Added via Claude (MCP)' }
    })
    const { data, error } = await sb.from('flashcards').insert(rows).select('id,front,back'); must(error)
    return { inserted: (data || []).length, cards: data || [] }
  },
  async list_flashcards(sb, { due = false, limit = 50 }) {
    let q = sb.from('flashcards').select('id,front,back,next_review,status,source').order('next_review', { ascending: true }).limit(limit)
    if (due) q = q.lte('next_review', new Date().toISOString().slice(0, 10))
    const { data, error } = await q; must(error); return data || []
  },
}

// ── tool definitions (name, description, JSON-Schema, write flag) ──
const S = (props: any, required: string[] = []) => ({ type: 'object', properties: props, required })
const str = { type: 'string' }, bool = { type: 'boolean' }, num = { type: 'integer' }
const TOOLS = [
  // reads
  { name: 'list_look_up_later', write: false, description: 'List your Look Up Later questions. status: pending (default) | answered | all.', inputSchema: S({ status: { type: 'string', enum: ['pending', 'answered', 'all'] }, limit: num }) },
  { name: 'list_deep_dives', write: false, description: 'List your Deep Dives (topics to understand deeply), newest first.', inputSchema: S({ limit: num }) },
  { name: 'list_flashcards', write: false, description: 'List your flashcards. due=true returns only cards due for review today.', inputSchema: S({ due: bool, limit: num }) },
  // writes
  { name: 'push_look_up_later', write: true, description: 'Add a question to your Look Up Later queue in Break. The app can research it later.', inputSchema: S({ question: str }, ['question']) },
  { name: 'push_deep_dive', write: true, description: 'Add a Deep Dive to Break: a topic to understand deeply. Give a title; optionally a prompt (the "explain this from memory" question, do not reveal the answer), a one-sentence summary, and keyPoints (array of strings or {text} objects).', inputSchema: S({ title: str, prompt: str, summary: str, keyPoints: { type: 'array', items: { type: ['string', 'object'] } }, source: str }, ['title']) },
  { name: 'push_flashcard', write: true, description: 'Add one SM-2 flashcard to Break. front = question/prompt, back = answer.', inputSchema: S({ front: str, back: str, source: str }, ['front', 'back']) },
  { name: 'push_flashcards', write: true, description: 'Add several flashcards at once. cards = array of {front, back}.', inputSchema: S({ cards: { type: 'array', items: { type: 'object', properties: { front: str, back: str, source: str }, required: ['front', 'back'] } } }, ['cards']) },
].filter((t) => !(READONLY && t.write))

// ── build a user-scoped supabase client from the stored session ──
async function userClient(email: string) {
  const { data: row, error } = await admin.from('brk_mcp_session').select('supa_refresh').eq('email', email).single()
  if (error || !row) throw new Error('No session for ' + email)
  const sb = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const { data, error: e2 } = await sb.auth.refreshSession({ refresh_token: row.supa_refresh })
  if (e2 || !data?.session) throw new Error('Session expired — reconnect the Break connector.')
  // persist the rotated refresh token
  await admin.from('brk_mcp_session').update({ supa_refresh: data.session.refresh_token, updated_at: new Date().toISOString() }).eq('email', email)
  await sb.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token })
  return sb
}

// ── OAuth: validate a bearer access token → email ──
async function emailForToken(token: string | null): Promise<string | null> {
  if (!token) return null
  const { data } = await admin.from('brk_mcp_tokens').select('email,expires_at,kind').eq('token', token).eq('kind', 'access').maybeSingle()
  if (!data) return null
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null
  return data.email
}

// ── MCP JSON-RPC handler ──
async function handleRpc(msg: any, email: string) {
  const { id, method, params } = msg
  const reply = (result: any) => ({ jsonrpc: '2.0', id, result })
  if (method === 'initialize') {
    return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'break', version: '0.1.0' } })
  }
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  if (method === 'tools/call') {
    const name = params?.name, args = params?.arguments || {}
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } }
    if (READONLY && tool.write) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Server is read-only' } }
    try {
      const sb = await userClient(email)
      const out = await ops[name](sb, args)
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
    } catch (e) {
      return reply({ content: [{ type: 'text', text: 'Error: ' + ((e as Error)?.message || String(e)) }], isError: true })
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } }
}

// Where the browser-rendered login UI lives. Supabase's functions domain
// downgrades text/html → text/plain (anti-phishing), so the page can't be
// served from here — it's hosted on GitHub Pages and we redirect to it.
const LOGIN_UI = Deno.env.get('MCP_LOGIN_URL') || 'https://nates123-cmd.github.io/5-minute-app/mcp-login.html'

// ── OAuth authorize → redirect to the hosted login page (PKCE params forwarded) ──
function loginPage(q: URLSearchParams) {
  const redirect_uri = q.get('redirect_uri') || ''
  const state = q.get('state') || ''
  const code_challenge = q.get('code_challenge') || ''
  const ok = isAllowedRedirect(redirect_uri) && q.get('code_challenge_method') === 'S256'
  if (!ok) return new Response('Invalid authorization request (need https claude.ai redirect + PKCE S256).', { status: 400 })
  const u = new URL(LOGIN_UI)
  u.searchParams.set('redirect_uri', redirect_uri)
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', code_challenge)
  return new Response(null, { status: 302, headers: { ...CORS, Location: u.toString() } })
}

// ── main router ──
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const url = new URL(req.url)
  const m = url.pathname.match(/\/break-mcp(\/.*)?$/)
  const sub = (m?.[1] || '/').replace(/\/+$/, '') || '/'

  // ── OAuth discovery ──
  if (sub === '/.well-known/oauth-protected-resource') {
    return json({ resource: BASE, authorization_servers: [BASE] })
  }
  // Serve both the OAuth (RFC 8414) and OIDC discovery docs — clients probe
  // either /.well-known/oauth-authorization-server or /.well-known/openid-configuration.
  if (sub === '/.well-known/oauth-authorization-server' || sub === '/.well-known/openid-configuration') {
    return json({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['break'],
    })
  }

  // ── Dynamic Client Registration (RFC 7591) — accept any client ──
  if (sub === '/register' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    return json({
      client_id: 'brk-' + randToken(8),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body.redirect_uris || [],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }, 201)
  }

  // ── authorize (login page) ──
  if (sub === '/authorize' && req.method === 'GET') return loginPage(url.searchParams)

  // send OTP
  if (sub === '/authorize/send' && req.method === 'POST') {
    const { email } = await req.json().catch(() => ({}))
    if (!email || email.toLowerCase() !== ALLOWED_EMAIL) return json({ error: 'This email is not authorized for Break.' }, 403)
    const authc = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    const { error } = await authc.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
    if (error) return json({ error: error.message }, 400)
    return json({ ok: true })
  }

  // verify OTP → mint auth code
  if (sub === '/authorize/verify' && req.method === 'POST') {
    const { email, token, redirect_uri, state, code_challenge } = await req.json().catch(() => ({}))
    if (!email || email.toLowerCase() !== ALLOWED_EMAIL) return json({ error: 'Email not authorized.' }, 403)
    if (!isAllowedRedirect(redirect_uri) || !code_challenge) return json({ error: 'Invalid request.' }, 400)
    const authc = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } })
    const { data, error } = await authc.auth.verifyOtp({ email, token: String(token).replace(/\D/g, ''), type: 'email' })
    if (error || !data?.session) return json({ error: error?.message || 'Invalid code.' }, 400)
    const lc = email.toLowerCase()
    await admin.from('brk_mcp_session').upsert({ email: lc, supa_refresh: data.session.refresh_token, updated_at: new Date().toISOString() })
    const code = randToken(24)
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    await admin.from('brk_mcp_codes').insert({ code, code_challenge, redirect_uri, email: lc, supa_refresh: data.session.refresh_token, expires_at: expires })
    const sep = redirect_uri.includes('?') ? '&' : '?'
    const redirect = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`
    return json({ redirect })
  }

  // ── token endpoint ──
  if (sub === '/token' && req.method === 'POST') {
    const ct = req.headers.get('content-type') || ''
    let p: Record<string, string> = {}
    if (ct.includes('application/json')) p = await req.json().catch(() => ({}))
    else { const f = new URLSearchParams(await req.text()); f.forEach((v, k) => (p[k] = v)) }

    if (p.grant_type === 'authorization_code') {
      const { data: row } = await admin.from('brk_mcp_codes').select('*').eq('code', p.code || '').maybeSingle()
      if (!row) return json({ error: 'invalid_grant' }, 400)
      await admin.from('brk_mcp_codes').delete().eq('code', p.code)
      if (new Date(row.expires_at) < new Date()) return json({ error: 'invalid_grant', error_description: 'code expired' }, 400)
      if (row.redirect_uri !== p.redirect_uri) return json({ error: 'invalid_grant', error_description: 'redirect mismatch' }, 400)
      const challenge = await sha256b64url(p.code_verifier || '')
      if (challenge !== row.code_challenge) return json({ error: 'invalid_grant', error_description: 'PKCE failed' }, 400)
      const access = randToken(), refresh = randToken()
      const accessExp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
      await admin.from('brk_mcp_tokens').insert([
        { token: access, kind: 'access', email: row.email, expires_at: accessExp },
        { token: refresh, kind: 'refresh', email: row.email, expires_at: null },
      ])
      return json({ access_token: access, token_type: 'Bearer', expires_in: 30 * 24 * 3600, refresh_token: refresh, scope: 'break' }, 200, { 'Cache-Control': 'no-store' })
    }

    if (p.grant_type === 'refresh_token') {
      const { data: row } = await admin.from('brk_mcp_tokens').select('*').eq('token', p.refresh_token || '').eq('kind', 'refresh').maybeSingle()
      if (!row) return json({ error: 'invalid_grant' }, 400)
      const access = randToken()
      const accessExp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
      await admin.from('brk_mcp_tokens').insert({ token: access, kind: 'access', email: row.email, expires_at: accessExp })
      return json({ access_token: access, token_type: 'Bearer', expires_in: 30 * 24 * 3600, scope: 'break' }, 200, { 'Cache-Control': 'no-store' })
    }
    return json({ error: 'unsupported_grant_type' }, 400)
  }

  // ── MCP endpoint (root) — requires bearer ──
  if (sub === '/') {
    const auth = req.headers.get('authorization') || ''
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null
    const email = await emailForToken(bearer)
    if (!email) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...CORS, 'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"` },
      })
    }
    if (req.method === 'GET') return new Response(null, { status: 405, headers: CORS })
    const payload = await req.json().catch(() => null)
    if (!payload) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    // batch or single
    if (Array.isArray(payload)) {
      const out = []
      for (const msg of payload) { if (msg?.id !== undefined && msg?.id !== null) out.push(await handleRpc(msg, email)) else await handleRpc(msg, email) }
      return json(out)
    }
    // notification (no id) → 202
    if (payload.id === undefined || payload.id === null) { await handleRpc(payload, email).catch(() => {}); return new Response(null, { status: 202, headers: CORS }) }
    return json(await handleRpc(payload, email))
  }

  return new Response('Not found', { status: 404, headers: CORS })
})
