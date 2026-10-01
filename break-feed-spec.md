# Break: the learning feed

Decided with Nate, 2026-10-01. Read with `DESIGN.md` (look) and
`break-courses-spec.md` (courses). This spec is the plan; build it in the phases
below, one PR each.

## The ask

> "A social-media-style feed that encourages learning. Paths that let me skip
> it, engage with it, and dive deeper into it. Ask follow-up questions, learn
> more. The right balance of new information, but guided by my own interests
> and topics. Begin tackling harder topics like the deep dives."

## Decisions

| Question | Decision |
|---|---|
| What the feed is organised around | **Channels** (topics you follow, each quietly running a slow course), plus Discover |
| Mix | **70 / 30**: 70% your channels and due work, 30% Discover (new) |
| Engage | **Guess first** where the card has one (course hooks always do) |
| Go deeper | **A sheet that rises over the card**: thread, ask box, save actions. Swipe down returns to the exact card |

## Every card, three paths

| Path | Gesture | What happens | Signal it gives |
|---|---|---|---|
| Skip | swipe up | next card | under 2s on the card = mild negative for that channel/topic |
| Engage | tap | answer the guess, or flip for the back | positive |
| Go deeper | pull up, or "Go deeper" on the back | the sheet (below) | strongest positive, especially a question asked |

## The go-deeper sheet

Rises over the card; the feed stays mounted underneath, so swiping the sheet
down lands back exactly where you were. Contents, top to bottom:

1. **Learn more**: one expansion of the card (about 150 words), generated on
   first open and cached on the card.
2. **Three follow-up questions** as tappable chips, plus a free **ask box**.
   Answers stream into a short thread. Grounded in the card text, the same
   pattern as Active Recall's `callClaudeARChat`, not Crux's (Crux's is tied to
   a global and has never run live).
3. **Actions**: Make a flashcard (offered, never auto-made), Save as deep dive
   (`ddFromLul`), **Start a channel on this** (creates a course from the card's
   topic via `coPlan`, intake skipped), Follow / Mute this channel.

Threads are saved (new table `card_threads`). The questions you ask are the best
interest signal the app will ever get, so they must persist, unlike today's
in-memory chats.

Cost rule: the sheet calls a model only because you asked. The feed itself
still never waits on a model mid-scroll.

## Channels

A channel is a topic you follow. Each one has a course behind it
(`courses` + `course_units`), so harder subjects arrive one 3-minute unit at a
time, interleaved with everything else, rather than as homework on a shelf.

- **Table `channels`**: id, user_id, name, course_id (nullable), weight, status
  (`following` / `muted`), seeded_from, created_at.
- **Seeding**: one pass proposes 6 to 8 channels from what you already have:
  flashcard clusters, existing courses, look-up-later questions, book reviews.
  You pick; nothing is followed without a tap.
- **A channel card is its next course unit**: hook (guess) on the front, body on
  the back, "why" and callback questions as engage steps. This is the `due-unit`
  feed item `break-courses-spec.md` §4.1 already called for.
- **Prebuild**: a unit takes about 20s to build, so the top channels' next units
  are built in the background on app open, never mid-scroll. A channel with no
  unit ready simply sits out a slot.
- **The rail** shows `Cards n/N · <your channels> · Discover`.

## The composer (who gets the next slot)

1. Due flashcards first, as now (the Cards phase of Flow).
2. Then each slot is drawn 70% from channels (weighted by channel weight and
   by how long since that channel last appeared) and 30% from Discover (the
   existing activity engine and its sources).
3. Self-tuning: if you skip more than 60% of channel cards across the last 20,
   Discover's share rises 10 points (cap 50%), and decays back as you engage.
4. Interest moves from per-activity to **per topic**: skips, dwell, engages and
   questions adjust the channel weight, and Discover topics you go deep on
   surface a "Follow this?" offer.

## Rules that do not change

- No streaks, XP or nags (`DESIGN.md` register test).
- No self-help cards; flashcards offered, never auto-made.
- Source-only cards are never faked by a model.
- Black and white; serif for what you are learning, sans for chrome.

## Phases

1. **Go-deeper sheet on every feed card.** Learn more, follow-up chips, ask
   box, save actions, `card_threads` table. Self-contained; the biggest felt
   change.
2. **Channels.** `channels` table, seeding pass, course units as feed cards,
   background prebuild, the 70/30 composer, the rail.
3. **Guess-first and per-topic tuning.** Engage steps on Discover cards where
   cheap (bundled sets first: "which fallacy is this?"), topic-level weights,
   the self-tuning Discover share, "Follow this?" offers.

## Open questions (settle when the phase starts)

- Phase 1: which model writes "Learn more" and the follow-ups (Haiku for speed
  vs Sonnet for depth)? Default: Sonnet, since you asked and it is one call.
- Phase 2: how many new units a day per channel (the courses default is 2)?
- Phase 2: what exactly the seeding pass proposes. Review the list with Nate.
