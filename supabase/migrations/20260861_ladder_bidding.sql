-- League Ladder — Phase 5: auction / bidding system.
--
-- Adds place_ladder_bid (the client-facing RPC), settlement at Sunday
-- 10PM (same close-week job Phase 3/4 already extended), and the
-- fall-through mechanic that finally closes the roster gap Phase 3's own
-- header flagged: "every standard league will visibly shrink week over
-- week... until Phase 5 lands."
--
-- ─────────────────────────────────────────────────────────────────────────
-- ESCROW DESIGN NOTE — worth flagging since it's a real judgment call the
-- plan's Phase 5 checklist doesn't fully pin down:
--
-- The checklist says settlement should "charge that league's Entry Fee
-- via nets_debit" for the winner and "refund every other bidder in full
-- via nets_credit" for everyone else. Read literally-at-settlement-time,
-- those two don't reconcile: "refund in full" only means something if
-- money was already taken, but if nothing's taken until settlement, the
-- winner would be charged the flat Entry Fee regardless of what they
-- actually bid — which conflicts with §5's Winning Bid Commission ("a %
-- cut of each winning bid"), a feature that only makes sense if the
-- winning BID amount is the real money that moves, not just the fixed
-- floor.
--
-- Resolution: bids are escrowed (debited) at PLACEMENT time, not
-- settlement time — place_ladder_bid debits the bidder's full bid amount
-- immediately, tagged reason='ladder_entry_fee' (so it's already the
-- correctly-labeled charge the checklist describes, nets_debit and all —
-- just timed at bid-time instead of settlement, which is the only timing
-- that makes "refund in full" literally true). At settlement: the winner
-- needs no further wallet movement (their bid is already spent); every
-- losing bidder gets their full escrowed amount credited back. Raising an
-- existing bid refunds the old escrowed amount and re-escrows the new one
-- in the same call, so a bidder is never holding two simultaneous holds
-- on one target league.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_bid_eligible_pool_internal — SQL-side data-gathering for
-- ladderBidEligiblePool (leagueLadder.js): the 2 players just relegated
-- FROM the target league (their status='relegated' row from the week that
-- closed just before p_week_number), plus whoever's currently active in
-- the league directly below the target (this week's roster — the
-- promoted departure, if any, already isn't in that roster for
-- p_week_number, so nothing further needs excluding here).
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
  v_pool uuid[];
begin
  select tier into v_target_tier from ladder_leagues where id = p_target_league_id;
  if v_target_tier is null then
    return array[]::uuid[];
  end if;

  select id into v_below_league_id from ladder_leagues where tier = v_target_tier + 1;

  select array_agg(distinct user_id) into v_pool
  from (
    select user_id from ladder_memberships
    where league_id = p_target_league_id and week_number = p_week_number - 1 and status = 'relegated'
    union
    select user_id from ladder_memberships
    where league_id = v_below_league_id and week_number = p_week_number and status = 'active'
  ) eligible;

  return coalesce(v_pool, array[]::uuid[]);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_player_points_internal / _ladder_bidder_points_internal — the
-- §4 tie-break's data source: a bidder's points tally in whichever league
-- actually determines it. A relegated bidder's tie-break league is the
-- target league itself, at the week they were relegated (p_week_number -
-- 1) — the last standings they actually posted there. A below-league
-- bidder's tie-break league is their current league, this week
-- (p_week_number) — same scoring (win=3/draw=1/loss=0) the standings
-- query in 20260859 already uses, reimplemented per-player here rather
-- than pulling the whole table.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_player_points_internal(p_user_id uuid, p_league_id uuid, p_week_number integer)
returns integer
language sql
stable
as $$
  select coalesce(sum(pts), 0)::integer from (
    select case when status = 'played' and home_score > away_score then 3
                when status = 'played' and home_score = away_score then 1
                else 0 end as pts
    from ladder_fixtures
    where league_id = p_league_id and week_number = p_week_number and home_user_id = p_user_id
    union all
    select case when status = 'played' and away_score > home_score then 3
                when status = 'played' and away_score = home_score then 1
                else 0 end
    from ladder_fixtures
    where league_id = p_league_id and week_number = p_week_number and away_user_id = p_user_id
  ) t;
$$;

create or replace function _ladder_bidder_points_internal(p_user_id uuid, p_target_league_id uuid, p_week_number integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was_relegated boolean;
  v_target_tier integer;
  v_below_league_id uuid;
begin
  select exists(
    select 1 from ladder_memberships
    where user_id = p_user_id and league_id = p_target_league_id
      and week_number = p_week_number - 1 and status = 'relegated'
  ) into v_was_relegated;

  if v_was_relegated then
    return _ladder_player_points_internal(p_user_id, p_target_league_id, p_week_number - 1);
  end if;

  select tier into v_target_tier from ladder_leagues where id = p_target_league_id;
  select id into v_below_league_id from ladder_leagues where tier = v_target_tier + 1;

  return _ladder_player_points_internal(p_user_id, v_below_league_id, p_week_number);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- place_ladder_bid — the client-facing RPC. Re-validates everything
-- placeLadderBid (leagueLadder.js) checks client-side, server-side: bidder
-- eligibility and the Entry Fee bid floor, per the plan's own "reject
-- invalid bids server-side, not just in the UI." Upserts against
-- ladder_bids' unique(bidder_user_id, target_league_id, week_number) —
-- placing again on an existing pending bid raises it (see the escrow note
-- above): refund the old hold, take the new one.
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

  v_entry_fee := _ladder_entry_fee_for_tier(v_target_tier);
  if p_amount < v_entry_fee then
    raise exception 'place_ladder_bid: amount % is below this league''s % bid floor', p_amount, v_entry_fee;
  end if;

  v_eligible := _ladder_bid_eligible_pool_internal(p_target_league_id, v_week);
  if not (v_user_id = any(v_eligible)) then
    raise exception 'place_ladder_bid: not eligible to bid for this league this week';
  end if;

  select * into v_existing from ladder_bids
  where bidder_user_id = v_user_id and target_league_id = p_target_league_id and week_number = v_week
  for update;

  if v_existing.id is not null and v_existing.status <> 'pending' then
    raise exception 'place_ladder_bid: this bid has already been settled';
  end if;

  if v_existing.id is not null then
    -- Raising an existing bid: refund the old hold before taking the new one.
    perform _nets_credit_internal(
      v_user_id, v_existing.amount, 'ladder_bid_raise_refund', null, 'ladder_bid', v_existing.id::text
    );
    perform _ladder_pool_debit(
      v_existing.amount, 'ladder_bid_raise_refund', v_user_id, 'ladder_bid', v_existing.id::text
    );
  end if;

  insert into ladder_bids (bidder_user_id, target_league_id, week_number, amount, status)
  values (v_user_id, p_target_league_id, v_week, p_amount, 'pending')
  on conflict (bidder_user_id, target_league_id, week_number)
  do update set amount = excluded.amount, placed_at = now()
  returning * into v_bid;

  -- Escrow the new bid — reason='ladder_entry_fee' since this IS the
  -- entry-fee payment for a winning bid (see the header note); losing
  -- bidders get it back in full at settlement below.
  perform _nets_debit_internal(v_user_id, p_amount, 'ladder_entry_fee', null, 'ladder_bid', v_bid.id::text);
  perform _ladder_pool_credit(p_amount, 'ladder_entry_fee', v_user_id, 'ladder_bid', v_bid.id::text);

  return v_bid;
end;
$$;

grant execute on function place_ladder_bid(uuid, bigint) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_settle_bids_internal — Sunday 10PM. Per league with at least one
-- pending bid: highest amount wins (tie -> highest points via
-- _ladder_bidder_points_internal, tie -> earliest placed_at) — same
-- ranking resolveLadderBids uses, reimplemented in SQL for the same
-- can't-call-out-to-JS reason as every other pure/SQL pair in this file.
-- Winner: mark 'won', seat them in the target league for next week
-- (status='auction_won', matching ladder_memberships' own status enum),
-- log the fee event. Already-escrowed bid amount needs no further debit.
-- Every other pending bidder for that league: mark 'refunded', credit
-- their escrowed amount back in full.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_settle_bids_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league record;
  v_winner_id uuid;
  v_winner_bidder uuid;
  v_winner_amount bigint;
  v_loser record;
begin
  for v_league in
    select distinct target_league_id from ladder_bids
    where week_number = p_week_number and status = 'pending'
  loop
    select b.id, b.bidder_user_id, b.amount
    into v_winner_id, v_winner_bidder, v_winner_amount
    from ladder_bids b
    where b.target_league_id = v_league.target_league_id
      and b.week_number = p_week_number
      and b.status = 'pending'
    order by
      b.amount desc,
      _ladder_bidder_points_internal(b.bidder_user_id, v_league.target_league_id, p_week_number) desc,
      b.placed_at asc
    limit 1;

    update ladder_bids set status = 'won' where id = v_winner_id;

    insert into ladder_memberships (user_id, league_id, week_number, status)
    values (v_winner_bidder, v_league.target_league_id, p_week_number + 1, 'auction_won')
    on conflict (user_id, week_number) do nothing;

    insert into ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned)
    values (v_winner_bidder, p_week_number + 1, v_league.target_league_id, 'entry', v_winner_amount, true);

    -- Refund every other pending bidder for this league in full — the
    -- winner's row is already 'won' above, so this loop only ever sees
    -- the losers.
    for v_loser in
      select * from ladder_bids
      where target_league_id = v_league.target_league_id
        and week_number = p_week_number
        and status = 'pending'
    loop
      update ladder_bids set status = 'refunded' where id = v_loser.id;
      perform _nets_credit_internal(
        v_loser.bidder_user_id, v_loser.amount, 'ladder_bid_refund', null, 'ladder_bid', v_loser.id::text
      );
      perform _ladder_pool_debit(
        v_loser.amount, 'ladder_bid_refund', v_loser.bidder_user_id, 'ladder_bid', v_loser.id::text
      );
    end loop;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_fall_through_internal — plan's own "closes the roster gap"
-- mechanic. For every player relegated FROM league T at the week that
-- closed just before p_week_number: if they won their own league's
-- buy-back bid this cycle, they're already seated by the settlement step
-- above — skip. Otherwise (didn't bid, or bid and lost), they aren't left
-- in limbo: write their next-week arrival into the league directly below
-- T, same as any other relegated arrival, and charge that league's Entry
-- Fee via _nets_debit_internal — this is also where Phase 4's deferred
-- "relegated player's fee" finally gets charged, now that their real
-- destination is known.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_fall_through_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_below_league_id uuid;
  v_below_tier integer;
  v_fee bigint;
  v_already_won boolean;
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

    -- Idempotency: skip if this player already has ANY next-week row
    -- (e.g. this job is re-run for a week already processed).
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

-- Deliberately no grant on any function above except place_ladder_bid —
-- same internal-only convention as the rest of this file.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_close_week_internal — now settles bids and runs the fall-through
-- pass, after fee settlement (Phase 4) and after promotion/relegation
-- resolves (Phase 3). Order matters: fall-through reads THIS week's bid
-- outcomes (status='won') to know who already bought their way back in,
-- so bid settlement must run first.
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
    perform _ladder_settle_week_fees_internal(v_week);
    perform _ladder_settle_bids_internal(v_week);
    perform _ladder_fall_through_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;
end;
$$;
