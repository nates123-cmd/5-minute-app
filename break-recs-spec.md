# Break — Recs Feature Addendum

This document extends `docs/redesign-spec.md`. Read that first — design tokens, typography rules, and home-screen layout from that spec all apply here.

This addendum adds:
- A third home-screen pillar: **Recs**
- A new **Recommendation** flow inside Capture
- A new **Recs screen** with tabs grouped by media type
- Migration of the existing **Listen** feature to live inside the Recs screen as the first tab

The existing Listen feature is **kept intact** — its data model, Spotify integration, and queue logic do not change. Only the entry point and visual treatment change.

---

## 1. Home-screen pillar update

The home screen goes from two pillars (Review, Queue) to three (Review, Queue, Recs).

### Layout
- Three equal columns
- Gap: 8px (was 10px for two columns)
- Pillar min-height: 120px (was 130px)
- Number size: 36px (was 48px) — narrower columns need smaller numbers
- All other pillar properties unchanged

### Recs pillar
- Background: `#9F7A7A` (dusty plum) — add as `--accent-4` in `:root`
- Text color: `var(--ink-on)` (cream)
- Label: "RECS"
- Number: combined count of unconsumed Listen items + saved Recs items (see "Pillar count" below)
- Sub: serif italic, see "Pillar count" below
- Tap → navigate to the new Recs screen

### Pillar count
The Recs pillar shows the total of:
- `listening_queue` rows where `listened = false` (existing Listen logic)
- `recommendations` rows where `status = 'saved'` (new — see schema below)

Implement as a new function `updateRecsBadge()` that fetches both counts in parallel and updates the pillar's number and sub-text.

Sub-text logic:
- `0` → "nothing saved" (italic)
- `1` → "1 to enjoy" (italic)
- `n` → "n to enjoy" (italic)

Call `updateRecsBadge()` in the same places `updateListenBadge()` is currently called, plus after any recommendations CRUD action.

**Also fix the existing Listen badge lag bug while we're here:** add a call to `updateListenBadge()` (and now `updateRecsBadge()`) at the end of `loadListenScreen()` after queue materialization completes, so the home count reflects newly-fetched episodes without requiring a page reload.

### Token addition
```css
:root {
  /* ... existing tokens ... */
  --accent-4: #9F7A7A;        /* dusty plum — Recs pillar */
}
```

---

## 2. Capture screen update

The Capture button on home opens the Capture screen. Currently it goes straight into the flashcard-creation flow (`anki-input`). It now needs to first ask: what kind of thing are you capturing?

### Capture chooser
On entering Capture, show a chooser screen with two options stacked vertically:

```
┌──────────────────────────────────────┐
│  Flashcard                           │
│  Something to remember               │
└──────────────────────────────────────┘
┌──────────────────────────────────────┐
│  Recommendation                      │
│  Something to read / watch / listen  │
└──────────────────────────────────────┘
```

- Each option is a card: bg `var(--surface)`, radius `var(--radius-md)`, padding 20px
- Title: serif, 18px, weight 500
- Subtitle: sans, 13px, `var(--text-muted)`, margin-top 4px
- Tapping Flashcard → existing `anki-input` flow (no change)
- Tapping Recommendation → new Recommendation flow (see below)

Screen header pattern matches other sub-screens (back chevron left, "Capture" title centered, no right action).

### Recommendation flow

**Step 1: Input**

A single screen with:
- Screen title: "Add a recommendation" (serif, 22px)
- Subtitle line below: "What did someone tell you to check out?" (sans, 13px, `var(--text-muted)`, margin-bottom 20px)
- Large text input: full-width, bg `var(--surface)`, no border, radius `var(--radius-md)`, padding 16px, font sans 16px, placeholder "e.g. Atomic Habits, The Bear, a Patrick Radden Keefe article…"
- Below input: row of optional media-type chips. Each chip: pill shape, sans 12px, padding 7px 14px, border `1px solid var(--border)`, color `var(--text)` opacity 0.6. Active chip: bg `var(--accent-4)` (plum), color `var(--ink-on)`, opacity 1, no border.
  - Chips: Book, Article, Movie, TV, Music, Podcast, Other
  - Tapping a chip toggles it; max one active at a time
  - Helper text above chip row: "Optional — narrows it down" (sans, 11px, `var(--text-faint)`)
- Primary button at bottom: "Look it up" — bg `var(--ink)`, color `var(--ink-on)`, full-width, radius `var(--radius-md)`, padding 14px, font sans 15px weight 500
- Disabled state when input is empty: opacity 0.4

**Step 2: Lookup (loading state)**

Replace the input area with a loading state while Claude runs the lookup:
- Centered text, serif 16px italic: "Looking up [user input]…"
- Below: small sans 12px `var(--text-muted)` that updates as state changes:
  - "Checking what I know" (first pass — knowledge-only call)
  - "Searching the web" (second pass — only if knowledge call returned `needs_search: true`)
  - "Almost there"
- No spinner — the text update is the feedback

**Step 3a: Confident result**

Claude returned a confident single match. Show:
- Card with bg `var(--surface)`, padding 20px, radius `var(--radius-md)`
- Title: serif 20px, weight 500
- Creator/author: sans 13px, `var(--text-muted)`, margin-top 2px
- Media type pill: 11px sans uppercase, padding 4px 10px, bg `var(--accent-4)`, color `var(--ink-on)`, inline, margin-top 10px
- One-line summary: serif italic, 15px, line-height 1.5, color `var(--text)` opacity 0.85, margin-top 12px
- Where to find it:
  - For articles/online content: "Read on [domain]" with a link
  - For streaming TV/movies: chips showing platforms ("Netflix", "HBO Max") — sans 11px, padding 4px 10px, bg `var(--surface-2)`, radius pill
  - For books: "Find on Bookshop.org" link, optional
  - For podcasts: "Listen on Spotify" / "Apple Podcasts" link
- Two buttons at bottom, side by side:
  - "Save" (primary, bg `var(--ink)`)
  - "Not this one" (secondary, transparent + border) — sends user back to Step 1 with input preserved

**Step 3b: Ambiguous result**

Claude returned `confident: false` with 2-4 candidates. Show:
- Header text: "A few matches — which one?" (serif 18px, margin-bottom 16px)
- Each candidate as a tappable card (same styling as confident result, but compressed):
  - Title (serif 16px)
  - Creator + year (sans 12px, `var(--text-muted)`)
  - Brief identifier (e.g. "Drama miniseries, 2017" or "Self-help book, 2018") — sans 11px italic
- Tap a candidate → re-runs lookup with that specific selection, returns to Step 3a
- Bottom: "None of these" secondary button → back to Step 1

**Step 3c: No match**

Claude couldn't find anything. Show:
- Text: "Couldn't find it. Want to save what you typed anyway?" (serif 16px)
- Two buttons:
  - "Save as-is" — saves the raw input as a rec with no enrichment, media_type from chip (or "other")
  - "Try again" — back to Step 1

**Step 4: Saved confirmation**

Brief inline confirmation, not a separate screen:
- Toast at bottom: "Saved to Recs" with a small "View" link that navigates to the Recs screen
- Auto-dismiss after 3 seconds
- Back to home

### Claude API logic

Two-pass lookup with `anthropic-dangerous-direct-browser-access: true`:

**Pass 1 — knowledge only:**
```js
const result = await callClaude(systemPrompt, userInput, mediaTypeHint);
// system prompt instructs:
// - return JSON only
// - if confident in a single answer, return {confident: true, ...details, needs_search: false}
// - if you don't know or info is likely stale (streaming availability, recent releases), return {confident: false, needs_search: true}
// - if ambiguous, return {confident: false, candidates: [...], needs_search: false}
```

**Pass 2 — web search (only if pass 1 returned `needs_search: true`):**

Use the API's `web_search_20250305` tool. Pass `tools: [{type: "web_search_20250305", name: "web_search"}]` in the request. System prompt is the same except now instructs Claude to search for current info before answering.

**Response shape (both passes):**
```json
{
  "confident": true,
  "candidates": null,
  "title": "Atomic Habits",
  "creator": "James Clear",
  "year": 2018,
  "media_type": "book",
  "summary": "A practical framework for building tiny habits that compound into remarkable change.",
  "where_to_find": [
    { "label": "Bookshop.org", "url": "https://bookshop.org/..." },
    { "label": "Audible", "url": null }
  ]
}
```

Or ambiguous:
```json
{
  "confident": false,
  "candidates": [
    { "title": "Heat", "creator": "Michael Mann", "year": 1995, "media_type": "movie", "identifier": "Crime epic with De Niro and Pacino" },
    { "title": "Heat", "creator": "Tate Taylor", "year": 2024, "media_type": "movie", "identifier": "Action thriller, Jason Statham" }
  ],
  "needs_search": false
}
```

System prompt for both passes is included at the end of this doc as Appendix A.

---

## 3. New Supabase table: `recommendations`

```sql
CREATE TABLE recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  creator text,
  year integer,
  media_type text NOT NULL,   -- 'book' | 'article' | 'movie' | 'tv' | 'music' | 'podcast' | 'other'
  summary text,
  where_to_find jsonb,        -- array of {label, url}
  raw_input text,             -- what the user originally typed
  source_query text,          -- the cleaned query used for lookup (may differ from raw_input)
  status text DEFAULT 'saved', -- 'saved' | 'consumed' | 'skipped'
  created_at timestamptz DEFAULT now(),
  consumed_at timestamptz
);

CREATE INDEX recommendations_media_type_idx ON recommendations(media_type);
CREATE INDEX recommendations_status_idx ON recommendations(status);
```

Helper functions to add (mirror existing `srsCreate`/`srsFetch` patterns):
- `recsCreate(rec)` — insert a row
- `recsFetch(filters)` — fetch with optional `{ media_type, status }` filters
- `recsUpdate(id, patch)` — partial update (e.g. mark consumed)
- `recsDelete(id)` — hard delete

Offline support: queue inserts in `localStorage['offline_recs_queue']`, sync on `window online` event (mirror existing `offline_card_queue` pattern).

---

## 4. Recs screen

Tapping the Recs pillar on home opens this screen.

### Header
- Screen header pattern (back chevron, centered title "Recs", right action "+ Add" which goes straight to the Recommendation step of Capture)
- Border-bottom 0.5px `var(--border)`, padding-bottom 14px

### Tab strip
Horizontal scrolling pill row, just below header:
- Tabs in order: Listen, Books, Articles, Movies, TV, Music, Other
- Each pill: padding 7px 14px, radius pill, sans 12px weight 500
- Inactive: bg transparent, border `1px solid var(--border)`, color `var(--text)` opacity 0.55
- Active: bg `var(--accent-4)` (plum), color `var(--ink-on)`, no border
- Scroll horizontally if overflow; no scrollbar shown
- Gap between pills: 6px

State: store active tab in `localStorage['recs_active_tab']`, default to 'Listen' on first open.

### Listen tab content

**Listen is not migrated to the `recommendations` table.** It continues to use `listening_subscriptions` and `listening_queue` as it does today. The entire existing Listen screen content moves into this tab.

Specifically:
- The pull-to-refresh / load-on-open flow (`loadListenScreen()`) runs when this tab is activated
- The existing list rendering, audiobook card, sort preference (`listen_sort`), dismiss flow all work unchanged
- The existing "+ Add" / "Listen Later" modal stays as it is — but it's no longer reached from the Recs screen's "+ Add" header button (that one is recommendation-only). Instead, keep the inline add button at the top of the Listen tab content if there is one today; if there wasn't one, add a small "+ Subscribe" or "+ Add episode" affordance contextual to Listen.

Visual changes to apply to existing Listen rendering:
- Item rows: padding 14px 2px, border-bottom 0.5px `var(--border)`, last child no border
- Episode title: serif 16px weight 500, color `var(--text)`
- Show name + duration: sans 11px, `var(--text-muted)`
- Summary (when present): serif italic 13px, line-height 1.5, `var(--text)` opacity 0.8
- Source chip ("Spotify"): sans 11px, bg `var(--surface)`, padding 3px 8px, radius pill
- "Open episode" link: color `var(--accent)` (terracotta), underline with 2px offset
- "Mark listened" / dismiss controls: stay where they are; restyle with the new tokens

### Other tabs (Books / Articles / Movies / TV / Music / Other)

Each pulls from `recommendations` filtered by `media_type` and `status != 'skipped'`. Show all `status = 'saved'` items first, then `status = 'consumed'` items (visually deemphasized — opacity 0.5).

Item row layout (same for all media-type tabs):
- Title: serif 16px weight 500
- Creator + year inline: sans 11px, `var(--text-muted)`, margin-top 2px
- Summary: serif italic 13px, line-height 1.5, `var(--text)` opacity 0.8, margin-top 6px
- `where_to_find` chips + link: sans 11px, chip styling as on lookup result screen
- Long-press → show action sheet: Mark consumed / Skip / Delete / Edit

Empty state per tab:
- Centered, vertically padded
- Serif 16px italic: "Nothing here yet."
- Sans 13px `var(--text-muted)`: "Tap + Add to save your first [book / article / etc]."

### "+ Add" button (top right of Recs screen header)
- Goes directly to Capture → Recommendation step (skips the chooser)
- Pre-fills the media-type chip if a non-Listen tab is active (e.g. user is on Books tab, tap +Add → media-type chip "Book" already selected)

---

## 5. Routing and screen IDs

Add new screen IDs to the routing system:
- `recs` — the Recs list screen
- `capture-chooser` — the new chooser screen between Capture button and the existing flows
- `rec-add` — the Recommendation input/lookup flow

The Capture button on home now routes to `capture-chooser` instead of directly to `anki-input`.

`anki-input` remains as-is and is reachable via the Flashcard option in the chooser.

---

## 6. Cleanup

- Remove the Listen card/row from the home screen (it now lives inside Recs)
- Remove any `navigateToActivity('listen')` calls that route from home
- The Listen screen function (`loadListenScreen()`) is kept and called by the Recs screen when Listen tab activates
- Update `updateListenBadge()` to remain as a callable helper but stop targeting any home-screen element — it now feeds into `updateRecsBadge()` instead

---

## 7. Don't change

- Spotify OAuth, token caching, `spotifyToken()` refresh logic
- `listening_subscriptions` and `listening_queue` tables
- `listenQueueFetch`, `listenEnrich`, `spotifyFetchLatestEpisodes` and related Spotify helpers
- Audiobook card logic (`listen_current_book` localStorage)
- The dedupe/FK handling on unsubscribe
- Service worker (but bump `CACHE_NAME` after these changes)

---

## 8. Process suggestion

1. Read `docs/redesign-spec.md` and confirm baseline redesign is shipped before starting this
2. Schema first: create the `recommendations` table in Supabase, add helper functions
3. Add `--accent-4` token, add the Recs pillar to home (without functionality first — hardcode count 0), confirm it renders
4. Wire up `updateRecsBadge()` and fix the Listen badge lag while you're there
5. Build the Recommendation flow (chooser → input → lookup → result → save). Mock the Claude API call with a stubbed JSON response first to verify the UI, then wire the real two-pass call
6. Build the Recs screen shell with tabs (no content yet)
7. Migrate Listen content into the Listen tab — verify all existing Listen functionality still works
8. Wire up the other media-type tabs from `recommendations`
9. End-to-end test: capture a book, capture an ambiguous movie title, capture an article, mark one consumed, delete one
10. Bump `CACHE_NAME`

---

## Appendix A: System prompts

### Pass 1 — knowledge-only lookup

```
You are a recommendation lookup assistant. The user has been told to read, watch, or listen to something and they're typing its name (or a fragment of a name) to save it for later.

Your job:
1. Identify what they're referring to
2. Return structured JSON describing it
3. If you can't be confident, ask for a web search

Return JSON only, no preamble or explanation.

Confidence rules:
- "confident: true" only if there's clearly one canonical answer in the global cultural record. "Atomic Habits" → confident (one famous book). "Inception" → confident. "The Office" → NOT confident (US vs UK; ask for candidates).
- "needs_search: true" if the answer depends on current information you can't know reliably — streaming availability, recent releases (last 2 years), where a current article lives online, recent podcast episodes.
- Otherwise return ambiguous candidates (2-4 max).

Schemas:

Confident:
{
  "confident": true,
  "needs_search": false,
  "title": string,
  "creator": string | null,
  "year": number | null,
  "media_type": "book" | "article" | "movie" | "tv" | "music" | "podcast" | "other",
  "summary": string (one sentence, under 25 words),
  "where_to_find": [{"label": string, "url": string | null}] | []
}

Ambiguous:
{
  "confident": false,
  "needs_search": false,
  "candidates": [
    {"title": string, "creator": string, "year": number, "media_type": string, "identifier": string (5-10 word distinguishing description)}
  ]
}

Needs search:
{
  "confident": false,
  "needs_search": true,
  "reason": string (brief, for logging)
}

Media-type hint: if the user has selected a media-type chip, prefer that interpretation. Don't return candidates of a different type unless none of that type fit.
```

### Pass 2 — with web search

Same prompt as Pass 1, with this addition prepended:

```
You have access to a web search tool. Use it to find current information about the recommendation — especially streaming availability, recent releases, and where articles live online. Search once, synthesize the result, then return the structured JSON. Never return needs_search: true on this pass — you must give a confident result or candidates.
```

Set `tools: [{type: "web_search_20250305", name: "web_search"}]` on this request.

---

## Open questions to confirm before starting

1. **Listen "+ Add" button:** Does the current Listen screen have an "+ Add" or subscription-add affordance, or is it all driven by auto-fetching from subscriptions? If there's an existing add button, leave it where it is. If not, no need to invent one — the Listen tab is read-only-ish from the user's perspective.
2. **Skipped recs:** Should the "Skipped" status filter into a separate place (e.g. a hidden "Skipped" tab or only accessible via long-press history), or just disappear from view? Default: just disappear from view.
3. **Edit a saved rec:** Is editing a rec (changing title, summary, media type) needed for v1, or can it wait? Default: not for v1 — long-press → Delete + re-capture is fine.
