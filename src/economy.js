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
// knockout, groups_knockout, ladder_cup) onto ENTRY_FEES_NETS. 'league'
// covers every round-robin/survivor shape, per the "normal leagues +
// survivor-format leagues" comment above. ladder_cup ("Survival Ladder
// Cup" — ranked ladder, one elimination life each, decided by the weekly
// Sunday cutoff, see LADDER_CUP_INTEGRATION.md) is the "Six-Day Survivor
// Cup" ENTRY_FEES_NETS.six_day_survivor was priced for — confirmed, not
// a separate never-built format as previously flagged here.
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
  if (format === "ladder_cup") {
    return ENTRY_FEES_NETS.six_day_survivor;
  }
  return null;
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
