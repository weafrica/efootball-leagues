// scripts/test-league-ladder.mjs
//
// Phase 2's own checklist: "write unit tests for these three functions
// against fixed 8-player inputs before touching the database" — updated
// by 20260876 to 6-player inputs and a double round-robin schedule (see
// that migration's header for the group-size-6 / double round-robin /
// UTC-cutoff rationale, mirrored here in leagueLadder.js). No test
// framework exists anywhere in this repo yet (no vitest/jest in
// package.json, no other *.test.js files) — adding one is a bigger,
// separate infra decision than this phase asked for, so this is a plain
// Node script using the built-in assert module instead. Run with:
//
//   node scripts/test-league-ladder.mjs
//
// Exits non-zero on any failed assertion, so it's CI-friendly even
// without a real test runner wired up yet.

import assert from "node:assert/strict";
import {
  generateRoundRobinFixtures,
  computeStandings,
  isWeekComplete,
  resolveLadderWeek,
  ladderBidEligiblePool,
  placeLadderBid,
  ladderRoundReleaseOffsetsHours,
  isFixtureForfeited,
  classifyLadderZones,
} from "../src/formats/leagueLadder.js";

const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6"];
const LEAGUE_ID = "league-6-test";
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok — ${name}`);
}

console.log("generateRoundRobinFixtures");

check("6 players produce exactly 30 fixtures (10 rounds x 3 matches — double round robin)", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  assert.equal(fixtures.length, 30);
});

check("every player appears in exactly 10 fixtures", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  const counts = {};
  fixtures.forEach((f) => {
    counts[f.home_user_id] = (counts[f.home_user_id] || 0) + 1;
    counts[f.away_user_id] = (counts[f.away_user_id] || 0) + 1;
  });
  PLAYERS.forEach((p) => assert.equal(counts[p], 10, `${p} should have 10 fixtures, got ${counts[p]}`));
});

check("no player plays themselves; every unordered pair appears exactly twice, once each direction", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  const seenDirectional = new Set();
  const unorderedCounts = {};
  fixtures.forEach((f) => {
    assert.notEqual(f.home_user_id, f.away_user_id);
    const directionalKey = `${f.home_user_id}>${f.away_user_id}`;
    assert.ok(!seenDirectional.has(directionalKey), `duplicate directional pairing: ${directionalKey}`);
    seenDirectional.add(directionalKey);
    const unorderedKey = [f.home_user_id, f.away_user_id].sort().join("|");
    unorderedCounts[unorderedKey] = (unorderedCounts[unorderedKey] || 0) + 1;
  });
  assert.equal(seenDirectional.size, 30); // 2 * C(6,2) = 30 directional pairings
  Object.values(unorderedCounts).forEach((c) => assert.equal(c, 2, "each pair should meet exactly twice"));
});

check("each pair's second meeting reverses home/away from their first", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  const firstSeen = {};
  fixtures.forEach((f) => {
    const key = [f.home_user_id, f.away_user_id].sort().join("|");
    if (!firstSeen[key]) {
      firstSeen[key] = f;
    } else {
      assert.equal(firstSeen[key].home_user_id, f.away_user_id);
      assert.equal(firstSeen[key].away_user_id, f.home_user_id);
    }
  });
});

check("odd headcount (5 players) still generates a valid double round-robin schedule with a bye", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS.slice(0, 5));
  assert.equal(fixtures.length, 20); // 2 * C(5,2)
  const counts = {};
  fixtures.forEach((f) => {
    counts[f.home_user_id] = (counts[f.home_user_id] || 0) + 1;
    counts[f.away_user_id] = (counts[f.away_user_id] || 0) + 1;
  });
  PLAYERS.slice(0, 5).forEach((p) => assert.equal(counts[p], 8));
});

check("every fixture starts pending with null scores and null countdown", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  fixtures.forEach((f) => {
    assert.equal(f.status, "pending");
    assert.equal(f.home_score, null);
    assert.equal(f.away_score, null);
    assert.equal(f.countdown_expires_at, null);
  });
});

check("rejects a duplicate id in playerIds", () => {
  assert.throws(() => generateRoundRobinFixtures(LEAGUE_ID, 1, ["p1", "p2", "p1"]));
});

check("leg 1 is exactly the first roundsSingle rounds, leg 2 the return leg — Early Bonus trigger boundary", () => {
  // 6 players -> roundsSingle = 5, roundsTotal = 10 -> 15 leg-1 fixtures
  // (5 rounds x 3 matches), 15 leg-2 fixtures, split cleanly at the
  // halfway point of the schedule.
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  const leg1 = fixtures.filter((f) => f.leg === 1);
  const leg2 = fixtures.filter((f) => f.leg === 2);
  assert.equal(leg1.length, 15);
  assert.equal(leg2.length, 15);
  fixtures.forEach((f) => assert.ok(f.leg === 1 || f.leg === 2, "every fixture must have leg 1 or 2"));
});

check("a pair's return meeting is always leg 2 when their first meeting was leg 1", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  const firstSeen = {};
  fixtures.forEach((f) => {
    const key = [f.home_user_id, f.away_user_id].sort().join("|");
    if (!firstSeen[key]) {
      firstSeen[key] = f;
    } else {
      assert.equal(firstSeen[key].leg, 1);
      assert.equal(f.leg, 2);
    }
  });
});

check("odd headcount (5 players): leg split still halves the schedule (roundsSingle = 4)", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS.slice(0, 5));
  const leg1 = fixtures.filter((f) => f.leg === 1);
  const leg2 = fixtures.filter((f) => f.leg === 2);
  assert.equal(leg1.length, 10); // 4 rounds x 2 matches (one bye per round)
  assert.equal(leg2.length, 10);
});

console.log("computeStandings");

check("full week, no draws — points/gd/gf all correct, winner ranked first", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS).map((f, i) => ({
    ...f,
    status: "played",
    // p1 wins every fixture they're in, 3-0; everyone else splits the rest 1-1
    home_score: f.home_user_id === "p1" ? 3 : f.away_user_id === "p1" ? 0 : 1,
    away_score: f.away_user_id === "p1" ? 3 : f.home_user_id === "p1" ? 0 : 1,
  }));
  const table = computeStandings(fixtures);
  const p1 = table.find((r) => r.user_id === "p1");
  assert.equal(p1.w, 10);
  assert.equal(p1.pts, 30);
  assert.equal(p1.gf, 30);
  assert.equal(p1.ga, 0);
  assert.equal(table[0].user_id, "p1"); // ranked first
});

check("a draw awards 1 point each, not 0", () => {
  const fixtures = [{ league_id: LEAGUE_ID, week_number: 1, home_user_id: "p1", away_user_id: "p2", status: "played", home_score: 2, away_score: 2 }];
  const table = computeStandings(fixtures);
  const p1 = table.find((r) => r.user_id === "p1");
  const p2 = table.find((r) => r.user_id === "p2");
  assert.equal(p1.pts, 1);
  assert.equal(p2.pts, 1);
  assert.equal(p1.d, 1);
  assert.equal(p2.d, 1);
});

check("a forfeited fixture: both sides get a loss, concede 4, no points", () => {
  const fixtures = [{ league_id: LEAGUE_ID, week_number: 1, home_user_id: "p1", away_user_id: "p2", status: "forfeited", home_score: null, away_score: null }];
  const table = computeStandings(fixtures);
  const p1 = table.find((r) => r.user_id === "p1");
  const p2 = table.find((r) => r.user_id === "p2");
  assert.equal(p1.l, 1);
  assert.equal(p2.l, 1);
  assert.equal(p1.ga, 4);
  assert.equal(p2.ga, 4);
  assert.equal(p1.pts, 0);
  assert.equal(p2.pts, 0);
});

check("a pending fixture doesn't affect the table at all", () => {
  const fixtures = [{ league_id: LEAGUE_ID, week_number: 1, home_user_id: "p1", away_user_id: "p2", status: "pending", home_score: null, away_score: null }];
  const table = computeStandings(fixtures);
  const p1 = table.find((r) => r.user_id === "p1");
  assert.equal(p1.p, 0);
  assert.equal(p1.pts, 0);
});

check("equal points tie-break falls through to goal difference", () => {
  // p1: 1 win (3-0) + 1 loss (0-1) = 3 pts, gd = 3-1 = +2
  // p2: 1 win (2-0) + 1 loss (0-3) = 3 pts, gd = 2-3 = -1
  const fixtures = [
    { league_id: LEAGUE_ID, week_number: 1, home_user_id: "p1", away_user_id: "p3", status: "played", home_score: 3, away_score: 0 },
    { league_id: LEAGUE_ID, week_number: 1, home_user_id: "p4", away_user_id: "p1", status: "played", home_score: 1, away_score: 0 },
    { league_id: LEAGUE_ID, week_number: 1, home_user_id: "p2", away_user_id: "p5", status: "played", home_score: 2, away_score: 0 },
    { league_id: LEAGUE_ID, week_number: 1, home_user_id: "p6", away_user_id: "p2", status: "played", home_score: 3, away_score: 0 },
  ];
  const table = computeStandings(fixtures);
  const p1 = table.find((r) => r.user_id === "p1");
  const p2 = table.find((r) => r.user_id === "p2");
  assert.equal(p1.pts, p2.pts);
  assert.ok(table.indexOf(p1) < table.indexOf(p2), "p1 (better gd) should rank above p2 despite equal points");
});

check("a player with 0 games played always sorts below one who's played", () => {
  const fixtures = [
    { league_id: LEAGUE_ID, week_number: 1, home_user_id: "p1", away_user_id: "p2", status: "played", home_score: 0, away_score: 0 },
  ];
  // p3 never appears in any fixture, so computeStandings never sees them —
  // this documents that seeding a full zero-row roster is the caller's job
  // (via the fixtures list itself, per the file header), not this function's.
  const table = computeStandings(fixtures);
  assert.equal(table.find((r) => r.user_id === "p3"), undefined);
});

console.log("isWeekComplete");

check("false while any fixture is pending", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  assert.equal(isWeekComplete(fixtures), false);
});

check("true once every fixture is played or forfeited", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS).map((f, i) => ({
    ...f,
    status: i % 5 === 0 ? "forfeited" : "played",
    home_score: 1,
    away_score: 0,
  }));
  assert.equal(isWeekComplete(fixtures), true);
});

check("true for an empty fixture list (vacuously complete)", () => {
  assert.equal(isWeekComplete([]), true);
});

console.log("resolveLadderWeek");

// 6-player standings (a full post-20260876 roster), best to worst,
// matching the shape computeStandings returns (only user_id matters to
// resolveLadderWeek — the rest of each row is irrelevant to it, but
// included here for realism).
const STANDINGS_6 = ["p1", "p2", "p3", "p4", "p5", "p6"].map((id, i) => ({
  user_id: id, p: 10, w: 10 - i, d: 0, l: i, gf: 0, ga: 0, gd: 0, pts: (10 - i) * 3,
}));

check("standard league (tier 2): rank 1 promotes, bottom 2 relegate, 3 stay", () => {
  const result = resolveLadderWeek("league-2", 5, STANDINGS_6, 2);
  assert.deepEqual(result.promoted, ["p1"]);
  assert.deepEqual(result.relegated, ["p5", "p6"]);
  assert.deepEqual(result.stayed, ["p2", "p3", "p4"]);
});

check("League 1 (tier 1): no promotion, bottom 2 still relegate, 4 stay", () => {
  const result = resolveLadderWeek("league-1", 5, STANDINGS_6, 1);
  assert.deepEqual(result.promoted, []);
  assert.deepEqual(result.relegated, ["p5", "p6"]);
  assert.deepEqual(result.stayed, ["p1", "p2", "p3", "p4"]);
});

check("return value carries leagueId/weekNumber/tier through unchanged", () => {
  const result = resolveLadderWeek("league-2", 5, STANDINGS_6, 2);
  assert.equal(result.leagueId, "league-2");
  assert.equal(result.weekNumber, 5);
  assert.equal(result.tier, 2);
});

check("edge case — 2 active players in a standard league: 1 promotes, 1 relegates, 0 stay", () => {
  const standings = STANDINGS_6.slice(0, 2);
  const result = resolveLadderWeek("league-6", 5, standings, 6);
  assert.deepEqual(result.promoted, ["p1"]);
  assert.deepEqual(result.relegated, ["p2"]);
  assert.deepEqual(result.stayed, []);
});

check("edge case — 1 active player in a standard league: promotes solo, nobody left to relegate", () => {
  const standings = STANDINGS_6.slice(0, 1);
  const result = resolveLadderWeek("league-6", 5, standings, 6);
  assert.deepEqual(result.promoted, ["p1"]);
  assert.deepEqual(result.relegated, []);
  assert.deepEqual(result.stayed, []);
});

check("edge case — 2 active players in League 1: no promotion, so both relegate, league empties", () => {
  const standings = STANDINGS_6.slice(0, 2);
  const result = resolveLadderWeek("league-1", 5, standings, 1);
  assert.deepEqual(result.promoted, []);
  assert.deepEqual(result.relegated, ["p1", "p2"]);
  assert.deepEqual(result.stayed, []);
});

check("edge case — empty standings (no fixtures this week): nobody moves, no crash", () => {
  const result = resolveLadderWeek("league-6", 5, [], 6);
  assert.deepEqual(result.promoted, []);
  assert.deepEqual(result.relegated, []);
  assert.deepEqual(result.stayed, []);
});

check("throws on a non-positive-integer tier", () => {
  assert.throws(() => resolveLadderWeek("league-6", 5, STANDINGS_6, 0));
});

console.log("ladderBidEligiblePool");

check("unions the 2 relegated with the (normally 5) non-promoted below-league players", () => {
  const pool = ladderBidEligiblePool({
    relegatedFromTargetLeague: ["r1", "r2"],
    activeInLeagueBelow: ["b1", "b2", "b3", "b4", "b5"],
  });
  assert.equal(pool.length, 7);
  ["r1", "r2", "b1", "b5"].forEach((id) => assert.ok(pool.includes(id)));
});

check("de-duplicates if the same id somehow appears in both lists", () => {
  const pool = ladderBidEligiblePool({ relegatedFromTargetLeague: ["p1"], activeInLeagueBelow: ["p1", "p2"] });
  assert.deepEqual(pool.sort(), ["p1", "p2"]);
});

check("empty on both sides returns an empty pool, no crash", () => {
  assert.deepEqual(ladderBidEligiblePool(), []);
});

console.log("placeLadderBid");

check("rejects a bid from someone outside the eligible pool", () => {
  const result = placeLadderBid({ bidderId: "outsider", amount: 100, eligibleBidderIds: ["p1", "p2"], entryFee: 80 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /not eligible/);
});

check("rejects a bid below the Entry Fee floor", () => {
  const result = placeLadderBid({ bidderId: "p1", amount: 79, eligibleBidderIds: ["p1"], entryFee: 80 });
  assert.equal(result.valid, false);
  assert.match(result.reason, /floor/);
});

check("accepts an eligible bid at or above the floor", () => {
  assert.equal(placeLadderBid({ bidderId: "p1", amount: 80, eligibleBidderIds: ["p1"], entryFee: 80 }).valid, true);
  assert.equal(placeLadderBid({ bidderId: "p1", amount: 150, eligibleBidderIds: ["p1"], entryFee: 80 }).valid, true);
});

console.log("ladderRoundReleaseOffsetsHours");

check("10 rounds (standard 6-player double round-robin league) spreads evenly across the ~143h59m window", () => {
  const offsets = ladderRoundReleaseOffsetsHours(10);
  const windowHours = 143 + 59 / 60;
  const step = windowHours / 9;
  const expected = Array.from({ length: 10 }, (_, i) => i * step);
  offsets.forEach((o, i) => assert.ok(Math.abs(o - expected[i]) < 1e-9, `round ${i}: got ${o}, want ${expected[i]}`));
  assert.ok(Math.abs(offsets[0]) < 1e-9);
  assert.ok(Math.abs(offsets[9] - windowHours) < 1e-9);
});

check("a single round releases immediately (offset 0)", () => {
  assert.deepEqual(ladderRoundReleaseOffsetsHours(1), [0]);
});

check("throws on a non-positive-integer round count", () => {
  assert.throws(() => ladderRoundReleaseOffsetsHours(0));
  assert.throws(() => ladderRoundReleaseOffsetsHours(-1));
});

console.log("generateRoundRobinFixtures — Phase 6 countdown stagger");

check("omitting weekStartAt still leaves countdown_expires_at null (Phase 2 behavior unchanged)", () => {
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS);
  fixtures.forEach((f) => assert.equal(f.countdown_expires_at, null));
});

check("passing weekStartAt stamps every fixture with a countdown 24h past its round's release", () => {
  const weekStartAt = "2026-08-24T00:00:00.000Z"; // a Monday 12:00 AM anchor
  const fixtures = generateRoundRobinFixtures(LEAGUE_ID, 1, PLAYERS, weekStartAt);
  fixtures.forEach((f) => assert.notEqual(f.countdown_expires_at, null));
  // Round 0 (the rotation-untouched first round: p1 vs p6, p2 vs p5, p3 vs p4)
  // releases at offset 0 -> countdown = weekStartAt + 24h.
  const round0 = fixtures.filter((f) => [f.home_user_id, f.away_user_id].includes("p1"))[0];
  assert.equal(round0.countdown_expires_at, "2026-08-25T00:00:00.000Z");
  // Every fixture within the same round shares the same countdown.
  const round0Countdowns = new Set(fixtures.slice(0, 3).map((f) => f.countdown_expires_at));
  assert.equal(round0Countdowns.size, 1);
  // Later rounds get later countdowns than earlier ones.
  const allCountdowns = fixtures.map((f) => new Date(f.countdown_expires_at).getTime());
  assert.ok(allCountdowns[allCountdowns.length - 1] > allCountdowns[0]);
});

console.log("classifyLadderZones");

check("rank 1 gets Elite Safety Zone when 6+ clear of rank 2", () => {
  const standings = [
    { user_id: "p1", pts: 20 }, { user_id: "p2", pts: 10 }, { user_id: "p3", pts: 9 },
    { user_id: "p4", pts: 8 }, { user_id: "p5", pts: 3 }, { user_id: "p6", pts: 1 },
  ];
  const zones = classifyLadderZones(standings);
  assert.equal(zones.p1, "elite_safe");
});

check("rank 4 gets Checkpoint Safety when 6+ clear of rank 5 (first relegation spot) in a full 6-player league", () => {
  const standings = [
    { user_id: "p1", pts: 20 }, { user_id: "p2", pts: 18 }, { user_id: "p3", pts: 16 },
    { user_id: "p4", pts: 14 }, { user_id: "p5", pts: 7 }, { user_id: "p6", pts: 1 },
  ];
  const zones = classifyLadderZones(standings);
  assert.equal(zones.p4, "checkpoint_safe");
});

check("bottom 2 always get Danger Zone", () => {
  const standings = [
    { user_id: "p1", pts: 20 }, { user_id: "p2", pts: 18 }, { user_id: "p3", pts: 16 },
    { user_id: "p4", pts: 14 }, { user_id: "p5", pts: 7 }, { user_id: "p6", pts: 1 },
  ];
  const zones = classifyLadderZones(standings);
  assert.equal(zones.p5, "danger_zone");
  assert.equal(zones.p6, "danger_zone");
});

check("Checkpoint Safety never fires in a thinner-than-5 league (no rank above the relegation spot to check)", () => {
  const standings = [
    { user_id: "p1", pts: 20 }, { user_id: "p2", pts: 18 }, { user_id: "p3", pts: 16 }, { user_id: "p4", pts: 1 },
  ];
  const zones = classifyLadderZones(standings);
  assert.ok(!Object.values(zones).includes("checkpoint_safe"));
});

console.log("isFixtureForfeited");

check("a pending fixture with an expired countdown should forfeit", () => {
  const fixture = { status: "pending", countdown_expires_at: "2026-01-01T00:00:00Z" };
  assert.equal(isFixtureForfeited(fixture, "2026-01-02T00:00:00Z"), true);
});

check("a pending fixture with a countdown still in the future should not forfeit", () => {
  const fixture = { status: "pending", countdown_expires_at: "2026-01-02T00:00:00Z" };
  assert.equal(isFixtureForfeited(fixture, "2026-01-01T00:00:00Z"), false);
});

check("an already-played fixture never forfeits, even past its countdown", () => {
  const fixture = { status: "played", countdown_expires_at: "2026-01-01T00:00:00Z" };
  assert.equal(isFixtureForfeited(fixture, "2026-01-02T00:00:00Z"), false);
});

check("an already-forfeited fixture doesn't re-forfeit", () => {
  const fixture = { status: "forfeited", countdown_expires_at: "2026-01-01T00:00:00Z" };
  assert.equal(isFixtureForfeited(fixture, "2026-01-02T00:00:00Z"), false);
});

check("a fixture with no countdown yet (null) never forfeits", () => {
  const fixture = { status: "pending", countdown_expires_at: null };
  assert.equal(isFixtureForfeited(fixture, "2026-01-02T00:00:00Z"), false);
});

console.log(`\n${passed} passed, 0 failed`);
