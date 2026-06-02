// JustWatch streaming-availability proxy - Supabase Edge Function (Deno).
// Unofficial JustWatch GraphQL has no CORS, so the PWA cannot call it direct.
// This proxies a search, trims to a small clean US where_to_find list, and
// caches results 7 days (service role) to limit hits on the unofficial API.
//
// Hardening: deployed with --no-verify-jwt so browser CORS preflight works,
// but the handler requires the project anon key (apikey header or bearer) -
// keeps random scanners out. The anon key is public, so the real protection
// is the cache + the allowlist; revisit if abused.
//
// Usage: GET ?title=Heat&year=1995&debug=1   (anon key required)

const JW_ENDPOINT = "https://apis.justwatch.com/graphql";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PROJECT_REF = "xsmnfcmtbpeaccnyinkr";

// Gate on the Supabase JWT's claims, not an env string match: this project's
// injected SUPABASE_ANON_KEY may be the new sb_publishable_ format while the
// app sends the legacy eyJ JWT, so equality would always fail. We don't verify
// the signature (no secret) - this just keeps random scanners out; the cache +
// allowlist are the real throttle, and the anon key is public anyway.
function keyOK(req) {
  let tok = req.headers.get("apikey") || "";
  if (!tok) tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = tok.split(".");
  if (parts.length !== 3) return false;
  try {
    let b = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b += "=".repeat((4 - (b.length % 4)) % 4);
    const p = JSON.parse(atob(b));
    return p && p.ref === PROJECT_REF && (p.role === "anon" || p.role === "service_role");
  } catch (_) {
    return false;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SEARCH_QUERY = "query GetSearchTitles($country: Country!, $language: Language!, $first: Int!, $filter: TitleFilter!) { popularTitles(country: $country, first: $first, filter: $filter, sortBy: POPULAR) { edges { node { __typename ... on MovieOrShow { objectType content(country: $country, language: $language) { title originalReleaseYear shortDescription fullPath scoring { imdbScore imdbVotes tomatoMeter certifiedFresh tmdbScore jwRating } } offers(country: $country, platform: WEB) { monetizationType standardWebURL package { clearName } } } } } } }";

// Clean display labels for the providers worth surfacing.
const SUB_PROVIDERS = {
  "Netflix": "Netflix", "Max": "Max", "HBO Max": "Max", "Hulu": "Hulu",
  "Disney Plus": "Disney+", "Amazon Prime Video": "Prime Video",
  "Apple TV": "Apple TV+", "Apple TV Plus": "Apple TV+",
  "Paramount Plus": "Paramount+", "Peacock": "Peacock", "Peacock Premium": "Peacock",
  "Starz": "Starz", "Showtime": "Showtime", "AMC+": "AMC+", "AMC Plus": "AMC+",
  "Crunchyroll": "Crunchyroll", "BritBox": "BritBox", "Britbox": "BritBox",
  "Acorn TV": "Acorn TV", "MUBI": "MUBI", "Shudder": "Shudder",
  "The Criterion Channel": "Criterion",
};
const FREE_PROVIDERS = {
  "Tubi TV": "Tubi", "Pluto TV": "Pluto TV", "The Roku Channel": "Roku Channel",
  "Plex": "Plex", "Kanopy": "Kanopy", "Hoopla": "Hoopla",
  "Amazon Freevee": "Freevee", "Crackle": "Crackle",
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function shapeOffers(rawOffers, jwUrl) {
  const out = [];
  const used = new Set();
  let hasRentBuy = false;
  for (const o of rawOffers || []) {
    const name = o && o.package && o.package.clearName;
    const mt = o && o.monetizationType;
    const url = (o && o.standardWebURL) || jwUrl;
    if (!name || !mt) continue;
    if (mt === "RENT" || mt === "BUY") { hasRentBuy = true; continue; }
    let label = null;
    if (mt === "FLATRATE" && SUB_PROVIDERS[name]) label = SUB_PROVIDERS[name];
    else if ((mt === "ADS" || mt === "FREE") && FREE_PROVIDERS[name]) {
      label = "Free: " + FREE_PROVIDERS[name];
    }
    if (!label || used.has(label)) continue;
    used.add(label);
    out.push({ label, url });
  }
  // Subscriptions first, then free, capped.
  const subs = out.filter((x) => !x.label.startsWith("Free:")).slice(0, 4);
  const free = out.filter((x) => x.label.startsWith("Free:")).slice(0, 2);
  const shaped = subs.concat(free);
  if (hasRentBuy && jwUrl) shaped.push({ label: "Rent / Buy", url: jwUrl });
  if (shaped.length === 0 && jwUrl) shaped.push({ label: "Where to watch", url: jwUrl });
  return shaped;
}

async function cacheGet(key) {
  if (!SB_URL || !SRK) return null;
  try {
    const r = await fetch(
      SB_URL + "/rest/v1/justwatch_cache?cache_key=eq." + encodeURIComponent(key) + "&select=payload,fetched_at",
      { headers: { apikey: SRK, Authorization: "Bearer " + SRK } });
    const a = await r.json();
    if (Array.isArray(a) && a[0] && a[0].fetched_at) {
      if (Date.now() - new Date(a[0].fetched_at).getTime() < TTL_MS) return a[0].payload;
    }
  } catch (_) { /* miss */ }
  return null;
}

async function cachePut(key, payload) {
  if (!SB_URL || !SRK) return;
  try {
    await fetch(SB_URL + "/rest/v1/justwatch_cache", {
      method: "POST",
      headers: {
        apikey: SRK, Authorization: "Bearer " + SRK,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ cache_key: key, payload, fetched_at: new Date().toISOString() }),
    });
  } catch (_) { /* best effort */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!keyOK(req)) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);

  let title = url.searchParams.get("title") || "";
  let year = url.searchParams.get("year") || "";
  const debug = url.searchParams.get("debug") === "1";
  if (req.method === "POST") {
    try {
      const b = await req.json();
      if (b && b.title) title = b.title;
      if (b && b.year) year = b.year;
    } catch (_) { /* query params */ }
  }
  title = title.trim();
  if (!title) return json({ error: "missing ?title" }, 400);

  // v2: scoring fields added; bump key so old v1 entries (no scores) are abandoned.
  const cacheKey = "v2|" + title.toLowerCase() + "|" + (year || "");
  const cached = await cacheGet(cacheKey);
  if (cached && !debug) return json({ ...cached, cached: true });

  let jw;
  try {
    const r = await fetch(JW_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "origin": "https://www.justwatch.com",
        "referer": "https://www.justwatch.com/",
      },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { country: "US", language: "en", first: 4, filter: { searchQuery: title } },
      }),
    });
    jw = await r.json();
    if (!r.ok || jw.errors) {
      return json({ error: "justwatch_error", status: r.status, detail: jw.errors || jw }, 502);
    }
  } catch (e) {
    return json({ error: "fetch_failed", detail: String(e) }, 502);
  }

  const edges = (jw && jw.data && jw.data.popularTitles && jw.data.popularTitles.edges) || [];
  const results = edges
    .map((e) => e && e.node)
    .filter((n) => n && n.content)
    .map((n) => {
      const jwUrl = n.content.fullPath ? "https://www.justwatch.com" + n.content.fullPath : null;
      const s = n.content.scoring || {};
      const out = {
        title: n.content.title,
        year: n.content.originalReleaseYear || null,
        type: n.objectType || null,
        summary: n.content.shortDescription || null,
        jwUrl,
        where_to_find: shapeOffers(n.offers, jwUrl),
        scoring: {
          rt: typeof s.tomatoMeter === "number" ? s.tomatoMeter : null,
          rt_certified: !!s.certifiedFresh,
          imdb: typeof s.imdbScore === "number" ? s.imdbScore : null,
          imdb_votes: typeof s.imdbVotes === "number" ? s.imdbVotes : null,
        },
      };
      if (debug) out._rawOffers = n.offers;
      return out;
    });

  if (year) {
    const y = Number(year);
    results.sort((a, b) =>
      Math.abs((a.year || 0) - y) - Math.abs((b.year || 0) - y));
  }

  const payload = { query: title, year: year || null, count: results.length, results };
  if (!debug) cachePut(cacheKey, payload);
  return json(payload);
});
