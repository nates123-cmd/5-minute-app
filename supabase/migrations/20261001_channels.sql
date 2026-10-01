-- Channels (break-feed-spec.md, phase 2).
--
-- A channel is a topic Nate follows. Each one has a course behind it, so a
-- channel's card in the feed is its next course unit. Weight moves with what he
-- engages with or skips; muted channels sit out without losing their course.
--
-- APPLY WITH `supabase db query --linked -f`, NOT `db push`. Idempotent.

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid(),
  name text not null,
  course_id uuid references public.courses(id) on delete set null,
  weight real not null default 1,
  status text not null default 'following',   -- following | muted
  seeded_from text,                           -- suggestion | topic | card | course | cluster
  last_shown_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists channels_user_idx on public.channels (user_id, status);

alter table public.channels enable row level security;

drop policy if exists channels_sel on public.channels;
drop policy if exists channels_ins on public.channels;
drop policy if exists channels_upd on public.channels;
drop policy if exists channels_del on public.channels;
create policy channels_sel on public.channels for select using (user_id = auth.uid());
create policy channels_ins on public.channels for insert with check (user_id = auth.uid());
create policy channels_upd on public.channels for update using (user_id = auth.uid());
create policy channels_del on public.channels for delete using (user_id = auth.uid());
