-- League Ladder — fix: a brand-new league's very first joiners were
-- always skipped past the current week.
--
-- join_ladder_league() has always computed v_target_week as
-- current_week + 1, unconditionally, no matter whether that current
-- week already has anyone in it. That +1 exists to protect an
-- ALREADY-RUNNING round robin from being disrupted by a late joiner
-- mid-week (see 20260874/20260875's Phase E header) — a real concern
-- once a week has fixtures other players are actively playing. But it
-- was never conditioned on that actually being true, so it also fired
-- for the very first joiners into a week that has zero existing
-- members and zero fixtures — nothing to protect. In production this
-- meant League 1's launch-day cycle sat on current_week = 1 with
-- bidding_open = true, but every one of its first six joiners got
-- pushed to week 2 instead, leaving week 1 permanently empty and the
-- live bid ticker invisible to everyone (no one's displayWeek ever
-- matched cycle.current_week).
--
-- Fix: only skip to current_week + 1 when the target league already
-- has an active roster for current_week. If current_week is 0 ("no
-- week opened yet," per ladder_cycle's own column comment) or the
-- target league has zero active members for current_week, seat the
-- joiner straight into current_week — there's no in-progress round
-- robin there to protect.
--
-- Safe to run more than once.

create or replace function join_ladder_league()
returns ladder_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_league_id uuid;
  v_current_week integer;
  v_current_week_roster integer;
  v_target_week integer;
  v_row ladder_memberships%rowtype;
  v_roster_count integer;
  v_final_league_id uuid;
begin
  if v_user_id is null then
    raise exception 'join_ladder_league: must be signed in';
  end if;

  select id into v_league_id
  from ladder_leagues
  where status = 'active'
  order by tier desc
  limit 1;

  if v_league_id is null then
    raise exception 'join_ladder_league: no League Ladder league is open for entry yet';
  end if;

  select current_week into v_current_week from ladder_cycle where id = true;
  v_current_week := coalesce(v_current_week, 0);

  -- Only defer to next week if THIS league already has someone active
  -- in the current week — i.e. there's an actual round robin already
  -- underway to avoid disrupting. current_week = 0 (nothing opened
  -- yet) always counts as "nothing to protect."
  if v_current_week = 0 then
    v_target_week := 1;
  else
    select count(*) into v_current_week_roster
    from ladder_memberships
    where league_id = v_league_id and week_number = v_current_week and status = 'active';

    v_target_week := case when v_current_week_roster = 0 then v_current_week else v_current_week + 1 end;
  end if;

  if exists (
    select 1 from ladder_memberships
    where user_id = v_user_id and status = 'active' and week_number >= v_current_week
  ) then
    raise exception 'join_ladder_league: already on the ladder';
  end if;

  -- Flat/free — every League Ladder league today is entry-level (see
  -- economy.js's LADDER_TIER_TABLE comment); no nets_debit call needed.

  insert into ladder_memberships (user_id, league_id, week_number, status)
  values (v_user_id, v_league_id, v_target_week, 'active')
  returning * into v_row;

  select count(*) into v_roster_count
  from ladder_memberships
  where league_id = v_league_id and week_number = v_target_week and status = 'active';

  if v_roster_count >= 6 then
    perform _rebalance_ladder_overflow_internal(v_target_week);
  end if;

  -- Re-read: the rebalance above may have just moved this player (if they
  -- were the peeled-off overflow arrival) into a brand-new league. Either
  -- way, wherever they actually ended up is the league to resync.
  select league_id into v_final_league_id
  from ladder_memberships
  where user_id = v_user_id and week_number = v_target_week and status = 'active';

  perform _ladder_sync_fixtures_internal(v_final_league_id, v_target_week);

  return v_row;
end;
$$;

grant execute on function join_ladder_league() to authenticated;
