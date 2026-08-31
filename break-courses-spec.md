# Break — Courses (Deep Dives v2)

Turns a Deep Dive from a single un-passable exam into a short course you can
actually walk through, one card at a time, and hands the result to the flashcard
ladder to keep forever.

Read `CLAUDE.md` first — the mastery ladder, the scroll feed, and Active Recall
all stay exactly as they are. This spec adds a layer between them.

---

## 0. Why

The current Deep Dive model is: **one explain-from-memory prompt + 3–6 key
points, and nothing else.** No teaching content, no partial credit, no resume.

The live data says that does not work:

| | |
|---|---|
| Dives on the shelf | **12** |
| Never drilled once (`review_count = 0`) | **9** |
| Archived without ever being drilled | **4** |
| Duplicates | 1 pair ("Language Families Across the world") |
| Most-drilled dive | Falklands War, 3 |

And the titles say why. These are the real ones:

- *"All the US presidents in order. With a decent-enough understanding of years… The smartest way to do this might be to memorize in eras (groups of 5 or something, say)."* — 251 chars, **in the title field**
- *"Taxonic classifications for animals. I want to understand each level to some degree with some examples of diverse species that fall under each"*
- One dive's title is **2,492 characters** — an entire research brief pasted into a topic-name field

He is already writing curricula. The schema gives him one text box and one exam.
So the dive gets created, is too big to ever sit down for, and gets swiped away.

Two structural problems, both fixed here:

1. **A dive has no content to learn from.** `key_points` deliberately do *not*
   reveal the answer (`index.html:6577`) — they are grading criteria. So a
   never-drilled dive is an exam you were never taught for.
2. **A dive is atomic.** There is no unit, no position, no progress. Confirmed:
   no `order`, `position`, `depends_on`, `parent_id`, `level`, or `stage`
   column exists on `deep_dives` or `clusters`, and nothing in the codebase
   sequences anything.

## 0.1 What the research says to do

| Principle | Source | What it becomes here |
|---|---|---|
| Practice testing + distributed practice are the two highest-utility techniques; **successive relearning** (both together) beats either | [Dunlosky et al. 2013](https://journals.sagepub.com/doi/abs/10.1177/1529100612453266), [RetrievalPractice.org](https://www.retrievalpractice.org/strategies/2018/successive-relearning) | Units mint flashcards; the existing SM-2 + ladder does the relearning |
| Decompose an objective into **knowledge components** — small, trackable units | [Koedinger KLI](https://onlinelibrary.wiley.com/doi/full/10.1111/j.1551-6709.2012.01245.x) | `dive_units`, 8–12 per course |
| **Pretesting** — guessing *before* instruction beats studying cold, even when the guess is wrong | [pretesting effect](https://www.sciencedirect.com/science/article/abs/pii/S1041608025000597) | The **Hook** beat. Also the entire engagement engine |
| **Generation / self-explanation / elaborative interrogation** beat re-reading | [Dunlosky](https://journals.sagepub.com/doi/abs/10.1177/1529100612453266), [elaborative interrogation](https://www.cognitivepsychology.com/Elaborative_Interrogation) | The **Recall** beat, graded by the existing `arGrade` |
| Interleave concepts rather than blocking one | Dunlosky | Units enter the scroll feed, mixed with everything else |
| Sustained motivation comes from **competence, autonomy, relatedness** — not extrinsic reward | [SDT app taxonomy](https://www.sciencedirect.com/science/article/pii/S1071581920300513) | Visible course map; user edits the syllabus; no streaks |

**Deliberately not copied from Duolingo.** The literature on it is mostly about
its gamification rather than its learning outcomes
([review](https://www.tandfonline.com/doi/full/10.1080/09588221.2021.1933540)),
and studies of streak/league mechanics find they generate anxiety and displace
the actual objective ([Learning @ Scale](https://dl.acm.org/doi/abs/10.1145/3491140.3528274)).
Break has no streak counter today. **Do not add one.** The pull is the curiosity
gap the Hook creates, plus a progress map that is telling the truth.

---

## 1. The model

**A dive becomes a course. A unit is one feed card, ~3 minutes.**

```
deep_dives (course)
  └── dive_units (8–12, ordered)
        └── flashcards (minted at Recall, then owned by SM-2 + ladder forever)
```

Division of labour, and it should stay this clean:

> **The course teaches once. The flashcards maintain for life.**

The existing whole-dive "explain this from memory" is **not deleted** — it
becomes the **capstone**, unlocked when the units are solid. That prompt was
always secretly a final exam.

### 1.1 Course shapes

Generation must know which shape it is building. These five cover the entire
current shelf:

| Shape | Unit = | Real dives |
|---|---|---|
| `chronology` | an era or turning point | US presidents, Falklands War |
| `hierarchy` | one level of the tree | animal taxonomy, US military structure, language families |
| `process` | one stage of the mechanism | how beer is made, mass spectrometer |
| `principles` | one principle + when it applies | Walsh's Standard of Performance, Let Them |
| `argument` | one claim or piece of evidence | the borders/ethnic-vs-religious question |

Note the presidents dive already specifies its own unit size — *"eras (groups of
5)"*. When the user's brief states a decomposition, **honour it verbatim**.

### 1.2 Schema

New table:

```sql
create table public.dive_units (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  dive_id uuid not null references public.deep_dives(id) on delete cascade,
  position int not null,
  title text not null,
  one_line text,                  -- syllabus-stage blurb, shown before the unit is built
  hook jsonb,                     -- {question, kind:'guess'|'choice', options?[], answer}
  body text,                      -- 150-250 words. THE MISSING TEACHING HALF
  why text,                       -- elaborative-interrogation prompt
  key_points jsonb,               -- same shape as deep_dives.key_points
  card_ids jsonb,                 -- flashcards minted from this unit
  sources jsonb,                  -- [{label,url}] when built from canonical data
  built_at timestamptz,           -- null = syllabus only, not yet generated
  state text not null default 'ready',   -- ready | taught | recalled | solid
  next_review date, interval int not null default 0,
  ease_factor real not null default 2.5, last_bucket text,
  review_count int not null default 0,
  created_at timestamptz not null default now()
);
```

Added to `deep_dives`:

```sql
alter table public.deep_dives
  add column if not exists shape text,          -- one of the five above
  add column if not exists brief text,          -- the long pasted ask moves HERE
  add column if not exists plan_status text not null default 'none';  -- none | planned
```

`brief` is what fixes the 2,492-character title: on planning, the long text
moves to `brief` and `title` is replaced with the short name Claude returns.

**Migration landmine:** `supabase db push` is unusable on this project (shared
suite ledger, ~69 sibling migrations). Apply via `db query --linked` or the
dashboard, exactly as `20260810_flashcards_mastery_ladder.sql` documents. RLS:
copy the per-user policy shape from `deep_dives` — and verify DELETE is included,
since a missing DELETE policy fails silently as a 0-row success.

---

## 2. Generation — two stages, canonical data first

### 2.1 Stage 1: the syllabus (cheap, one call, user-reviewed)

Input: `title` + `brief` + existing `guidance`. Output:

```json
{ "shortTitle": "...", "shape": "chronology",
  "units": [{"title": "...", "oneLine": "..."}] }
```

8–12 units. Shown to the user **before anything is committed** — reorder, rename,
delete, add. This is the autonomy lever, and it is also the cheapest possible
quality gate. Only on accept do `dive_units` rows get written (`built_at` null).

### 2.2 Stage 2: build a unit (lazy, just-in-time)

Never build all units up front. **9 of 12 existing dives were never opened** —
generating 12 units × 12 dives would be spend on content nobody reads. Build unit
`n+1` while the user is on unit `n`, exactly like `ladderPrefetchNext()`
(`index.html:5277`) and the feed's read-ahead.

Output per unit: `hook`, `body` (150–250 words), `why`, `key_points` (3–5),
`sources`.

### 2.3 Canonical first — this is the load-bearing rule

The project's own hard-won rule (`CLAUDE.md`, "Why bundled beats a model for
tier 1"): **named lists are lists, and a model asked to recite one will
eventually invent an entry.** Three of the five shapes on the current shelf are
list-shaped, and they are exactly the ones where a confident error is invisible:

| Dive | Canonical source | Claude's job |
|---|---|---|
| US presidents in order | Wikidata SPARQL (P39 head of state, ordered) | write the era narrative around the fetched list |
| Animal taxonomy | Wikidata / GBIF ranks | explain what distinguishes each rank |
| Language families | Wikidata language-family tree | explain the branch logic |
| Falklands, beer, mass spec, Walsh, borders | none needed | full generation |

So the unit builder takes an optional **facts block**: when a canonical fetch
succeeds, it is passed in and the prompt says *"use ONLY these facts for names,
dates, and order; write the explanation around them."* When it fails, the unit
is still built, but `sources` is empty and the unit renders a quiet "unverified"
affordance rather than pretending.

Wikidata SPARQL is already wired in this app for the `country` card
(`index.html:8251`) — reuse that fetch shape, do not write a second one.

---

## 3. The unit card — three beats, one card

One feed card, flipped through. ~3 minutes.

### Beat 1 — Hook (pretest)

The question **before** any teaching. Two kinds: a free guess, or 3–4 choices.
Wrong is the expected outcome and the copy must say so — *"Guess. Being wrong
here is the point."* No score, no penalty, nothing written on a miss.

This is the engagement mechanic. It is also the pedagogy. That is the whole
trick — do not add a second, extrinsic one on top.

### Beat 2 — Teach

`body` (150–250 words) plus the `why` prompt. **Select any text → "Make a
flashcard"**, prefilled, through the existing `openRememberPreview`
(`index.html:5882`) — this is the "make anything a flashcard" ask, and the
preview modal already exists for exactly this.

### Beat 3 — Recall

Explain it back. Reuse Active Recall wholesale — `arGrade` (`index.html:6778`),
speak/type/mental, per-key-point `verdicts`, `ddEffectiveBucket`. Grade the
**unit**, not the dive: write `dive_units.next_review` via a `duSchedule` that
mirrors `ddSchedule` (`index.html:6098`).

Then **mint the cards**: 2–4 atomic flashcards from this unit's key points via
`srsCreate(front, back, 'Course: ' + diveTitle)`, deduped with `cardExists`
(`index.html:4882`), ids stored in `card_ids`. From that moment the ladder owns
them.

State machine: `ready → taught → recalled → solid`. `solid` = recalled easy at
least twice, i.e. successive relearning, not one lucky pass.

---

## 4. Surfaces

### 4.1 The feed (primary)

Add `due-unit` to `DUE_SLUGS` (`index.html:9157`), alongside `due-card`,
`due-quiz`, `due-lul`, `due-dive`. The existing cadence — one due card every 6,
lead 4 — already interleaves it correctly and gets us the interleaving benefit
for free.

Feed rules that must hold:
- **Never generate a unit mid-scroll.** Same rule as `FEED_LADDER_CAP` — a model
  call under a thumb stalls the feed. The feed serves only units with
  `built_at` set; building happens on the course screen or as prefetch.
- Scrolling past a unit is a skip, not a miss. Nothing is written.
- Cap: at most 1 unit card per ~6, and never two units of the same course inside
  `FEED_LOOKBACK`.

### 4.2 The Deep Dives screen becomes the course map

Row per course, with real progress: **"Falklands War · 7 of 12 units solid"**.
Tapping opens the map — the ordered unit list, each showing its state, the next
one highlighted. Capstone sits at the bottom, locked until every unit is
`recalled` or better.

Progress language stays declarative and non-punitive, matching `renderStateLine`
(`index.html:4891`): "due", never "overdue"; no percentages, no grades — the app
already deliberately hides scores from the user (`arGrade` is told to return no
number).

### 4.3 Home

The Deep Dives pillar's sub-label changes from "to drill" to the next concrete
action — "next: Falklands, unit 8". One line, ignorable.

---

## 5. Phasing

| Phase | Ships | Verify |
|---|---|---|
| **1** | `dive_units` table + `shape`/`brief`/`plan_status`, syllabus generation with the review-and-edit step, course map screen | Plan the presidents dive; syllabus honours "eras of 5"; long title moves to `brief` |
| **2** | Unit builder (lazy) + the three-beat unit card + canonical fetch for presidents/taxonomy/languages | Walk 3 units of Falklands end to end; confirm cards minted and dedupe held |
| **3** | Feed integration (`due-unit`), interleaving caps, home line | Scroll 30 cards; units appear at cadence; no double-course adjacency |
| **4** | Capstone unlock, select-text-to-flashcard, cross-course connections | All units solid → capstone unlocks and runs the existing AR path unchanged |

**Migration is on demand.** Existing dives keep working exactly as they do
today; each gets a "Build the course" button. Nothing is auto-generated, nothing
is rewritten underneath him. (Also worth a one-time cleanup: the duplicate
"Language Families" pair, and the four dives archived without ever being drilled
— those are "planned but never started", not "retired".)

---

## 6. Don't change

- `sm2()` stays pure — the clamp and mastery multiplier live in `ladderApply`
  so the SM-2 tests stay a clean canary (`index.html:5149`).
- The mastery ladder, its pack validator, and the Haiku→Sonnet retry.
- Active Recall's screen, modes, and grading prompt. Units call the same grader.
- `deep_dives` scheduling for capstones — `ddSchedule` / the archive leash still
  govern the course-level exam.
- No streaks, no XP, no leagues, no lives. See §0.1.
