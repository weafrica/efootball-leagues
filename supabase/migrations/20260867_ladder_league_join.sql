-- League Ladder — self-service join for the entry-level (bottom) league.
--
-- CONTEXT: LeagueLadderDetail.jsx's own header says it plainly — "No join
-- flow, no bidding UI, no fee display" — and confirmed by grep, every
-- existing `insert into ladder_memberships` in this repo lives inside
-- internal SECURITY DEFINER functions (carry-forward in
-- _ladder_open_week_internal, promotion/relegation, bidding resolution).
-- None of them is reachable from a client. This migration is that
-- missing entry-flow, mirroring join_ladder()'s pattern from 20260849
-- (charge-and-insert in one transaction, so there's no way to end up
-- charged-but-not-joined or joined-but-uncharged).
--
-- Only the bottom league (highest tier number among active leagues) is
-- joinable this way — every other tier is reached only via promotion, an
-- auction win, or a relegated arrival (all already-built server-side
-- transitions), never a direct self-service join. This mirrors
-- ladderEntryFeeForTier's own comment in economy.js ("Charged only on a
-- transition") — letting a client join tier 1 directly by just paying
-- 80N would bypass that entirely.
--
-- Fee: LADDER_TIER_TABLE's entryFee column reimplemented inline below
-- (v_fee), same "kept in sync by hand across SQL and economy.js"
-- convention this codebase already uses elsewhere. Tier 8's row is 0 —
-- "the bottom league is free to enter" per economy.js's own comment —
-- and every tier auto-created past 8 reuses that same free entry, so in
-- practice this fee is always 0 today (tier 8 is presently the only
-- active league, and is always the highest-tier one). nets_debit is
-- skipped entirely when the fee is 0 rather than called with amount 0,
-- since nets_debit itself rejects amount <= 0 (20260825).
--
-- Target week: current_week + 1, never current_week itself — whatever
-- week is already open had its roster and fixtures generated the moment
-- _ladder_open_week_internal last ran, so a same-week join could never
-- get fixtures generated for it. Inserting one week ahead means the
-- joiner sits in ladder_memberships exactly like every carried-forward
-- player by the time the next open-week fire reads that week's roster
-- and generates fixtures from it — no separate case needed inside
-- _ladder_open_week_internal itself. Works identically whether
-- current_week is 0 (never opened) or already mid-cycle.
--
-- Guards against joining twice: refuses if the caller already has an
-- active membership at week_number >= current_week (already on the
-- ladder, mid-cycle, or already queued for next week) — same
-- "already on the ladder" rejection join_ladder() uses for the
-- unrelated permanent ladder.
--
-- Safe to run more than once.

create or replace function join_ladder_league()
returns ladder_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_league_id uuid;
  v_league_tier integer;
  v_current_week integer;
  v_target_week integer;
  v_fee bigint;
  v_row ladder_memberships%rowtype;
begin
  if v_user_id is null then
    raise exception 'join_ladder_league: must be signed in';
  end if;

  select id, tier into v_league_id, v_league_tier
  from ladder_leagues
  where status = 'active'
  order by tier desc
  limit 1;

  if v_league_id is null then
    raise exception 'join_ladder_league: no League Ladder league is open for entry yet';
  end if;

  select current_week into v_current_week from ladder_cycle where id = true;
  v_current_week := coalesce(v_current_week, 0);
  v_target_week := v_current_week + 1;

  if exists (
    select 1 from ladder_memberships
    where user_id = v_user_id and status = 'active' and week_number >= v_current_week
  ) then
    raise exception 'join_ladder_league: already on the ladder';
  end if;

  -- Same tier -> Entry Fee pricing as economy.js's LADDER_TIER_TABLE.
  -- Tier 8, and anything past it, is free.
  v_fee := case
    when v_league_tier >= 8 then 0
    when v_league_tier = 7 then 18
    when v_league_tier = 6 then 29
    when v_league_tier = 5 then 36
    when v_league_tier = 4 then 48
    when v_league_tier = 3 then 58
    when v_league_tier = 2 then 67
    when v_league_tier = 1 then 80
    else 0
  end;

  if v_fee > 0 then
    perform nets_debit(
      v_fee,
      'ladder_league_join',
      'Joined League Ladder — Tier ' || v_league_tier,
      'ladder_leagues',
      v_league_id::text
    );
  end if;

  insert into ladder_memberships (user_id, league_id, week_number, status)
  values (v_user_id, v_league_id, v_target_week, 'active')
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function join_ladder_league() to authenticated;
