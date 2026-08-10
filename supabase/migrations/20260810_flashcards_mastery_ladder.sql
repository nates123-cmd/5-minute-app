-- Mastery ladder for flashcards.
--
-- A card carries a rung that decides HOW it gets asked; sm2() still decides
-- WHEN. The rungs are 0 Recognize, 1 Reversed, 2 Reworded, 3 Discriminate,
-- 4 Produce. Two consecutive Easy at a rung promotes; a Miss drops one.
--
-- Every column defaults to today's behaviour, so an untouched row is rung 0
-- with no variant pack and renders exactly as it did before.
--
-- Applied to the shared suite project (xsmnfcmtbpeaccnyinkr) via MCP
-- apply_migration. `supabase db push` is unusable here: the ledger carries
-- ~69 sibling migrations from the other suite apps.

alter table public.flashcards
  -- Current rung, 0..4. The client clamps; no check constraint, because a
  -- constraint on a table five other apps read is a rollback liability.
  add column if not exists ladder_level  smallint not null default 0,

  -- Consecutive Easy grades at the current rung. Resets on promote, on Hard,
  -- and on Miss.
  add column if not exists ladder_streak smallint not null default 0,

  -- High-water mark: the first time this card reached rung 4. Deliberately NOT
  -- cleared on demotion, so "this was once mastered" survives a bad day.
  add column if not exists mastered_at   timestamptz,

  -- Cached practice pack: the reworded prompt, the discriminate options, the
  -- produce prompt and the plain-MC distractors, generated once per card.
  -- MUST stay nullable with no default -- a '{}' default would make the
  -- "is it cached" test true for every row and nothing would ever generate.
  add column if not exists variants      jsonb,

  -- Fingerprint of front+back when the pack was built. A mismatch means the
  -- card was edited and the pack is stale, so it is treated as absent.
  add column if not exists variants_src  text;
