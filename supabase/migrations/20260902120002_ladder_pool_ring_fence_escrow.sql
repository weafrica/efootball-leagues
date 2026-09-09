-- League Ladder — ring-fence pending bid escrow from reward payouts.
--
-- ROOT CAUSE: ladder_pool (20260855) is a single global singleton balance
-- shared between two very different kinds of money:
--
--   - Live bid escrow — held against a specific 'pending' ladder_bids row
--     and must always be refundable on demand (self-raise, dethroning,
--     admin cancel — place_ladder_bid / admin_cancel_ladder_bid).
--   - Match Reward / Early Bonus / Streak Bonus / retroactive top-up —
--     permanently paid out, funded only by entry fees, decay penalties,
--     and forfeits.
--
-- Because both draw down the exact same `balance`, an unrelated fixture
-- approval (or streak bonus, or retroactive top-up) on ANY league can
-- debit the pool below what's needed to refund a completely different
-- league's pending bid. Since a bid's refund-then-reescrow happens in one
-- transaction inside place_ladder_bid, that unrelated shortfall then
-- surfaces as a hard failure on a totally different action — either
-- "admin can't approve a result" (reward side hits the shortfall first)
-- or "raising my bid errors out" (escrow side hits it first), depending
-- on which happened to run last. Same bug, two symptoms.
--
-- FIX: every reward-type debit now goes through a new wrapper,
-- _ladder_pool_reward_debit, that refuses to let the pool balance drop
-- below the sum of every currently-'pending' ladder_bids row — i.e. money
-- that is live escrow and must remain fully refundable at all times. If a
-- reward payout would eat into that reserve, it fails with a clear
-- "pool needs topping up" error instead of silently endangering a bid
-- refund down the line.
--
-- Escrow refunds themselves (ladder_bid_raise_refund / ladder_bid_refund /
-- ladder_bid_admin_cancel_refund, all in place_ladder_bid /
-- admin_cancel_ladder_bid) keep calling _ladder_pool_debit directly,
-- unguarded — they only ever return money whose matching
-- 'ladder_entry_fee' credit already sits in the balance, so they can
-- never be the cause of a shortfall and must never be blocked by this
-- guard (blocking a refund would defeat the entire point of ring-fencing
-- it).
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_pool_reward_debit — guarded wrapper around _ladder_pool_debit
-- for reward-type payouts only. Locks the pool row, computes the live
-- escrow reserve (sum of every 'pending' ladder_bids.amount), and refuses
-- the debit if it would take balance below that reserve.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_pool_reward_debit(
  p_amount bigint,
  p_reason text,
  p_user_id uuid default null,
  p_ref_type text default null,
  p_ref_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_balance bigint;
  v_escrow_reserve bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception '_ladder_pool_reward_debit: amount must be positive';
  end if;

  select balance into v_current_balance from ladder_pool where id = true for update;

  select coalesce(sum(amount), 0) into v_escrow_reserve
  from ladder_bids
  where status = 'pending';

  if v_current_balance - p_amount < v_escrow_reserve then
    raise exception '_ladder_pool_reward_debit: % (%) would drop the pool to % - % = %, below its live bid escrow reserve of % — pool needs topping up',
      p_reason, p_amount, v_current_balance, p_amount, v_current_balance - p_amount, v_escrow_reserve;
  end if;

  return _ladder_pool_debit(p_amount, p_reason, p_user_id, p_ref_type, p_ref_id);
end;
$$;

-- Deliberately no grant — same no-direct-grant convention as
-- _ladder_pool_debit/_credit: reachable only from inside another
-- SECURITY DEFINER function.

-- ─────────────────────────────────────────────────────────────────────────
-- _credit_ladder_match_reward_internal — identical body to 20260878's
-- version (Match Reward + Early Bonus + ledger + streak bonus), with every
-- _ladder_pool_debit(...) call for a reward reason switched to
-- _ladder_pool_reward_debit(...). Nothing else changes.
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

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_retroactive_topup_internal — identical to 20260877's version,
-- with its one reward-reason debit switched to _ladder_pool_reward_debit.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_retroactive_topup_internal(p_week_number integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_tier integer;
  v_row record;
  v_new_d integer;
  v_new_reward bigint;
  v_delta bigint;
  v_topped_up integer := 0;
begin
  v_max_tier := _ladder_current_max_tier_internal();

  for v_row in
    select rl.id, rl.fixture_id, rl.user_id, rl.tier, rl.paid_at_d, rl.reward_amount
    from ladder_reward_ledger rl
    join ladder_leagues ll on ll.id = rl.league_id
    where rl.week_number = p_week_number
      and ll.status = 'active'
    for update of rl
  loop
    v_new_d := v_max_tier - v_row.tier;
    if v_new_d > v_row.paid_at_d then
      v_new_reward := _ladder_match_reward_for_tier(v_row.tier);
      v_delta := v_new_reward - v_row.reward_amount;
      if v_delta > 0 then
        perform _nets_credit_internal(
          v_row.user_id, v_delta, 'ladder_match_reward_topup', null, 'ladder_fixture', v_row.fixture_id::text
        );
        perform _ladder_pool_reward_debit(
          v_delta, 'ladder_match_reward_topup', v_row.user_id, 'ladder_fixture', v_row.fixture_id::text
        );

        update ladder_reward_ledger
        set max_tier_at_credit = v_max_tier, paid_at_d = v_new_d, reward_amount = v_new_reward, updated_at = now()
        where id = v_row.id;

        v_topped_up := v_topped_up + 1;
      end if;
    end if;
  end loop;

  return v_topped_up;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- One-off correction: the pool is very likely ALREADY below the live
-- escrow reserve right now (that's the reported symptom — admin approval
-- failing on a league created yesterday, with a different league's bid
-- activity as the only other pool traffic since). Top it up to exactly
-- cover today's reserve so existing pending bids stay refundable and the
-- guard above doesn't immediately trip on the very shortfall it's meant
-- to prevent going forward. This is an internal-ledger correction, not
-- real currency movement — it repairs ladder_pool.balance to reflect what
-- it should always have been kept at, it does not credit any player's
-- nets_wallets.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  v_balance bigint;
  v_escrow_reserve bigint;
  v_shortfall bigint;
begin
  select balance into v_balance from ladder_pool where id = true for update;

  select coalesce(sum(amount), 0) into v_escrow_reserve
  from ladder_bids
  where status = 'pending';

  v_shortfall := v_escrow_reserve - v_balance;

  if v_shortfall > 0 then
    perform _ladder_pool_credit(v_shortfall, 'ladder_pool_topup_correction', null, null, null);
    raise notice 'ladder_pool topped up by % (was %, live escrow reserve is %)', v_shortfall, v_balance, v_escrow_reserve;
  else
    raise notice 'ladder_pool already covers its % live escrow reserve (balance %) — no top-up needed', v_escrow_reserve, v_balance;
  end if;
end $$;
