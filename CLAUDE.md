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
| `flashcards` | id, front, back, source, interval, ease_factor, next_review, status, created_at |
| `quiz_performance` | id, topic, difficulty (1–5), hit_rate, asked_questions (jsonb), updated_at |
| `mantras` | id, text, created_at |

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
SM-2 spaced repetition: rating 0 = miss (interval→1), 1 = hard (interval×1.2, ease−0.15), 2 = easy (interval×ease, ease+0.1).

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
`mantra` — Mantra session (fetch from Supabase, shuffle, cycle)
`mantra-manage` — CRUD for mantras

---

## Home screen layout
- **SRS row** (full width): left 2/3 = Review Due card, right 1/3 = + Add Flashcard button
- **Mantras row** (full width): directly below SRS row
- **Activity grid**: 2-column card grid, all other activities
- Quiz cards use `data-quiz` attribute (not `data-activity`) — guard: `if (!card.dataset.activity) return`

---

## DURATION_ACTIVITIES buckets
Activities are bucketed by duration (`1min`, `5min`, `10min`, `random`). `anki-input` and quiz activities are NOT in any bucket — only accessible by tapping their home card directly.

## INFORMATIONAL_SCREENS
Array of slugs that get "Google it", "Ask Claude", "Remember It" buttons injected automatically.

---

## CSS design tokens
```css
--bg:      #F5F2EE   /* warm off-white */
--text:    #1C1C1C
--muted:   #6B6560
--accent:  #A89880   /* warm stone */
--card-bg: #EDEBE7
--border:  #D8D4CE
--radius:  14px
```
No gamification. Clean, minimal, readable.

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
