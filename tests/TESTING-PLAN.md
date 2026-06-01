# 5-Minute Break — QA Test Plan

Additive Playwright harness for the single-file vanilla-JS PWA (`index.html`, no
build step). Every assertion calls the **real shipped function** through
`page.evaluate` against the page's `window` globals — zero re-implementation of
logic under test. The app is served from the repo root by Playwright's
`webServer` (`python3 -m http.server 8211 --directory ..`).

## How boot routing works (and why tests seed state)

`boot()` runs at the end of the page `<script>`:

```
if (!hasSession()) -> showScreen('otp')        // no auth session
else if (!getApiKey()) -> showScreen('apikey') // session but no Claude key
else -> showScreen('home')
```

So a "land on home" test must seed **both** a fake non-expired auth session
(`sb-…-auth-token`) **and** an `anthropic_api_key`, plus stub `fetch` (boot kicks
off badge-count fetches). `helper.js` does this via `addInitScript`.

## Risk ranking

| # | Area | Function(s) / file:line | Why risky | Covered |
|---|------|------------------------|-----------|---------|
| 1 | Activity-grid registry integrity | `ACTIVITY_REGISTRY`, `regKey`, `DURATION_ACTIVITIES` — index.html:2102, 2148, 2186 | Data-driven grid. Quiz slugs collide with activity slugs (`history`/`cooking`); `regKey` namespaces quiz entries `quiz-<slug>`. A typo'd/duplicate slug, or a `DURATION_ACTIVITIES` bucket referencing a slug not in the registry, silently breaks navigation or renders dead cards. | ✅ logic.spec |
| 2 | Settings hide/show toggle filtering | `getHiddenActivities`, `setHiddenActivities`, `renderActivityGrid` — index.html:2151, 2159 | Toggle persists to `localStorage['hidden_activities']` as `regKey` strings. If filtering used `slug` instead of `regKey`, hiding "History Quiz" would also hide "History Rabbit Hole". Corrupt/non-JSON storage must not throw (try/catch → empty Set). | ✅ logic.spec + grid.spec |
| 3 | SM-2 spaced-repetition scheduling | `sm2(card, rating)` — index.html:3953 | Pure scheduling math. Miss→interval 1; hard→×1.2, ease−0.15 floored at 1.3; easy→×ease, ease+0.1 capped at 2.5. Off-by-one on `next_review` date or a missing clamp corrupts every future review. Computes `next_review` via `localDateStr`. | ✅ logic.spec |
| 4 | Local-date string (no UTC drift) | `localDateStr(d)` — index.html:3869 | Used for `next_review` and "due today" queries. Must read **local** getFullYear/Month/Date and zero-pad — a UTC slip would mark cards due a day early/late near midnight. | ✅ logic.spec |
| 5 | Offline card queue + sync | `getOfflineQueue`, `setOfflineQueue`, `srsCreate`, `syncOfflineQueue` — index.html:3893, 3929, 3898 | When `navigator.onLine` is false, `srsCreate` must queue to `localStorage['offline_card_queue']` and NOT hit the network; sync on reconnect must POST each and keep only the failures. A wedge here silently drops user-authored cards. | ✅ offline.spec |
| 6 | HTML escaping (XSS surface) | `esc(str)` — index.html:2470 | Every card title/desc and Claude/Wikipedia/quiz string flows through `esc` into `innerHTML`. Must escape the dangerous five and ampersand-first (no double-escape), and not leak `"null"`/`"undefined"`. | ✅ logic.spec |
| 7 | Adaptive quiz difficulty | inline in `advanceQuiz` — index.html:5038–5060 | Rolling 20-result window; hitRate>0.8 builds +streak, <0.5 builds −streak; ±3 streak shifts difficulty 1–5 with clamps. **Not pure** — tightly coupled to async question-loading + DOM + Supabase upsert, so it cannot be exercised in isolation without re-implementing it. See "NOT covered". | ❌ documented |
| 8 | Boot / smoke | `boot`, `showScreen`, `hasSession`, `getApiKey` — index.html:3846, 2209 | Page must load with no uncaught errors and route to the correct first screen for each session/key state. | ✅ smoke.spec |

## NOT covered (and why)

- **Adaptive quiz difficulty (`advanceQuiz`)** — the difficulty/streak math is
  inlined inside an `async` function that also pushes to a module-scoped array,
  mutates the DOM, calls `loadQuizQuestion()`, and fires a Supabase upsert. There
  is no extracted pure function to call. Testing it would require re-implementing
  the algorithm (forbidden) or driving a full quiz session against live
  jService/OpenTDB/Claude/Supabase. Pinned by documentation only.
- **JustWatch proxy URL/offer shaping** (`supabase/functions/justwatch/index.ts`,
  `shapeOffers`, `SEARCH_QUERY`) — server-side **Deno** edge function, a different
  runtime. It is never a `window` global in the browser, so it is out of scope
  for this browser-driven harness (would need a separate Deno test runner). The
  client only builds `SB_URL + '/functions/v1/justwatch'`; there is no
  client-side `jwLookup` in `index.html`.
- **Claude / quiz / Wikipedia / Open-Meteo network calls** (`callClaude`,
  `makeLoader` card loaders, `startQuiz`, weather) — these are thin fetch
  wrappers over third-party APIs gated on a real API key. Out of scope: testing
  them asserts vendor behaviour, not Break's logic. Their output sink (`esc`) and
  routing (`navigateToActivity`/`showScreen`) are covered instead.
- **OTP auth round-trip** (`otpSend`, `otpVerify`, `_refreshSession`) — requires
  a live Supabase auth server + a real inbox. We cover the *routing consequence*
  (no session → OTP gate) instead, with a seeded fake session for the home path.
- **Service worker / PWA caching** (`sw.js`) — install/activate/cache-version
  behaviour is environment-specific and SW is bypassed on localhost by design;
  not exercised here.
- **Timer countdown** (`startTimer`, `runBoxPhase`) — wall-clock `setTimeout`/
  `setInterval` driven; covered only for the "starts without error / sets
  `activeTimer`" invariant in grid.spec, not the full elapsed-time fire (would
  require fake timers fighting the real `setTimeout` closure).

## Files

- `playwright.config.js` — serves app on :8211, baseURL, reuseExistingServer.
- `helper.js` — `boot`, `seedSession`, `stubFetchEmpty`.
- `constants.js` — mirrored storage-key strings (identifiers, not logic).
- `smoke.spec.js` — boot/routing/no-uncaught-errors.
- `logic.spec.js` — `sm2`, `localDateStr`, `esc`, `regKey`, registry integrity.
- `grid.spec.js` — `renderActivityGrid` + hide/show toggle filtering (DOM-level).
- `offline.spec.js` — `srsCreate` offline queueing + `syncOfflineQueue` drain.
