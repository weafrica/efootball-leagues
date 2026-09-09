-- SURVIVAL LADDER CUP — auto-name each monthly cup after the month it
-- actually runs in ("August Survivor Cup", then "September Survivor
-- Cup" the moment the next one auto-opens), instead of cloning
-- whatever name the previous cup happened to have.
--
-- Builds on 20260901_ladder_cup_monthly_cycle.sql, which already stopped
-- the old weekly "#N" auto-numbering but still copied v_prev.name verbatim
-- — that's why the live cup's title never changed on its own. This
-- replaces that copy with a name computed from the month the new cup
-- starts in, and one-time renames whatever ladder_cup league is currently
-- live to match (the screenshot showed "6 DAY SURVIVAL CUP" — a
-- hand-typed name from before this system existed, not something last
-- migration's "#N" strip was ever going to touch, since it had no
-- trailing "#N" to strip).
--
-- Safe to run more than once.

create or replace function _ladder_cup_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new_id uuid;
  v_name text;
begin
  if exists (select 1 from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null) then
    return null; -- a cup is already live — never open a second one
  end if;

  select * into v_prev from leagues where format = 'ladder_cup' order by created_at desc limit 1;
  if not found then
    return null; -- no prior Ladder Cup to clone settings from — nothing to auto-open yet
  end if;

  -- 'FMMonth' = full month name, FM fill mode strips to_char's normal
  -- fixed-width padding (otherwise "August   " with trailing spaces).
  v_name := to_char(now(), 'FMMonth') || ' Survivor Cup';

  insert into leagues (
    name, created_by, format, entry_closes_at, starts_at, description,
    round_period_hours, created_by_admin, league_type, ladder_cup_cutoff_at
  )
  values (
    v_name, v_prev.created_by, 'ladder_cup', null, now(), v_prev.description,
    v_prev.round_period_hours, v_prev.created_by_admin, v_prev.league_type,
    _ladder_cup_last_day_of_month_2359_utc(now())
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- One-time: rename whatever ladder_cup league is currently live to match
-- the month it's actually running in (its own starts_at, not now() — in
-- case this happens to run right at a month boundary).
update leagues
set name = to_char(coalesce(starts_at, now()), 'FMMonth') || ' Survivor Cup'
where format = 'ladder_cup' and ladder_cup_finalized_at is null;
