-- Deep Dives: archive + resurfacing + a drill cadence driven by the AI grade.
-- Applied to prod (xsmnfcmtbpeaccnyinkr) on 2026-07-12, before the code shipped.
alter table public.deep_dives
  add column if not exists status text not null default 'active',   -- 'active' | 'archived'
  add column if not exists archived_at timestamptz,
  add column if not exists resurface_at date,                       -- when an archived dive comes back into view
  add column if not exists next_review date,                        -- null = never drilled = due
  add column if not exists interval int not null default 0,
  add column if not exists ease_factor real not null default 2.5,
  add column if not exists last_bucket text,                        -- 'miss' | 'hard' | 'easy'
  add column if not exists review_count int not null default 0,
  add column if not exists last_score real;                         -- 0-1 key-point hit fraction from the AI grade

create index if not exists deep_dives_status_idx on public.deep_dives (status);
create index if not exists deep_dives_next_review_idx on public.deep_dives (next_review);
create index if not exists deep_dives_resurface_at_idx on public.deep_dives (resurface_at);
