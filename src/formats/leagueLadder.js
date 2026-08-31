// src/formats/leagueLadder.js
//
// WEAFRICA LEAGUE LADDER SYSTEM — core engine, Phase 2 of the build plan.
//
// This slice covers just the weekly cycle's sport, not its economy: fixtures
// generate, matches get played, standings compute correctly. No fees, no
// promotion/relegation, no bidding — those are Phases 3-5. Field names
// mirror the app's existing round-robin standings shape (App.jsx's
// computeStandings: p/w/d/l/gf/ga/gd/pts), not ladderCup.js's w/l/gd-only
// shape, since this format has draws and that one doesn't.
//
// Pure functions only — no React, no Supabase. Every function here takes
// plain data in and returns plain data out; whatever calls these decides
// how to persist the result (see Phase 2's own checklist: the Supabase
// scheduled function and result-submission RPC are separate, not part of
// this file).
//
// resolveLadderWeek (added for Phase 3) lives in this file too — it's a
// pure classification function only (given a league's final standings,
// who's promoted/relegated/stayed). It does NOT write anything to
// ladder_memberships, generate next week's rows, auto-create a new bottom
// league, or handle the auction fall-through — those are all orchestration
// concerns that belong to the Sunday 23:59 UTC resolve job
// (_ladder_resolve_promotion_relegation_internal, in the Phase 3
// migration), which reimplements this same classification logic in SQL
// for the same reason _generate_round_robin_fixtures_internal reimplements
// generateRoundRobinFixtures — a cron job can't call out to this file.
//
// NOT in this file yet (coming in later phases):
//   - fee settlement (Phase 4)
//   - bidding / auction fall-through (Phase 5)
//
// Phase 6 (fixture countdown & forfeit automation) added two things below:
//   - generateRoundRobinFixtures now takes an optional weekStartAt and, when
//     given one, stamps every fixture's countdown_expires_at per plan §6's
//     staggered release schedule (see ladderRoundReleaseOffsetsHours).
//     Omitting weekStartAt keeps the old Phase 2 behavior (countdown left
//     null) — every existing caller/test that doesn't pass it is unaffected.
//   - isFixtureForfeited, a pure predicate the hourly sweep job's logic
//     mirrors in SQL (same split as every other pure/SQL pair here).

const LADDER_ROSTER_SIZE = 6; // players per league — see 20260876's group-size-6 change (was 8)

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 — fixture countdown stagger (plan §6), window recalculated by
// 20260876 for the corrected literal-UTC cutoff and the new double
// round-robin round count. Each round of fixtures (not each individual
// match — players in the same round release together) gets its own
// release time, evenly spaced across a ~143h59m window: Monday 00:00 UTC
// through Saturday 23:59 UTC, so every fixture still gets a full 24-hour
// play window before the Sunday 23:59 UTC hard cutoff (previously Sunday
// 10:00 PM SAST, wrongly converted in 20260875 and corrected here — see
// that migration's header). Generalized to whatever round count a given
// league actually produces: LADDER_ROSTER_SIZE is fixed at 6, giving 10
// rounds (double round-robin, 2*(6-1)) in the normal case, but a
// thin/bye-padded or mid-week-born league can produce a different count.
// ─────────────────────────────────────────────────────────────────────────
const LADDER_COUNTDOWN_WINDOW_HOURS = 143 + 59 / 60; // Mon 00:00 UTC -> Sat 23:59 UTC
const LADDER_COUNTDOWN_MATCH_WINDOW_HOURS = 24; // each fixture's own play window

// ladderRoundReleaseOffsetsHours(roundCount) → array of hour-offsets from
// weekStartAt (Monday 00:00 UTC) at which each round releases. For the
// standard 10-round (6-player, double round-robin) case this spreads
// evenly across the ~143h59m window above (step ≈ 16 hours between
// rounds). A single round has nothing to stagger against, so it just
// releases at offset 0 (immediately).
export function ladderRoundReleaseOffsetsHours(roundCount) {
  if (!Number.isInteger(roundCount) || roundCount < 1) {
    throw new Error("ladderRoundReleaseOffsetsHours: roundCount must be a positive integer");
  }
  if (roundCount === 1) return [0];
  const step = LADDER_COUNTDOWN_WINDOW_HOURS / (roundCount - 1);
  return Array.from({ length: roundCount }, (_, i) => i * step);
}

// ─────────────────────────────────────────────────────────────────────────
// generateRoundRobinFixtures — DOUBLE round robin as of 20260876: every
// pair plays each other twice, once with each as home. Built on the same
// "circle method" App.jsx's roundRobin() uses, reimplemented locally so
// this module stays self-contained like ladderCup.js. For 6 players this
// produces exactly 10 rounds of 3 matches — 10 fixtures per player, no
// double-booking within a round (though nothing here actually depends on
// rounds being played in order — players can complete fixtures in any
// order per plan §2. The round index itself is still only ever used
// locally to pick a release offset, never persisted. What IS persisted
// per row is `leg`, 1|2 — added by 20260878 so the round-based Early
// Bonus trigger has something stable to check at credit time: leg 1 is
// the first roundsSingle rounds, leg 2 is the return leg).
//
// Mechanically: the circle-method rotation is a single (n-1)-cycle, so
// running it for exactly n-1 rounds always returns the player array to
// its original order. Rather than deriving a second rotation sequence for
// the return leg, the loop below just keeps rotating for 2*(n-1) rounds
// total and swaps home/away for the second half — round r and round
// r+(n-1) land on the exact same pairing-by-index, just reversed, which
// is precisely a return leg. Same reasoning as the SQL port
// (_generate_round_robin_fixtures_internal, 20260876 migration).
//
// Handles an odd-length playerIds (a league mid-fill, below the nominal
// 6) by padding with a bye the same way App.jsx's version does — one
// player sits out each round rather than the function failing. Not
// expected to happen once Phase 3's auto-create-league logic is in place,
// but cheap insurance against calling this before a league is actually
// full.
//
// weekStartAt (optional) — a Date/ISO-string/epoch for that week's Monday
// 00:00 UTC opening. When given, every fixture in a round gets the same
// countdown_expires_at: that round's staggered release time (see
// ladderRoundReleaseOffsetsHours) plus the 24h match window. Omitted (the
// Phase 2 default) leaves countdown_expires_at null on every row, same as
// before Phase 6.
//
// Returns plain objects shaped for a bulk insert into ladder_fixtures —
// no id/created_at (db-generated), status/scores at their "not played
// yet" defaults. Unlike the SQL version, this pure function has no
// database to check, so it always emits every fixture for both legs; the
// "skip a pairing that already has a played/forfeited result" resync
// behavior is a SQL-side (_generate_round_robin_fixtures_internal) concern
// only, per this file's own "whatever calls these decides how to persist"
// header note.
// ─────────────────────────────────────────────────────────────────────────
export function generateRoundRobinFixtures(leagueId, weekNumber, playerIds, weekStartAt) {
  if (!leagueId) throw new Error("generateRoundRobinFixtures: leagueId is required");
  if (!Number.isInteger(weekNumber) || weekNumber < 1) throw new Error("generateRoundRobinFixtures: weekNumber must be a positive integer");
  const uniqueIds = [...new Set(playerIds || [])];
  if (uniqueIds.length !== (playerIds || []).length) throw new Error("generateRoundRobinFixtures: playerIds contains a duplicate");
  if (uniqueIds.length < 2) throw new Error("generateRoundRobinFixtures: need at least 2 players");

  const ids = [...uniqueIds];
  if (ids.length % 2 !== 0) ids.push(null); // bye slot for an odd headcount
  const n = ids.length;
  const roundsSingle = n - 1;
  const roundsTotal = 2 * roundsSingle; // double round robin: home leg + away leg
  const fixtures = [];

  const startMs = weekStartAt != null ? new Date(weekStartAt).getTime() : null;
  const releaseOffsets = weekStartAt != null ? ladderRoundReleaseOffsetsHours(roundsTotal) : null;

  for (let r = 0; r < roundsTotal; r++) {
    const leg2 = r >= roundsSingle;
    const countdownExpiresAt = releaseOffsets
      ? new Date(startMs + (releaseOffsets[r] + LADDER_COUNTDOWN_MATCH_WINDOW_HOURS) * 3600 * 1000).toISOString()
      : null;
    for (let i = 0; i < n / 2; i++) {
      // return leg: same pairing this rotation position produced in leg
      // 1 (the array is back to its original order by now — a single
      // (n-1)-cycle completes exactly every roundsSingle rotations),
      // home/away reversed.
      const home = leg2 ? ids[n - 1 - i] : ids[i];
      const away = leg2 ? ids[i] : ids[n - 1 - i];
      if (home === null || away === null) continue; // this round's bye
      fixtures.push({
        league_id: leagueId,
        week_number: weekNumber,
        home_user_id: home,
        away_user_id: away,
        countdown_expires_at: countdownExpiresAt,
        status: "pending",
        home_score: null,
        away_score: null,
        played_at: null,
        leg: leg2 ? 2 : 1,
      });
    }
    // Rotate every round, leg 1 and leg 2 alike — by design: it's the
    // leg2 flag, not the array's rotation state, that decides home/away,
    // so letting the rotation keep cycling through leg 2 just replays leg
    // 1's exact index pairings again, which is what leg 2 needs.
    ids.splice(1, 0, ids.pop());
  }

  return fixtures;
}

// ─────────────────────────────────────────────────────────────────────────
// computeStandings — points table from a set of fixtures, no playerIds
// param: every player who's meant to be in the table already appears in
// the fixtures list (generateRoundRobinFixtures guarantees everyone gets
// 2*(LADDER_ROSTER_SIZE - 1) fixtures for a full 6-player double
// round-robin league — 10 fixtures each), so seeding
// the table purely from the fixtures themselves is enough — no separate
// roster input needed, matching the signature the build plan specifies.
//
// Scoring: classic win=3/draw=1/loss=0 — the same points convention
// App.jsx's own computeStandings already uses for round-robin leagues.
// This is table POINTS, not Nets — completely separate from plan §5's
// flat, participation-based Match Reward (a fixed amount per fixture
// played, win or lose, not tied to these points at all). Don't confuse
// the two when Phase 4 wires up rewards.
//
// A 'forfeited' fixture (Phase 6's missed-countdown rule) scores exactly
// like the app's existing no-show handling: both sides get a recorded
// loss and concede 4 goals, nobody scores, no points either way — same
// shape as isFixtureLocked's no-show branch elsewhere in the app, kept
// consistent rather than inventing a different forfeit scoring rule here.
//
// Tie-break: plan §3/§4 say "highest points wins" for promotion/bidding
// decisions, but points alone can't produce a strict order when two
// players are level. Falls through to goal difference, then goals for,
// then user_id (stable, arbitrary but deterministic) — same secondary
// sort shape App.jsx's computeStandings already uses (gd, then gf, then a
// final deterministic key), just with user_id standing in for team name
// since players here aren't clubs.
//
// A player with zero matches played always sorts below anyone who's
// played at least one game, regardless of points/gd (both start at 0) —
// again matching the existing app's standings behavior, so an untested
// or newly-arrived player is never mistaken for one who's played and
// simply had a perfect scoreless run.
// ─────────────────────────────────────────────────────────────────────────
export function computeStandings(fixtures) {
  const table = {};
  const ensure = (userId) => {
    if (!table[userId]) table[userId] = { user_id: userId, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
    return table[userId];
  };

  (fixtures || []).forEach((f) => {
    const h = ensure(f.home_user_id);
    const a = ensure(f.away_user_id);

    // A corrected forfeit (admin used correct_ladder_fixture_result on a
    // 'forfeited' fixture — see 20260904/20260905) has real numbers in
    // home_score/away_score where an untouched auto-forfeit has null (see
    // 20260862's sweep). Score it exactly like "played" once that's true;
    // only fall back to the flat double-forfeit outcome while it's still
    // null. Keeps this in lockstep with the SQL resolve's own fallback.
    const forfeitHasRealScore = f.status === "forfeited" && f.home_score != null && f.away_score != null;

    if (f.status === "played" || forfeitHasRealScore) {
      h.p++; a.p++;
      h.gf += f.home_score; h.ga += f.away_score;
      a.gf += f.away_score; a.ga += f.home_score;
      if (f.home_score > f.away_score) { h.w++; h.pts += 3; a.l++; }
      else if (f.home_score < f.away_score) { a.w++; a.pts += 3; h.l++; }
      else { h.d++; a.d++; h.pts += 1; a.pts += 1; }
    } else if (f.status === "forfeited") {
      h.p++; a.p++; h.l++; a.l++;
      h.ga += 4; a.ga += 4; // double-forfeit: both concede 4, neither scores, no points
    }
    // status === "pending" doesn't affect the table yet
  });

  const rows = Object.values(table);
  rows.forEach((r) => { r.gd = r.gf - r.ga; });

  rows.sort((a, b) => {
    const aPlayed = a.p > 0 ? 1 : 0;
    const bPlayed = b.p > 0 ? 1 : 0;
    if (aPlayed !== bPlayed) return bPlayed - aPlayed;
    return b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || String(a.user_id).localeCompare(String(b.user_id));
  });

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// isWeekComplete — true once every fixture is settled one way or another
// (played or forfeited), false if anything's still pending. This is the
// gate Phase 3's resolve job checks before it's safe to finalize a week —
// it does NOT enforce the Sunday 23:59 UTC cutoff itself (that's the
// scheduled 'ladder-close-week-sunday' cron job's job — see 20260876), it
// just answers "is there anything left unplayed right now."
// ─────────────────────────────────────────────────────────────────────────
export function isWeekComplete(fixtures) {
  return (fixtures || []).every((f) => f.status === "played" || f.status === "forfeited");
}

// ─────────────────────────────────────────────────────────────────────────
// isFixtureForfeited — Phase 6's missed-fixture predicate (plan §6): true
// once a still-pending fixture's countdown has expired, meaning it's due
// to become an automatic double-forfeit (both sides 4-0, no match
// reward). Pure predicate only — doesn't write anything or decide
// anything about points/rewards itself (see computeStandings' own
// 'forfeited' branch and economy.js's "forfeited fixtures never call
// computeLadderMatchNets" note for those). The hourly sweep job's SQL
// (_ladder_forfeit_expired_fixtures_internal, Phase 6 migration)
// reimplements this exact same countdown_expires_at < now() check
// server-side — same "JS is the tested reference, SQL reimplements for
// the scheduled job" split as generateRoundRobinFixtures.
//
// A fixture with no countdown yet (null — not staggered, or Phase 6
// hasn't run) never forfeits; neither does anything already played or
// forfeited.
// ─────────────────────────────────────────────────────────────────────────
export function isFixtureForfeited(fixture, now = new Date()) {
  if (!fixture || fixture.status !== "pending" || !fixture.countdown_expires_at) return false;
  return new Date(fixture.countdown_expires_at).getTime() < new Date(now).getTime();
}

// ─────────────────────────────────────────────────────────────────────────
// resolveLadderWeek — Phase 3's promotion/relegation classifier. Pure
// function: given a league's final standings for the week (the array
// computeStandings returns, already sorted best-to-worst) plus that
// league's tier, decides who's promoted, who's relegated, and who stays.
// leagueId/weekNumber aren't used by the classification logic itself —
// they're carried through onto the return value so callers (and tests)
// don't have to re-attach them separately, matching the plan's own
// `resolveLadderWeek(leagueId, weekNumber)` call shape while still keeping
// this a pure function with no Supabase calls inside it.
//
// Rules (plan §3):
//   - Rank 1 auto-promotes — except League 1 (tier 1), which has nowhere
//     higher to go, so it never promotes anyone.
//   - Bottom 2 relegate, in every league, including League 1.
//
// Degenerate-roster handling (plan's own "test edge cases... what happens
// if a league has fewer than 6 active players" ask): relegateCount is
// capped at whatever's left after the promoted player (if any) is removed,
// so a thin league never tries to relegate more players than exist. This
// can fully empty a league whose active roster drops to 2 or fewer — that
// is a real, currently-undefined outcome this phase surfaces rather than
// hides, not a bug this function papers over; see the unit tests below for
// the exact behavior at each roster size.
//
// What this function does NOT do (all orchestration, not classification —
// see the Supabase resolve job instead): write any ladder_memberships
// rows, decide which tier a promoted/relegated player lands in, auto-create
// a new bottom league, or touch the auction/bidding system (Phase 5).
// Notably, per this phase's own scope, relegated players get no next-week
// row at all yet — they're left "in limbo" until Phase 5's buy-back
// auction or fall-through mechanic gives them one; this function's
// `relegated` array is just the classification Phase 5 will later consume,
// not a promise that a placement already happened.
// ─────────────────────────────────────────────────────────────────────────
export function resolveLadderWeek(leagueId, weekNumber, standings, tier) {
  if (!leagueId) throw new Error("resolveLadderWeek: leagueId is required");
  if (!Number.isInteger(weekNumber) || weekNumber < 1) throw new Error("resolveLadderWeek: weekNumber must be a positive integer");
  if (!Number.isInteger(tier) || tier < 1) throw new Error("resolveLadderWeek: tier must be a positive integer (1 = top)");

  const ranked = [...(standings || [])]; // assumed already sorted best->worst, as computeStandings returns
  const isTopLeague = tier === 1;

  const promoted = !isTopLeague && ranked.length > 0 ? [ranked[0].user_id] : [];
  const remaining = ranked.slice(promoted.length);

  const relegateCount = Math.min(2, remaining.length);
  const relegated = relegateCount > 0
    ? remaining.slice(remaining.length - relegateCount).map((r) => r.user_id)
    : [];

  const relegatedSet = new Set(relegated);
  const stayed = remaining.filter((r) => !relegatedSet.has(r.user_id)).map((r) => r.user_id);

  return { leagueId, weekNumber, tier, promoted, relegated, stayed };
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 5 — auction / bidding, pure pieces only. The eligibility pool and
// bid validation below are plain data in, plain data out — same "pure
// classifier, SQL reimplements it for the scheduled job" split
// resolveLadderWeek uses. The actual DB writes (bid upsert, escrow
// debit/refund, membership rows, fee events) live in the Phase 5 migration's
// place_ladder_bid / _ladder_settle_bids_internal / _ladder_fall_through_internal,
// not here.
//
// There used to be a third pure piece here — resolveLadderBids, a
// winner/tie-break ranking function for a league's full set of pending
// bids at Sunday settlement, paired with SQL's
// _ladder_bidder_points_internal / _ladder_player_points_internal
// tie-break helpers. The live open-bid auction redesign (Phase C,
// 20260871) collapsed that: at most one 'pending' bid per league ever
// exists now (every dethroned bid is refunded live), so there's nothing
// left to rank at settlement — _ladder_settle_bids_internal just seats
// whoever is still 'pending'. resolveLadderBids and both points helpers
// were dead code after that migration landed; removed here along with
// their SQL counterparts (see the matching cleanup migration).
// ─────────────────────────────────────────────────────────────────────────

// ladderBidEligiblePool({ relegatedFromTargetLeague, activeInLeagueBelow })
// → the eligible bidder pool for one league's auction spot (plan §4): the
// 2 players just relegated FROM the target league, plus the (normally 5,
// since 20260876 capped league rosters at 6) non-promoted players
// currently active in the league directly below it.
// Both inputs are plain arrays of user ids — callers (the SQL RPC, or a
// test) decide how those two lists were derived; this function just
// unions them (de-duplicated, though the two sets can't legitimately
// overlap — a player can't be relegated from league T and also be an
// active member of league T+1 in the same cycle).
export function ladderBidEligiblePool({ relegatedFromTargetLeague, activeInLeagueBelow } = {}) {
  return [...new Set([...(relegatedFromTargetLeague || []), ...(activeInLeagueBelow || [])])];
}

// placeLadderBid({ bidderId, amount, eligibleBidderIds, entryFee }) →
// { valid: true } or { valid: false, reason }. Pure validation only — no
// insert, no Supabase. This is the client-side pre-check (so the UI can
// reject obviously-bad input before round-tripping); place_ladder_bid's
// SQL RPC re-does both checks server-side (plan's own "reject invalid
// bids server-side, not just in the UI"), since a client check alone is
// never a real guarantee.
export function placeLadderBid({ bidderId, amount, eligibleBidderIds, entryFee } = {}) {
  if (!eligibleBidderIds || !eligibleBidderIds.includes(bidderId)) {
    return { valid: false, reason: "not eligible to bid for this league this week" };
  }
  if (!(Number(amount) >= Number(entryFee))) {
    return { valid: false, reason: "bid is below this league's Entry Fee floor" };
  }
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 7 — Elite Safety Zone / Checkpoint Safety / Danger Zone, per the
// now-confirmed spec (previously flagged in 20260863's header as needing
// real specs before writing any code):
//
//   - Elite Safety Zone: rank 1 is 6+ points clear of rank 2.
//   - Checkpoint Safety: the rank just above the relegation zone is 6+
//     points clear of the first relegation-zone spot.
//   - Danger Zone: the bottom 2 clubs — the ones due to be relegated.
//
// classifyLadderZones is a pure, live-standings read, NOT a resolution
// rule — it doesn't feed into resolveLadderWeek. Promotion is always rank
// 1 and relegation is always the bottom 2 regardless of any point gap
// (resolveLadderWeek's own rule, unchanged); these zones are purely a
// badge on top of that so players can see how secure their spot is before
// the Sunday cutoff. A leader who loses their cushion next round just
// stops showing the badge — nothing else changes.
//
// 20260876 capped league rosters at 6 (a 7th joiner now peels off into a
// new league instead of the league growing to 8), so the relegation zone
// is always the bottom 2 of a league that tops out at 6 — ranks 5 and 6,
// not the old 7/8. Checkpoint Safety moves with it: rank 4 clear of rank
// 5 (the first relegation-zone spot), not rank 6 clear of rank 7. A
// 7+-row standings array can still theoretically reach this function
// mid-resync (e.g. a stale read during an overflow split), so the check
// stays index-based off the bottom 2 rather than assuming exactly 6 rows.
//
// standings: the array computeStandings returns (already sorted
// best-to-worst). Returns a plain { [user_id]: zone } map, zone one of
// 'elite_safe' | 'checkpoint_safe' | 'danger_zone' | null. Checkpoint
// Safety only ever fires in a full (5+) league — nothing to check against
// at the first relegation-zone spot in a thinner one. Danger Zone never
// overwrites an already-assigned Elite/Checkpoint badge (only relevant in
// a very thin league where the same club could be both rank 1 and in the
// bottom 2).
// ─────────────────────────────────────────────────────────────────────────
const LADDER_SAFETY_ZONE_GAP = 6;

export function classifyLadderZones(standings) {
  const rows = standings || [];
  const zones = {};
  rows.forEach((r) => { zones[r.user_id] = null; });

  if (rows.length >= 2 && rows[0].pts - rows[1].pts >= LADDER_SAFETY_ZONE_GAP) {
    zones[rows[0].user_id] = "elite_safe";
  }

  const firstRelegationIdx = rows.length - 2; // first of the bottom-2 relegation spots
  const checkpointIdx = firstRelegationIdx - 1; // the rank just above it
  if (rows.length >= 5 && rows[checkpointIdx].pts - rows[firstRelegationIdx].pts >= LADDER_SAFETY_ZONE_GAP) {
    zones[rows[checkpointIdx].user_id] = "checkpoint_safe";
  }

  rows.slice(-2).forEach((r) => {
    if (zones[r.user_id] == null) zones[r.user_id] = "danger_zone";
  });

  return zones;
}

export { LADDER_ROSTER_SIZE, LADDER_SAFETY_ZONE_GAP };
