// scripts/test-ladder-fees.mjs
//
// League Ladder redesign — Phase A checklist: unit test against the live
// tier-pricing formulas (d = maxActiveTier - tier) so a future rate
// change is caught by a failing test, not by someone re-deriving the
// math by hand. Same no-framework, plain-assert convention as
// test-league-ladder.mjs (Phase 2) — run with:
//
//   node scripts/test-ladder-fees.mjs
//
// Exits non-zero on any failed assertion.

import assert from "node:assert/strict";
import {
  ladderEntryFeeForTier,
  computeLadderMatchNets,
  computeTableFee,
  computeLadderWeekFee,
  computeDecayPenalty,
  computeLadderRetroactiveTopup,
} from "../src/economy.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}

console.log("ladderEntryFeeForTier / computeLadderMatchNets — live tier pricing (Phase A)");

check("d = 0 (the current frontier tier) always resolves to 0N entry / 4N match reward / 1N early bonus, at any ladder size", () => {
  // Same d = 0 regardless of how large maxActiveTier has grown — this is
  // the whole point of pricing off distance-from-frontier instead of a
  // fixed per-tier table.
  [1, 8, 50, 1000].forEach((maxActiveTier) => {
    assert.equal(ladderEntryFeeForTier(maxActiveTier, maxActiveTier), 0, `maxActiveTier ${maxActiveTier}`);
    assert.equal(computeLadderMatchNets(maxActiveTier, maxActiveTier), 4, `maxActiveTier ${maxActiveTier}`);
    assert.equal(computeLadderMatchNets(maxActiveTier, maxActiveTier, { firstLeg: true }), 5, `maxActiveTier ${maxActiveTier}`);
  });
});

check("Early Bonus trigger is round-based (first leg), not opt-in by default — omitting firstLeg pays no bonus", () => {
  const maxActiveTier = 10;
  assert.equal(computeLadderMatchNets(7, maxActiveTier), computeLadderMatchNets(7, maxActiveTier, { firstLeg: false }));
  assert.ok(computeLadderMatchNets(7, maxActiveTier, { firstLeg: true }) > computeLadderMatchNets(7, maxActiveTier, { firstLeg: false }));
});

check("consecutive d values never jump more than 1N in match reward", () => {
  const maxActiveTier = 30;
  let prevReward = null;
  for (let tier = 1; tier <= maxActiveTier; tier++) {
    const reward = computeLadderMatchNets(tier, maxActiveTier);
    if (prevReward !== null) {
      assert.ok(Math.abs(reward - prevReward) <= 1, `tier ${tier}: ${prevReward} -> ${reward}`);
    }
    prevReward = reward;
  }
});

check("match reward grows with distance from the frontier (d=1 -> 4N, d=3 -> 4N, d=9 -> 5N)", () => {
  // rate lowered 0.5 -> 0.1 per tier of depth, 20260903 — formula shape
  // (linear in d, uncapped) unchanged, only the coefficient moved
  const maxActiveTier = 10;
  assert.equal(computeLadderMatchNets(9, maxActiveTier), 4); // d=1: 4 + round(0.1) = 4
  assert.equal(computeLadderMatchNets(7, maxActiveTier), 4); // d=3: 4 + round(0.3) = 4
  assert.equal(computeLadderMatchNets(1, maxActiveTier), 5); // d=9: 4 + round(0.9) = 5
});

check("entry fee is 2x the match reward once off the frontier, 0 at the frontier", () => {
  const maxActiveTier = 10;
  assert.equal(ladderEntryFeeForTier(10, maxActiveTier), 0); // d=0
  assert.equal(ladderEntryFeeForTier(8, maxActiveTier), 2 * computeLadderMatchNets(8, maxActiveTier)); // d=2
});

console.log("computeTableFee");

check("League 1 worked example: ~175N week -> ~35N Table Fee", () => {
  assert.equal(computeTableFee(175), 35);
});

check("League 8 worked example: ~28N week -> 5-6N Table Fee", () => {
  const fee = computeTableFee(28);
  assert.ok(fee === 5 || fee === 6, `expected 5 or 6, got ${fee}`);
  assert.equal(fee, 6); // 28 * 0.20 = 5.6 -> rounds to 6
});

check("a player who earned nothing owes nothing", () => {
  assert.equal(computeTableFee(0), 0);
});

console.log("computeLadderWeekFee");

check("transitioned player owes the destination league's live Entry Fee, earnings ignored", () => {
  const maxActiveTier = 10;
  const fee = computeLadderWeekFee({ id: "p1" }, true, 999, { tier: 5 }, maxActiveTier);
  assert.equal(fee, ladderEntryFeeForTier(5, maxActiveTier));
});

check("a stayer owes the 20% Table Fee, transition league ignored", () => {
  const fee = computeLadderWeekFee({ id: "p1" }, false, 175, { tier: 10 }, 10);
  assert.equal(fee, 35);
});

check("a player transitioning into the current frontier tier (d=0, free to enter) owes 0", () => {
  const maxActiveTier = 10;
  const fee = computeLadderWeekFee({ id: "p1" }, true, 999, { tier: maxActiveTier }, maxActiveTier);
  assert.equal(fee, 0);
});

check("every player pays exactly one fee type per week (never both)", () => {
  const player = { id: "p1" };
  const weeklyEarnings = 175;
  const maxActiveTier = 10;
  const league = { tier: 5 };
  const entryFee = computeLadderWeekFee(player, true, weeklyEarnings, league, maxActiveTier);
  const tableFee = computeLadderWeekFee(player, false, weeklyEarnings, league, maxActiveTier);
  assert.notEqual(entryFee, tableFee);
  assert.equal(entryFee, ladderEntryFeeForTier(5, maxActiveTier));
  assert.equal(tableFee, computeTableFee(weeklyEarnings));
});

console.log("\ncomputeDecayPenalty — Phase 7");

check("10% of lifetime earnings, rounded down", () => {
  assert.equal(computeDecayPenalty(999, 999), 99);
});

check("capped at current balance when lifetime earnings outstrip it", () => {
  assert.equal(computeDecayPenalty(1000, 40), 40);
});

check("zero lifetime earnings owes nothing", () => {
  assert.equal(computeDecayPenalty(0, 500), 0);
});

check("zero current balance owes nothing, even with lifetime earnings", () => {
  assert.equal(computeDecayPenalty(500, 0), 0);
});

console.log("\ncomputeLadderRetroactiveTopup — Phase F");

check("no top-up owed when the frontier hasn't moved since payment", () => {
  const maxActiveTier = 10;
  const alreadyPaid = computeLadderMatchNets(7, maxActiveTier);
  assert.equal(computeLadderRetroactiveTopup(7, maxActiveTier, alreadyPaid), 0);
});

check("a split that raises the frontier tops up every league whose d just grew", () => {
  const tier = 7;
  const oldMaxActiveTier = 10; // d = 3 at payment time
  const paidThen = computeLadderMatchNets(tier, oldMaxActiveTier);
  const newMaxActiveTier = 12; // a split two tiers up: d is now 5
  const topup = computeLadderRetroactiveTopup(tier, newMaxActiveTier, paidThen);
  assert.equal(topup, computeLadderMatchNets(tier, newMaxActiveTier) - paidThen);
  assert.ok(topup > 0);
});

check("a league that keeps pace with the frontier (still d=0 after the split) owes nothing", () => {
  // The newly-born split-off league is the new frontier itself (d=0 at
  // birth, priced and paid at the new maxActiveTier directly) — nothing
  // for a top-up pass to find there.
  const maxActiveTier = 11;
  assert.equal(computeLadderRetroactiveTopup(maxActiveTier, maxActiveTier, computeLadderMatchNets(maxActiveTier, maxActiveTier)), 0);
});

check("never returns a negative top-up even if previouslyPaid already exceeds the recomputed reward", () => {
  assert.equal(computeLadderRetroactiveTopup(5, 10, 9999), 0);
});

check("previouslyPaid defaults to 0 when omitted/undefined, topping up the full current reward", () => {
  const maxActiveTier = 10;
  assert.equal(computeLadderRetroactiveTopup(6, maxActiveTier, undefined), computeLadderMatchNets(6, maxActiveTier));
});

console.log(`\n${passed} passed`);
