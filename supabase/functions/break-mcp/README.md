# Break remote MCP server

Lets **Claude** (claude.ai web / Claude Desktop) push into your Break app —
**flashcards**, **deep dives**, and **look-up-later** items — plus read them back.
Claude is the client, so reasoning is billed to your Claude subscription.

One Supabase Edge Function (`break-mcp`) that is BOTH an MCP server over
Streamable HTTP AND a minimal OAuth 2.1 authorization server (PKCE-enforced), so
claude.ai can connect with a normal "Add connector" flow. Modeled on Course+'s
`supabase/functions/mcp/index.ts`.

Everything runs **as you**: the OTP login stores your Supabase refresh token, and
every write goes through the user-scoped client, so each table's
`user_id default auth.uid()` files rows under you (per-user RLS).

## Shares the suite Supabase project

Same project as the web app (`xsmnfcmtbpeaccnyinkr`). Its OWN auth tables
(`brk_mcp_session`, `brk_mcp_codes`, `brk_mcp_tokens` — service-role only, RLS on,
no policies) and its OWN function name (`break-mcp`) keep it isolated from
Course+'s `mcp` function in the same project.

## Connect (one time, in claude.ai)

1. Settings → Connectors → **Add custom connector**.
2. URL: `https://xsmnfcmtbpeaccnyinkr.supabase.co/functions/v1/break-mcp`
3. Claude opens the Break login page (`/mcp-login.html`, hosted on GitHub Pages).
   Enter your email → 8-digit code → connected.

> The login page must be deployed first — it lives at repo root and ships with
> the normal GitHub Pages deploy (merge to `main` / `/ship`).

## Tools

**Push (write):** `push_look_up_later`, `push_deep_dive`, `push_flashcard`,
`push_flashcards` (batch).

**Read:** `list_look_up_later`, `list_deep_dives`, `list_flashcards`.

Set env `BREAK_MCP_READONLY=1` on the function to hide every write tool.

## Try it

- "Add a flashcard to Break: front 'What is the capital of Mongolia?', back 'Ulaanbaatar'."
- "Push a deep dive to Break on the Bretton Woods system."
- "Add to my Break look-up-later: why is the sky blue at noon but red at sunset?"

Changes show up live in the Break web app.

## Deploy / redeploy the function

```bash
supabase functions deploy break-mcp --no-verify-jwt --project-ref xsmnfcmtbpeaccnyinkr
```

`verify_jwt` MUST stay false — the function implements its own OAuth bearer auth
and serves unauthenticated OAuth discovery endpoints.
