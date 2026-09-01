-- SURVIVAL LADDER CUP — fix two bugs in the monthly auto-cycle:
--
-- 1. NAMING BUG: _ladder_cup_open_new_internal only ever runs at 23:59 UTC
--    on the LAST day of the outgoing month (via the monthly cron tick).
--    `now()` at that instant is still, technically, the old month (one
--    minute before rollover) — so naming the new cup off `now()` named
--    every cup after the month that just ended, not the month it's about
--    to run through for the next ~30 days. Naming off tomorrow's date
--    fixes that.
--
-- 2. CARRY-FORWARD REGRESSION: 20260898/20260899 added automatic club +
--    member + phone carry-forward into each new cup, so owners don't have
--    to manually rejoin every cycle. 20260901 (switch to monthly cadence)
--    and 20260902 (monthly naming) each redefined this same function
--    starting from 20260895's ORIGINAL body (pre-carry-forward), silently
--    dropping that feature. Restoring it here, combined with the fixed
--    naming and the current monthly cadence.
--
-- Points/status restart on carry-forward is unchanged and intentional:
-- trg_auto_ladder_cup_entry (20260814) fires on every teams insert
-- regardless of path, giving every carried-forward club a fresh
-- ladder_cup_entries row (0 pts/w/l/gd/streak, fresh second life, status
-- 'active') — same as a normal manual join, just automatic now.
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
  v_team record;
  v_new_team_id uuid;
begin
  if exists (select 1 from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null) then
    return null; -- a cup is already live — never open a second one
  end if;

  select * into v_prev from leagues where format = 'ladder_cup' order by created_at desc limit 1;
  if not found then
    return null; -- no prior Ladder Cup to clone settings/clubs from — nothing to auto-open yet
  end if;

  -- 'FMMonth' = full month name, FM fill mode strips to_char's normal
  -- fixed-width padding. now() + 1 day = the month this cup is actually
  -- about to run through, not the instant it happens to be created.
  v_name := to_char(now() + interval '1 day', 'FMMonth') || ' Survivor Cup';

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

  -- Carry every real club from the cup that just finished into the new
  -- one automatically — same name, same WhatsApp number, same owner(s).
  -- Each insert into teams re-triggers trg_auto_ladder_cup_entry for its
  -- own fresh ladder_cup_entries row, exactly like a self-join would.
  for v_team in select id, name, phone from teams where league_id = v_prev.id loop
    insert into teams (league_id, name, phone)
    values (v_new_id, v_team.name, v_team.phone)
    returning id into v_new_team_id;

    insert into members (league_id, team_id, user_id, display_name, phone)
    select v_new_id, v_new_team_id, m.user_id, m.display_name, m.phone
    from members m
    where m.league_id = v_prev.id and m.team_id = v_team.id;
  end loop;

  return v_new_id;
end;
$$;

-- One-time: fix the currently-live cup's name to match the month it's
-- actually running in (its own starts_at + 1 day, not now(), in case this
-- happens to run right at a later month boundary).
update leagues
set name = to_char(coalesce(starts_at, now()) + interval '1 day', 'FMMonth') || ' Survivor Cup'
where format = 'ladder_cup' and ladder_cup_finalized_at is null;

-- One-time: backfill clubs from the cup that just finished into the
-- currently-live one, for any owner not already a member there (the
-- handful who'd already manually rejoined are skipped to avoid
-- duplicating them).
do $$
declare
  v_current uuid;
  v_prev uuid;
  v_team record;
  v_new_team_id uuid;
begin
  select id into v_current from leagues
  where format = 'ladder_cup' and ladder_cup_finalized_at is null
  order by created_at desc limit 1;

  select id into v_prev from leagues
  where format = 'ladder_cup' and id <> v_current
  order by created_at desc limit 1;

  if v_current is null or v_prev is null then
    return;
  end if;

  for v_team in select id, name, phone from teams where league_id = v_prev loop
    if exists (
      select 1 from members m
      where m.league_id = v_current
        and m.user_id in (select user_id from members where league_id = v_prev and team_id = v_team.id)
    ) then
      continue; -- this owner already (re)joined the live cup manually — skip
    end if;

    insert into teams (league_id, name, phone)
    values (v_current, v_team.name, v_team.phone)
    returning id into v_new_team_id;

    insert into members (league_id, team_id, user_id, display_name, phone)
    select v_current, v_new_team_id, m.user_id, m.display_name, m.phone
    from members m
    where m.league_id = v_prev and m.team_id = v_team.id;
  end loop;
end $$;
