-- League Ladder redesign — Phase E (continued, again): double round robin,
-- groups of 6, resync on every join, and the cutoff corrected to UTC.
--
-- Four changes, all interacting with each other, so bundled in one
-- migration rather than split:
--
-- 1. CUTOFF CORRECTED TO UTC. 20260875 read "11:59pm Sunday" as SAST and
--    converted it to 21:59 UTC. That was wrong — the actual ask was
--    11:59pm Sunday UTC, i.e. 23:59 UTC directly, no timezone conversion
--    at all. _generate_round_robin_fixtures_internal's window math now
--    operates purely in UTC (`at time zone 'UTC'` instead of
--    'Africa/Johannesburg'), and the cron fires at 23:59 UTC directly —
--    simpler than before, since there's no SAST offset left to get wrong.
--
-- 2. GROUP SIZE 6, NOT 8. Every "8" in the overflow-split machinery is
--    now "6": a league splits once its roster passes 6 (i.e. a 7th player
--    landing triggers the peel, same as a 9th did before), and
--    join_ladder_league's own overflow-check threshold moves from 8 to 6
--    accordingly. Nothing about the round-robin algorithm itself changes
--    size-wise — it already worked for any n — this only changes when a
--    league is considered full.
--
-- 3. DOUBLE ROUND ROBIN. _generate_round_robin_fixtures_internal now
--    builds a full home-and-away schedule — every pair plays each other
--    twice, once with each as home — not a single leg. Mechanically: the
--    circle-method rotation is a single (n-1)-cycle, so running it for
--    exactly n-1 rounds always returns the player array to its original
--    order by the time the loop ends (that's what the rotation being a
--    full cycle means). So rather than re-deriving a second rotation
--    sequence, the loop simply runs for 2*(n-1) rounds total and swaps
--    home/away for the second half — round r and round r+(n-1) hit the
--    exact same pairing-by-index, just reversed, which is precisely a
--    return leg. Total rounds double; the release-stagger step shrinks
--    accordingly so the whole schedule still fits the time left before
--    cutoff.
--
-- 4. RESYNC ON EVERY JOIN, RESULTS PRESERVED. Previously, once a league
--    had any fixtures for the week, later joins were a no-op for fixture
--    generation (not-exists guard) — a late joiner just sat in the roster
--    unscheduled until next week. Now every join re-syncs the league's
--    entire fixture set to match its current roster, but never touches a
--    fixture that's already been played or forfeited:
--      - _generate_round_robin_fixtures_internal opens by DELETING every
--        'pending' row for (league_id, week_number) — clearing anything
--        not yet played, since the schedule is about to be recomputed
--        from scratch for the new full roster.
--      - It then rebuilds the complete double round-robin over the
--        current roster, but for each (home, away) pairing it would
--        insert, first checks whether a 'played' or 'forfeited' row
--        already exists for that EXACT directional pair — home a
--        specific player, away a specific player — for this league/week.
--        If so, that leg is already decided; skip it, leaving the
--        existing row (with its score, played_at, everything) completely
--        untouched. Only pairings with no recorded result get a fresh
--        'pending' row.
--    Net effect: a match a player has already won or lost stays exactly
--    as it is, permanently, no matter how many more people join the
--    league afterward or how many times the schedule gets rebuilt around
--    it. Everything else — new pairings introduced by a new joiner,
--    and previously-scheduled-but-unplayed pairings between existing
--    players, which get freed by the pending-delete and rebuilt with
--    fresh countdown timing — regenerates every time.
--    The old _ladder_maybe_autostart_fixtures_internal (which had an
--    "already fixtured -> do nothing" early exit, by design, since it was
--    only ever meant to fire once) is renamed to _ladder_sync_fixtures_internal
--    and loses that exit — it's now meant to be called on every roster
--    change, not just the first one that crosses the playable threshold.
--
-- Safe to run more than once — the delete-and-skip-existing-results
-- pattern above means re-running this migration itself, or re-calling
-- _ladder_sync_fixtures_internal any number of times against an unchanged
-- roster, converges to the same fixture set rather than compounding.

-- ─────────────────────────────────────────────────────────────────────────
-- _generate_round_robin_fixtures_internal — rewritten for double round
-- robin, live resync (delete-pending / skip-already-played), and a UTC
-- (not SAST) cutoff. See this migration's header for the rotation-cycle
-- reasoning behind the leg-2 swap.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _generate_round_robin_fixtures_internal(
  p_league_id uuid,
  p_week_number integer,
  p_player_ids uuid[],
  p_week_start_at timestamptz default now()
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := p_player_ids;
  v_n integer;
  v_rounds_single integer;
  v_rounds_total integer;
  v_step_hours numeric;
  v_home uuid;
  v_away uuid;
  v_inserted integer := 0;
  v_r integer;
  v_i integer;
  v_last uuid;
  v_leg2 boolean;
  v_countdown timestamptz;
  v_local timestamp;
  v_dow integer;
  v_close_at timestamptz;
  v_window_hours numeric;
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_round_robin_fixtures_internal: need at least 2 players';
  end if;

  -- Clear anything not yet played for this league/week — the schedule is
  -- about to be rebuilt from scratch for the current full roster. Played
  -- and forfeited rows are untouched by this delete (status filter), so
  -- recorded results survive regardless of how the rest of the schedule
  -- reshuffles.
  delete from ladder_fixtures
  where league_id = p_league_id and week_number = p_week_number and status = 'pending';

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid; -- bye slot, same as the JS version
  end if;
  v_n := array_length(v_ids, 1);
  v_rounds_single := v_n - 1;
  v_rounds_total := 2 * v_rounds_single; -- double round robin: home leg + away leg

  -- Live release window: hours between p_week_start_at and the nearest
  -- upcoming Sunday 23:59 UTC (the one standing cutoff, defined directly
  -- in UTC — no timezone conversion), minus the final fixture's own 24h
  -- play window.
  v_local := p_week_start_at at time zone 'UTC';
  v_dow := extract(dow from v_local)::integer; -- 0 = Sunday .. 6 = Saturday
  v_close_at := (date_trunc('day', v_local) + (((7 - v_dow) % 7) * interval '1 day') + interval '23 hours 59 minutes')
                at time zone 'UTC';
  if v_close_at <= p_week_start_at then
    v_close_at := v_close_at + interval '7 days';
  end if;
  v_window_hours := greatest(0, extract(epoch from (v_close_at - p_week_start_at)) / 3600.0 - 24);

  v_step_hours := case when v_rounds_total > 1 then v_window_hours / (v_rounds_total - 1) else 0 end;

  for v_r in 0 .. v_rounds_total - 1 loop
    v_countdown := p_week_start_at + ((v_r * v_step_hours) + 24) * interval '1 hour';
    v_leg2 := v_r >= v_rounds_single;

    for v_i in 1 .. v_n / 2 loop
      if v_leg2 then
        -- return leg: same pairing this rotation position produced in
        -- leg 1 (the array is back to its original order by now — a
        -- single (n-1)-cycle completes exactly every v_rounds_single
        -- rotations), home/away reversed.
        v_home := v_ids[v_n - v_i + 1];
        v_away := v_ids[v_i];
      else
        v_home := v_ids[v_i];
        v_away := v_ids[v_n - v_i + 1];
      end if;

      if v_home is not null and v_away is not null then
        if not exists (
          select 1 from ladder_fixtures
          where league_id = p_league_id and week_number = p_week_number
            and home_user_id = v_home and away_user_id = v_away
            and status in ('played', 'forfeited')
        ) then
          insert into ladder_fixtures (league_id, week_number, home_user_id, away_user_id, status, countdown_expires_at)
          values (p_league_id, p_week_number, v_home, v_away, 'pending', v_countdown);
          v_inserted := v_inserted + 1;
        end if;
      end if;
    end loop;

    -- rotate: pop the last element, insert it right after the fixed first
    -- element. Run every round, leg 1 and leg 2 alike — by design: it's
    -- the v_leg2 flag, not the array's rotation state, that decides
    -- home/away, so letting the rotation keep cycling through leg 2 just
    -- replays leg 1's exact index pairings again, which is what leg 2
    -- needs.
    v_last := v_ids[v_n];
    for v_i in reverse v_n .. 3 loop
      v_ids[v_i] := v_ids[v_i - 1];
    end loop;
    v_ids[2] := v_last;
  end loop;

  return v_inserted;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_sync_fixtures_internal — renamed from
-- _ladder_maybe_autostart_fixtures_internal. Same >= 2 floor, but no more
-- "already fixtured -> return" early exit: this is now meant to run on
-- every roster change (join, overflow split, weekly carry-forward), and
-- _generate_round_robin_fixtures_internal's own delete-pending /
-- skip-already-played logic is what makes calling it repeatedly safe and
-- correct rather than wasteful or destructive.
-- ─────────────────────────────────────────────────────────────────────────
drop function if exists _ladder_maybe_autostart_fixtures_internal(uuid, integer);

create or replace function _ladder_sync_fixtures_internal(
  p_league_id uuid,
  p_week_number integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_ids uuid[];
begin
  select array_agg(user_id order by joined_at) into v_player_ids
  from ladder_memberships
  where league_id = p_league_id and week_number = p_week_number and status = 'active';

  if array_length(v_player_ids, 1) >= 2 then
    perform _generate_round_robin_fixtures_internal(p_league_id, p_week_number, v_player_ids);
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rebalance_ladder_overflow_internal — same peeling logic as before,
-- capacity threshold moved from 8 to 6: a league splits once its roster
-- passes 6 (a 7th player triggers the peel), and the overflow batch is
-- everything past the newest 6 arrivals. Calls the renamed sync helper.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rebalance_ladder_overflow_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overflow_league record;
  v_max_tier integer;
  v_overflow_ids uuid[];
  v_new_league_id uuid;
begin
  for v_overflow_league in
    select league_id, count(*) as cnt
    from ladder_memberships
    where week_number = p_week_number
    group by league_id
    having count(*) > 6
  loop
    select max(tier) into v_max_tier from ladder_leagues where status = 'active';

    select array_agg(user_id) into v_overflow_ids
    from (
      select user_id
      from ladder_memberships
      where league_id = v_overflow_league.league_id and week_number = p_week_number
      order by joined_at desc
      limit (v_overflow_league.cnt - 6)
    ) newest_arrivals;

    if v_overflow_ids is not null and array_length(v_overflow_ids, 1) > 0 then
      v_new_league_id := _ensure_ladder_league_internal(v_max_tier + 1);
      update ladder_memberships
      set league_id = v_new_league_id
      where league_id = v_overflow_league.league_id
        and week_number = p_week_number
        and user_id = any(v_overflow_ids);

      perform _ladder_sync_fixtures_internal(v_new_league_id, p_week_number);
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- join_ladder_league — same shape as before, overflow-check threshold
-- moved from 8 to 6. The final sync call at the end now doubles as both
-- "auto-start this league if it just crossed 2" AND "resync this league's
-- schedule to include the player who just joined" — same call either way,
-- since _ladder_sync_fixtures_internal no longer distinguishes first-time
-- generation from a later resync.
-- ─────────────────────────────────────────────────────────────────────────
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
  v_target_week := v_current_week + 1;

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

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_open_week_internal — unchanged shape, just calls the renamed
-- sync helper for the new week's carried-forward roster (a brand new
-- week_number, so there's nothing previously played to preserve here —
-- the delete-pending / skip-played logic is a no-op the first time a
-- given week_number is touched).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_open_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_week integer;
  v_new_week integer;
  v_bidding_open boolean;
  v_league record;
begin
  select current_week, bidding_open into v_prev_week, v_bidding_open
  from ladder_cycle where id = true for update;

  if v_bidding_open then
    raise exception '_ladder_open_week_internal: week % is still open — close it before opening a new one', v_prev_week;
  end if;

  v_new_week := v_prev_week + 1;

  if v_prev_week > 0 then
    for v_league in select id from ladder_leagues where status = 'active' loop
      insert into ladder_memberships (user_id, league_id, week_number, status)
      select user_id, v_league.id, v_new_week, 'active'
      from ladder_memberships
      where league_id = v_league.id and week_number = v_prev_week and status = 'active';
    end loop;
  end if;

  for v_league in select id from ladder_leagues where status = 'active' loop
    perform _ladder_sync_fixtures_internal(v_league.id, v_new_week);
  end loop;

  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$$;

-- Cutoff corrected: 23:59 UTC directly (11:59pm Sunday UTC), not a SAST
-- conversion. pg_cron already runs in UTC, so this is now a literal
-- match with no offset math — 'ladder-close-week-sunday' fires at 23:59
-- UTC every Sunday, closes the outgoing week, and (per 20260875)
-- immediately opens the next one in the same transaction.
select cron.schedule(
  'ladder-close-week-sunday',
  '59 23 * * 0', -- 23:59 UTC = 11:59 PM UTC, Sunday
  $$select _ladder_close_week_internal();$$
);
