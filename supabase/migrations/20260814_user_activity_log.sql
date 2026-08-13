-- Step 1 of activity tracking: one generic log table. Every future event
-- (page views, match actions, whatever comes next) writes here as
-- { event_type, metadata } rather than getting its own table — keeps this
-- additive instead of a new migration per event type.

create table if not exists public.user_activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_activity_log_user_id_idx on public.user_activity_log(user_id);
create index if not exists user_activity_log_event_type_idx on public.user_activity_log(event_type);
create index if not exists user_activity_log_created_at_idx on public.user_activity_log(created_at);

alter table public.user_activity_log enable row level security;

-- Any signed-in user can write their own activity rows. Deliberately no
-- select policy yet — nobody can read this table from the client until we
-- decide who's allowed to (admin dashboard, most likely) in a later step.
create policy "users insert own activity"
  on public.user_activity_log for insert
  to authenticated
  with check (auth.uid() = user_id);
