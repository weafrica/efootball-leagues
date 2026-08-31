-- League Ladder redesign — Phase C: Live open-bid auction, replacing the
-- sealed-bid model from Phase 5 (20260861).
--
-- Under the old model every bid just had to clear the tier's Entry Fee
-- floor and stayed 'pending' until Sunday, when _ladder_settle_bids_internal
-- ranked all of a league's pending bids at once (amount, then points
-- tie-break, then placed_at) and refunded every loser in one pass. Under
-- this phase, the ranking happens live: at most one bid per league/week
-- is ever 'pending' at a time (the current leader) — every bid that gets
-- outbid is refunded and flipped to 'refunded' immediately, in the same
-- transaction as the bid that dethroned it. By Sunday there's nothing left
-- to rank.
--
-- 9. place_ladder_bid: a new bid must beat the CURRENT LEADING bid for
--    that target league/week, not just clear the tier's live Entry Fee
--    floor. The floor only applies when there's no leader yet (the very
--    first bid on a league this week, or every prior bid there has
--    already been outbid/refunded).
-- 10. On a new leading bid that dethrones a DIFFERENT bidder: that
--    bidder's escrowed amount is credited back and their row flipped to
--    'refunded' immediately, in the same transaction as the new bid's
--    own escrow debit. The league's current leader row is locked with
--    `for update` before anything is compared or written — same
--    lock-before-compare pattern the prior self-raise case already used
--    on a bidder's own row — so two near-simultaneous bids can't both
--    read the same stale leader and both believe they came out on top.
--    Self-raises (the current leader raising their own bid) still work
--    exactly as before: refund the old hold, re-escrow the new amount,
--    same row stays 'pending' throughout.
-- 11. _ladder_settle_bids_internal simplifies to match: since at most one
--    'pending' bid can exist per league/week by the time Sunday arrives
--    (every other bid was already refunded live during the week), it just
--    seats whoever is still 'pending' — no ranking, no tie-break query,
--    no per-league loser-refund loop needed anymore.
--
-- A previously-outbid bidder (their row already 'refunded') is free to
-- bid again later in the week and retake the lead — this is an open
-- auction, not a one-shot sealed bid. The insert...on conflict upsert
-- below now explicitly sets status = 'pending' on every successful bid
-- (not just amount/placed_at) to support exactly that re-entry case; the
-- old upsert never needed to touch status because every bid stayed
-- 'pending' until Sunday.
--
-- SCOPE NOTE: this assumes it's deployed at a week boundary with no
-- outstanding multi-bidder 'pending' rows left over from the old
-- sealed-bid model for an in-flight week (i.e. no league/week has more
-- than one 'pending' bid at deploy time). If that invariant is ever
-- violated, place_ladder_bid still behaves sanely for the bidder calling
-- it (it locks and compares against the single highest 'pending' row),
-- but any OTHER stray 'pending' bids for that league/week won't be
-- refunded until they're specifically dethroned or Sunday settlement
-- seats whichever one is still 'pending' at that point.
--
-- Not touched by this migration: leagueLadder.js's resolveLadderBids, the
-- pure JS ranking function _ladder_settle_bids_internal's OLD body
-- mirrored (see its own header, which references
-- _ladder_bidder_points_internal by name). That function — and the
-- points-tie-break helpers it was built to consume — have no caller left
-- in the SQL after this migration; they're dead code under the new live
-- model, not deleted here since deleting them is a cleanup decision, not
-- part of this phase's ask. Flagging clearly rather than leaving it
-- implicit: resolveLadderBids' own doc comment is now stale (it still
-- describes ranking a league's full set of pending bids at once), same
-- kind of documented SQL/JS divergence Phase B left on resolveLadderWeek.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- place_ladder_bid — same eligibility/sign-in/amount validation as
-- 20260861's version. What's new: the bid floor is now "beat the current
-- leader" once one exists, and dethroning a different bidder refunds them
-- live instead of leaving their row 'pending' for Sunday to sort out.
-- ─────────────────────────────────────────────────────────────────────────
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
  if p_amount is null or p_amount <= 0 then
    raise exception 'place_ladder_bid: amount must be positive';
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
  -- writing anything — same for-update-before-compare pattern the
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
    -- own lead). Beat their bid — the live Entry Fee floor doesn't apply
    -- once there's an existing leader to beat instead.
    if p_amount <= v_leader.amount then
      raise exception 'place_ladder_bid: amount % does not beat the current leading bid of %', p_amount, v_leader.amount;
    end if;
  else
    -- No leader yet (first bid on this league this week, or every prior
    -- bid here has already been outbid) — the live Entry Fee floor
    -- applies, same as the old sealed-bid model.
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
    -- Self-raise: this bidder is already the leader (v_existing.id =
    -- v_leader.id here, by the "at most one pending bid" invariant).
    -- Refund the old hold before taking the new one, same as before.
    perform _nets_credit_internal(
      v_user_id, v_existing.amount, 'ladder_bid_raise_refund', null, 'ladder_bid', v_existing.id::text
    );
    perform _ladder_pool_debit(
      v_existing.amount, 'ladder_bid_raise_refund', v_user_id, 'ladder_bid', v_existing.id::text
    );
  elsif v_leader.id is not null and v_leader.bidder_user_id <> v_user_id then
    -- Dethroning a different bidder's leading bid — refund them in full
    -- and flip their row to 'refunded' immediately, in this same
    -- transaction, instead of leaving it 'pending' for Sunday.
    update ladder_bids set status = 'refunded' where id = v_leader.id;
    perform _nets_credit_internal(
      v_leader.bidder_user_id, v_leader.amount, 'ladder_bid_refund', null, 'ladder_bid', v_leader.id::text
    );
    perform _ladder_pool_debit(
      v_leader.amount, 'ladder_bid_refund', v_leader.bidder_user_id, 'ladder_bid', v_leader.id::text
    );
  end if;
  -- (else: v_existing.id is null or already 'refunded' from an earlier
  -- dethroning — this bidder holds no live escrow to refund before
  -- placing their new bid.)

  insert into ladder_bids (bidder_user_id, target_league_id, week_number, amount, status)
  values (v_user_id, p_target_league_id, v_week, p_amount, 'pending')
  on conflict (bidder_user_id, target_league_id, week_number)
  do update set amount = excluded.amount, status = 'pending', placed_at = now()
  returning * into v_bid;

  -- Escrow the new bid — reason='ladder_entry_fee' since this IS the
  -- entry-fee payment for a winning bid; a bidder who's later dethroned
  -- gets it back in full immediately (above), not at settlement anymore.
  perform _nets_debit_internal(v_user_id, p_amount, 'ladder_entry_fee', null, 'ladder_bid', v_bid.id::text);
  perform _ladder_pool_credit(p_amount, 'ladder_entry_fee', v_user_id, 'ladder_bid', v_bid.id::text);

  return v_bid;
end;
$$;

grant execute on function place_ladder_bid(uuid, bigint) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_settle_bids_internal — simplified for the live model. By the
-- time Sunday's close runs, every bid that was ever outbid has already
-- been refunded and flipped to 'refunded' live (place_ladder_bid, above)
-- — so at most one 'pending' bid can exist per league/week, and it's
-- already the winner. No ranking, no tie-break query, no per-league
-- loser-refund loop needed: just seat whoever is still 'pending'.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_settle_bids_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  for v_row in
    select id, target_league_id, bidder_user_id, amount
    from ladder_bids
    where week_number = p_week_number and status = 'pending'
  loop
    update ladder_bids set status = 'won' where id = v_row.id;

    insert into ladder_memberships (user_id, league_id, week_number, status)
    values (v_row.bidder_user_id, v_row.target_league_id, p_week_number + 1, 'auction_won')
    on conflict (user_id, week_number) do nothing;

    insert into ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned)
    values (v_row.bidder_user_id, p_week_number + 1, v_row.target_league_id, 'entry', v_row.amount, true);
  end loop;
end;
$$;
