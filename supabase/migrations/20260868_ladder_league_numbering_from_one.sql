-- League Ladder — renumber so League 1 is the entry-level (bottom) league,
-- not League 8.
--
-- CONTEXT: tier used to count down from the top (1 = elite, 8 = bottom).
-- Flipped per request: League 1 is now the first league anyone joins, and
-- each capacity-triggered league created above it (once a league fills to
-- 8 concurrent players in a given week — see _rebalance_ladder_overflow_
-- internal, 20260859) gets the next number up: League 2, League 3, ... to
-- infinity. Confirmed this is purely capacity-driven, not promotion-
-- driven — no change needed to _ensure_ladder_league_internal or
-- _rebalance_ladder_overflow_internal themselves, since both only ever
-- reason about "one more than the current max tier," which doesn't care
-- which direction is "up." (Phase 3's actual promotion/relegation engine
-- still promotes toward a *lower* tier number, i.e. still thinks tier 1
-- is elite — that's now backwards under this renumbering and will need
-- fixing before promotion is turned on for real. Out of scope here since
-- nothing is promoting yet with zero real players.)
--
-- The only league that exists today is tier 8 (seeded empty by
-- 20260866, still zero members per the last check) — safe to just
-- renumber it directly rather than a generic shift, and naturally
-- idempotent (matches nothing, so a no-op, once already renumbered).
update ladder_leagues set tier = 1 where tier = 8;

-- join_ladder_league() (20260867) charged whatever ladderEntryFeeForTier
-- said for the tier it joined — under the old numbering that was always
-- 0 (tier 8's row). Reimplemented flat/free here to match economy.js's
-- own simplification (LADDER_TIER_TABLE is now a single flat row,
-- pricing-by-tier deferred) rather than re-deriving a tier-keyed fee
-- table in SQL that would just go stale the moment economy.js's version
-- changes again.
create or replace function join_ladder_league()
returns ladder_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_league_id uuid;
  v_current_week integer;
  v_target_week integer;
  v_row ladder_memberships%rowtype;
begin
  if v_user_id is null then
    raise exception 'join_ladder_league: must be signed in';
  end if;

  select id into v_league_id
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

  -- Flat/free — every League Ladder league today is entry-level (see
  -- economy.js's LADDER_TIER_TABLE comment); no nets_debit call needed.

  insert into ladder_memberships (user_id, league_id, week_number, status)
  values (v_user_id, v_league_id, v_target_week, 'active')
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function join_ladder_league() to authenticated;
