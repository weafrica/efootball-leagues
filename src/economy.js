// src/economy.js
//
// WEAFRICA NETS ECONOMY — pricing basics: match rewards, entry fees, and
// the Top 20 prize pool split.
//
// Pure functions only — no React, no Supabase. This is the "how much"
// layer; actually moving Nets (crediting rewards, debiting entry fees)
// goes through creditNets/debitNets in src/nets.js, the only place
// allowed to touch nets_wallets/nets_transactions. Nothing in this file
// writes anything — call sites compute an amount here, then pass it to
// those RPCs with the right reason/ref.
//
// Field names/style mirror src/formats/ladderCup.js.

// ─────────────────────────────────────────────────────────────────────────
// Match rewards
//
// Every match type pays a fixed net per outcome, plus (for the three
// formats where it applies) a flat "participation" net paid regardless of
// outcome — win, draw, or loss all still bank it. Six-Day Survivor and
// Knockout don't get a participation net; their win reward is already the
// whole payout for that match.
// ─────────────────────────────────────────────────────────────────────────

const PARTICIPATION_NET = 1;

const MATCH_REWARD_TABLE = {
  random_match: { win: 2, draw: 1, loss: 0, draws: true, participation: true },
  // Ladder Battle (the per-match reward inside a Ladder Cup) now mirrors
  // Six-Day Survivor's flat shape exactly: win 4, loss 0, no draws (there
  // are none in this format), no participation net. Previously tiered by
  // beatHigherRank (winHigher 3 / winLower 1 / draw 2, +1 participation)
  // — that scheme is gone; the Ladder Cup's own upset bonus already lives
  // in the standings-points system (ladderCup.js's UPSET_BONUS), not here.
  ladder_battle: { win: 4, loss: 0, draws: false, participation: false },
  six_day_survivor: { win: 4, loss: 0, draws: false, participation: false },
  league: { win: 5, draw: 2, loss: 0, draws: true, participation: true }, // double round robin
  // Home & away knockout: win starts at 3 and grows 1/round, so a final
  // (round 8, ~32 days deep) is worth far more than a round-1 win. Applies
  // uniformly to every played fixture — leg or decider — since the reward
  // is per-fixture, not per-tie: participation net now applies here too.
  //
  // draws: true, draw: 0 — a level scoreline pays the same as a loss (0
  // base + 1 participation = 1). This is only reachable for a plain leg of
  // a two-legged (home & away) tie: every fixture that must produce an
  // outright winner — a single-leg match, the final, or the tie's decider
  // (see isDeciderFixture/advanceKnockout in App.jsx) — goes to penalties
  // instead of staying level, so this branch never fires for those.
  knockout: { winBase: 3, winPerRound: 1, loss: 0, draw: 0, draws: true, participation: true },
  // groups_knockout's group stage (stage 1) only — its own bracket stage
  // (stage 2) reuses the 'knockout' table above, same as pure knockout
  // leagues. A plain round-robin group match CAN end level (unlike the
  // bracket), so this keeps the normal win/draw/loss shape 'league' uses,
  // just at groups_knockout's own lower reward: win=4, draw=2, loss=0,
  // +1 participation.
  groups_knockout_group: { win: 4, draw: 2, loss: 0, draws: true, participation: true },
};

export const MATCH_TYPES = Object.keys(MATCH_REWARD_TABLE);

// computeMatchNets(matchType, outcome, options) → number of Nets earned.
//   matchType: one of MATCH_TYPES
//   outcome:   "win" | "draw" | "loss"
//   options:
//     - knockout win: { round: number } — 1-indexed round
export function computeMatchNets(matchType, outcome, options = {}) {
  const table = MATCH_REWARD_TABLE[matchType];
  if (!table) throw new Error(`computeMatchNets: unknown match type "${matchType}"`);

  let base;
  if (outcome === "win") {
    if (matchType === "knockout") base = table.winBase + table.winPerRound * ((options.round || 1) - 1);
    else base = table.win;
  } else if (outcome === "draw") {
    if (!table.draws) throw new Error(`computeMatchNets: ${matchType} has no draws`);
    base = table.draw;
  } else if (outcome === "loss") {
    base = table.loss;
  } else {
    throw new Error(`computeMatchNets: unknown outcome "${outcome}"`);
  }

  return base + (table.participation ? PARTICIPATION_NET : 0);
}

// ─────────────────────────────────────────────────────────────────────────
// Entry fees — flat Nets cost to join a paid format. "league" covers both
// normal (round robin) leagues and Survivor-format leagues; they share one
// price since both are the same "full league" commitment, distinct from
// the standalone Six-Day Survivor Cup below.
//
// All four league-format fees cut by 75% (now 25% of their original
// value): 40→10, 240→60, 50→12.5→13 (rounded), 80→20. Individual Ladder
// Challenges (the `challenges` table, is_ladder = true; NOT the Ladder Cup
// league format above) are free to send/accept — no entry fee.
// ─────────────────────────────────────────────────────────────────────────
export const ENTRY_FEES_NETS = {
  six_day_survivor: 10, // was 40
  league: 60, // was 240 — normal leagues + survivor-format leagues
  knockout: 13, // was 50 (12.5 rounded) — home & away, ~150 teams / 8 rounds / ~32 days
  groups_knockout: 20, // was 80
};

// entryFeeForLeagueFormat(format) → Nets cost to join, or null if this
// league format isn't a paid-entry format.
//
// Maps leagues.format (single_round_robin, double_round_robin, survivor,
// knockout, groups_knockout) onto ENTRY_FEES_NETS. 'league' covers every
// round-robin/survivor shape, per the "normal leagues + survivor-format
// leagues" comment above. ladder_cup ("Survival Ladder Cup" — ranked
// ladder, one elimination life each, decided by the weekly Sunday
// cutoff, see LADDER_CUP_INTEGRATION.md) used to reuse the "Six-Day
// Survivor Cup" price (ENTRY_FEES_NETS.six_day_survivor) here — it's now
// free to join instead, so it's handled as its own branch below rather
// than through this table.
// One-time fee to join the permanent Ladder Battles ladder (ladder_ranks) —
// separate from ENTRY_FEES_NETS since it's not a league format. Charged and
// the ladder_ranks row created together by the join_ladder() RPC (see
// supabase/migrations/20260849_ladder_join_fee_and_purge.sql) — keep this in
// sync with that migration's v_fee constant if it ever changes.
export const LADDER_JOIN_FEE_NETS = 5;

// Fee to "buy your life back" — rejoin (rebirth) a fully eliminated
// Survival Ladder Cup club, after both the original life and the one
// second-life offer are gone. Charged and the entry reset together by the
// rebirth_ladder_cup_entry() RPC (see
// supabase/migrations/20260897_ladder_cup_rebirth_fee.sql) — keep this in
// sync with that migration's v_fee constant if it ever changes.
export const LADDER_CUP_REBIRTH_FEE_NETS = 6;

// How many opponents a Survival Ladder Cup club sees for free on its
// challenge board, and the cost to reveal one more beyond that (up to
// LADDER_CUP_RULES.SHOWN_OPPONENTS = 10, formats/ladderCup.js — the same
// ceiling the underlying matchmaking pool already used). Charged and the
// entry's purchased_opponent_slots incremented together by the
// buy_ladder_cup_opponent_slot() RPC (see
// supabase/migrations/20260904_ladder_cup_opponent_slot_purchase.sql) —
// keep these in sync with that migration's v_fee/v_base/v_max constants
// if they ever change.
export const LADDER_CUP_BASE_VISIBLE_OPPONENTS = 3;
export const LADDER_CUP_OPPONENT_SLOT_FEE_NETS = 1;
export const LADDER_CUP_MAX_VISIBLE_OPPONENTS = 10;

export function entryFeeForLeagueFormat(format) {
  if (format === "single_round_robin" || format === "double_round_robin" || format === "survivor") {
    return ENTRY_FEES_NETS.league;
  }
  if (format === "knockout") {
    return ENTRY_FEES_NETS.knockout;
  }
  if (format === "groups_knockout") {
    return ENTRY_FEES_NETS.groups_knockout;
  }
  // Survival Ladder Cup is free to play — no Nets entry fee. (Used to
  // reuse ENTRY_FEES_NETS.six_day_survivor; the Ladder Battle match
  // reward and the Top 20 prize pool split are unaffected by this, but
  // with no entry fee collected the real-money prize pool naturally
  // finalizes at 0 — see finalize_ladder_cup_prize_pool.)
  if (format === "ladder_cup") {
    return null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// League Ladder redesign — Phase A: LIVE per-tier Entry Fee / Match Reward
// / Early Bonus. Replaces the flat single-row placeholder Phase 4 left
// here ("entry fee should auto-adjust to the league below's match reward"
// was deferred at the time; this is that formula, now designed) and the
// stale pre-renumbering 8-row scale before that.
//
// Tier still counts up from the bottom since 20260868's renumbering —
// League 1 is entry-level, and each capacity-triggered league created
// above it (_rebalance_ladder_overflow_internal) gets the next number up,
// unbounded. Rather than a fixed per-tier table (which would go stale
// again the moment the ladder grows past whatever it was sized for),
// pricing is keyed off DISTANCE FROM THE CURRENT GROWTH FRONTIER:
//
//   d              = maxActiveTier - tier
//   MatchReward(d) = 4 + round(0.1 * d)   -- rate lowered from 0.5,
//                                          -- 20260903_ladder_match_reward_
//                                          -- slower_growth.sql — formula
//                                          -- shape kept linear/uncapped
//                                          -- on purpose, only the
//                                          -- coefficient changed
//   EntryFee(d)    = 0 if d = 0, else round(2 * MatchReward(d))
//   EarlyBonus(d)  = round(0.25 * MatchReward(d))
//
// d = 0 (the newest/highest-numbered active league) always prices at the
// floor — 0 / 4N / 1N — no matter how large the ladder has grown, since d
// is relative, not absolute.
//
// This file is pure (no React, no Supabase — see the file header), so it
// has no way to look up "the current max active tier" itself the way the
// SQL mirror's _ladder_current_max_tier_internal() can just query
// ladder_leagues. Every function below therefore takes maxActiveTier as
// an explicit argument — callers fetch it themselves (e.g.
// `select max(tier) from ladder_leagues where status = 'active'`, same
// query _ladder_current_max_tier_internal() runs) and pass it in.
//
// Mirrors supabase/migrations/20260869_ladder_live_tier_pricing.sql's
// _ladder_match_reward_for_tier / _ladder_entry_fee_for_tier /
// _ladder_early_bonus_for_tier, rate update in
// 20260903_ladder_match_reward_slower_growth.sql. Hand-sync convention,
// same as every other JS/SQL pair in this codebase — keep both in sync by
// hand if this ever changes, flagged on both sides.
// ─────────────────────────────────────────────────────────────────────────
function ladderTierRow(tier, maxActiveTier) {
  const d = maxActiveTier - tier;
  const matchReward = 4 + Math.round(0.1 * d);
  const entryFee = d === 0 ? 0 : Math.round(2 * matchReward);
  const earlyBonus = Math.round(0.25 * matchReward);
  return { entryFee, matchReward, earlyBonus };
}

// ladderEntryFeeForTier(tier, maxActiveTier) → Nets cost to join that
// tier right now. Charged only on a transition (auto-promotion, winning
// an auction bid, or a relegated arrival) — also that tier's bid floor
// per §4. Live, not a fixed table: the same tier's fee changes as the
// ladder grows and maxActiveTier moves, by design.
export function ladderEntryFeeForTier(tier, maxActiveTier) {
  return ladderTierRow(tier, maxActiveTier).entryFee;
}

// computeLadderMatchNets(tier, maxActiveTier, { firstLeg }) → Nets earned
// for one played League Ladder fixture: the tier's current Match Reward,
// plus its current Early Bonus on top if the fixture was part of the
// FIRST LEG of the double round-robin (rounds 1..roundsSingle of
// roundsTotal — the front half of the 10-round schedule in the normal
// 6-player case). Decided trigger, round-based rather than countdown-
// based: see supabase/migrations/20260878_ladder_early_bonus_round_
// trigger.sql, which is also where the SQL side actually wires this into
// crediting (this file stays pure — no fixture/round lookups here, the
// caller passes in which leg the fixture belongs to). Forfeited fixtures
// never call this — no reward for a double-forfeit.
export function computeLadderMatchNets(tier, maxActiveTier, { firstLeg = false } = {}) {
  const row = ladderTierRow(tier, maxActiveTier);
  return row.matchReward + (firstLeg ? row.earlyBonus : 0);
}

// Streak Bonuses (Phase 7): 2 wins in a row pays +10% of that league's
// CURRENT Match Reward, credited on top of the win's own Match Reward.
// Only kicks in from the 2nd consecutive win onward — a streak of 0 or 1
// (first win, or the streak was just broken by a draw/loss) pays
// nothing. "Current match reward" means the tier's normal
// computeLadderMatchNets base, not early-bonus-inflated — same
// ladderTierRow lookup, just its matchReward field, now live off
// maxActiveTier same as everything else in this section.
const LADDER_STREAK_BONUS_RATE = 0.10;
const LADDER_STREAK_BONUS_MIN_STREAK = 2;

export function computeLadderStreakBonus(tier, maxActiveTier, winStreak) {
  const streak = Number(winStreak) || 0;
  if (streak < LADDER_STREAK_BONUS_MIN_STREAK) return 0;
  const row = ladderTierRow(tier, maxActiveTier);
  return Math.round(row.matchReward * LADDER_STREAK_BONUS_RATE);
}

// computeLadderRetroactiveTopup(tier, newMaxActiveTier, previouslyPaid) →
// additional Nets owed for a Match Reward already credited at this tier,
// now that the ladder's max active tier has grown (Phase F). d = maxTier -
// tier is relative, so every existing league's Match Reward moves the
// instant a new frontier tier is born — a player paid earlier in the week,
// before that split, was priced at the d that held then; this is the gap
// between that and what the same fixture prices at right now.
//
// Always non-negative: d only ever grows within a week under this
// formula (the frontier only ever moves up mid-week, never down), so
// there's never a clawback case — but this still floors at 0 rather than
// trusting that invariant blindly, in case previouslyPaid ever reflects a
// tier that's since moved (shouldn't happen; cheap to guard anyway).
//
// Mirrors supabase/migrations/20260877_ladder_retroactive_topup.sql's
// _ladder_retroactive_topup_internal — same hand-sync convention as every
// other JS/SQL pair in this codebase. Pure — the SQL side is the one that
// actually walks ladder_reward_ledger and credits players; this just
// prices the delta for a single row, so it's testable without a database.
export function computeLadderRetroactiveTopup(tier, newMaxActiveTier, previouslyPaid) {
  const newReward = computeLadderMatchNets(tier, newMaxActiveTier);
  const delta = newReward - (Number(previouslyPaid) || 0);
  return delta > 0 ? delta : 0;
}

// Placement Bonus and Transfer Window/Reroll — Phase 7's other two
// pending items — are CONFIRMED DROPPED, not just deferred. Neither is
// built anywhere in this codebase (nothing to remove), and per spec
// they're staying that way: no placement-bonus credit exists in the
// weekly settlement, and there's no reroll/transfer-window mechanic
// alongside the League Ladder cycle. (This is distinct from the
// already-shipped Transfer Market — src/TransferMarket.jsx / the
// transfer_listings/transfer_offers tables — which is a normal club
// buy/sell market, not a Ladder "transfer window" mechanic, and is
// unaffected by this decision.)

const LADDER_TABLE_FEE_RATE = 0.20;

// computeTableFee(weeklyEarnings) → 20% of a stayer's total Nets earned
// that week (match rewards + early bonuses + streak bonuses, combined —
// no placement bonus, see above) — pay-as-you-earn, never a flat number.
// Rounded to the nearest whole Net (see §5's "≈5–6N" / "≈35N" worked
// examples). A player who earned nothing that week owes nothing.
export function computeTableFee(weeklyEarnings) {
  const earnings = Number(weeklyEarnings) || 0;
  if (earnings <= 0) return 0;
  return Math.round(earnings * LADDER_TABLE_FEE_RATE);
}

// computeLadderWeekFee(player, transitioned, weeklyEarnings, league,
// maxActiveTier) → the single fee this player owes at the Sunday 23:59 UTC
// settlement. Every player pays exactly one of these, never both, never
// neither:
//   - transitioned (promoted / won an auction bid / relegated arrival):
//     the DESTINATION league's live Entry Fee — weeklyEarnings is ignored.
//   - otherwise (stayed put): the 20% Table Fee on this week's earnings.
// `league` is whichever league prices the fee: the destination league for
// a transitioned player, the current league for a stayer (used only for
// its tier — Table Fee itself is earnings-based, not tier-based). `player`
// isn't used by the calculation itself; it's part of the signature so a
// future per-player override (e.g. a fee waiver) has somewhere to hook in
// without changing every call site. maxActiveTier is threaded through to
// ladderEntryFeeForTier same as everywhere else in the Phase A section
// above — Entry Fee is live, not a fixed table.
export function computeLadderWeekFee(player, transitioned, weeklyEarnings, league, maxActiveTier) {
  if (transitioned) {
    return ladderEntryFeeForTier(league && league.tier, maxActiveTier);
  }
  return computeTableFee(weeklyEarnings);
}

const LADDER_DECAY_PENALTY_RATE = 0.10;

// computeDecayPenalty(lifetimeEarnings, currentBalance) — Phase 7. Applies
// to a player who played zero matches in a week (checked by the caller via
// ladder_fixtures, not here — this is just the fee math): 10% of their
// ALL-TIME cumulative Nets earned in the ladder, not that week's (a fully
// inactive week earns 0 anyway, so charging off the week's earnings would
// always be a 0N penalty and defeat the point). Rounded down to the
// nearest whole Net, and capped at whatever they actually still have —
// lifetime earnings can be well above current balance if they've since
// spent Nets elsewhere in the app (shop, other formats), and the penalty
// should never push a wallet negative or fail the whole weekly settlement
// job over one player's spend history.
export function computeDecayPenalty(lifetimeEarnings, currentBalance) {
  const earnings = Number(lifetimeEarnings) || 0;
  const balance = Number(currentBalance) || 0;
  if (earnings <= 0 || balance <= 0) return 0;
  return Math.min(Math.floor(earnings * LADDER_DECAY_PENALTY_RATE), balance);
}

// ─────────────────────────────────────────────────────────────────────────
// Top 20 prize pool split — how a finished paid format's pool is divided.
// Only the top TOP20_PRIZE_SPLIT.length places get paid; with fewer than
// 20 participants the rest of the split is deliberately left unclaimed
// rather than redistributed, so finishing 1st in a 5-club league is worth
// the same 30% share it'd be in a full 20-club one — not a bigger slice of
// a smaller pie.
// ─────────────────────────────────────────────────────────────────────────
export const TOP20_PRIZE_SPLIT = [
  0.30,   // 1st
  0.1424, // 2nd
  0.0949, // 3rd
  0.0593, // 4th
  0.0593, // 5th
  0.0356, 0.0356, 0.0356, 0.0356, 0.0356, // 6th–10th
  0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, // 11th–20th
];

// computePrizePool(totalNets, participantCount) → [{ rank, nets }, ...]
//
// Pays min(participantCount, 20) places. Each place's exact share
// (totalNets × its split fraction) is floored to a whole Net; the sum of
// that flooring loss across the paid places — never the whole unclaimed
// tail below the last paid place — is credited to 1st, so the pool always
// pays out in whole Nets with minimal rounding drift and no double-dipping
// into the deliberately-unclaimed portion.
export function computePrizePool(totalNets, participantCount) {
  const paidPlaces = Math.min(participantCount, TOP20_PRIZE_SPLIT.length);
  if (paidPlaces <= 0) return [];

  const shares = TOP20_PRIZE_SPLIT.slice(0, paidPlaces).map((frac) => totalNets * frac);
  const floors = shares.map((s) => Math.floor(s));
  const flooredSum = floors.reduce((a, b) => a + b, 0);
  const exactSum = shares.reduce((a, b) => a + b, 0);
  floors[0] += Math.round(exactSum - flooredSum);

  return floors.map((nets, i) => ({ rank: i + 1, nets }));
}

// ─────────────────────────────────────────────────────────────────────────
// Ladder Cup prize pool split — Ladder Cup pays out separately from the
// pooled Top 20 system above (it's excluded there; see
// finalize_ladder_cup_prize_pool). Winner takes a flat 50% off the top;
// the remaining 50% is spread across 2nd–20th using the SAME relative
// shape TOP20_PRIZE_SPLIT uses for those places (2nd gets proportionally
// more than 20th, same taper), just rescaled so places 2–20 sum to 0.50
// instead of 0.70. Scale factor = 0.50 / (1 - TOP20_PRIZE_SPLIT[0]).
// ─────────────────────────────────────────────────────────────────────────
const LADDER_CUP_RUNNER_UP_SCALE = 0.50 / (1 - TOP20_PRIZE_SPLIT[0]); // 0.50 / 0.70

export const LADDER_CUP_PRIZE_SPLIT = [
  0.50, // 1st (champion)
  ...TOP20_PRIZE_SPLIT.slice(1).map((frac) => frac * LADDER_CUP_RUNNER_UP_SCALE),
];

// computeLadderCupPrizePool(totalNets, participantCount) → [{ rank, nets }, ...]
// Same pay-min(participants, 20)-places and floor-then-fix-up-on-1st
// rounding as computePrizePool, just against LADDER_CUP_PRIZE_SPLIT.
export function computeLadderCupPrizePool(totalNets, participantCount) {
  const paidPlaces = Math.min(participantCount, LADDER_CUP_PRIZE_SPLIT.length);
  if (paidPlaces <= 0) return [];

  const shares = LADDER_CUP_PRIZE_SPLIT.slice(0, paidPlaces).map((frac) => totalNets * frac);
  const floors = shares.map((s) => Math.floor(s));
  const flooredSum = floors.reduce((a, b) => a + b, 0);
  const exactSum = shares.reduce((a, b) => a + b, 0);
  floors[0] += Math.round(exactSum - flooredSum);

  return floors.map((nets, i) => ({ rank: i + 1, nets }));
}
