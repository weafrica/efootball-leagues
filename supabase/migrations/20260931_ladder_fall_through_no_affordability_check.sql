-- Repo-drift backfill — this was applied LIVE via Supabase:apply_migration
-- in a prior session and confirmed still running via pg_get_functiondef on
-- 2026-09-07, but was never written back to this repo. Filing it now so the
-- repo matches reality.
--
-- Supersedes 20260870_ladder_affordability_fallbacks.sql's version of this
-- function. That migration introduced a wallet-balance check so a player
-- who couldn't afford the league-below Entry Fee would be reseated as a
-- stayer in their own pre-relegation league instead of transitioning down.
--
-- Rule change (decided this session): relegated players finished bottom of
-- their league, so there's no match-reward money for them to draw an Entry
-- Fee from — the affordability check was actively working against players
-- who should freely fall through. This version removes the balance check,
-- the fee lookup, and the fee debit/pool-credit/fee-event logging
-- entirely. Every relegated player now moves into the tier below for free,
-- unconditionally, with no Entry Fee charged either way.
--
-- Everything else (already-won-bid skip, already-seated idempotency guard)
-- is unchanged from 20260870.
--
-- Safe to run more than once.

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
  v_already_seated boolean;
begin
  for v_row in
    select m.user_id, m.league_id, l.tier as tier
    from ladder_memberships m
    join ladder_leagues l on l.id = m.league_id
    where m.week_number = p_week_number and m.status = 'relegated'
  loop
    select exists(
      select 1 from ladder_bids
      where bidder_user_id = v_row.user_id
        and target_league_id = v_row.league_id
        and week_number = p_week_number + 1
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

    insert into ladder_memberships (user_id, league_id, week_number, status)
    values (v_row.user_id, v_below_league_id, p_week_number + 1, 'active')
    on conflict (user_id, week_number) do nothing;
  end loop;
end;
$$;
