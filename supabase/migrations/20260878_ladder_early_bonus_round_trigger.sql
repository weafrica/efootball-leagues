-- League Ladder redesign — Early Bonus trigger (finishes the item Phase A
-- priced but never wired up: see 20260869's header, "still waiting on
-- Phase 6's countdown-based 'completed early' check to land").
--
-- Decided trigger: ROUND-BASED, not countdown-based. A fixture earns its
-- league's Early Bonus (on top of the normal Match Reward) when it falls
-- in the FIRST LEG of the double round-robin — rounds 1 through
-- roundsSingle (n-1) of the roundsTotal (2*(n-1)) schedule. For the
-- normal 6-player league that's rounds 1-5 of 10. Expressed as leg = 1
-- rather than a hardcoded "round <= 5" so it stays correct for a
-- thinner-than-6 or bye-padded league, where roundsSingle isn't 5.
--
-- ladder_fixtures never persisted a round number at all — Phase 6's
-- countdown work and 20260876's double-round-robin rewrite both computed
-- round position only transiently, to pick a release offset, then threw
-- it away (see leagueLadder.js's own header: "the round index below is
-- only ever used to pick a release offset, never persisted"). Round-based
-- Early Bonus needs that position to survive to credit time, so this
-- migration finally persists it, as `leg` (1 or 2) — enough to answer
-- "first half or second half", which is all the trigger needs. Written
-- once at fixture-generation time and never touched again: 20260876's
-- resync-on-every-join only deletes/rebuilds 'pending' rows, so a
-- fixture's leg is fixed the moment it's played, no matter how many more
-- times the roster (and therefore roundsSingle) changes around it
-- afterward.
--
-- Three pieces:
--   1. ladder_fixtures.leg (smallint, 1|2) — new column.
--   2. _generate_round_robin_fixtures_internal — now stamps leg on every
--      inserted row (v_leg2 ? 2 : 1). Everything else about the function
--      is unchanged from 20260876.
--   3. _credit_ladder_match_reward_internal — credits
--      _ladder_early_bonus_for_tier(tier) on top of the normal Match
--      Reward when the fixture's leg = 1. Not written to
--      ladder_reward_ledger — per 20260877's header, that ledger is
--      scoped specifically to the flat Match Reward the d formula prices;
--      Early Bonus (like Streak Bonus) stays outside it, unchanged.
--
-- RIDE-ALONG FIX: while rewriting _credit_ladder_match_reward_internal to
-- add the Early Bonus branch, restore the call to it from
-- submit_ladder_fixture_result. 20260860 originally wired
-- `perform _credit_ladder_match_reward_internal(v_fixture.id);` into that
-- RPC; 20260873's CREATE OR REPLACE (Phase D, live bid eligibility) redid
-- the whole function body to add the eligibility recheck call and, in the
-- process, silently dropped that line — nothing in 20260873's header
-- says rewards were meant to move elsewhere. Net effect since 20260873:
-- a player submitting their own result via submit_ladder_fixture_result
-- (the normal path) has been getting scored (standings) but never PAID —
-- no Match Reward, no Streak Bonus, no reward-ledger row — while
-- admin_override_ladder_fixture_result (the admin correction path) kept
-- crediting correctly the whole time, since its own call site was never
-- touched. This migration restores the call, in the same place 20260860
-- had it. ladder_reward_ledger's unique (fixture_id, user_id) constraint
-- means any fixture an admin already corrected-and-credited under the
-- gap won't be double-paid if it's somehow re-submitted.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- leg — 1 = first leg (rounds 1..roundsSingle), 2 = return leg
-- (roundsSingle+1..roundsTotal). Backfilled to 1 for any pre-existing row
-- (harmless either way: every row that's already 'played'/'forfeited' was
-- already credited without an Early Bonus, back when the bonus didn't
-- exist — this backfill doesn't retroactively pay anything, it just gives
-- old rows a defined value instead of null).
-- ─────────────────────────────────────────────────────────────────────────
alter table ladder_fixtures add column if not exists leg smallint check (leg in (1, 2));
update ladder_fixtures set leg = 1 where leg is null;
alter table ladder_fixtures alter column leg set not null;
alter table ladder_fixtures alter column leg set default 1;

-- ─────────────────────────────────────────────────────────────────────────
-- _generate_round_robin_fixtures_internal — identical to 20260876's
-- version, plus stamping `leg` on every inserted row.
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

  delete from ladder_fixtures
  where league_id = p_league_id and week_number = p_week_number and status = 'pending';

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid; -- bye slot, same as the JS version
  end if;
  v_n := array_length(v_ids, 1);
  v_rounds_single := v_n - 1;
  v_rounds_total := 2 * v_rounds_single; -- double round robin: home leg + away leg

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
          insert into ladder_fixtures
            (league_id, week_number, home_user_id, away_user_id, status, countdown_expires_at, leg)
          values
            (p_league_id, p_week_number, v_home, v_away, 'pending', v_countdown, case when v_leg2 then 2 else 1 end);
          v_inserted := v_inserted + 1;
        end if;
      end if;
    end loop;

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
-- _credit_ladder_match_reward_internal — same Match Reward + ledger +
-- streak-bonus body as 20260877's version, plus: Early Bonus credited on
-- top of the Match Reward whenever the fixture's leg = 1 (first half of
-- the schedule). Deliberately checked from the fixture row itself, not
-- recomputed from week/roster state — leg was fixed at generation time,
-- so this stays correct even if the roster (and therefore what "half of
-- the schedule" means) has since changed.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _credit_ladder_match_reward_internal(p_fixture_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture ladder_fixtures%rowtype;
  v_tier integer;
  v_max_tier integer;
  v_reward bigint;
  v_early_bonus bigint;
  v_winner uuid;
  v_loser uuid;
  v_is_draw boolean;
  v_new_streak integer;
  v_bonus bigint;
begin
  select * into v_fixture from ladder_fixtures where id = p_fixture_id;
  if v_fixture.id is null then
    raise exception '_credit_ladder_match_reward_internal: fixture not found';
  end if;

  select tier into v_tier from ladder_leagues where id = v_fixture.league_id;
  v_max_tier := _ladder_current_max_tier_internal();
  v_reward := _ladder_match_reward_for_tier(v_tier);

  perform _nets_credit_internal(
    v_fixture.home_user_id, v_reward, 'ladder_match_reward', null, 'ladder_fixture', v_fixture.id::text
  );
  perform _nets_credit_internal(
    v_fixture.away_user_id, v_reward, 'ladder_match_reward', null, 'ladder_fixture', v_fixture.id::text
  );
  perform _ladder_pool_debit(
    v_reward, 'ladder_match_reward', v_fixture.home_user_id, 'ladder_fixture', v_fixture.id::text
  );
  perform _ladder_pool_debit(
    v_reward, 'ladder_match_reward', v_fixture.away_user_id, 'ladder_fixture', v_fixture.id::text
  );

  -- Early Bonus — first-leg fixtures only (leg = 1: rounds 1..roundsSingle
  -- of the double round-robin). Paid to both participants, same as the
  -- Match Reward it rides on top of; not ledgered (see this migration's
  -- header).
  if v_fixture.leg = 1 then
    v_early_bonus := _ladder_early_bonus_for_tier(v_tier);
    if v_early_bonus > 0 then
      perform _nets_credit_internal(
        v_fixture.home_user_id, v_early_bonus, 'ladder_early_bonus', null, 'ladder_fixture', v_fixture.id::text
      );
      perform _nets_credit_internal(
        v_fixture.away_user_id, v_early_bonus, 'ladder_early_bonus', null, 'ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_debit(
        v_early_bonus, 'ladder_early_bonus', v_fixture.home_user_id, 'ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_debit(
        v_early_bonus, 'ladder_early_bonus', v_fixture.away_user_id, 'ladder_fixture', v_fixture.id::text
      );
    end if;
  end if;

  insert into ladder_reward_ledger
    (fixture_id, user_id, league_id, week_number, tier, max_tier_at_credit, paid_at_d, reward_amount)
  values
    (v_fixture.id, v_fixture.home_user_id, v_fixture.league_id, v_fixture.week_number, v_tier, v_max_tier, v_max_tier - v_tier, v_reward),
    (v_fixture.id, v_fixture.away_user_id, v_fixture.league_id, v_fixture.week_number, v_tier, v_max_tier, v_max_tier - v_tier, v_reward)
  on conflict (fixture_id, user_id) do nothing;

  if v_fixture.home_score = v_fixture.away_score then
    v_is_draw := true;
  else
    v_is_draw := false;
    if v_fixture.home_score > v_fixture.away_score then
      v_winner := v_fixture.home_user_id; v_loser := v_fixture.away_user_id;
    else
      v_winner := v_fixture.away_user_id; v_loser := v_fixture.home_user_id;
    end if;
  end if;

  if v_is_draw then
    update ladder_memberships set win_streak = 0
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id in (v_fixture.home_user_id, v_fixture.away_user_id);
  else
    update ladder_memberships set win_streak = 0
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id = v_loser;

    update ladder_memberships set win_streak = win_streak + 1
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id = v_winner
    returning win_streak into v_new_streak;

    v_bonus := _ladder_streak_bonus_for_tier(v_tier, v_new_streak);
    if v_bonus > 0 then
      perform _nets_credit_internal(
        v_winner, v_bonus, 'ladder_streak_bonus', null, 'ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_debit(
        v_bonus, 'ladder_streak_bonus', v_winner, 'ladder_fixture', v_fixture.id::text
      );
    end if;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- submit_ladder_fixture_result — ride-along fix (see this migration's
-- header): restores the _credit_ladder_match_reward_internal call that
-- 20260873 silently dropped. Everything else identical to 20260873's
-- version.
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

  select fixtures_locked into v_locked from ladder_cycle where id = true;
  if v_locked and not v_is_admin then
    raise exception 'submit_ladder_fixture_result: fixtures are locked for this week';
  end if;

  update ladder_fixtures
  set home_score = p_home_score, away_score = p_away_score, status = 'played', played_at = now()
  where id = p_fixture_id
  returning * into v_fixture;

  perform _credit_ladder_match_reward_internal(v_fixture.id);
  perform _ladder_recheck_bid_eligibility_on_result_internal(v_fixture.league_id, v_fixture.week_number);

  return v_fixture;
end;
$$;

grant execute on function submit_ladder_fixture_result(uuid, integer, integer) to authenticated;
