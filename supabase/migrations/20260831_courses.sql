-- Courses (Deep Dives v2) — see break-courses-spec.md
--
-- Deliberately NOT columns on deep_dives. The existing 12 dives keep working
-- exactly as they do today; a course is a separate record with its own surface,
-- so this whole feature can be reverted by dropping two tables. If courses earn
-- their keep, the two models merge later (the dive prompt becomes the capstone).
--
-- APPLY WITH `supabase db query --linked`, NOT `db push` — this project shares a
-- migration ledger with ~69 sibling suite migrations and push is unusable here.
-- The CLI also needs a PLAIN-TEXT supabase/.temp/project-ref file; the newer
-- linked-project.json alone yields "Cannot find project ref".

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid(),
  title text not null,
  brief text,                       -- the long pasted ask lives HERE, not in title
  shape text,                       -- chronology|hierarchy|process|principles|argument
  summary text,
  capstone_prompt text,             -- the whole-course exam, unlocked when units are solid
  status text not null default 'active',   -- active|archived
  source text,
  created_at timestamptz not null default now()
);

create table if not exists public.course_units (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  position int not null,
  title text not null,
  one_line text,                    -- syllabus blurb, shown before the unit is built
  hook jsonb,                       -- {question, kind:'guess'|'choice', options:[], answer}
  body text,                        -- 150-250 words: the teaching half a dive never had
  why text,                         -- elaborative-interrogation prompt
  key_points jsonb,                 -- [{text}] — same shape as deep_dives.key_points
  facts jsonb,                      -- canonical rows this unit was built from
  sources jsonb,                    -- [{label,url}] when canonical
  card_ids jsonb,                   -- flashcards minted at Recall
  built_at timestamptz,             -- null = syllabus only, not generated yet
  state text not null default 'ready',   -- ready|taught|recalled|solid
  next_review date,
  interval int not null default 0,
  ease_factor real not null default 2.5,
  last_bucket text,
  review_count int not null default 0,
  easy_streak int not null default 0,     -- 2 easies => solid (successive relearning)
  created_at timestamptz not null default now()
);

create index if not exists course_units_course_idx on public.course_units (course_id, position);
create index if not exists course_units_due_idx on public.course_units (next_review);

alter table public.courses enable row level security;
alter table public.course_units enable row level security;

-- Same four-policy shape as deep_dives/flashcards. DELETE is included on
-- purpose: a missing DELETE policy does not error, it silently deletes 0 rows.
drop policy if exists courses_sel on public.courses;
drop policy if exists courses_ins on public.courses;
drop policy if exists courses_upd on public.courses;
drop policy if exists courses_del on public.courses;
create policy courses_sel on public.courses for select using (auth.uid() = user_id);
create policy courses_ins on public.courses for insert with check (auth.uid() = user_id);
create policy courses_upd on public.courses for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy courses_del on public.courses for delete using (auth.uid() = user_id);

drop policy if exists course_units_sel on public.course_units;
drop policy if exists course_units_ins on public.course_units;
drop policy if exists course_units_upd on public.course_units;
drop policy if exists course_units_del on public.course_units;
create policy course_units_sel on public.course_units for select using (auth.uid() = user_id);
create policy course_units_ins on public.course_units for insert with check (auth.uid() = user_id);
create policy course_units_upd on public.course_units for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy course_units_del on public.course_units for delete using (auth.uid() = user_id);
