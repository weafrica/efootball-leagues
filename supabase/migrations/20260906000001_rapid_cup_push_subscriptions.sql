-- Rapid Cup Push Alarm — Step 1 (see RAPID-CUP-PUSH-ALARM-BUILD-PLAN.md,
-- Sections 2-3). One row per subscribed device, since a user can have more
-- than one (phone + desktop, or two phones). No `update` — a changed
-- subscription is a delete-and-reinsert (see pushsubscriptionchange
-- handling in Step 2), not a patch.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user on push_subscriptions (user_id);

alter table push_subscriptions enable row level security;

-- A user can only see/add/remove their own device's subscription — never
-- another user's, and never through anon.
create policy "push_subscriptions_select_own" on push_subscriptions
  for select to authenticated
  using (user_id = auth.uid());

create policy "push_subscriptions_insert_own" on push_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid());

create policy "push_subscriptions_delete_own" on push_subscriptions
  for delete to authenticated
  using (user_id = auth.uid());

-- No update policy on purpose (see file header) — deliberately not "delete
-- + insert" wrapped in one policy either, since RLS's WITH CHECK / USING
-- split already makes plain insert/delete the simplest correct shape.

-- service_role (used by the send-rapid-cup-push Edge Function in Step 3)
-- bypasses RLS by default in Supabase — no extra grant needed for it to
-- read every user's subscriptions when sending.
