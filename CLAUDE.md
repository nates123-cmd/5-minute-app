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
| `deep_dives` | id, user_id, title, prompt, key_points (jsonb), summary, context, source, cluster_id (FK→clusters, nullable), created_at, last_reviewed_at, **status** ('active'\|'archived'), **archived_at**, **resurface_at** (date), **next_review** (date), **interval**, **ease_factor**, **last_bucket** ('miss'\|'hard'\|'easy'), **review_count**, **last_score** (0–1 key-point hit fraction) |
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

### Deep Dives: archive, resurfacing, drill cadence
A dive is no longer a flat on-demand shelf — it carries a **miss / hard / easy status** that sets how often it comes back.

- **The grade is AI-driven.** `arGrade` already returned an overall `bucket` plus per-key-point `verdicts`; both now land on the row. `ddEffectiveBucket(aiBucket, hitFrac)` takes **whichever is harsher** — Claude's verdict, or the band its own hit-fraction falls in (<0.5 miss, <0.85 hard, else easy) — so a confident answer that skipped half the key points still grades as a miss. Mental mode has no AI read, so the self-rating is the grade.
- **`ddSchedule(dive, bucket)`** — SM-2-lite, stretched for concepts: miss → 1d (ease −0.20); hard → 3d, then ×1.2 (ease −0.15); easy → 7d, then ×ease (ease +0.10, cap 2.6). Writes `interval`, `ease_factor`, `next_review`, `last_bucket`. A dive with no `next_review` has never been drilled and counts as **due**.
- **Swipe a `.dd-item` left → archive** (`ddWireRow` / `ddArchive`), reversible via the **undo bar** (`showUndo`, 6s). Long-press still deletes. Archive ≠ delete.
- **Resurfacing** is the "bring it back into my vision" mechanism: archiving sets `resurface_at = today + DD_LEASH[last_bucket]` (miss 14d, hard 30d, easy 90d, never-drilled 45d). When the leash runs out the dive reappears **on its own** at the top of the shelf under "Back from the archive" and counts in the home pillar badge — no restore needed.
- **Re-drilling a resurfaced dive** (`ddApplyGrade`): graded miss/hard → auto-restored to active (you clearly need it); graded easy → stays archived with the leash **doubled** (cap 365d). Spaced retirement.
- Deep Dives screen has a `Shelf | Archived` segment (`ddView`); Shelf sections = Back from the archive → Due → Scheduled. Home badge = due + resurfaced ("to drill"), falling back to shelf size.

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
- **Scroll button** (outlined, below Capture) → `openFeed()`, the vertical card feed (see below)
- **Pillars row**: 3 equal columns — Review (`--accent`), Queue (`--accent-2`), Recs (`--accent-4`). Recs number = `listening_queue` unlistened + `recommendations` saved, via `updateRecsBadge()` (`updateListenBadge()` now just delegates to it; no home element of its own). Tapping Recs → `recs` screen.
- **Filter pills** (Reflect / Informational / Activity / Random)
- **Activity grid**: 2-column card grid
- Quiz cards use `data-quiz` attribute (not `data-activity`) — guard: `if (!card.dataset.activity) return`

---

## Scroll feed (`#screen-feed`)

A vertical, snap-scrolling feed of activity cards — the grid is for when you know
what you want, the feed is for when you don't. Entered from the home **Scroll**
button (`openFeed()`), left via the back arrow. No end, no counter.

### The two refactors it needed
- **`CARD_SPECS`** — `makeLoader(slug, prompt, render, fallbackData)` now files
  `{slug, prompt, render, fallbackData}` into `CARD_SPECS[slug]` as a side effect.
  The feed needs those three pieces without makeLoader's DOM coupling (it renders
  into feed items, not `#<slug>-content`). 25 activities register this way;
  `stoic` predates makeLoader and registers its spec by hand in the feed section.
- **`cardKey(data)`** — the "what is this card about" lookup, extracted out of
  makeLoader so both paths share it. `feedKey(slug, data)` wraps it to give
  stoic passages a stable identity (`cardKey` has no `passage` case).

### How it stays ahead of a thumb
| Mechanism | Where |
|---|---|
| **Batch fetch** — one Claude call returns `FEED_BATCH` (3) cards, not one | `feedGenerate()` appends "Return a JSON ARRAY of N…" to the spec's own prompt |
| **Read-ahead** — keep `FEED_AHEAD` (3) cards mounted past the active one | `feedFill()` |
| **Warm start** — the unmounted buffer persists and refills on the home screen | `feedPersist()` / `feedRestore()` / `feedPrewarm()` (4s after landing on home) |
| **DOM windowing** — only `FEED_WINDOW` (10) items stay mounted | `feedTrim()` |
| **Implicit ranking** — dwell time reweights which activity comes next | `feedScoreExit()`; `<2s` → ×0.88, `>9s` → ×1.18; thumbs → ×1.5 / ×0.6 |
| **Forced variety** — no activity repeat within `FEED_LOOKBACK` (4) cards | `feedPickSlug()` at generation, `feedTake()` at mount |

Weights live in `localStorage['feed_weights']`, clamped to 0.25–4 so no activity
can die out or take over. Buffer in `localStorage['feed_buffer']`, filter in
`localStorage['feed_bucket']`.

### Landmines
- **Active card comes from `scrollTop`, not an IntersectionObserver**
  (`feedOnScroll()`). Every item is exactly one track-height tall (`--feed-h`,
  set in JS), so it's one division — and an observer needs the tab to be
  rendering, which silently breaks headless/background verification.
- **`scroll-snap-type: y mandatory` re-anchors to its snapped element.** Two
  consequences: (1) on a cold open the sentinel is the snap target, so inserting
  cards above it scrolls *to the sentinel* — `feedFill()` forces `scrollTop = 0`
  on the first fill; (2) `feedTrim()` must re-pin to `active.offsetTop`, never
  subtract the removed height by hand (that lands a full card off).
- **`openFeed()` is synchronous, not `requestAnimationFrame`** — rAF never fires
  in a backgrounded tab and the feed would open empty.
- **The rail keeps `class="card-actions"`** so the existing global `[data-thumb]`
  handler still finds it (it calls `thumb.closest('.card-actions')` and would
  throw on null). `.feed-rail` resets that class's row styling.
- **Batches arrive three-of-a-kind.** `feedTake()` returns `null` rather than
  mounting a third in a row while another batch is in flight; `feedFill()` breaks
  on null and refills when that batch lands. Observed max run is 2.
- There is **no `reflection` bucket** in DURATION_ACTIVITIES (removed with the
  mantra/stoic screens). Feed filters are All / Learn / Do / Quick →
  `random` / `informational` / `activity` / `1min`. "All" deliberately means
  *every* `CARD_SPECS` key, not `DURATION_ACTIVITIES.random`, because a few
  activities (stoic, psychology) have specs but sit in no bucket.

### Card sources — not every card costs a model call

`CARD_SOURCES[slug]` is a function returning finished card objects shaped for
that slug's `spec.render()`, or `null` to fall through to Claude. Three tiers:

| Tier | What | Slugs |
|---|---|---|
| 1. Bundled data | Canonical finite sets, in-repo. Instant, free, works offline and signed out. | `cognitive-bias`, `logical-fallacy`, `thought-experiment`, `etymology`, `new-word`, `stoic` |
| 2. Free keyless API | Real data that changes. CORS-open, no key. | `on-this-day` (Wikimedia On This Day), `fun-fact` (Wikipedia "Did you know") |
| 3. Claude | Genuinely generative, no source of truth. | everything else |

`wikiFeatured()` fetches `api.wikimedia.org/feed/v1/wikipedia/en/featured/Y/M/D`
once per day. It returns **six** sections — `tfa`, `dyk`, `image`, `news`,
`mostread`, `onthisday` — so more card types can come off the same cached call.
Only `dyk` is wired up: `tfa` would suit `history` and `image` (which has a real
photo + description) would suit `beautiful-place`, but **both are bespoke
loaders that never registered a `CARD_SPEC`, so the feed cannot serve them.**
Registering those two as specs is the cheapest next win.

**Why bundled beats a model for tier 1:** named biases, fallacies, thought
experiments and etymologies are *lists*. Asking a model for one makes it
recite from memory and occasionally invent an entry. A real list is more
accurate and ~1000x faster.

- `pickUnseen(slug, pool, n, keyOf)` draws from a bundled set, preferring
  entries the exclusion list hasn't recorded, reshuffling the whole pool once
  exhausted rather than returning nothing.
- **Sources are pulled ONE card at a time, not `FEED_BATCH`.** Batching exists
  to amortise a model round trip; bundled data has none, and pulling three at
  once makes the mount-time interleave land three of a kind.
- `FEED_INSTANT_TARGET` (0.4) is the share of cards the feed tries to serve
  from instant sources. It's a taste dial: higher = cheaper/faster but only 7
  activities have sources, so the feed narrows.
- `on-this-day` caches the day's Wikimedia payload in `onThisDayCache`.
  Without it every batch refetched the same list.

**Landmines around the source layer:**
- **Don't key `preferInstant` on `feedBuffer.length === 0`.** Sources yield one
  card at a time, so the buffer sits at zero most of the time and that
  condition latches on permanently — the model then never runs and the feed
  serves only the 7 sourced activities forever. It's keyed on
  `feedMounted.length === 0` (true cold start) plus the share target.
- **Wikipedia DYK is curated for interest, not tone.** A live pull served
  "Police investigating rapist ..." as a Fun Fact. `GRIM_TERMS` filters it —
  coarse, will miss things. Deliberately *not* applied to `on-this-day`, where
  historical weight is the point.
- **Daily API pools are small** (~9 DYK items/day). `unseenOnly()` returns
  `null` once they're spent so `feedGenerate` falls through to Claude instead
  of recycling the same nine facts. Bundled sets use `pickUnseen`, which
  reshuffles instead — they're big enough that it rarely bites.
- DYK entries carry no `pages`/summary of their own (unlike onthisday events);
  the article link is only in the `html` field. `wikiSummary()` pulls the
  linked article's extract for the card's context line, cached per title.
- Sources are consulted by **the feed only**. The single-activity screens
  still go through `makeLoader` → Claude, unchanged. Promoting sources into
  `makeLoader` so those screens get them too is a clean follow-up.
- Because tier-1 cards need neither network nor session, `feedEligible()`
  narrows to sourced slugs when `hasSession()` is false — **the feed works
  signed out and offline**, on bundled content only.

### Models

`CLAUDE_MODEL` (`claude-sonnet-4-6`) is the default for quality-sensitive,
once-per-user-action calls. `FEED_MODEL` (`claude-haiku-4-5`) is used only by
`feedGenerateViaClaude` — the feed is where token spend actually lives, and
Haiku is ~3x cheaper and faster. `callClaude(prompt, {model})` takes the
override; everything that omits it gets `CLAUDE_MODEL`.

> **Unverified:** the deployed `claude` edge function is not in this repo. It's
> assumed to forward the request body's `model` field through. If it pins or
> allowlists the model server-side, the Haiku swap silently does nothing (or
> 400s) and you'll see it in the proxy response, not in this code.

### Rail actions (right side, per card)
▲/▼ (global handler + weight nudge) · ☆ Remember It (`generateRememberCard` →
`openRememberPreview`) · ↷ Look up later (`lulCreate` + `updateLulBadge`) ·
↑ Share. The activity name at the top of each card opens that full activity screen.
Glyphs are geometric, not emoji — the pre-existing `.card-actions` footer uses
emoji, the feed rail deliberately does not.

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
