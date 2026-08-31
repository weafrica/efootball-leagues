-- League Ladder redesign — Phase B: Affordability fallbacks.
--
-- Two gaps closed here, both keyed off the same root problem: the ladder's
-- weekly close job charges league-transition Entry Fees to players whose
-- wallet balance was never checked before they were seated in the higher-
-- fee league. Today that means _nets_debit_internal's "insufficient
-- balance" exception is the only thing standing between a broke player and
-- an aborted Sunday close for the ENTIRE ladder (no per-iteration handling
-- in either loop this migration touches).
--
-- 7. Fall-through (_ladder_fall_through_internal): the balance check now
--    happens BEFORE the league-below membership row is written, not after.
--    A player who can't cover the league-below Entry Fee never transitions
--    at all — they're reseated as an ordinary stayer in their own
--    pre-relegation league instead (no tier change, no Entry Fee this
--    week — just the normal Table Fee _ladder_settle_week_fees_internal
--    already charges every 'active' stayer). Side effect: no league-below
--    membership row is ever created for a player who never actually moves
--    there.
--
-- 8. Promotion (_ladder_resolve_promotion_relegation_internal): selection
--    now walks that week's standings in rank order and promotes the FIRST
--    player who can afford the destination (tier - 1) league's live Entry
--    Fee, rather than always seating rank 1 and finding out three steps
--    later (at _ladder_settle_week_fees_internal) that they can't pay.
--    Promotion for a league only comes back null if nobody in the
--    standings can afford it — same "nobody, not just rank 1" bar as
--    fall-through above.
--
--    Correctness fix this surfaces: relegation's "bottom 2" used to
--    assume the promoted player was always standings[1], so it always
--    started counting relegation candidates from standings[2]. That
--    assumption breaks the moment promotion can skip past rank 1 — the
--    promoted player can now be at any index. Fixed by removing whichever
--    index actually got promoted from the standings array (wherever they
--    land) before taking the bottom 2, so the same player can never be
--    counted as both promoted and relegated.
--
-- Both functions keep every other behavior from their prior definitions
-- (20260862 for fall-through, 20260859 for promotion/relegation) —
-- standings computation, idempotency guards, fee-event logging, and the
-- "relegated players get no next-week row here" scope note are all
-- unchanged. Diff is scoped to the affordability check and the relegation
-- index fix.
--
-- Deliberately NOT touched: leagueLadder.js's resolveLadderWeek (the pure
-- JS classifier) and its unit tests in test-league-ladder.mjs. That
-- function was explicitly scoped to never know about wallet balances (see
-- its own header) — this is an intentional, documented SQL/JS divergence,
-- not a break of the hand-sync convention every other SQL/JS pair in this
-- codebase follows.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_fall_through_internal — same as 20260862's version, but the
-- league-below Entry Fee is now checked against the player's wallet
-- balance BEFORE the league-below membership row is written or
-- _nets_debit_internal is called. Insufficient balance no longer raises
-- (and no longer aborts the weekly close) — it reseats the player as a
-- stayer in v_row.league_id (their own pre-relegation league, not
-- v_below_league_id) instead.
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
  v_balance bigint;
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

    if v_fee > 0 then
      select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_row.user_id;

      if coalesce(v_balance, 0) < v_fee then
        -- Can't afford the league-below Entry Fee — skip the transition
        -- entirely rather than let _nets_debit_internal raise and abort
        -- the whole weekly close. Reseated as an ordinary stayer in their
        -- own pre-relegation league: no tier change, no Entry Fee this
        -- week, just the normal Table Fee later. No league-below
        -- membership row is written for a player who never moves there.
        insert into ladder_memberships (user_id, league_id, week_number, status)
        values (v_row.user_id, v_row.league_id, p_week_number + 1, 'active')
        on conflict (user_id, week_number) do nothing;
        continue;
      end if;
    end if;

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

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_resolve_promotion_relegation_internal — same as 20260859's
-- version (standings computation is byte-for-byte unchanged), except:
--
--   - Promotion now walks the standings array in rank order and stops at
--     the first player whose wallet balance covers the destination
--     (tier - 1) league's live Entry Fee. If the destination's Entry Fee
--     is 0 (the d = 0 floor case), the first player in the array
--     qualifies immediately, same as rank-1-always-promotes used to
--     behave in that case.
--   - The relegation pool is built by removing whichever standings INDEX
--     actually got promoted (which may not be index 1 anymore), instead
--     of always assuming index 1 was promoted and starting the remaining
--     pool at index 2.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_resolve_promotion_relegation_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week integer;
  v_next_week integer;
  v_league record;
  v_standings uuid[];
  v_n integer;
  v_promoted uuid;
  v_promoted_idx integer;
  v_dest_tier integer;
  v_dest_fee bigint;
  v_balance bigint;
  v_remaining uuid[];
  v_relegated uuid[];
  v_relegate_count integer;
  v_target_league_id uuid;
  i integer;
begin
  select current_week into v_week from ladder_cycle where id = true;
  if v_week is null or v_week = 0 then
    return; -- nothing opened yet, nothing to resolve
  end if;
  v_next_week := v_week + 1;

  for v_league in select id, tier from ladder_leagues where status = 'active' order by tier loop
    select array_agg(s.user_id order by (s.played > 0) desc, s.pts desc, s.gd desc, s.gf desc, s.user_id asc)
    into v_standings
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
        where league_id = v_league.id and week_number = v_week
        union all
        select away_user_id,
               case when status = 'played' and away_score > home_score then 3
                    when status = 'played' and away_score = home_score then 1
                    else 0 end,
               case when status in ('played', 'forfeited') then 1 else 0 end,
               case when status = 'played' then away_score else 0 end,
               case when status = 'played' then home_score when status = 'forfeited' then 4 else 0 end
        from ladder_fixtures
        where league_id = v_league.id and week_number = v_week
      ) m
      group by m.user_id
    ) s;

    v_n := coalesce(array_length(v_standings, 1), 0);
    if v_n = 0 then
      continue; -- no fixtures this week for this league — nothing to resolve
    end if;

    -- Promotion: first player in rank order who can afford the
    -- destination league's live Entry Fee — only if this isn't League 1
    -- (tier 1 has nowhere higher to go). v_promoted stays null (and
    -- v_promoted_idx stays null) if nobody in the array can afford it.
    v_promoted := null;
    v_promoted_idx := null;

    if v_league.tier > 1 then
      v_dest_tier := v_league.tier - 1;
      v_dest_fee := _ladder_entry_fee_for_tier(v_dest_tier);

      for i in 1 .. v_n loop
        if v_dest_fee <= 0 then
          v_promoted := v_standings[i];
          v_promoted_idx := i;
          exit;
        end if;

        select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_standings[i];

        if coalesce(v_balance, 0) >= v_dest_fee then
          v_promoted := v_standings[i];
          v_promoted_idx := i;
          exit;
        end if;
      end loop;
    end if;

    -- Relegation: bottom 2 of whoever's left after the promoted player
    -- (at whatever index they actually landed, not assumed index 1) is
    -- removed, capped at what's actually available.
    if v_promoted_idx is not null then
      v_remaining := v_standings[1 : v_promoted_idx - 1] || v_standings[v_promoted_idx + 1 : v_n];
    else
      v_remaining := v_standings;
    end if;

    v_relegate_count := least(2, coalesce(array_length(v_remaining, 1), 0));
    if v_relegate_count > 0 then
      v_relegated := v_remaining[(array_length(v_remaining, 1) - v_relegate_count + 1) : array_length(v_remaining, 1)];
    else
      v_relegated := array[]::uuid[];
    end if;

    -- Mark this week's outcome on the CLOSING week's own rows — describes
    -- what happened to this row's player that week, per ladder_memberships'
    -- own convention. Stayers are left at their existing 'active' status,
    -- no update needed.
    if v_promoted is not null then
      update ladder_memberships set status = 'promoted'
      where user_id = v_promoted and league_id = v_league.id and week_number = v_week;
    end if;
    if array_length(v_relegated, 1) > 0 then
      update ladder_memberships set status = 'relegated'
      where user_id = any(v_relegated) and league_id = v_league.id and week_number = v_week;
    end if;

    -- Write the promoted player's arrival into their destination league
    -- for next week. Idempotency guard (on conflict do nothing) in case
    -- this job is ever re-run for a week it already resolved.
    --
    -- Relegated players deliberately get NO next-week row here at all —
    -- that's Phase 5's (bidding/fall-through's) territory.
    if v_promoted is not null then
      v_target_league_id := _ensure_ladder_league_internal(v_dest_tier);
      insert into ladder_memberships (user_id, league_id, week_number, status)
      values (v_promoted, v_target_league_id, v_next_week, 'active')
      on conflict (user_id, week_number) do nothing;
    end if;
  end loop;
end;
$$;
