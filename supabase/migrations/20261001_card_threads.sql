-- Go-deeper threads (break-feed-spec.md, phase 1).
--
-- One row per feed card Nate pulled a thread on: the "learn more" expansion,
-- the suggested follow-up questions, and the Q&A he actually had. The questions
-- he asks are the best interest signal the app will ever get, so they persist
-- (the older Crux / Active Recall chats are memory-only).
--
-- APPLY WITH `supabase db query --linked -f`, NOT `db push` (shared ledger; see
-- the courses migration header). Idempotent.

create table if not exists public.card_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid(),
  card_key text not null,             -- feed key of the card (stable per card)
  card_slug text,                     -- activity slug it came from
  topic text,
  card_text text,
  learn_more text,
  questions jsonb not null default '[]'::jsonb,   -- suggested follow-ups
  messages jsonb not null default '[]'::jsonb,    -- [{role, content}]
  channel_id uuid,                    -- phase 2: which channel it belonged to
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists card_threads_user_key_idx on public.card_threads (user_id, card_key);

alter table public.card_threads enable row level security;

drop policy if exists card_threads_sel on public.card_threads;
drop policy if exists card_threads_ins on public.card_threads;
drop policy if exists card_threads_upd on public.card_threads;
drop policy if exists card_threads_del on public.card_threads;
create policy card_threads_sel on public.card_threads for select using (user_id = auth.uid());
create policy card_threads_ins on public.card_threads for insert with check (user_id = auth.uid());
create policy card_threads_upd on public.card_threads for update using (user_id = auth.uid());
create policy card_threads_del on public.card_threads for delete using (user_id = auth.uid());
