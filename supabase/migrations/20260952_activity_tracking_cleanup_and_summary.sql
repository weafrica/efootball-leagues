-- Activity tracking — the three loose ends from USER-ACTIVITY-TRACKING-BUILD-PLAN.md:
--
--   1. Retention. user_activity_log only ever grew. The plan's own privacy
--      note says to pick a retention period and write it down: 6 months.
--      A daily job deletes anything older than that. (Change the interval in
--      the cron command below if you want a different window.)
--   2. An admin summary — players active today / 7 / 30 days, new accounts,
--      players who came back after 14+ days away, a 14-day activity chart
--      and the busiest event types. Computed on the fly from the raw log,
--      so nothing extra is stored.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- 1. Retention: internal delete + a daily scheduled run (03:30 UTC).
--    Same shape as _purge_inactive_ladder_members_internal (20260850): no
--    auth check, and deliberately not reachable from the client — only the
--    scheduled job calls it.
-- ---------------------------------------------------------------------------
create or replace function public._purge_old_activity_log_internal(p_keep interval default interval '6 months')
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_removed integer;
begin
  delete from public.user_activity_log where created_at < now() - p_keep;
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$function$;

revoke all on function public._purge_old_activity_log_internal(interval) from public, anon, authenticated;

create extension if not exists pg_cron with schema extensions;

-- cron.schedule upserts by job name, so re-running updates the job in place.
select cron.schedule(
  'purge-old-activity-log-daily',
  '30 3 * * *',
  $$select public._purge_old_activity_log_internal();$$
);

-- ---------------------------------------------------------------------------
-- 2. Admin summary. Days are cut at South African midnight, not UTC, so
--    "today" means what an admin in Johannesburg expects.
-- ---------------------------------------------------------------------------
create or replace function public.get_activity_summary()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tz constant text := 'Africa/Johannesburg';
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'get_activity_summary: admin only';
  end if;

  return jsonb_build_object(
    'active_today', (
      select count(distinct user_id) from public.user_activity_log
      where user_id is not null and (created_at at time zone v_tz)::date = v_today
    ),
    'active_7d', (
      select count(distinct user_id) from public.user_activity_log
      where user_id is not null and created_at >= now() - interval '7 days'
    ),
    'active_30d', (
      select count(distinct user_id) from public.user_activity_log
      where user_id is not null and created_at >= now() - interval '30 days'
    ),
    'new_accounts_7d', (
      select count(*) from public.profiles where created_at >= now() - interval '7 days'
    ),
    -- Active in the last 7 days, AND their previous activity before that
    -- was more than 14 days before they showed up again. Players with no
    -- earlier activity at all are new, not "came back".
    'returned_7d', (
      select count(*) from (
        select r.user_id, r.first_recent, max(l.created_at) as last_before
        from (
          select user_id, min(created_at) as first_recent
          from public.user_activity_log
          where user_id is not null and created_at >= now() - interval '7 days'
          group by user_id
        ) r
        join public.user_activity_log l on l.user_id = r.user_id and l.created_at < r.first_recent
        group by r.user_id, r.first_recent
      ) x
      where x.last_before < x.first_recent - interval '14 days'
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', d.day, 'users', coalesce(a.users, 0), 'events', coalesce(a.events, 0)
             ) order by d.day), '[]'::jsonb)
      from (select generate_series(v_today - 13, v_today, interval '1 day')::date as day) d
      left join (
        select (created_at at time zone v_tz)::date as day,
               count(distinct user_id) as users, count(*) as events
        from public.user_activity_log
        where created_at >= now() - interval '16 days'
        group by 1
      ) a on a.day = d.day
    ),
    'top_events_7d', (
      select coalesce(jsonb_agg(jsonb_build_object('event_type', t.event_type, 'count', t.c) order by t.c desc), '[]'::jsonb)
      from (
        select event_type, count(*) as c
        from public.user_activity_log
        where created_at >= now() - interval '7 days'
        group by event_type
        order by c desc
        limit 10
      ) t
    )
  );
end;
$function$;

revoke all on function public.get_activity_summary() from public, anon;
grant execute on function public.get_activity_summary() to authenticated;
