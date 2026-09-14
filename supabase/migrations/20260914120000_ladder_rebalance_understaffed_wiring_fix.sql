-- Fixes wiring introduced in 20260913234750_ladder_auto_rebalance_understaffed_leagues.
--
-- Bug: _ladder_close_week_internal called
--   _ladder_rebalance_understaffed_leagues_internal(v_week + 1)
-- BEFORE _ladder_open_week_internal() creates any ladder_memberships rows for
-- v_week + 1 (that copy-forward happens later, inside open_week). The
-- rebalance function's own guard clause (v_min_tier is null -> return) means
-- this call was always a silent no-op in production -- it never actually
-- topped up an understaffed tier when run automatically.
--
-- Fix: remove the premature call from close_week, and call it from
-- _ladder_open_week_internal instead, right after the new week's memberships
-- are created and overflow-rebalanced, and before fixtures are generated
-- from them.
--
-- Verified via rolled-back dry run against real week 4 data before applying:
-- tiers 1-19 -> 6 players each, tier 20 -> 5, tier 21 -> 0 (only 2 spare
-- players existed at the bottom to cover 3 separate shortfalls, so the one
-- remaining shortfall lands at the bottom "growth" tier as designed).
-- Player-count conservation confirmed (119 in, 119 out; no duplication).

CREATE OR REPLACE FUNCTION public._ladder_close_week_internal()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_week integer;
begin
  select current_week into v_week from ladder_cycle where id = true;

  -- Forfeit sweep moved here from the hourly cron: catch every
  -- still-pending, countdown-expired fixture in one go, right before
  -- standings are computed, so promotion/relegation still sees a
  -- fully-resolved week exactly like it did when the sweep ran hourly.
  perform _ladder_forfeit_expired_fixtures_internal();

  perform _ladder_resolve_promotion_relegation_internal();

  if v_week is not null and v_week > 0 then
    perform _ladder_record_wall_of_fame_internal(v_week);
    perform _ladder_settle_week_fees_internal(v_week);
    perform _ladder_settle_bids_internal(v_week);
    perform _ladder_fall_through_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;

  perform _ladder_open_week_internal();
end;
$function$;

CREATE OR REPLACE FUNCTION public._ladder_open_week_internal()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prev_week integer;
  v_new_week integer;
  v_bidding_open boolean;
  v_league record;
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
      where league_id = v_league.id and week_number = v_prev_week and status = 'active'
      on conflict (user_id, week_number) do nothing;
    end loop;
  end if;

  perform _rebalance_ladder_overflow_internal(v_new_week);

  -- Fixed timing: run understaffed-tier top-up here, once this week's
  -- memberships actually exist, and before fixtures are generated from them.
  perform _ladder_rebalance_understaffed_leagues_internal(v_new_week);

  for v_league in select id from ladder_leagues where status = 'active' loop
    perform _ladder_sync_fixtures_internal(v_league.id, v_new_week);
  end loop;
  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$function$;
