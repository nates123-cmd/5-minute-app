-- Standing guidance on a deep dive.
--
-- "Revise key points" already reshapes a dive from a plain-language request, but
-- the request itself is thrown away the moment it runs. So the NEXT revise has
-- no idea what you said last time, and grading treats every point as equally
-- important no matter how emphatically you said one of them mattered most.
--
-- guidance accumulates those instructions and is replayed into every later
-- revise AND into grading. Without it the same correction has to be argued
-- forever, which is exactly the complaint.
--
-- Per-point marks (core / minor / a note on one point) need no column:
-- key_points is already jsonb and its entries simply grow optional "weight" and
-- "note" fields. Old rows keep working — absent means normal.
--
-- Ported from Course+ Study (cp_dives.guidance). Same capability, separate deck:
-- work material still never lands in this table.

alter table public.deep_dives
  add column if not exists guidance text;
