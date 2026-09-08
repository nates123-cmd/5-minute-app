-- Crux: the diagnosis behind a deep dive.
--
-- Every other dive on the shelf arrives already understood — the dive is just
-- the drill. A Crux dive arrives from the opposite direction: it exists because
-- the user could NOT explain the topic, and the session found the exact sentence
-- where their explanation went circular.
--
-- That diagnosis is worth keeping. The hand-wave sentence is in their own words
-- and will read as embarrassingly familiar months later; the prediction is a
-- thing they promised to check against the world and otherwise never would.
-- key_points cannot carry any of it — that column drives Active Recall grading
-- and has to stay [{text, weight?, note?}] or the grader silently degrades.
--
-- One jsonb column, because the shape is a fixed five-part payload read as a
-- whole and never queried into:
--   {failure, failureWhy, handWave, handWavePush,
--    number:{headline,detail}, constraint:{...}, killerCase:{...},
--    bottleneck:{...}, prediction:{text,how}}
--
-- Absent means the dive did not come from Crux. Every existing row is that, and
-- every existing read path ignores the column, so this is additive only.

alter table public.deep_dives
  add column if not exists crux jsonb;
