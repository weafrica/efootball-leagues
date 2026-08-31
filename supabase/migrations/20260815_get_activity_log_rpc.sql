-- Step 2 of activity tracking: an admin-only way to read the log. Same
-- pattern as get_all_accounts (see 20260805-ish accounts migration) —
-- a security-definer function that checks admins internally, rather than
-- a client-facing RLS select policy on user_activity_log. Non-admins get
-- zero rows back (the exists-check filters everything out), not an error.

create or replace function public.get_activity_log(p_limit int default 200)
returns table (
  id uuid,
  user_id uuid,
  email text,
  efootball_username text,
  event_type text,
  metadata jsonb,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    l.id, l.user_id, u.email, p.efootball_username, l.event_type, l.metadata, l.created_at
  from public.user_activity_log l
  left join auth.users u on u.id = l.user_id
  left join public.profiles p on p.user_id = l.user_id
  where exists (select 1 from public.admins a where a.user_id = auth.uid())
  order by l.created_at desc
  limit greatest(1, least(p_limit, 500)); -- hard ceiling so nobody accidentally pulls the whole table
$$;

grant execute on function public.get_activity_log(int) to authenticated;
