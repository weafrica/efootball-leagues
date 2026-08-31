-- League Ladder redesign — Phase E (continued): true auto-start, and
-- collapsing "week start" into the same instant as the cutoff.
--
-- Two gaps in 20260874's version of Phase E, both from the same root
-- cause — "auto-start" only ever fired at the moment a league was BORN
-- (an overflow split), never as it filled up afterward:
--
-- GAP 1 — auto-start stalled after birth. A freshly split league almost
-- always starts with exactly 1 player (join_ladder_league checks for
-- overflow after every single insert, so a parent league only ever
-- crosses 9 by one player at a time — see 20260874's own header, "the
-- common case is exactly 1 overflow player"). That 1-player league then
-- becomes the new highest tier, so it's the direct target for every
-- subsequent join — but nothing re-checked it for fixture-readiness as
-- it filled 1 -> 2 -> 3 ... Its fixtures only ever appeared at the next
-- Monday cron, which defeated the point of "auto-start." Fixed by
-- extracting the birth-time check into a standalone helper,
-- _ladder_maybe_autostart_fixtures_internal, and calling it from EVERY
-- membership-changing path — overflow split, ordinary join, and weekly
-- carry-forward alike — not just the split.
--
-- GAP 2 — threshold. Per instruction, auto-start now fires as soon as a
-- league has >= 2 active members for the week (2 is the floor
-- _generate_round_robin_fixtures_internal itself already enforces — a
-- round robin can't be built from fewer). This applies uniformly: a
-- league is playable the moment it has 2, whether that's immediately at
-- a split, or three ordinary joins later, or already-carried-forward
-- players at the weekly rollover.
--
-- WEEK-START ANCHOR REMOVED. There is no longer any notion of "the week
-- started at Monday 00:00 SAST" threaded through as a shared value.
-- Every fixture-generation call site now anchors purely to "the instant
-- this league actually became viable" (now(), taken fresh at each call —
-- _generate_round_robin_fixtures_internal's p_week_start_at parameter
-- still exists and still defaults to now(), it's just never overridden
-- with a batch-level value anymore). The ONLY fixed instant left anywhere
-- in the system is the cutoff itself.
--
-- CUTOFF UNIFIED — now Sunday 23:59 SAST, and it is BOTH the end of the
-- closing week and the start of the next one, not two events 2 hours
-- apart. Concretely:
--   - _generate_round_robin_fixtures_internal's release window now counts
--     down to Sunday 23:59 SAST (was 22:00 SAST) — every league's last
--     fixture releases 24h before THAT.
--   - _ladder_close_week_internal (resolution: promotion/relegation,
--     Wall of Fame, fees, bids, fall-through, decay) now calls
--     _ladder_open_week_internal itself, in the same transaction,
--     immediately after flipping bidding_open to false — which is exactly
--     the guard _ladder_open_week_internal's own `for update` check
--     requires, so the chain is safe. The two jobs are no longer
--     scheduled as separate cron entries 2 hours apart; there is one cron
--     job, 'ladder-close-week-sunday', at Sunday 23:59 SAST (21:59 UTC),
--     and it does both. 'ladder-open-week-tuesday' is unscheduled below.
--
-- Safe to run more than once (cron.schedule upserts by name;
-- cron.unschedule on a name that isn't currently scheduled is a no-op —
-- the `select ... from cron.job where jobname = ...` guard returns zero
-- rows rather than erroring on a second run).

-- ─────────────────────────────────────────────────────────────────────────
-- _generate_round_robin_fixtures_internal — identical to 20260874's
-- version except the cutoff clock time in v_close_at: 23:59 instead of
-- 22:00. p_week_start_at is unchanged as a parameter (still needed to
-- know "count down from when") — what's removed is any caller passing a
-- shared, batch-level value into it; see every call site below, all of
-- which now just let it default to now().
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
  -- upcoming Sunday 23:59 SAST (the one standing cutoff — see this
  -- migration's header), minus the final fixture's own 24h play window.
  v_local := p_week_start_at at time zone 'Africa/Johannesburg';
  v_dow := extract(dow from v_local)::integer; -- 0 = Sunday .. 6 = Saturday
  v_close_at := (date_trunc('day', v_local) + (((7 - v_dow) % 7) * interval '1 day') + interval '23 hours 59 minutes')
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
-- _ladder_maybe_autostart_fixtures_internal — new. The one place that
-- decides "is this league playable right now, and does it need
-- fixtures". Every membership-changing path calls this instead of
-- duplicating the count+not-exists check inline. Idempotent: a league
-- that already has fixture rows for the week is a no-op, so calling this
-- repeatedly as a league fills up (2, 3, 4... players) only ever
-- generates once, at the first moment it crosses 2.
--
-- Threshold is >= 2, not > 2: this is the same floor
-- _generate_round_robin_fixtures_internal already enforces (a round robin
-- needs at least 2 players to exist at all) — "greater than 2" in the
-- product ask is read as "2 or more", matching "auto start from 2
-- players" stated the same breath. Flagging this reading explicitly
-- since the two phrasings don't literally agree; if a literal >= 3 floor
-- is actually wanted, this is the one line to change.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_maybe_autostart_fixtures_internal(
  p_league_id uuid,
  p_week_number integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_ids uuid[];
  v_already_fixtured boolean;
begin
  select exists(
    select 1 from ladder_fixtures
    where league_id = p_league_id and week_number = p_week_number
  ) into v_already_fixtured;

  if v_already_fixtured then
    return;
  end if;

  select array_agg(user_id) into v_player_ids
  from ladder_memberships
  where league_id = p_league_id and week_number = p_week_number and status = 'active';

  if array_length(v_player_ids, 1) >= 2 then
    perform _generate_round_robin_fixtures_internal(p_league_id, p_week_number, v_player_ids);
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rebalance_ladder_overflow_internal — same peeling logic as 20260874's
-- version. The inline ">= 2, not-exists, generate" block is replaced with
-- a single call to the new shared helper — behaviorally identical for the
-- birth-time case (a 1-player batch still does nothing here), but now
-- consistent with every other call site instead of being its own copy of
-- the same check.
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

      -- Auto-start check happens here too (birth-time), on top of every
      -- ordinary join into this same league going forward — see
      -- join_ladder_league below. Usually a no-op (batch of 1), but
      -- covers the rare 2+ batch (a genuine race between near-simultaneous
      -- joins) without waiting for the next join to trip it.
      perform _ladder_maybe_autostart_fixtures_internal(v_new_league_id, p_week_number);
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- join_ladder_league — same eligibility/fee/insert logic as 20260874's
-- version. New: after the overflow check (which may have moved this very
-- player into a newly-split league), re-reads wherever the player
-- actually landed and runs the auto-start check on THAT league — not just
-- on overflow, on every join. This is what closes Gap 1: a league sitting
-- at 1 player gets checked again the moment a 2nd player joins it
-- directly (no split involved), and again at 3, 4... except each of those
-- later calls is a no-op once fixtures already exist from the first one
-- that hit 2.
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

  if v_roster_count >= 8 then
    perform _rebalance_ladder_overflow_internal(v_target_week);
  end if;

  -- Re-read: the rebalance above may have just moved this player (if they
  -- were the peeled-off overflow arrival) into a brand-new league. Either
  -- way, wherever they actually ended up is the league to auto-start-check.
  select league_id into v_final_league_id
  from ladder_memberships
  where user_id = v_user_id and week_number = v_target_week and status = 'active';

  perform _ladder_maybe_autostart_fixtures_internal(v_final_league_id, v_target_week);

  return v_row;
end;
$$;

grant execute on function join_ladder_league() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_open_week_internal — same carry-forward shape as 20260874's
-- version. The per-league fixture loop is now just a call to the shared
-- auto-start helper (no more locally-held v_player_ids/v_already_fixtured/
-- v_week_start_at — nothing here anchors on a shared "week start" moment
-- anymore, per this migration's header). Covers carried-forward leagues
-- that received no joins at all mid-week and so were never touched by
-- join_ladder_league's own auto-start check.
--
-- No longer reachable from a separate cron tick — see
-- _ladder_close_week_internal below, which now calls this directly, at
-- the same instant it closes the previous week.
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
    perform _ladder_maybe_autostart_fixtures_internal(v_league.id, v_new_week);
  end loop;

  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_close_week_internal — same resolution shape as 20260865's
-- version (promotion/relegation, Wall of Fame, fees, bids, fall-through,
-- decay), unchanged. New: after flipping the cycle flags
-- (bidding_open = false, fixtures_locked = true), it now calls
-- _ladder_open_week_internal itself, in the same transaction — the two
-- were previously separate cron jobs 2 hours apart; now they're one
-- instant, per this migration's header. Safe: _ladder_open_week_internal's
-- own guard requires bidding_open = false, which is exactly what the line
-- immediately above it just set.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_close_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week integer;
begin
  select current_week into v_week from ladder_cycle where id = true;

  perform _ladder_resolve_promotion_relegation_internal();

  if v_week is not null and v_week > 0 then
    perform _ladder_record_wall_of_fame_internal(v_week);
    perform _ladder_settle_week_fees_internal(v_week);
    perform _ladder_settle_bids_internal(v_week);
    perform _ladder_fall_through_internal(v_week);
    perform _ladder_apply_decay_penalty_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;

  perform _ladder_open_week_internal();
end;
$$;

-- pg_cron runs in UTC; SAST is UTC+2 (no daylight saving), so Sunday
-- 23:59 SAST is Sunday 21:59 UTC. Re-scheduling 'ladder-close-week-sunday'
-- to this time (was Sunday 20:00 UTC / 22:00 SAST) is what makes the
-- cutoff the single instant that both closes the outgoing week and opens
-- the next — see this migration's header. cron.schedule upserts by job
-- name, so this updates the existing job's fire time in place.
select cron.schedule(
  'ladder-close-week-sunday',
  '59 21 * * 0', -- Sunday 21:59 UTC = Sunday 23:59 SAST
  $$select _ladder_close_week_internal();$$
);

-- 'ladder-open-week-tuesday' is now redundant: _ladder_close_week_internal
-- calls _ladder_open_week_internal directly, above. Unscheduling it rather
-- than leaving it in place avoids a second, now-pointless attempt to open
-- the week 2 hours later that would just hit the "still open" guard (or
-- worse, silently do nothing useful) every single week. The subselect
-- means this is a no-op if the job was already unscheduled by an earlier
-- run of this migration.
select cron.unschedule(jobid) from cron.job where jobname = 'ladder-open-week-tuesday';
