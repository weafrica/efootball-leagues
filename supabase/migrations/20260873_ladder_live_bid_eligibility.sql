-- League Ladder redesign — Phase D: live bid eligibility.
--
-- Under Phase C (20260871), a league's auction leader can change mid-week,
-- any time a new bid dethrones the old one. Eligibility has to keep up:
-- the old end-of-week-snapshot pool (last week's status='relegated' rows +
-- this week's already-settled active roster) can no longer be trusted at
-- the moment a bid is placed mid-week — standings are still live.
--
-- 12. _ladder_bid_eligible_pool_internal now computes both halves of the
--     pool from a LIVE standings query (this week, in progress), not a
--     snapshot: introduces _ladder_live_standings_internal, the same
--     played/pts/gd/gf/user_id ranking 20260859/20260870 already use for
--     promotion/relegation, factored out here so both the eligibility
--     pool and the new re-eligibility check (15, below) share one query
--     instead of drifting apart.
-- 13. The live rank-1 of the league below is excluded from the pool —
--     they're on track for free auto-promotion this week, no need to bid
--     for the spot above them.
-- 14. The 2 players currently sitting in relegation position (bottom of
--     their OWN league's live standings) are restricted to bidding only
--     on their own current league (buy-back) — they no longer appear in
--     the "active in league below" half of the pool for the league above
--     them. This was implicit under the old snapshot model (a relegated
--     player's own-league buy-back pool and the league-below's "active"
--     pool for the league above never overlapped, because relegation had
--     already happened by the time the snapshot was read); it has to be
--     enforced explicitly now that both checks run against the same
--     in-progress week.
--
-- placeLadderBid / ladderBidEligiblePool (leagueLadder.js) are unchanged —
-- both are pure functions that only ever consumed whatever pool array
-- they were handed; which live query built that array is entirely a
-- server-side concern.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_live_standings_internal — this week's standings for one league,
-- computed straight from ladder_fixtures, live and in progress. Same
-- tie-break order as 20260859/20260870's inline standings query
-- (played-status-first, pts desc, gd desc, gf desc, user_id asc) — pulled
-- out into its own function here since Phase D needs the exact same query
-- in two places (the eligibility pool below, and the fixture-result
-- re-eligibility check). Returns an empty array, not null, for a league
-- with no fixtures yet this week.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_live_standings_internal(p_league_id uuid, p_week_number integer)
returns uuid[]
language sql
stable
as $$
  select coalesce(
    array_agg(s.user_id order by (s.played > 0) desc, s.pts desc, s.gd desc, s.gf desc, s.user_id asc),
    array[]::uuid[]
  )
  from (
    select m.user_id,
           sum(m.pts) as pts,
           sum(m.played) as played,
           sum(m.gf) as gf,
           sum(m.gf) - sum(m.ga) as gd
    from (
      select home_user_id as user_id,
             case when status = 'played' and home_score > away_score then 3
                  when status = 'played' and home_score = away_score then 1
                  else 0 end as pts,
             case when status in ('played', 'forfeited') then 1 else 0 end as played,
             case when status = 'played' then home_score else 0 end as gf,
             case when status = 'played' then away_score when status = 'forfeited' then 4 else 0 end as ga
      from ladder_fixtures
      where league_id = p_league_id and week_number = p_week_number
      union all
      select away_user_id,
             case when status = 'played' and away_score > home_score then 3
                  when status = 'played' and away_score = home_score then 1
                  else 0 end,
             case when status in ('played', 'forfeited') then 1 else 0 end,
             case when status = 'played' then away_score else 0 end,
             case when status = 'played' then home_score when status = 'forfeited' then 4 else 0 end
      from ladder_fixtures
      where league_id = p_league_id and week_number = p_week_number
    ) m
    group by m.user_id
  ) s;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_bid_eligible_pool_internal — live version. Pool for one target
-- league's auction spot, this week, right now:
--
--   - the live rank-2..N of the league directly below (rank 1 excluded —
--     they're on track for free auto-promotion), MINUS whichever of those
--     are themselves in their own league's bottom-2 relegation position
--     (restricted to their own league's buy-back only, per 14 above)
--   - the live bottom 2 of the TARGET league's own standings (buy-back
--     candidates for their own current league)
--
-- A league with fewer than 2 players in live standings degrades the same
-- way the old snapshot version and the promotion/relegation resolver both
-- do: whatever's actually there (0, 1, or 2 players) is used as-is, no
-- padding, no crash.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_bid_eligible_pool_internal(p_target_league_id uuid, p_week_number integer)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_tier integer;
  v_below_league_id uuid;
  v_below_standings uuid[];
  v_below_n integer;
  v_below_relegation uuid[];
  v_below_pool uuid[];
  v_own_standings uuid[];
  v_own_n integer;
  v_own_relegation uuid[];
  v_pool uuid[];
begin
  select tier into v_target_tier from ladder_leagues where id = p_target_league_id;
  if v_target_tier is null then
    return array[]::uuid[];
  end if;

  select id into v_below_league_id from ladder_leagues where tier = v_target_tier + 1;

  v_below_pool := array[]::uuid[];
  if v_below_league_id is not null then
    v_below_standings := _ladder_live_standings_internal(v_below_league_id, p_week_number);
    v_below_n := coalesce(array_length(v_below_standings, 1), 0);

    if v_below_n >= 2 then
      v_below_relegation := v_below_standings[(v_below_n - least(2, v_below_n) + 1) : v_below_n];
      select coalesce(array_agg(u), array[]::uuid[]) into v_below_pool
      from unnest(v_below_standings[2 : v_below_n]) u
      where not (u = any(v_below_relegation));
    end if;
    -- v_below_n <= 1: only rank 1 (or nobody) — nothing left once rank 1
    -- is excluded, v_below_pool stays empty.
  end if;

  v_own_standings := _ladder_live_standings_internal(p_target_league_id, p_week_number);
  v_own_n := coalesce(array_length(v_own_standings, 1), 0);
  if v_own_n > 0 then
    v_own_relegation := v_own_standings[(v_own_n - least(2, v_own_n) + 1) : v_own_n];
  else
    v_own_relegation := array[]::uuid[];
  end if;

  select coalesce(array_agg(distinct u), array[]::uuid[]) into v_pool
  from unnest(v_below_pool || v_own_relegation) u;

  return v_pool;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_recheck_bid_eligibility_on_result_internal — step 15. Called
-- whenever a fixture result is recorded in p_affected_league_id (played or
-- forfeited): if that changes who's live rank 1 there, and the league ONE
-- TIER ABOVE (the one whose "league below" pool draws from
-- p_affected_league_id) currently has a pending bid leader who is that
-- new rank 1, they're now on track for free auto-promotion — void their
-- bid and refund them immediately (same refund shape place_ladder_bid's
-- own dethrone path already uses).
--
-- Under Phase C at most one 'pending' bid can exist per league/week, so
-- there's never a second-place pending bid sitting behind the voided one
-- to explicitly "promote" — the next place_ladder_bid call (or Sunday's
-- _ladder_settle_bids_internal) already finds the new max('pending')
-- correctly with nothing left in the way. Idempotent: re-running this for
-- the same league/week after the leader's already been voided just finds
-- no matching pending leader and returns.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_recheck_bid_eligibility_on_result_internal(
  p_affected_league_id uuid,
  p_week_number integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_affected_tier integer;
  v_target_league_id uuid;
  v_leader ladder_bids%rowtype;
  v_live_standings uuid[];
  v_rank1 uuid;
begin
  select tier into v_affected_tier from ladder_leagues where id = p_affected_league_id;
  if v_affected_tier is null then
    return;
  end if;

  select id into v_target_league_id from ladder_leagues where tier = v_affected_tier - 1;
  if v_target_league_id is null then
    return; -- tier 1 (or the affected league's tier no longer exists) — nothing above it to hold a bid
  end if;

  select * into v_leader from ladder_bids
  where target_league_id = v_target_league_id and week_number = p_week_number and status = 'pending'
  order by amount desc, placed_at asc
  limit 1
  for update;

  if v_leader.id is null then
    return; -- no live bid leader on the league above — nothing to recheck
  end if;

  v_live_standings := _ladder_live_standings_internal(p_affected_league_id, p_week_number);
  if coalesce(array_length(v_live_standings, 1), 0) = 0 then
    return;
  end if;
  v_rank1 := v_live_standings[1];

  if v_leader.bidder_user_id = v_rank1 then
    -- The current leader has newly become this league's live rank 1 —
    -- they're on track for free auto-promotion, so void and refund their
    -- bid in full, same shape as place_ladder_bid's own dethrone path.
    update ladder_bids set status = 'refunded' where id = v_leader.id;
    perform _nets_credit_internal(
      v_leader.bidder_user_id, v_leader.amount, 'ladder_bid_refund', null, 'ladder_bid', v_leader.id::text
    );
    perform _ladder_pool_debit(
      v_leader.amount, 'ladder_bid_refund', v_leader.bidder_user_id, 'ladder_bid', v_leader.id::text
    );
  end if;
end;
$$;

-- Deliberately no grant on any function above — internal only, same
-- convention as every other _*_internal function in this file.

-- ─────────────────────────────────────────────────────────────────────────
-- Hook the recheck into every place a fixture result gets recorded:
-- normal participant submission, the hourly forfeit sweep, and the admin
-- override. All three re-create their prior definition in full (this
-- migration's diff is scoped to the one new `perform` call added to each)
-- so `\df+` / a fresh read of this file shows the complete, current body
-- rather than a partial patch.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function submit_ladder_fixture_result(
  p_fixture_id uuid,
  p_home_score integer,
  p_away_score integer
) returns ladder_fixtures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_fixture ladder_fixtures%rowtype;
  v_locked boolean;
begin
  if v_user_id is null then
    raise exception 'submit_ladder_fixture_result: must be signed in';
  end if;
  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'submit_ladder_fixture_result: scores must be non-negative';
  end if;

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'submit_ladder_fixture_result: fixture not found';
  end if;
  if v_fixture.status <> 'pending' then
    raise exception 'submit_ladder_fixture_result: fixture is not pending';
  end if;

  v_is_admin := exists (select 1 from admins a where a.user_id = v_user_id);

  if not v_is_admin and v_user_id <> v_fixture.home_user_id and v_user_id <> v_fixture.away_user_id then
    raise exception 'submit_ladder_fixture_result: not a participant in this fixture';
  end if;

  -- Admins can still record a result after the Sunday 10PM lock (a late
  -- correction, a dispute resolved after the fact); participants cannot.
  select fixtures_locked into v_locked from ladder_cycle where id = true;
  if v_locked and not v_is_admin then
    raise exception 'submit_ladder_fixture_result: fixtures are locked for this week';
  end if;

  update ladder_fixtures
  set home_score = p_home_score, away_score = p_away_score, status = 'played', played_at = now()
  where id = p_fixture_id
  returning * into v_fixture;

  perform _ladder_recheck_bid_eligibility_on_result_internal(v_fixture.league_id, v_fixture.week_number);

  return v_fixture;
end;
$$;

grant execute on function submit_ladder_fixture_result(uuid, integer, integer) to authenticated;

create or replace function admin_override_ladder_fixture_result(
  p_fixture_id uuid,
  p_home_score integer,
  p_away_score integer
) returns ladder_fixtures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_fixture ladder_fixtures%rowtype;
  v_was_played boolean;
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'admin_override_ladder_fixture_result: admin only';
  end if;
  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'admin_override_ladder_fixture_result: scores must be non-negative';
  end if;

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'admin_override_ladder_fixture_result: fixture not found';
  end if;

  v_was_played := (v_fixture.status = 'played');

  update ladder_fixtures
  set home_score = p_home_score, away_score = p_away_score, status = 'played',
      played_at = coalesce(played_at, now())
  where id = p_fixture_id
  returning * into v_fixture;

  if not v_was_played then
    perform _credit_ladder_match_reward_internal(v_fixture.id);
  end if;

  perform _ladder_recheck_bid_eligibility_on_result_internal(v_fixture.league_id, v_fixture.week_number);

  return v_fixture;
end;
$$;

grant execute on function admin_override_ladder_fixture_result(uuid, integer, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_forfeit_expired_fixtures_internal — the hourly sweep can forfeit
-- several fixtures across several leagues in one pass, so it reruns the
-- recheck per DISTINCT (league_id, week_number) affected this pass rather
-- than once overall. Return value (count of rows forfeited) is unchanged.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_forfeit_expired_fixtures_internal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_affected record;
begin
  create temporary table if not exists _ladder_forfeit_affected (
    league_id uuid, week_number integer
  ) on commit drop;
  delete from _ladder_forfeit_affected;

  with forfeited as (
    update ladder_fixtures
    set status = 'forfeited', home_score = null, away_score = null, played_at = now()
    where status = 'pending'
      and countdown_expires_at is not null
      and countdown_expires_at < now()
    returning league_id, week_number
  )
  insert into _ladder_forfeit_affected (league_id, week_number)
  select league_id, week_number from forfeited;

  get diagnostics v_count = row_count;

  for v_affected in select distinct league_id, week_number from _ladder_forfeit_affected loop
    perform _ladder_recheck_bid_eligibility_on_result_internal(v_affected.league_id, v_affected.week_number);
  end loop;

  return v_count;
end;
$$;

-- Deliberately no grant — internal only, reachable solely from the
-- scheduled sweep (unchanged from 20260862).
