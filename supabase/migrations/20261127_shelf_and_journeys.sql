-- Break revamp (2026-11-27): the shelf and journeys. Additive only.
--
-- Shelf: a card overdue by more than a week stops counting as due. It keeps its
-- schedule (next_review, interval, ease are untouched) and comes back a few a
-- day as a "Re-meet". Clearing shelved_at undoes it.
alter table public.flashcards add column if not exists shelved_at timestamptz;
create index if not exists flashcards_shelved_idx on public.flashcards (user_id, shelved_at) where shelved_at is not null;

-- Journeys: a channel's lesson ends on doors. Onward follows the planned
-- spine; Deeper and Sideways are written per step and, when picked, become a
-- side step (parent_id set, off the spine).
alter table public.course_units add column if not exists parent_id uuid references public.course_units(id) on delete set null;
alter table public.course_units add column if not exists doors jsonb;
alter table public.course_units add column if not exists door_picked text;
alter table public.course_units add column if not exists picked_at timestamptz;
alter table public.course_units add column if not exists taught_at timestamptz;
