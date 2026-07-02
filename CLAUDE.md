# 5-Minute Break — Project Context

## What it is
A PWA (Progressive Web App) that serves up short, enriching activities during breaks. Hosted on GitHub Pages. Single-file architecture: all HTML, CSS, and JS lives in `index.html`.

**Live URL:** https://nates123-cmd.github.io/5-minute-app/
**Local dev:** `python3 -m http.server 8080` → http://localhost:8080 (SW bypasses cache on localhost, just refresh after edits)

---

## File structure
```
index.html       — entire app (HTML + CSS + JS, ~2600+ lines)
sw.js            — service worker (cache name: 5min-break-vN, bump on deploy)
manifest.json    — PWA manifest
dev-config.js    — GITIGNORED — sets Anthropic API key in localStorage for local dev
.gitignore       — ignores dev-config.js
```

---

## Tech stack
- **No build step** — plain HTML/CSS/JS, edit and refresh
- **Claude API** — `claude-sonnet-4-5`, direct browser fetch with `anthropic-dangerous-direct-browser-access: true`
- **Supabase** — REST API (no SDK), anon key auth, used for flashcards + quiz performance + mantras
- **Service worker** — cache-first for static assets, network-first for Anthropic + Supabase, bypass entirely on localhost. Only handles GET requests. Auto-updates on every page load (`updateViaCache: 'none'`, `reg.update()`, `controllerchange` → reload).

---

## Supabase config
```js
SB_URL = 'https://xsmnfcmtbpeaccnyinkr.supabase.co'
SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' // anon key, safe to commit
```

### Tables
| Table | Key columns |
|---|---|
| `flashcards` | id, front, back, source, interval, ease_factor, next_review, status, created_at, context ('fun'), cluster_id (FK→clusters, nullable), last_missed_at |
| `deep_dives` | id, user_id, title, prompt, key_points (jsonb), summary, context, source, cluster_id (FK→clusters, nullable), created_at, last_reviewed_at |
| `clusters` | id, user_id, name, context, created_at — lazy groupings of flashcards; created when active recall assembles a concept "from my cards" (`ddGenerateFromCards`). Per-user RLS. |
| `quiz_performance` | id, topic, difficulty (1–5), hit_rate, asked_questions (jsonb), updated_at |
| `listening_subscriptions` | id, name, feed_url, created_at |
| `listening_queue` | id, title, show_name, summary, source, subscription_id, duration_secs, spotify_url, listened, pub_date, recommended_by, created_at |
| `recommendations` | id, title, creator, year, media_type, summary, where_to_find (jsonb), raw_input, source_query, status (saved\|consumed\|skipped), created_at, consumed_at |
| `justwatch_cache` | cache_key (PK), payload (jsonb), fetched_at — RLS on, **no policies**: only the edge function's service role touches it (anon cannot read) |
| ~~`mantras`~~ | removed from app in Citrine redesign (table left untouched in Supabase, no longer queried) |

Recs helpers: `recsCreate/recsFetch/recsUpdate/recsDelete` (mirror `srs*`), offline via `localStorage['offline_recs_queue']`. `sbCount(query)` = count-only fetch (mirrors `srsGetDueCount`).

Helper: `sbFetch(path, options)` — wraps fetch to Supabase REST with auth headers.

---

## Key JS patterns

### `makeLoader(slug, promptFn, renderFn, fallbackData)`
Factory for Claude-powered activity cards. Handles exclusion lists (seen items), like/dislike context, swipe-to-dismiss, card footer (thumbs/bookmark/share), and error toasts.

```js
const loadFunFact = makeLoader(
  'fun-fact',
  (ex) => 'Give me a fun fact...' + ex + ' Return JSON: {fact, context}',
  (d) => '<div class="ai-single">...</div>',
  { fact: '...', context: '...' }  // shown if Claude fails
);
```

### `callClaude(userPrompt)`
Shared Claude fetch — system prompt forces JSON-only output. Throws on error (message surfaced via toast in makeLoader).

### `callClaudeQuiz(prompt)`
Quiz-specific Claude fetch — same pattern, used for quiz question generation and distractor generation.

### `srsCreate(front, back, source)`
Saves flashcard to Supabase. Supports offline queuing via `localStorage['offline_card_queue']` — syncs on `window online` event.

### `sm2(card, rating)`
SM-2 spaced repetition: rating 0 = miss (interval→1), 1 = hard (interval×1.2, ease−0.15), 2 = easy (interval×ease, ease+0.1). A miss (review flow + AR write-back) also stamps `last_missed_at` for cluster ripeness.

### Learning path: clusters, ripeness, state line, capture
- **Clusters** = lazy flashcard groupings. `ddGenerateFromCards` finds one coherent concept, creates a `clusters` row, tags member cards' `cluster_id`. Tuning constants (v1 locked): `CLUSTER_MIN_CARDS=8` (availability floor), `RIPE_DUE_QUORUM=0.4`, `MISS_WINDOW_DAYS=7`.
- **`clSnapshot()`** — one cheap pass (2 queries: all fun cards + clusters). Returns `{dueCount, clusters:[{id,name,total,due,dueFrac,available,ripe}]}`. A cluster is *available* at 8+ cards, *ripe* when ≥40% due OR any member missed within 7d.
- **`renderStateLine()`** — one declarative home line, computed fresh on every `screenchange==='home'`. Priority: ripe cluster (tap → `arStartFromCluster`) > cards due (tap → review) > nothing. "Due" language only, never "overdue"; ignorable, zero persistence.
- **Cluster picker** — Deep Dives "From my cards" tab (`ddRenderClusterPicker`): available clusters, ripe-first, tap to run active recall; plus "Assemble a new concept" (`dd-assemble-btn`).
- **Capture at seams** — `quizMissCapture(q,a)` (inline "Keep this?" once per miss, deterministic card, no API) and `proposeReadCandidates(mountEl, text, source)` (2-3 candidates at end of Stoic passage + history rabbit hole, one-tap keep, silent on error/3.2s timeout). Both dedupe via `cardExists(front)` and mint through `srsCreate`.

### `navigateToActivity(slug, skipLoad)`
Central routing — shows the right screen, triggers load function if not skipLoad.

### `showScreen(id)`
Shows `#screen-{id}`, hides all others. Dispatches `screenchange` CustomEvent (used for FAB visibility).

---

## Activity list

### Claude-powered cards (use `makeLoader`)
`fun-fact`, `introspection`, `new-word`, `new-term`, `finance-term`, `geography-fact`, `logical-fallacy`, `on-this-day`, `thought-experiment`, `etymology`, `health-insight`, `brain-teaser`, `cognitive-bias`, `stoic-reminder`

### Static/scripted
`breathe`, `mindfulness`, `reading`, `mental-math`, `stoic`, `journal`

### Quiz activities (separate system)
`history`, `geography`, `trivia`, `cooking`
- History & Geography: jService.io → Claude fallback
- Trivia: Open Trivia DB → Claude fallback
- Cooking: Claude only
- Adaptive difficulty 1–5, streak±3 shifts difficulty, rolling hit rate over last 20

### Special screens
`srs-review` — Spaced repetition flashcard review (flip or multiple-choice mode)
`anki-input` — Add Flashcard (3 modes: both sides / I have front / I have back, Claude generates missing side)
`recs` — Recs screen: horizontal tab strip (Listen, Books, Articles, Movies, TV, Music, Other; active tab in `localStorage['recs_active_tab']`). Listen tab = the existing Listen feature, logic unchanged (`#screen-listen` now nested as the Listen pane, no longer a routed `.screen`). Other tabs render from `recommendations` filtered by media_type. Long-press / right-click a row → action sheet (Mark consumed / Skip / Delete). Podcasts captured as recs land in the Other tab.
`rec-add` — Recommendation capture (reached from Add menu `data-add="rec"` and Recs `+ Add`). **Fire-and-forget** (like Listen Later): "Look it up" saves the raw entry immediately (`captureRec`), returns home with a toast, then `recEnrich` runs a two-pass Claude lookup in the background (pass 1 knowledge-only; pass 2 adds `web_search_20250305` only when pass 1 returns `needs_search`) and patches the row on a confident match. Ambiguous/no-match/error leaves the raw row — fix via the Recs action-sheet **Edit** modal (`openRecEditModal`). Dedicated fetch (NOT `callClaude`), model `claude-sonnet-4-5`. Media-type chip is an **authoritative** filter (movie↔tv the only allowed fuzziness; titles read literally, not expanded to famous superstrings). Region assumed **US** for streaming/links. Action sheet: Mark consumed / Edit / Skip / Delete.

**JustWatch (movie/TV source of truth):** `supabase/functions/justwatch/` is a Deno Edge Function proxying JustWatch's unofficial GraphQL (no CORS otherwise), trimming to a small US `where_to_find` (FLATRATE-first, rent/buy collapsed to one JustWatch link), cached 7d in `justwatch_cache` via service role. In `recEnrich`, movie/tv recs → `jwLookup()` supplies title/year/type/`where_to_find` (Claude summary as fallback); non-film/TV stays the Claude path. Function deployed with `--no-verify-jwt` (browser-CORS) but gates on the anon key in-code. Client calls `SB_URL + '/functions/v1/justwatch'` with the anon key. Redeploy: `supabase functions deploy justwatch --project-ref xsmnfcmtbpeaccnyinkr --no-verify-jwt`.
~~`mantra` / `mantra-manage`~~ — removed in Citrine redesign

---

## Home screen layout (post-Citrine redesign)
- **Header**: "Break" wordmark + date; timer icon
- **Capture button** (full-width, `--ink`) → opens the **Add menu** modal: Add Card / Recommendation / Look Up Later / Listen Later
- **Pillars row**: 3 equal columns — Review (`--accent`), Queue (`--accent-2`), Recs (`--accent-4`). Recs number = `listening_queue` unlistened + `recommendations` saved, via `updateRecsBadge()` (`updateListenBadge()` now just delegates to it; no home element of its own). Tapping Recs → `recs` screen.
- **Filter pills** (Reflect / Informational / Activity / Random)
- **Activity grid**: 2-column card grid
- Quiz cards use `data-quiz` attribute (not `data-activity`) — guard: `if (!card.dataset.activity) return`

---

## DURATION_ACTIVITIES buckets
Activities are bucketed by duration (`1min`, `5min`, `10min`, `random`). `anki-input` and quiz activities are NOT in any bucket — only accessible by tapping their home card directly.

## INFORMATIONAL_SCREENS
Array of slugs that get "Google it", "Ask Claude", "Remember It" buttons injected automatically.

---

## CSS design tokens (Citrine — see `break-redesign-spec.md`)
```css
--bg:        #F4ECDD   /* wheat */
--surface:   #EAE0CC   /* tinted card */
--surface-2: #E2D6BC
--text:      #3A3025   /* warm brown */
--text-muted/--text-faint  /* rgba browns */
--accent:    #C97A60   /* terracotta — Review */
--accent-2:  #D9B374   /* ochre — Queue */
--accent-3:  #8FA188   /* sage — active filter */
--accent-4:  #9F7A7A   /* dusty plum — Recs */
--ink: #3A3025  --ink-on: #F4ECDD
--radius-sm/md/lg/pill
--font-serif: Fraunces  --font-sans: system
```
Back-compat aliases (`--muted`, `--card-bg`, `--radius`, `--font`) map to the new tokens. Serif (Fraunces) for headings/hero/numbers; sans for chrome. No gamification, no shadows. Mantras removed.

---

## Offline support
- Card creation queued to `localStorage['offline_card_queue']` when offline
- Syncs automatically on `window online` event
- Quiz + Mantra sessions show toast and return to home if offline

---

## Deploy workflow
1. Edit `index.html` (and `sw.js`/`manifest.json` if needed)
2. Bump `CACHE_NAME` version in `sw.js` whenever deploying
3. `git add . && git commit -m "..." && git push`
4. GitHub Pages deploys within ~1 minute

---

## Pending / known issues
- `dev-config.js` must be recreated manually if the project is cloned fresh (contains the Anthropic API key — gitignored)
- Mantra offline add not supported (v1 decision)
