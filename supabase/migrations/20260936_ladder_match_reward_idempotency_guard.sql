-- _credit_ladder_match_reward_internal moves real money (wallet credits
-- for both players, matching debits from the shared ladder_pool) on every
-- call, with no check of whether that fixture has already been paid. The
-- only existing protection is `ladder_reward_ledger`'s
-- `on conflict (fixture_id, user_id) do nothing` — which stops a second
-- LEDGER row, but does nothing to stop the wallet credits and pool debits
-- above it from running again. A second call for the same fixture (a
-- retry, a race, a future call site that forgets the status-guard every
-- current one relies on) silently double-pays both players while the
-- ledger looks completely normal — see
-- supabase/tests/database/credit_ladder_match_reward.test.sql, which
-- demonstrates this concretely: after a duplicate call, wallet balances
-- come out exactly double, while the ledger still shows one row per
-- participant.
--
-- Fix: guard the function itself on the ledger, instead of trusting every
-- one of its (currently 6, likely more later) call sites to never invoke
-- it twice. This makes the ledger the actual source of truth it already
-- looked like it was.
--
-- Safe to run more than once.

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

  -- Idempotency guard: this fixture has already been paid out if a ledger
  -- row for it already exists. Return quietly instead of re-crediting —
  -- this is the one place that actually needs to know "has this fixture
  -- been paid," so it shouldn't depend on every caller getting that right.
  if exists (select 1 from ladder_reward_ledger where fixture_id = p_fixture_id) then
    return;
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
  perform _ladder_pool_reward_debit(
    v_reward, 'ladder_match_reward', v_fixture.home_user_id, 'ladder_fixture', v_fixture.id::text
  );
  perform _ladder_pool_reward_debit(
    v_reward, 'ladder_match_reward', v_fixture.away_user_id, 'ladder_fixture', v_fixture.id::text
  );

  -- Early Bonus — first-leg fixtures only (leg = 1: rounds 1..roundsSingle
  -- of the double round-robin). Paid to both participants, same as the
  -- Match Reward it rides on top of; not ledgered (see 20260877/878's
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
      perform _ladder_pool_reward_debit(
        v_early_bonus, 'ladder_early_bonus', v_fixture.home_user_id, 'ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_reward_debit(
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
      perform _ladder_pool_reward_debit(
        v_bonus, 'ladder_streak_bonus', v_winner, 'ladder_fixture', v_fixture.id::text
      );
    end if;
  end if;
end;
$$;
