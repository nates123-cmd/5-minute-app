# Break: design

Read this before any visual change. It supersedes the "Citrine softened" look in
`break-redesign-spec.md` (cream, terracotta, Fraunces). That file is history now.

## References, and who owns what

Nate's moodboard slide (App-moodboard-v2, last slide, 2026-09-30): "wikitok;
vocabulary scroll; colors: black, white".

| Reference | Owns | What was taken |
|---|---|---|
| **WikiTok** (wikitok.io) | Structure, ground, content cards | The app opens straight into the feed, no menu in the way. Black ground. Wordmark top-left, text-only navigation top-right. Content cards: bold sans headline, left-aligned body, sitting low on the card, "Read more →" links. Photos go edge to edge. |
| **Vocabulary** (Monkey Taps, iOS) | The flashcard | One prompt, dead centre, heavy book serif. Under it, small sans definition. The `0/5` progress pill at the top. Quiet row of actions under the word. |
| **Nate** | Palette | Black and white. No hue anywhere. |

Vocabulary's own palette (cream, coral, teal) was **not** used: Nate's palette
note wins the ground, and WikiTok agrees with it.

**The motif that does real work:** Vocabulary's `0/5` pill is the Flow rail's
counter. It sits only on the step you are in and counts flashcards you have
actually graded against the number owed when the sitting opened (`flowDone`
over `flowCounts`). It is data, never decoration.

## Register

Quiet and fast, like a feed you flick through at a bus stop, not a study app.
**If a change makes it feel more like homework (badges, streak flames, coloured
progress bars, encouragement copy), it is wrong.**

## Behaviour that belongs to the design

- `boot()` opens a **Flow**, not home. Flow's first phase is **Cards** (due
  flashcards), then Queue, Dive, Ground, Discover.
- Home is one tap away on the **Break** wordmark. Opening the app at `#home`
  lands on home instead (the test harness boots that way).

## Colour tokens

| Token | Value | Role |
|---|---|---|
| `--bg` | `#000000` | Ground everywhere |
| `--surface` | `#141414` | Tiles, inputs, grid cards |
| `--surface-2` | `#232323` | Second surface, skeletons |
| `--text` | `#FFFFFF` | Headlines, the word being learned |
| `--text-muted` | white 64% | Body copy, definitions |
| `--text-faint` | white 40% | Chrome: labels, hints, inactive nav |
| `--accent`, `--accent-3`, `--ink` | `#FFFFFF` | The one white fill (primary action) |
| `--accent-2` | `#BDBDBD` | Legacy accent slot, grey |
| `--accent-4` | `#8C8C8C` | Legacy accent slot, grey |
| `--ink-on` | `#000000` | Text on a white fill |
| `--yes-bg` / `--yes-fg` | white / black | Right answer, Easy |
| `--no-bg` / `--no-fg` | `#262626` / white 55% | Wrong answer, offline banner |
| `--border` / `--border-strong` | white 14% / 34% | Hairlines / outlines |

The accent names survive only so the old rules keep compiling. Never add a hue
back through them.

## Type: two faces, two jobs

- **Source Serif 4** (600/700): *something you are learning or wrote yourself.*
  Flashcard prompts and answers' headwords, Ground (mantras, book one-pagers),
  Flow phase markers' `.due-done`.
- **Instrument Sans** (400–700): *everything else.* Content card headlines
  (700, WikiTok), body, the wordmark, counts, navigation, buttons.

If you are about to set chrome in the serif, or a flashcard in the sans, stop.

Scale: flashcard headword 38–52px (`.due-word`, prompts of 28 chars or fewer),
longer prompts 24–30px, content headlines 24–32px, body 16–17px, chrome
10.5–13px.

## Devices to reach for first

- Text-only nav: words that go white when active, grey when not, struck through
  when done. No pills, except the one counter pill.
- The single white fill: one primary per screen (Easy, Capture, the Flashcards
  pillar). Everything else is an outline or plain text.
- Hairline rows (`border-bottom: 1px solid var(--border)`) for lists of actions,
  not stacks of tiles.
- Edge-to-edge, square-cornered photos on content cards.
- Content cards bottom-anchored; flashcards and Flow markers centred.

## Banned

- Any hue: no terracotta, sage, red/green right-wrong, purple gradients.
- Bare system font stack; Inter / Roboto / Poppins as display.
- Fraunces (the old look's face).
- Bordered rounded cards as the default grouping; uniform radius on everything.
- A kind label on a flashcard (the counter already says what it is).
- Icons beside every label. Unicode ★/☆.
- Drop shadows (one exists, on the overflow menu, to lift it off black).

## Honesty rules that outrank the design

- The counter shows graded cards over cards owed **at open**. Never fake
  progress, never count a scroll-past as done.
- Flow phase markers say "Nothing else due." only in the sense the engine means
  it (the source ran dry or you skipped ahead). Do not reword them into stronger
  claims ("No cards left today") that a skip would make false.
- Wrong answers are dimmed and struck through, never hidden: the miss is data.

## Looking at it

Never ship a visual change you have not seen. The app needs a session and live
Supabase to reach the feed, so render a stubbed copy:

1. Generate a scratch `preview.html` at the repo root: `index.html` with a
   `<script>` injected right after `<head>` that (a) writes a fake session to
   `localStorage['sb-xsmnfcmtbpeaccnyinkr-auth-token']` (`expires_at: 4102444800`),
   (b) stubs `navigator.serviceWorker.register`, and (c) replaces `window.fetch`
   for `supabase.co` URLs: `/auth/v1/` returns a session object (else the app
   clears the fake token), `/rest/v1/flashcards` returns due rows, everything
   else `[]`. Non-Supabase URLs pass through so pictures load. See
   `tests/flow.spec.js` `stubFlow()` for row shapes.
   **Injecting with `document.write` from a loader page does not work** (the
   stub never runs); bake the stub into a static copy.
2. A scratch `phone.html` with a 390x844 `<iframe src="preview.html">`, scaled
   with CSS `transform` if the Chrome viewport is short.
3. `python3 -m http.server 5199 --bind 127.0.0.1`, open `phone.html`, drive the
   iframe with `contentWindow` calls (`feedToggleFlip(item)`, `flowSkipTo(4)`,
   set `#feed-track` `scrollTop` then dispatch `scroll`).
4. Delete both scratch files before committing.
