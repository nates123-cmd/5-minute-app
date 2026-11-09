-- Flashcard kinds, retirement, and a review log (Nate, 2026-11-09).
--
-- kind     : what sort of thing the card is, which sets how high up the
--            mastery ladder it is worth taking it. 'vocab' stops at rung 2
--            (recognise it in a fresh sentence), 'fact' at rung 1 (both
--            directions), 'concept' takes the full ladder. Null = unsorted,
--            treated as concept until the Tidy pass sorts it.
-- status   : existing column; 'retired' is a new value. Retired cards are
--            never due, never counted, never deleted (Tidy can restore).
-- review_log: one row per grade, from either surface. Nothing reads it yet;
--            it exists so a real scheduler (FSRS) can be fitted later.
--
-- APPLY WITH `supabase db query --linked -f`, NOT `db push`. Idempotent.

alter table public.flashcards add column if not exists kind text;
create index if not exists flashcards_status_due_idx on public.flashcards (status, next_review);

create table if not exists public.review_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid(),
  card_id uuid references public.flashcards(id) on delete cascade,
  rating smallint not null,            -- 0 miss, 1 hard, 2 easy, 3 cold
  shown_rung smallint,                 -- the rung actually asked at
  level_before smallint,
  interval_before integer,
  ease_before real,
  interval_after integer,
  surface text,                        -- review | flow | passage
  reviewed_at timestamptz not null default now()
);

create index if not exists review_log_card_idx on public.review_log (card_id, reviewed_at);
create index if not exists review_log_user_idx on public.review_log (user_id, reviewed_at);

alter table public.review_log enable row level security;

drop policy if exists review_log_sel on public.review_log;
drop policy if exists review_log_ins on public.review_log;
create policy review_log_sel on public.review_log for select using (user_id = auth.uid());
create policy review_log_ins on public.review_log for insert with check (user_id = auth.uid());
