-- League Ladder -- item 9 (minor bid edge case), option (a).
--
-- The bottom-most league (currently Tier 12) has entry fee 0 by design --
-- joining it normally via join_ladder_league() is free, no debit at all.
-- But place_ladder_bid required every bid amount to be strictly positive,
-- and a winning bid's escrow is never refunded (by design -- the winner's
-- bid money stays spent). So a relegation-zone player "buying back" their
-- own spot in that same free league via a bid -- rather than just staying
-- as a normal reseated stayer -- would have been forced to pay at least
-- 1 Net for something that's supposed to cost nothing. Confirmed live:
-- this has never actually happened (zero bid history for the current
-- bottom league), but the inconsistency is real.
--
-- Fix: relax the top-level amount check from "must be positive" to "must
-- not be negative". No other logic needs to change -- the existing
-- floor/leader-beat checks already do the right thing with this alone:
--   - No leader yet: the floor check (`p_amount < v_entry_fee`) already
--     allows amount = 0 exactly when entry_fee = 0, and still rejects 0
--     for every paid league (entry_fee > 0) with the same floor message
--     as before.
--   - A leader already exists: beating them still requires strictly
--     exceeding their amount, so a second 0-amount bid can never dethrone
--     a first 0-amount bid -- someone has to actually offer > 0 to take
--     the lead once someone's holding it, even in a free league.
--
-- The only other change: every place that moves wallet/pool money now
-- skips the call when the amount involved is 0, since _nets_debit_internal,
-- _nets_credit_internal, _ladder_pool_credit, and _ladder_pool_debit all
-- themselves reject non-positive amounts. Same "amount <= 0 -> skip the
-- money movement" pattern _ladder_fall_through_internal already uses for
-- free-tier entry.
--
-- Verified live (see league-ladder-fix-plan-status.md item 9 for the full
-- test log): negative amounts still rejected everywhere; a 0 bid on a
-- paid league (Tier 5, fee 10) still correctly hits the floor; a 0 bid on
-- the free league (Tier 12) now clears the amount check.
--
-- Safe to run more than once.

create or replace function place_ladder_bid(p_target_league_id uuid, p_amount bigint)
returns ladder_bids
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_week integer;
  v_bidding_open boolean;
  v_target_tier integer;
  v_entry_fee bigint;
  v_eligible uuid[];
  v_existing ladder_bids%rowtype;
  v_leader ladder_bids%rowtype;
  v_bid ladder_bids%rowtype;
begin
  if v_user_id is null then
    raise exception 'place_ladder_bid: must be signed in';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'place_ladder_bid: amount must not be negative';
  end if;

  select current_week, bidding_open into v_week, v_bidding_open from ladder_cycle where id = true;
  if not v_bidding_open then
    raise exception 'place_ladder_bid: bidding is not open right now';
  end if;

  select tier into v_target_tier from ladder_leagues where id = p_target_league_id;
  if v_target_tier is null then
    raise exception 'place_ladder_bid: target league not found';
  end if;

  v_eligible := _ladder_bid_eligible_pool_internal(p_target_league_id, v_week);
  if not (v_user_id = any(v_eligible)) then
    raise exception 'place_ladder_bid: not eligible to bid for this league this week';
  end if;

  -- Lock this league's current leading bid FIRST, before comparing or
  -- writing anything -- same for-update-before-compare pattern the
  -- self-raise case below already used on a bidder's own row. This is
  -- what makes two near-simultaneous bids safe: whichever transaction
  -- gets the lock first sees (and dethrones) the true current leader; the
  -- other blocks until the first commits, then re-reads the now-updated
  -- leader.
  select * into v_leader from ladder_bids
  where target_league_id = p_target_league_id and week_number = v_week and status = 'pending'
  order by amount desc, placed_at asc
  limit 1
  for update;

  if v_leader.id is not null then
    -- A leader already exists (possibly this same bidder, raising their
    -- own lead). Beat their bid strictly -- this still holds even when
    -- the leader's amount is 0 (a free league's first buy-back bid):
    -- dethroning it requires actually offering more than 0.
    if p_amount <= v_leader.amount then
      raise exception 'place_ladder_bid: amount % does not beat the current leading bid of %', p_amount, v_leader.amount;
    end if;
  else
    -- No leader yet (first bid on this league this week, or every prior
    -- bid here has already been outbid) -- the live Entry Fee floor
    -- applies, same as the old sealed-bid model. When the floor is 0
    -- (this league's normal entry is free), amount = 0 now clears it.
    v_entry_fee := _ladder_entry_fee_for_tier(v_target_tier);
    if p_amount < v_entry_fee then
      raise exception 'place_ladder_bid: amount % is below this league''s % bid floor', p_amount, v_entry_fee;
    end if;
  end if;

  select * into v_existing from ladder_bids
  where bidder_user_id = v_user_id and target_league_id = p_target_league_id and week_number = v_week
  for update;

  if v_existing.id is not null and v_existing.status = 'won' then
    raise exception 'place_ladder_bid: this bid has already been settled';
  end if;

  if v_existing.id is not null and v_existing.status = 'pending' then
    -- Self-raise: this bidder is already the leader. Refund the old hold
    -- before taking the new one -- skipped entirely when the old hold was
    -- 0 (a free league's first bid), since there's nothing to refund and
    -- the wallet/pool helpers reject a 0-amount call outright.
    if v_existing.amount > 0 then
      perform _nets_credit_internal(
        v_user_id, v_existing.amount, 'ladder_bid_raise_refund', null, 'ladder_bid', v_existing.id::text
      );
      perform _ladder_pool_debit(
        v_existing.amount, 'ladder_bid_raise_refund', v_user_id, 'ladder_bid', v_existing.id::text
      );
    end if;
  elsif v_leader.id is not null and v_leader.bidder_user_id <> v_user_id then
    -- Dethroning a different bidder's leading bid -- refund them in full
    -- and flip their row to 'refunded' immediately. Skipped when their
    -- held amount was 0 for the same reason as the self-raise case above.
    update ladder_bids set status = 'refunded' where id = v_leader.id;
    if v_leader.amount > 0 then
      perform _nets_credit_internal(
        v_leader.bidder_user_id, v_leader.amount, 'ladder_bid_refund', null, 'ladder_bid', v_leader.id::text
      );
      perform _ladder_pool_debit(
        v_leader.amount, 'ladder_bid_refund', v_leader.bidder_user_id, 'ladder_bid', v_leader.id::text
      );
    end if;
  end if;
  -- (else: v_existing.id is null or already 'refunded' from an earlier
  -- dethroning -- this bidder holds no live escrow to refund before
  -- placing their new bid.)

  insert into ladder_bids (bidder_user_id, target_league_id, week_number, amount, status)
  values (v_user_id, p_target_league_id, v_week, p_amount, 'pending')
  on conflict (bidder_user_id, target_league_id, week_number)
  do update set amount = excluded.amount, status = 'pending', placed_at = now()
  returning * into v_bid;

  -- Escrow the new bid -- skipped when the amount is 0 (a free league's
  -- floor), since there's nothing to actually hold and the debit/credit
  -- helpers reject a 0-amount call.
  if p_amount > 0 then
    perform _nets_debit_internal(v_user_id, p_amount, 'ladder_entry_fee', null, 'ladder_bid', v_bid.id::text);
    perform _ladder_pool_credit(p_amount, 'ladder_entry_fee', v_user_id, 'ladder_bid', v_bid.id::text);
  end if;

  return v_bid;
end;
$$;
