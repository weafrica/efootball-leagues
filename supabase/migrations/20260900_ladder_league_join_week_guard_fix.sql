-- LEAGUE LADDER — fix: a joiner into a brand-new (just-split-off) league
-- was wrongly deferred to next week, even though nothing had been played
-- yet.
--
-- CONTEXT: 20260894 fixed join_ladder_league()'s "push late joiners to
-- next week" guard for the current_week = 0 case, but left the general
-- case checking the wrong signal:
--
--   select count(*) into v_current_week_roster
--   from ladder_memberships
--   where league_id = v_league_id and week_number = v_current_week and status = 'active';
--
--   v_target_week := case when v_current_week_roster = 0 then v_current_week else v_current_week + 1 end;
--
-- "Any active member already this week" is true the INSTANT a league is
-- created by _rebalance_ladder_overflow_internal (the peeled-off overflow
-- arrivals are seated immediately) — with zero fixtures played. The very
-- next player to join that brand-new league was bumped to week + 1 alone,
-- where _ladder_sync_fixtures_internal correctly declined to generate
-- anything for a roster of 1 (needs >= 2). Net effect: a league can sit
-- with e.g. 2 players correctly fixtured in week N and a 3rd player
-- stranded in week N+1 with no opponent and no fixtures, despite the
-- whole point of this redesign being that an unplayed, all-pending round
-- robin is freely resyncable (see _generate_round_robin_fixtures_internal's
-- delete-pending/skip-played logic) — there's nothing to protect until a
-- match has actually been played.
--
-- Fix: only defer to week + 1 when the league's current week has an
-- actual PLAYED or FORFEITED fixture — a real signal the round robin is
-- underway — not merely "someone's active in it". A same-week joiner into
-- a still-all-pending week gets seated straight into that week and
-- resynced in, same as any other join.
--
-- Also backfills every currently-live case of this bug: any active
-- membership sitting one week ahead of the cycle's current week, in a
-- league that hasn't played anything yet this week, gets pulled back down
-- and that league's fixtures resynced.
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
  v_week_started boolean;
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

  -- Only defer to next week if THIS league's current week has an actual
  -- played/forfeited fixture — real evidence a round robin is underway
  -- worth protecting. current_week = 0 (nothing opened yet) and an
  -- all-pending current week (nothing played yet, however many members
  -- are seated) both count as "nothing to protect."
  if v_current_week = 0 then
    v_target_week := 1;
  else
    select exists (
      select 1 from ladder_fixtures
      where league_id = v_league_id and week_number = v_current_week and status in ('played', 'forfeited')
    ) into v_week_started;

    v_target_week := case when v_week_started then v_current_week + 1 else v_current_week end;
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

-- One-off backfill: pull back any active membership currently sitting one
-- week ahead of the cycle's current week in a league that hasn't played
-- anything yet this week, then resync fixtures for every league touched
-- so the newly-corrected player(s) actually get fixtured in.
do $$
declare
  v_cycle_week integer;
  v_affected_leagues uuid[];
  v_league_id uuid;
begin
  select current_week into v_cycle_week from ladder_cycle where id = true;
  if v_cycle_week is null or v_cycle_week = 0 then
    raise notice 'No active week — nothing to backfill.';
    return;
  end if;

  with corrected as (
    update ladder_memberships m
    set week_number = v_cycle_week
    where m.status = 'active'
      and m.week_number = v_cycle_week + 1
      and not exists (
        select 1 from ladder_fixtures f
        where f.league_id = m.league_id and f.week_number = v_cycle_week and f.status in ('played', 'forfeited')
      )
    returning m.league_id
  )
  select array_agg(distinct league_id) into v_affected_leagues from corrected;

  if v_affected_leagues is null then
    raise notice 'No misassigned week-ahead memberships found — nothing to backfill.';
    return;
  end if;

  foreach v_league_id in array v_affected_leagues loop
    perform _ladder_sync_fixtures_internal(v_league_id, v_cycle_week);
  end loop;
end $$;

-- Verify: League 6 should now show all its active members on week 1, with
-- fixtures covering every one of them.
select l.tier,
       (select count(*) from ladder_memberships m where m.league_id = l.id and m.status = 'active' and m.week_number = 1) as week1_members,
       (select count(*) from ladder_memberships m where m.league_id = l.id and m.status = 'active' and m.week_number = 2) as week2_members,
       (select count(*) from ladder_fixtures f where f.league_id = l.id and f.week_number = 1) as week1_fixtures
from ladder_leagues l
where l.tier = 6;
