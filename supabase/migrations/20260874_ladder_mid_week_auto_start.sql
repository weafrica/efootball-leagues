-- League Ladder redesign — Phase E: mid-week auto-start leagues.
--
-- Today a league only ever grows (via _rebalance_ladder_overflow_internal)
-- and only ever gets its fixtures generated once a week, at the Monday
-- 00:00 SAST open-week cron. That means a brand-new overflow league born
-- from a capacity split sits with fixtures for up to 6 days before it
-- plays a single match. This phase moves both actions — the overflow
-- check and that new league's own fixture generation — to the moment
-- they're actually triggerable: right when a join pushes a league over
-- capacity, any day of the week.
--
-- 16. join_ladder_league() now does the overflow check itself: after
--     inserting the new membership, count that league's active roster for
--     the target week; at 8 (i.e. every join from here on checks, though
--     _rebalance_ladder_overflow_internal's own `having count(*) > 8`
--     guard means it's only ever a real split once a 9th player lands),
--     call _rebalance_ladder_overflow_internal immediately instead of
--     waiting for next Monday's cron.
-- 17. _generate_round_robin_fixtures_internal's release-stagger window is
--     no longer a fixed 142 hours (which only ever meant something
--     relative to a Monday 00:00 SAST anchor). It's now computed live:
--     hours between p_week_start_at and the nearest upcoming Sunday 22:00
--     SAST (this cycle's standing close), minus the last fixture's own
--     24h play window. For the normal cron-triggered case (anchor is
--     always exactly Monday 00:00 SAST) this reproduces 142 exactly — the
--     existing worked example / unit tests for the SQL path are
--     unaffected. For a league born mid-week, the anchor is now() at
--     whatever moment the split happens, so a league born, say, Friday
--     afternoon gets a correspondingly compressed release schedule
--     instead of assuming a full week it doesn't have left.
--
--     NOT mirrored into leagueLadder.js's ladderRoundReleaseOffsetsHours /
--     LADDER_COUNTDOWN_WINDOW_HOURS: that pure JS pair is only ever
--     exercised with a fixed full-week anchor today (Phase 2's own tests,
--     any future client-side preview) — nothing calls it from the new
--     mid-week trigger path, which is SQL-only (a join RPC calling
--     straight into _rebalance_ladder_overflow_internal). Flagging this
--     explicitly rather than leaving an implicit gap in the usual
--     hand-sync convention: if a client-side preview of a mid-week split's
--     schedule is ever needed, the JS side will need this same
--     generalization then, not before.
-- 18. _rebalance_ladder_overflow_internal generates the new league's
--     fixtures itself, immediately after creating it and moving the
--     overflow players in, PROVIDED that overflow batch is >= 2 (a
--     round robin needs at least 2 players — the common case is exactly 1
--     overflow player peeled off a barely-9th join, which stays fixture-
--     less until either it grows to 2+ via a later overflow event, or the
--     standing Monday cron's per-league loop reaches it, whichever comes
--     first — see the new not-exists guard in _ladder_open_week_internal,
--     below, which makes either path safe to land on the same league/week
--     without double-inserting fixtures).
-- 19. Resolution timing is unaffected by any of the above, confirmed: a
--     mid-week-born league is active in ladder_leagues like any other, so
--     it's already picked up by _ladder_resolve_promotion_relegation_internal
--     / _ladder_settle_week_fees_internal / _ladder_settle_bids_internal /
--     _ladder_fall_through_internal's existing "every active league" loops
--     at the one standing Sunday 10PM close — nothing new to build here,
--     nothing changed.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _generate_round_robin_fixtures_internal — same circle-method algorithm
-- as 20260866's version; only v_step_hours' source changed, from the
-- fixed 142.0 constant to a live v_window_hours computed from
-- p_week_start_at against the nearest upcoming Sunday 22:00 SAST.
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
  v_rounds integer;
  v_step_hours numeric;
  v_home uuid;
  v_away uuid;
  v_inserted integer := 0;
  v_r integer;
  v_i integer;
  v_last uuid;
  v_countdown timestamptz;
  v_local timestamp;
  v_dow integer;
  v_close_at timestamptz;
  v_window_hours numeric;
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_round_robin_fixtures_internal: need at least 2 players';
  end if;

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid; -- bye slot, same as the JS version
  end if;
  v_n := array_length(v_ids, 1);
  v_rounds := v_n - 1;

  -- Live release window: hours between p_week_start_at and the nearest
  -- upcoming Sunday 22:00 SAST, minus the final fixture's own 24h play
  -- window. Reproduces the old fixed 142 exactly when p_week_start_at is
  -- Monday 00:00 SAST (the normal cron anchor); shrinks automatically for
  -- any later, mid-week anchor.
  v_local := p_week_start_at at time zone 'Africa/Johannesburg';
  v_dow := extract(dow from v_local)::integer; -- 0 = Sunday .. 6 = Saturday
  v_close_at := (date_trunc('day', v_local) + (((7 - v_dow) % 7) * interval '1 day') + interval '22 hours')
                at time zone 'Africa/Johannesburg';
  if v_close_at <= p_week_start_at then
    v_close_at := v_close_at + interval '7 days';
  end if;
  v_window_hours := greatest(0, extract(epoch from (v_close_at - p_week_start_at)) / 3600.0 - 24);

  v_step_hours := case when v_rounds > 1 then v_window_hours / (v_rounds - 1) else 0 end;

  for v_r in 0 .. v_rounds - 1 loop
    v_countdown := p_week_start_at + ((v_r * v_step_hours) + 24) * interval '1 hour';

    for v_i in 1 .. v_n / 2 loop
      v_home := v_ids[v_i];
      v_away := v_ids[v_n - v_i + 1];
      if v_home is not null and v_away is not null then
        insert into ladder_fixtures (league_id, week_number, home_user_id, away_user_id, status, countdown_expires_at)
        values (p_league_id, p_week_number, v_home, v_away, 'pending', v_countdown);
        v_inserted := v_inserted + 1;
      end if;
    end loop;

    -- rotate: pop the last element, insert it right after the fixed first
    -- element — same shift App.jsx's/leagueLadder.js's ids.splice(1, 0,
    -- ids.pop()) performs, just 1-indexed.
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
-- _rebalance_ladder_overflow_internal — same peeling logic as 20260859's
-- version. New: right after moving the overflow batch into the freshly
-- created league, generate that league's fixtures immediately if the
-- batch is playable (>= 2). Guarded with a not-exists check on
-- ladder_fixtures for idempotency, same "safe to run more than once"
-- standard as everything else in this file — matters here specifically
-- because this function can now be reached from a live join RPC, not just
-- a once-a-week cron tick.
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
  v_already_fixtured boolean;
begin
  for v_overflow_league in
    select league_id, count(*) as cnt
    from ladder_memberships
    where week_number = p_week_number
    group by league_id
    having count(*) > 8
  loop
    select max(tier) into v_max_tier from ladder_leagues where status = 'active';

    select array_agg(user_id) into v_overflow_ids
    from (
      select user_id
      from ladder_memberships
      where league_id = v_overflow_league.league_id and week_number = p_week_number
      order by joined_at desc
      limit (v_overflow_league.cnt - 8)
    ) newest_arrivals;

    if v_overflow_ids is not null and array_length(v_overflow_ids, 1) > 0 then
      v_new_league_id := _ensure_ladder_league_internal(v_max_tier + 1);
      update ladder_memberships
      set league_id = v_new_league_id
      where league_id = v_overflow_league.league_id
        and week_number = p_week_number
        and user_id = any(v_overflow_ids);

      -- Mid-week auto-start: this new league doesn't have to wait for
      -- next Monday's cron. If it's already playable, generate its
      -- fixtures right now, anchored to this instant (not the old
      -- weekly-batch anchor) — see _generate_round_robin_fixtures_internal's
      -- own header for the compressed-window arithmetic that follows from
      -- that. A single-player overflow batch (the common case — a bare
      -- 9th join peels off exactly 1) is left fixture-less for now; it
      -- either grows to 2+ via a later overflow event (this same branch,
      -- next time it fires) or gets picked up by the standing Monday
      -- cron's per-league loop once the week actually opens — either way
      -- it's covered, and the not-exists check below plus the matching
      -- guard in _ladder_open_week_internal keep both paths from ever
      -- double-inserting fixtures for the same league/week.
      if array_length(v_overflow_ids, 1) >= 2 then
        select exists(
          select 1 from ladder_fixtures
          where league_id = v_new_league_id and week_number = p_week_number
        ) into v_already_fixtured;

        if not v_already_fixtured then
          perform _generate_round_robin_fixtures_internal(v_new_league_id, p_week_number, v_overflow_ids, now());
        end if;
      end if;
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- join_ladder_league — same eligibility/fee/insert logic as 20260868's
-- version. New: after inserting the membership, checks the (possibly
-- just-created-via-split) league's own roster size for the target week
-- and triggers the overflow rebalance immediately, live, instead of
-- leaving it for the weekly cron to find. This is now the ONLY call site
-- for _rebalance_ladder_overflow_internal in the whole codebase — see
-- _ladder_open_week_internal below, which no longer calls it (per this
-- migration's header, item 16): overflow has only ever been reachable
-- from new joins landing in the bottom/frontier league in the first place
-- (20260859's own header: "can't actually fire anywhere except wherever
-- the bottom tier ends up"), so relocating the check here loses no
-- coverage.
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

  if v_roster_count >= 8 then
    perform _rebalance_ladder_overflow_internal(v_target_week);
  end if;

  return v_row;
end;
$$;

grant execute on function join_ladder_league() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_open_week_internal — same carry-forward / fixture-generation
-- shape as 20260862's version. Two changes: (1) no longer calls
-- _rebalance_ladder_overflow_internal itself (moved to join_ladder_league,
-- live) — overflow for v_new_week has already been resolved, incrementally,
-- by whatever joins landed through the week; (2) the per-league fixture
-- loop now skips any league that already has fixture rows for v_new_week,
-- so a league that auto-started mid-week (already fixtured) isn't
-- double-fixtured when this job reaches its week.
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
  v_week_start_at timestamptz := now();
  v_league record;
  v_player_ids uuid[];
  v_already_fixtured boolean;
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
    select array_agg(user_id) into v_player_ids
    from ladder_memberships
    where league_id = v_league.id and week_number = v_new_week and status = 'active';

    if array_length(v_player_ids, 1) >= 2 then
      select exists(
        select 1 from ladder_fixtures where league_id = v_league.id and week_number = v_new_week
      ) into v_already_fixtured;

      if not v_already_fixtured then
        perform _generate_round_robin_fixtures_internal(v_league.id, v_new_week, v_player_ids, v_week_start_at);
      end if;
    end if;
  end loop;

  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$$;
