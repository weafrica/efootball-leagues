-- League Ladder — fix the Sunday 23:59 UTC cutoff silently failing to
-- close the week or open the next one.
--
-- ROOT CAUSE: _ladder_close_week_internal (the single function the
-- 'ladder-close-week-sunday' cron job calls) runs promotion/relegation,
-- Wall of Fame, fee settlement, bid settlement, fall-through, and decay
-- penalty, then _ladder_open_week_internal, ALL in one transaction. Any
-- unhandled exception anywhere in that chain rolls the whole thing back —
-- so nothing closes and nothing opens, for every league, not just the one
-- that hit the problem. 20260870 ("Affordability fallbacks") identified
-- exactly this failure mode for fall-through and promotion and fixed both
-- of them. Two gaps let the same failure mode back in:
--
-- 1. _ladder_settle_week_fees_internal was NEVER covered by 20260870 and
--    still isn't: it charges every 'active' stayer their weekly Table Fee
--    (20% of that week's match earnings) and every 'promoted' player their
--    destination league's Entry Fee via a bare _nets_debit_internal call,
--    no balance check, no exception handling. A stayer who spent their
--    Nets earnings elsewhere during the week (item market, transfers,
--    shop) before the fee is charged raises "insufficient balance" and
--    aborts the entire Sunday close — this is the main live exposure,
--    since it runs for every active/promoted player across all leagues,
--    every single week, not just the smaller relegated/promoted-edge-case
--    populations fall-through and promotion cover.
--
-- 2. _ladder_resolve_promotion_relegation_internal was redefined again in
--    20260905 (to honor a corrected forfeit score in standings) by
--    branching off 20260859's version instead of 20260870's — silently
--    reverting BOTH of 20260870's fixes: promotion is back to always
--    seating rank 1 regardless of wallet balance (reopening the exact
--    "aborted Sunday close" hole 20260870 closed), and relegation's
--    "bottom 2" is back to assuming the promoted player is always
--    standings[1], which is wrong the moment promotion skips past rank 1.
--    This migration reapplies 20260870's affordability walk and
--    promoted-index removal on top of 20260905's forfeit-honoring
--    standings query, so neither fix is lost going forward.
--
-- Fix pattern for both functions matches what 20260870 already
-- established for fall-through and what 20260863 already established for
-- decay penalty: check the wallet BEFORE debiting, and skip/degrade
-- gracefully instead of raising. _ladder_settle_week_fees_internal now
-- skips (not charges) a fee it can't collect, logging nothing for that
-- fee this week rather than aborting every other player's settlement
-- along with it.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_resolve_promotion_relegation_internal — 20260905's forfeit-
-- honoring standings computation, with 20260870's affordability-walk
-- promotion selection and promoted-index-aware relegation restored on top.
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
                    when status = 'forfeited' and home_score is not null and away_score is not null and home_score > away_score then 3
                    when status = 'played' and home_score = away_score then 1
                    when status = 'forfeited' and home_score is not null and away_score is not null and home_score = away_score then 1
                    else 0 end as pts,
               case when status in ('played', 'forfeited') then 1 else 0 end as played,
               case when status = 'played' then home_score
                    when status = 'forfeited' and home_score is not null then home_score
                    else 0 end as gf,
               case when status = 'played' then away_score
                    when status = 'forfeited' and away_score is not null then away_score
                    when status = 'forfeited' then 4
                    else 0 end as ga
        from ladder_fixtures
        where league_id = v_league.id and week_number = v_week
        union all
        select away_user_id,
               case when status = 'played' and away_score > home_score then 3
                    when status = 'forfeited' and home_score is not null and away_score is not null and away_score > home_score then 3
                    when status = 'played' and away_score = home_score then 1
                    when status = 'forfeited' and home_score is not null and away_score is not null and away_score = home_score then 1
                    else 0 end,
               case when status in ('played', 'forfeited') then 1 else 0 end,
               case when status = 'played' then away_score
                    when status = 'forfeited' and away_score is not null then away_score
                    else 0 end,
               case when status = 'played' then home_score
                    when status = 'forfeited' and home_score is not null then home_score
                    when status = 'forfeited' then 4
                    else 0 end
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
    -- (tier 1 has nowhere higher to go). Stays null if nobody can afford
    -- it. See 20260870's header for why this has to be a walk, not
    -- always rank 1.
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
    -- that's fall-through's territory.
    if v_promoted is not null then
      v_target_league_id := _ensure_ladder_league_internal(v_dest_tier);
      insert into ladder_memberships (user_id, league_id, week_number, status)
      values (v_promoted, v_target_league_id, v_next_week, 'active')
      on conflict (user_id, week_number) do nothing;
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_settle_week_fees_internal — same fee math and idempotency guard
-- as 20260862's version, but the wallet balance is now checked BEFORE
-- _nets_debit_internal is called for either fee type. Insufficient
-- balance no longer raises (and no longer aborts the weekly close) — that
-- one player's fee for the week is skipped (no debit, no pool credit, no
-- fee_events row) and the loop moves on to the next player, same
-- skip-gracefully shape as 20260870's fall-through fix and 20260863's
-- decay-penalty cap.
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
  v_balance bigint;
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

    -- Affordability guard: a player who can't cover this fee (spent their
    -- earnings elsewhere during the week — item market, transfers, shop)
    -- just doesn't get charged it this week, rather than taking down the
    -- entire Sunday close for every other league.
    select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_row.user_id;
    if coalesce(v_balance, 0) < v_fee then
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
