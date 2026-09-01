-- Courses: intake, standing guidance, callbacks, checkpoints, daily queue.
-- Apply with `supabase db query --linked --file <this>` (db push is unusable on
-- the shared suite ledger; the CLI needs a plain-text supabase/.temp/project-ref).

alter table public.courses
  add column if not exists guidance text,              -- standing steer, replayed into every later build
  add column if not exists intake jsonb,               -- [{q,a}] from the design conversation
  add column if not exists new_per_day int not null default 2;

alter table public.course_units
  -- 'checkpoint' units exist to test the span behind them, not new material.
  add column if not exists kind text not null default 'unit',
  add column if not exists callback jsonb,             -- {question, answer, fromPositions:[int]}
  add column if not exists questions jsonb;            -- [{q,a,at}] asked while reading this unit

create index if not exists course_units_state_idx on public.course_units (state, next_review);
