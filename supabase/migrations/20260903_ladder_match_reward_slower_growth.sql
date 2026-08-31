-- League Ladder — slow down Match Reward's per-tier growth rate.
--
-- Formula shape is UNCHANGED (confirmed keep, per discussion) — still
-- linear in d, still uncapped, still grows every time the ladder gains a
-- tier. Only the coefficient moves:
--
--   d              = current_max_active_tier - tier
--   MatchReward(d) = 4 + round(0.1 * d)    -- was 0.5
--   EntryFee(d)    = 0 if d = 0, else round(2 * MatchReward(d))   -- unchanged shape
--   EarlyBonus(d)  = round(0.25 * MatchReward(d))                 -- unchanged shape
--   StreakBonus    = round(MatchReward(d) * 0.10)                 -- unchanged shape
--
-- Entry Fee / Early Bonus / Streak Bonus all call
-- _ladder_match_reward_for_tier internally (confirmed in
-- 20260869_ladder_live_tier_pricing.sql) rather than duplicating the
-- formula, so lowering the rate here is a single point of change — they
-- inherit the slower growth automatically, no separate edits needed.
--
-- Per the flagged discussion: this is still an uncapped, linear-in-d
-- formula — 5x slower to reach any given reward value than before, not
-- bounded. If/when the platform's total active-player count (and
-- therefore ladder depth) grows enough, this will still eventually
-- produce large per-match rewards; lowering the rate only changes how
-- much growth that takes, not whether it happens. Revisit if/when
-- ladder_leagues' max(tier) is being watched and this becomes relevant
-- in practice.
--
-- d=0 still floors at 0 / 4N / 1N regardless of ladder depth — unaffected
-- by this change, same as Phase A's original unit-test guarantee.
--
-- Safe to run more than once.

create or replace function _ladder_match_reward_for_tier(p_tier integer)
returns bigint
language sql
stable
as $$
  select (4 + round(0.1 * (_ladder_current_max_tier_internal() - p_tier)))::bigint;
$$;

-- _ladder_entry_fee_for_tier, _ladder_early_bonus_for_tier, and
-- _ladder_streak_bonus_for_tier are all unchanged — they call the
-- function above and inherit its new rate without needing a
-- create-or-replace of their own.
