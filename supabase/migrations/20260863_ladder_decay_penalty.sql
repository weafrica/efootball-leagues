-- League Ladder — Phase 7 (partial): Decay Penalty.
--
-- SCOPE NOTE: Phase 7's checklist has several items — only Decay Penalty
-- is fully specified in the plan doc. Everything else in that phase
-- (Elite Safety Zone / Checkpoint Safety, Danger Zone, Live Bid Ticker,
-- Placement Bonus, Transfer Window/Reroll, Streak Bonuses, Wall of Fame)
-- is explicitly flagged in the plan as needing real specs before writing
-- any code — "get real specs for each... before treating any of them as
-- a port from v3, since there's currently nothing concrete in the doc or
-- the repo to port." Deliberately not touched here. Second Life is
-- confirmed NOT to be ported at all — nothing to build, nothing to skip.
--
-- Decay Penalty itself, per §Phase 7: at the Sunday 10PM resolve job, any
-- player with zero matches played that week is removed from
-- ladder_memberships and charged 10% of their all-time cumulative Nets
-- earned in the ladder (not that week's).
--
-- SCOPE NOTE (own): restricted to players whose week resolved as
-- 'active' (i.e. stayers — not promoted, not relegated) by the time this
-- runs. Promotion/relegation, fee settlement, and bid fall-through
-- (Phases 3-5) already have fully-specified rules for what happens to a
-- promoted/relegated player's next-week seat; layering Decay Penalty's
-- "remove from ladder_memberships" on top of THOSE outcomes as well would
-- mean redefining what promotion/relegation/fall-through do for an edge
-- case the plan doesn't address (e.g. a relegated player who also played
-- zero matches — do they still get their buy-back auction shot?). Left
-- for a future migration once that interaction is actually specified.
-- Applying it to stayers only is a strict, unambiguous reading of "zero
-- matches played" that can't conflict with any other phase's logic.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_apply_decay_penalty_internal — the removal + charge, for a given
-- week's resolve pass. Runs after promotion/relegation/fees/bids/
-- fall-through (see _ladder_close_week_internal below) so it only ever
-- looks at rows still sitting at status='active' — anyone this week's
-- earlier resolve steps already reclassified is out of scope, per this
-- migration's own scope note above.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_apply_decay_penalty_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member record;
  v_played_count integer;
  v_lifetime_earnings bigint;
  v_current_balance bigint;
  v_penalty bigint;
begin
  for v_member in
    select lm.id, lm.user_id, lm.league_id
    from ladder_memberships lm
    where lm.week_number = p_week_number and lm.status = 'active'
    for update
  loop
    select count(*) into v_played_count
    from ladder_fixtures f
    where f.league_id = v_member.league_id
      and f.week_number = p_week_number
      and f.status = 'played'
      and (f.home_user_id = v_member.user_id or f.away_user_id = v_member.user_id);

    if v_played_count = 0 then
      select coalesce(sum(amount), 0) into v_lifetime_earnings
      from nets_transactions
      where user_id = v_member.user_id and reason = 'ladder_match_reward';

      select coalesce(balance, 0) into v_current_balance
      from nets_wallets where user_id = v_member.user_id;

      -- Same 10%-of-lifetime-earnings math as computeDecayPenalty in
      -- economy.js, capped at their current balance so an inactive
      -- player who's since spent Nets elsewhere never goes negative and
      -- never fails the whole weekly settlement job over it.
      v_penalty := least(floor(v_lifetime_earnings * 0.10)::bigint, v_current_balance);

      if v_penalty > 0 then
        perform _nets_debit_internal(
          v_member.user_id, v_penalty, 'ladder_decay_penalty', null, 'ladder_week', p_week_number::text
        );
        perform _ladder_pool_credit(
          v_penalty, 'ladder_decay_penalty', v_member.user_id, 'ladder_week', p_week_number::text
        );
      end if;

      update ladder_memberships set status = 'eliminated' where id = v_member.id;
    end if;
  end loop;
end;
$$;

-- Deliberately no grant — same internal-only convention as every other
-- _*_internal function in this file's siblings.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_close_week_internal — now applies Decay Penalty last, after
-- fall-through (Phase 5). Order matters: fall-through's roster-gap-closing
-- pass reads THIS week's relegation/bid outcomes, not next week's — Decay
-- Penalty removing a stayer doesn't retroactively change who was
-- promoted/relegated/fell-through this week, so it's safe to run after
-- all of that without reordering anything upstream.
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
    perform _ladder_apply_decay_penalty_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;
end;
$$;
