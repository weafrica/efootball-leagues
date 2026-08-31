-- League Ladder redesign — Phase A: Live tier pricing (foundation;
-- everything else in the redesign reads from this).
--
-- Since 20260868's renumbering, tier counts up from the bottom (League 1
-- = entry-level) with no fixed ceiling — new leagues keep getting created
-- one tier above the current max as the ladder fills up (see
-- _rebalance_ladder_overflow_internal, 20260859). _ladder_match_reward_
-- for_tier and _ladder_entry_fee_for_tier were never updated for that:
-- they're still the old immutable 8-row table from 20260860/20260862,
-- hardcoded against the pre-renumbering direction (tier 1 = 25N/elite,
-- tier 8 = 4N/bottom) and hard-capped at 8 tiers. Both are stale and
-- wrong under the new numbering.
--
-- Replaced with a live formula keyed off *distance from the current
-- growth frontier* (d = current_max_active_tier - tier) rather than a
-- fixed per-tier table, so pricing keeps working correctly no matter how
-- many tiers the ladder grows to:
--
--   d               = _ladder_current_max_tier_internal() - tier
--   MatchReward(d)  = 4 + round(0.5 * d)
--   EntryFee(d)     = 0 if d = 0, else round(2 * MatchReward(d))
--   EarlyBonus(d)   = round(0.25 * MatchReward(d))
--
-- d = 0 is always the newest/highest-numbered active league (the current
-- frontier) — it always prices at the floor (0 / 4N / 1N) no matter how
-- large the ladder has grown, since d is relative, not absolute. Every
-- function below goes through _ladder_current_max_tier_internal() rather
-- than re-querying ladder_leagues itself, so there's exactly one place to
-- fix if that query ever needs to change.
--
-- Mirrors economy.js's ladderTierRow() (same function this migration's
-- predecessors kept in sync) — hand-sync convention, same as every other
-- JS/SQL pair in this codebase (_generate_round_robin_fixtures_internal,
-- the standings query in 20260859). Flagged on both sides.
--
-- Early Bonus still isn't credited anywhere yet (20260860's header:
-- depends on Phase 6's countdown-based "completed early" check landing
-- in the crediting path) — this migration only adds the pricing
-- function itself, same foundation-only scope as the other two.
--
-- Ride-along fix: _ladder_streak_bonus_for_tier (20260865) calls
-- _ladder_match_reward_for_tier and was marked immutable on the (now
-- incorrect) assumption that match reward never depends on live table
-- state. Now that match reward reads the current max active tier, it
-- has to be stable too, or the planner is entitled to fold/cache it as
-- if it were a true constant. Re-declared at the bottom of this
-- migration with the same body, stable instead of immutable.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_current_max_tier_internal — single source of truth for "current
-- max active tier." Same query _rebalance_ladder_overflow_internal
-- (20260859) already inlines for the same concept; centralized here so
-- every pricing function shares one definition of "the frontier" instead
-- of each re-deriving it. Defaults to 1 (the entry-level league) if
-- somehow no active league exists yet, rather than null, so downstream
-- arithmetic (current_max_active_tier - tier) never has to null-guard.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_current_max_tier_internal()
returns integer
language sql
stable
as $$
  select coalesce(max(tier), 1) from ladder_leagues where status = 'active';
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_match_reward_for_tier — mirrors economy.js's ladderTierRow()
-- .matchReward. Replaces 20260860's hardcoded, un-renumbered 8-row table.
-- stable (not immutable): depends on _ladder_current_max_tier_internal(),
-- which reads live table state.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_match_reward_for_tier(p_tier integer)
returns bigint
language sql
stable
as $$
  select (4 + round(0.5 * (_ladder_current_max_tier_internal() - p_tier)))::bigint;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_entry_fee_for_tier — mirrors economy.js's ladderTierRow()
-- .entryFee. Replaces 20260860/20260862's hardcoded table (including
-- 20260862's tier-8-is-free special case — that's now just the d = 0
-- case of the general rule, no special-casing needed). stable, same
-- reason as above.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_entry_fee_for_tier(p_tier integer)
returns bigint
language sql
stable
as $$
  select case when _ladder_current_max_tier_internal() - p_tier = 0 then 0::bigint
    else round(2 * _ladder_match_reward_for_tier(p_tier))
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_early_bonus_for_tier — new. Mirrors economy.js's ladderTierRow()
-- .earlyBonus. Not wired into any crediting path yet — same "priced but
-- not credited" state Early Bonus has been in since 20260860 (still
-- waiting on Phase 6's countdown-based "completed early" check to land in
-- _credit_ladder_match_reward_internal). This just makes the number
-- available for whenever that lands.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_early_bonus_for_tier(p_tier integer)
returns bigint
language sql
stable
as $$
  select round(0.25 * _ladder_match_reward_for_tier(p_tier))::bigint;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_streak_bonus_for_tier — ride-along fix, see this migration's
-- header. Same body as 20260865, immutable -> stable.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_streak_bonus_for_tier(p_tier integer, p_streak integer)
returns bigint
language sql
stable
as $$
  select case when coalesce(p_streak, 0) < 2 then 0
    else round(_ladder_match_reward_for_tier(p_tier) * 0.10)
  end;
$$;
