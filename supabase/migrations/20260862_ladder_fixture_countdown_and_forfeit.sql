-- League Ladder — Phase 6: fixture countdown & forfeit automation, plus a
-- fee-table change that rides along in this migration (League 8, the
-- bottom league, is now free to enter — Entry Fee 0).
--
-- Three things, in order:
--
-- 1. Countdown stagger (plan §6): _generate_round_robin_fixtures_internal
--    now stamps every fixture's countdown_expires_at with the same
--    staggered ~19h40m release schedule leagueLadder.js's
--    generateRoundRobinFixtures/ladderRoundReleaseOffsetsHours computes
--    (Tue 12AM through Sat 10PM, 24h play window per fixture). The JS
--    version is the tested reference (scripts/test-league-ladder.mjs);
--    this reimplements the same arithmetic in SQL for the same
--    can't-call-out-to-JS-from-a-cron-job reason every other pure/SQL pair
--    in this codebase exists. _ladder_open_week_internal is updated to
--    supply the anchor: now() at the moment the Tuesday cron fires IS
--    that week's Tuesday 12:00 AM SAST, per its own schedule (20260856),
--    so no separate "week start" column is needed.
--
-- 2. Hourly forfeit sweep (plan's own resolution choice): any 'pending'
--    fixture whose countdown_expires_at has passed becomes a double-
--    forfeit — both sides 4-0, no match reward — mirroring the app's
--    existing no-show pattern (isFixtureLocked's no-show branch,
--    App.jsx) rather than inventing a new shape. computeStandings
--    (leagueLadder.js) already has a 'forfeited' branch that scores this
--    correctly; LeagueLadderDetail.jsx already renders forfeited fixtures
--    distinctly from a played result.
--
-- 3. League 8 (bottom league) made free to enter: economy.js's
--    LADDER_TIER_TABLE[8].entryFee is now 0 (see that file). This
--    migration mirrors the same change into _ladder_entry_fee_for_tier,
--    and patches the two places that actually DEBIT a player for an
--    entry fee (_ladder_settle_week_fees_internal's promoted branch,
--    _ladder_fall_through_internal) to skip the debit/credit/fee-event
--    when the fee is 0 — same "owes nothing, not a $0 event" treatment
--    Table Fee already gets for a zero-earnings week. Without this guard
--    _nets_debit_internal raises ("amount must be positive") and
--    ladder_fee_events' own check (amount > 0) would reject the insert,
--    so this isn't just bookkeeping — moving into League 8 for free would
--    otherwise hard-fail the Sunday settlement job for anyone it happens
--    to.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _generate_round_robin_fixtures_internal — same circle-method algorithm
-- as before (20260856), now taking an explicit p_week_start_at (defaults
-- to now(), matching "generate fixtures right as the week opens" for
-- every existing call site) and stamping each round's fixtures with a
-- staggered countdown_expires_at.
--
-- Round-release-offset arithmetic mirrors leagueLadder.js's
-- ladderRoundReleaseOffsetsHours exactly: a 118-hour window (Tue 12AM ->
-- Sat 10PM) divided into (round_count - 1) equal gaps, so for the
-- standard 7-round/8-player case each round is ~19h40m after the last —
-- Tue 12AM, Tue 7:40PM, Wed 3:20PM, Thu 11AM, Fri 6:40AM, Sat 2:20AM, Sat
-- 10PM — then + 24h for that round's own countdown_expires_at. A single-
-- round league (2 players, no bye) releases immediately (offset 0).
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
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_round_robin_fixtures_internal: need at least 2 players';
  end if;

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid; -- bye slot, same as the JS version
  end if;
  v_n := array_length(v_ids, 1);
  v_rounds := v_n - 1;
  v_step_hours := case when v_rounds > 1 then 118.0 / (v_rounds - 1) else 0 end;

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
-- _ladder_open_week_internal — same two-pass shape as 20260859's version,
-- now captures v_week_start_at once (the moment this job runs — Tuesday
-- 12:00 AM SAST per the cron schedule below) and threads it through both
-- call sites of the fixture generator so every league's countdown stagger
-- is anchored to the same instant.
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

  perform _rebalance_ladder_overflow_internal(v_new_week);

  for v_league in select id from ladder_leagues where status = 'active' loop
    select array_agg(user_id) into v_player_ids
    from ladder_memberships
    where league_id = v_league.id and week_number = v_new_week and status = 'active';

    if array_length(v_player_ids, 1) >= 2 then
      perform _generate_round_robin_fixtures_internal(v_league.id, v_new_week, v_player_ids, v_week_start_at);
    end if;
  end loop;

  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_forfeit_expired_fixtures_internal — the hourly sweep. Finds
-- every 'pending' fixture whose countdown has expired and marks it a
-- double-forfeit: both sides 4-0, no scorer, no points (matches
-- leagueLadder.js's computeStandings 'forfeited' branch and App.jsx's
-- existing no-show scoring convention). Deliberately does NOT call
-- _credit_ladder_match_reward_internal — a forfeit never pays a Match
-- Reward, per plan §6 ("neither receives the match reward") and
-- economy.js's own "forfeited fixtures never call
-- computeLadderMatchNets" note. Idempotent by construction: the
-- `status = 'pending'` filter means an already-forfeited row is never
-- touched again on a later sweep run.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_forfeit_expired_fixtures_internal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update ladder_fixtures
  set status = 'forfeited', home_score = null, away_score = null, played_at = now()
  where status = 'pending'
    and countdown_expires_at is not null
    and countdown_expires_at < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Deliberately no grant — internal only, reachable solely from the
-- scheduled sweep below (same convention as every other _*_internal
-- function in this codebase).

create extension if not exists pg_cron with schema extensions;

-- Hourly resolution, per the plan's own "hourly is probably enough" call.
-- cron.schedule upserts by job name, so re-running this migration updates
-- the existing job in place rather than creating duplicates.
select cron.schedule(
  'ladder-forfeit-sweep-hourly',
  '0 * * * *',
  $$select _ladder_forfeit_expired_fixtures_internal();$$
);

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_entry_fee_for_tier — tier 8 (and anything past it, via the
-- clamp) is now 0: the bottom league is free to enter. Mirrors
-- economy.js's LADDER_TIER_TABLE[8].entryFee — keep both in sync by hand
-- if this ever changes, same convention as every other JS/SQL pair here.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_entry_fee_for_tier(p_tier integer)
returns bigint
language sql
immutable
as $$
  select case least(greatest(p_tier, 1), 8)
    when 1 then 80 when 2 then 67 when 3 then 58 when 4 then 48
    when 5 then 36 when 6 then 29 when 7 then 18 when 8 then 0
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_settle_week_fees_internal — same as 20260860's version, with one
-- change: the 'promoted' branch now skips the debit/credit/fee-event
-- entirely when the destination tier's Entry Fee is 0 (only reachable via
-- promotion into League 8 from an auto-created tier 9+ overflow league,
-- since tier 8 is otherwise the ladder's floor) — same "owes nothing, not
-- a $0 event" treatment the 'active'/Table-Fee branch already had.
-- Skipping here just means no fee_events row for that promotion; the
-- membership/promotion itself already happened in the resolve job, this
-- function only ever charges, never seats anyone.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_settle_week_fees_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_fee bigint;
  v_earnings bigint;
  v_fee_type text;
  v_reason text;
begin
  for v_row in
    select m.user_id, m.status, m.league_id, l.tier as league_tier
    from ladder_memberships m
    join ladder_leagues l on l.id = m.league_id
    where m.week_number = p_week_number
      and m.status in ('active', 'promoted')
  loop
    if v_row.status = 'promoted' then
      v_fee_type := 'entry';
      v_reason := 'ladder_entry_fee';
      v_fee := _ladder_entry_fee_for_tier(v_row.league_tier - 1);
      if v_fee <= 0 then
        continue; -- free entry (League 8) — owes nothing, no event to log
      end if;
    else
      select coalesce(sum(amount), 0) into v_earnings
      from nets_transactions
      where user_id = v_row.user_id
        and ref_type = 'ladder_fixture'
        and reason = 'ladder_match_reward'
        and ref_id in (
          select id::text from ladder_fixtures where week_number = p_week_number
        );

      v_fee := round(v_earnings * 0.20);
      if v_fee <= 0 then
        continue; -- earned nothing (or a rounding-to-zero week) -> owes nothing
      end if;
      v_fee_type := 'table';
      v_reason := 'ladder_table_fee';
    end if;

    -- Idempotency guard: skip if this exact (user, week, fee_type) was
    -- already charged by a previous run.
    if exists (
      select 1 from ladder_fee_events
      where user_id = v_row.user_id and week_number = p_week_number and fee_type = v_fee_type
    ) then
      continue;
    end if;

    perform _nets_debit_internal(
      v_row.user_id, v_fee, v_reason, null, 'ladder_week', p_week_number::text
    );
    perform _ladder_pool_credit(
      v_fee, v_reason, v_row.user_id, 'ladder_week', p_week_number::text
    );

    insert into ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned)
    values (v_row.user_id, p_week_number, v_row.league_id, v_fee_type, v_fee, v_row.status = 'promoted');
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_fall_through_internal — same as 20260861's version, with the
-- same zero-fee guard as above. A relegated player falling through into
-- League 8 (the common case — League 8 is the usual "league below"
-- tier 7) now gets seated for free: the membership row is still written
-- unconditionally, only the debit/credit/fee-event is skipped when
-- v_fee <= 0.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_fall_through_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_already_won boolean;
  v_below_league_id uuid;
  v_below_tier integer;
  v_fee bigint;
  v_already_seated boolean;
begin
  for v_row in
    select m.user_id, m.league_id, l.tier as tier
    from ladder_memberships m
    join ladder_leagues l on l.id = m.league_id
    where m.week_number = p_week_number - 1 and m.status = 'relegated'
  loop
    select exists(
      select 1 from ladder_bids
      where bidder_user_id = v_row.user_id
        and target_league_id = v_row.league_id
        and week_number = p_week_number
        and status = 'won'
    ) into v_already_won;

    if v_already_won then
      continue; -- bought their way back into their own league — settled above
    end if;

    select exists(
      select 1 from ladder_memberships where user_id = v_row.user_id and week_number = p_week_number + 1
    ) into v_already_seated;

    if v_already_seated then
      continue;
    end if;

    v_below_league_id := _ensure_ladder_league_internal(v_row.tier + 1);
    select tier into v_below_tier from ladder_leagues where id = v_below_league_id;
    v_fee := _ladder_entry_fee_for_tier(v_below_tier);

    insert into ladder_memberships (user_id, league_id, week_number, status)
    values (v_row.user_id, v_below_league_id, p_week_number + 1, 'active')
    on conflict (user_id, week_number) do nothing;

    if v_fee <= 0 then
      continue; -- free entry (League 8 or an overflow tier reusing its rate)
    end if;

    perform _nets_debit_internal(
      v_row.user_id, v_fee, 'ladder_entry_fee', null, 'ladder_week', (p_week_number + 1)::text
    );
    perform _ladder_pool_credit(
      v_fee, 'ladder_entry_fee', v_row.user_id, 'ladder_week', (p_week_number + 1)::text
    );

    insert into ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned)
    values (v_row.user_id, p_week_number + 1, v_below_league_id, 'entry', v_fee, true);
  end loop;
end;
$$;
