-- WEEKEND LEAGUE — tighten _weekend_league_open_new_internal's v_prev
-- lookup from "any admin-created, non-ladder_cup league starting on a
-- Fri/Sat/Sun" down to "format = 'groups_knockout'" specifically, which
-- is Three-Day Titans League's own, unique format (already how the
-- group-stage/knockout sweep functions scope themselves).
--
-- Without this, any OTHER admin-created knockout league that happens to
-- land a starts_at on a Friday/Saturday/Sunday — an FA Cup instance, a
-- Rapid Cup instance, etc. — outranks the real Weekend League in the
-- "order by starts_at desc limit 1" lookup below and gets cloned forward
-- as if it were the next Weekend League, silently hijacking the weekly
-- cycle (wrong name, wrong format, wrong rules). Confirmed live: several
-- "Rapid Cup — ..." rows created today already have a later starts_at
-- than the current Three-Day Titans League row, so the very next Friday
-- cron tick would have cloned one of those instead.
--
-- A parallel fix was made in the frontend's isWeekendLeague() and the two
-- weekendLeagues spotlight builders in src/App.jsx, for the same reason.
--
-- Same cron job ('weekend-league-monday-open', unchanged) calls this
-- function by name, so replacing the function body alone is enough — no
-- need to re-schedule anything. Safe to run more than once.
create or replace function _weekend_league_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new leagues%rowtype;
  v_new_id uuid;
  v_next_start timestamptz;
begin
  v_next_start := _next_utc_dow_hour(now(), 5, 17); -- next Friday 17:00 UTC

  if exists (
    select 1 from leagues
    where created_by_admin = true and format = 'groups_knockout' and starts_at = v_next_start
  ) then
    return null;
  end if;

  select * into v_prev
  from leagues
  where created_by_admin = true
    and format = 'groups_knockout'
    and extract(dow from starts_at) in (5, 6, 0)
  order by starts_at desc
  limit 1;

  if not found then
    return null;
  end if;

  v_new := v_prev;
  v_new.id := gen_random_uuid();
  v_new.created_at := now();
  v_new.starts_at := v_next_start;
  v_new.entry_closes_at := v_next_start;
  v_new.prizes_paid_at := null;
  v_new.current_stage := 1;
  v_new.final_stage_started := false;
  v_new.groups_count := null;
  v_new.group_stage_due_at := null;

  insert into leagues select (v_new).*
  returning id into v_new_id;

  return v_new_id;
end;
$$;
