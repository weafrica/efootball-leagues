// src/formats/ladderCup.js
//
// WEAFRICA SURVIVAL LADDER CUP — core engine, step 1 of 3.
//
// This slice covers just two things: scoring a win, and the
// elimination / second-life state machine. That's the part every other
// piece (opponent matching, walkovers, badges, cutoff) depends on, so it's
// the right thing to get deployed and working first.
//
// NOT in this file yet (coming in later steps):
//   - opponent matching (±10 band, widening)
//   - walkover claims (message → 24h wait → claim → admin review)
//   - hard-cutoff finalization / crowning a champion
//   - badge display logic beyond the raw counters recordLadderCupWin tracks
//
// Pure functions only — no React, no Supabase. Field names mirror the rest
// of the codebase's format engines (`pts`, `w`, `l`, `gd`); no `d` since
// this format has no draws.
//
// FORMATS registration (add to the FORMATS array in App.jsx):
//   { id: "ladder_cup", label: "Survival Ladder Cup", kind: "ladder_cup",
//     desc: "Ranked ladder, one elimination life each. Most points by the Sunday cutoff wins.",
//     available: true }
//
// STEP 2 added opponent matching (below, at the bottom of the file) — the
// ±10 ladder-points band that widens until it finds live opponents, no
// byes. STEP 3 added walkover claims. STEP 4 added cutoff finalization
// and the full tiebreaker chain. STEP 5 added the remaining MATCH FLOW
// mechanics: random home-team assignment, match length validation, and
// substitution counts. The engine now covers the full ruleset. STEP 10
// added resolveMatchWinner, the validation gate a submitted scoreline goes
// through before it's trusted enough to feed to recordLadderCupWin.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LADDER_CUP_RULES = {
  SECOND_LIFE_WINDOW_HOURS: 24,
  SECOND_LIFE_DEDUCTION: 6,   // points deducted on re-entry, floored at 0
  HEATER_STREAK_START: 3,     // heater bonus kicks in at a 3-win streak
  BAND_START: 10,             // opponent matching starts at ±10 ladder points
  BAND_STEP: 5,                // widens ±15, ±20, ±25... no ceiling
  SHOWN_OPPONENTS: 5,          // always show up to 5 live opponents
  WALKOVER_WAIT_HOURS: 24,     // must message + wait this long before claiming
  MAX_CONCURRENT_WALKOVER_CLAIMS: 5, // one per shown opponent slot
  BASE_WIN_POINTS: 3,
  UPSET_BONUS: 1,
  HEATER_BONUS: 1,
  BOUNTY_BONUS: 2,
  // OPEN DECISION (see ruleset "STILL OPEN"): does extra-time scoring count
  // toward goal difference? Penalties never do, that's settled. Regulation
  // always does. This flag is the one switch to flip once that's decided.
  COUNT_EXTRA_TIME_IN_GD: false,
  MATCH_LENGTH_MIN_MINUTES: 6,  // home team's choice, per half
  MATCH_LENGTH_MAX_MINUTES: 15,
  BASE_SUBSTITUTIONS: 6,
  EXTRA_TIME_SUBSTITUTIONS: 1,  // additional sub allowed only if the match reaches extra time
};

// ---------------------------------------------------------------------------
// Entry (a club's standing in one Ladder Cup league)
// ---------------------------------------------------------------------------

/** @typedef {"active"|"pending_second_life"|"eliminated"|"champion"} LadderCupStatus */

export function createLadderCupEntry(clubId, clubName) {
  return {
    club_id: clubId,
    club_name: clubName,
    pts: 0,
    w: 0,
    l: 0,
    gd: 0,                // regulation-time goal difference only (see COUNT_EXTRA_TIME_IN_GD)
    streak: 0,             // current consecutive-win streak, resets to 0 on any loss
    status: /** @type {LadderCupStatus} */ ("active"),
    second_life_used: false,
    second_life_offer: null, // { offered_at, expires_at } while status === "pending_second_life"
    toughest_opponent_beaten_pts: 0, // saved for the tiebreaker step, unused until then
    badge_counts: {
      heater_wins: 0,     // how many wins scored a heater bonus (badge display logic comes later)
      giant_slayer: 0,     // count of upset wins
      second_life: false,  // permanent single badge once re-entered
      bounty_hunter: 0,    // count of bounty wins
    },
  };
}

// ---------------------------------------------------------------------------
// Standings & ranking (needed to know who's "ranked above" and who's #1)
// ---------------------------------------------------------------------------

/**
 * Sorts by the full tiebreaker chain: points, then goal difference
 * (regulation-time only — see COUNT_EXTRA_TIME_IN_GD), then toughest
 * opponent beaten (that opponent's points at the moment of the win). This
 * is the same ordering used for in-week "ranked above you" / "#1" scoring
 * checks and for crowning the champion at cutoff — the ruleset defines one
 * tiebreaker chain, not two.
 */
export function rankLadderCupStandings(entries) {
  const sorted = [...entries].sort((a, b) =>
    b.pts - a.pts ||
    b.gd - a.gd ||
    b.toughest_opponent_beaten_pts - a.toughest_opponent_beaten_pts
  );
  return sorted.map((e, i) => ({ ...e, rank_position: i + 1 }));
}

/** True if `challengerId` beating `opponentId` counts as an upset (opponent ranked above challenger). */
export function isUpset(standingsBeforeMatch, challengerId, opponentId) {
  const ranks = new Map(standingsBeforeMatch.map((e) => [e.club_id, e.rank_position]));
  const mine = ranks.get(challengerId);
  const theirs = ranks.get(opponentId);
  if (mine == null || theirs == null) return false;
  return theirs < mine; // lower rank_position number = higher in the standings
}

/** IDs of every club tied for #1 right now — all of them are valid bounty targets. */
export function getBountyTargetIds(standingsBeforeMatch) {
  const leaders = standingsBeforeMatch.filter((e) => e.rank_position === 1);
  return new Set(leaders.map((e) => e.club_id));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Computes the points a win is worth, with full breakdown for display.
 * @param {object} p
 * @param {boolean} p.isWalkover
 * @param {boolean} p.beatHigherRank - opponent was ranked above the winner (ignored for walkovers)
 * @param {number} p.streakAfterThisWin - winner's win streak INCLUDING this win
 * @param {boolean} p.isBountyTarget - opponent was #1 (or tied #1) at match time
 */
export function computeWinPoints({ isWalkover, beatHigherRank, streakAfterThisWin, isBountyTarget }) {
  const R = LADDER_CUP_RULES;
  if (isWalkover) {
    // "Walkover win scoring: BASE 3 POINTS ONLY — no upset, no bounty, no heater stack"
    return { points: R.BASE_WIN_POINTS, breakdown: { base: R.BASE_WIN_POINTS, upset: 0, heater: 0, bounty: 0 } };
  }
  const base = R.BASE_WIN_POINTS;
  const upset = beatHigherRank ? R.UPSET_BONUS : 0;
  const heater = streakAfterThisWin >= R.HEATER_STREAK_START ? R.HEATER_BONUS : 0;
  const bounty = isBountyTarget ? R.BOUNTY_BONUS : 0;
  return { points: base + upset + heater + bounty, breakdown: { base, upset, heater, bounty } };
}

// ---------------------------------------------------------------------------
// Recording a result
// ---------------------------------------------------------------------------

/**
 * Applies one match result to both entries. Returns new (not mutated) entry
 * objects: { winner, loser, winnerPointsBreakdown }. Call rankLadderCupStandings
 * on the full entry list again afterward — a result changes points, which can
 * change who's #1, which affects the NEXT match's bounty target.
 *
 * @param {object} p
 * @param {object} p.winner - winner's current entry
 * @param {object} p.loser - loser's current entry
 * @param {Array} p.standingsBeforeMatch - rankLadderCupStandings() output, pre-match
 * @param {boolean} [p.isWalkover]
 * @param {number} p.winnerGoals - regulation-time goals (0 for a walkover)
 * @param {number} p.loserGoals - regulation-time goals (0 for a walkover)
 * @param {"regulation"|"extra_time"|"penalties"} p.decidedBy
 * @param {number} p.extraTimeGoalsWinner
 * @param {number} p.extraTimeGoalsLoser
 * @param {Date} p.now
 */
export function recordLadderCupWin({
  winner, loser, standingsBeforeMatch, isWalkover = false,
  winnerGoals = 0, loserGoals = 0, decidedBy = "regulation",
  extraTimeGoalsWinner = 0, extraTimeGoalsLoser = 0, now = new Date(),
}) {
  const beatHigherRank = !isWalkover && isUpset(standingsBeforeMatch, winner.club_id, loser.club_id);
  const isBountyTarget = !isWalkover && getBountyTargetIds(standingsBeforeMatch).has(loser.club_id);
  const streakAfterThisWin = winner.streak + 1;
  const { points: gained, breakdown } = computeWinPoints({ isWalkover, beatHigherRank, streakAfterThisWin, isBountyTarget });

  // Goal difference: regulation always counts, penalties never do, extra
  // time is gated by the open COUNT_EXTRA_TIME_IN_GD switch.
  let gdDelta = winnerGoals - loserGoals;
  if (decidedBy === "extra_time" && LADDER_CUP_RULES.COUNT_EXTRA_TIME_IN_GD) {
    gdDelta += extraTimeGoalsWinner - extraTimeGoalsLoser;
  }

  const newWinner = {
    ...winner,
    pts: winner.pts + gained,
    w: winner.w + 1,
    gd: winner.gd + gdDelta,
    streak: streakAfterThisWin,
    toughest_opponent_beaten_pts: Math.max(winner.toughest_opponent_beaten_pts, loser.pts),
    badge_counts: {
      ...winner.badge_counts,
      heater_wins: winner.badge_counts.heater_wins + (breakdown.heater ? 1 : 0),
      giant_slayer: winner.badge_counts.giant_slayer + (breakdown.upset ? 1 : 0),
      bounty_hunter: winner.badge_counts.bounty_hunter + (breakdown.bounty ? 1 : 0),
    },
  };

  const loserAfterLoss = applyLoss(loser, now);
  const newLoser = { ...loserAfterLoss, gd: loserAfterLoss.gd - gdDelta };

  return { winner: newWinner, loser: newLoser, winnerPointsBreakdown: breakdown };
}

// ---------------------------------------------------------------------------
// Elimination & Second Life
// ---------------------------------------------------------------------------

/**
 * Applies a loss. Streak always resets. If the club still has its one life,
 * they're moved into the 24h second-life decision window instead of being
 * eliminated outright; if they've already used it, this is final.
 */
export function applyLoss(entry, now = new Date()) {
  const base = { ...entry, l: entry.l + 1, streak: 0 };
  if (entry.second_life_used) {
    return { ...base, status: "eliminated", second_life_offer: null };
  }
  const offeredAt = now;
  const expiresAt = new Date(now.getTime() + LADDER_CUP_RULES.SECOND_LIFE_WINDOW_HOURS * 60 * 60 * 1000);
  return {
    ...base,
    status: "pending_second_life",
    second_life_offer: { offered_at: offeredAt.toISOString(), expires_at: expiresAt.toISOString() },
  };
}

/** Accepting the second-life offer: -6 points (floor 0), streak already 0, life consumed. */
export function acceptSecondLife(entry) {
  if (entry.status !== "pending_second_life") {
    throw new Error("No pending second-life offer to accept.");
  }
  return {
    ...entry,
    pts: Math.max(0, entry.pts - LADDER_CUP_RULES.SECOND_LIFE_DEDUCTION),
    status: "active",
    second_life_used: true,
    second_life_offer: null,
    badge_counts: { ...entry.badge_counts, second_life: true },
  };
}

/** Explicit decline, or the 24h window lapsing with no response — same outcome either way. */
export function declineOrExpireSecondLife(entry) {
  if (entry.status !== "pending_second_life") return entry;
  return { ...entry, status: "eliminated", second_life_offer: null };
}

/** Call periodically (or lazily, on read) to auto-decline offers past their 24h window. */
export function expireStaleSecondLifeOffers(entries, now = new Date()) {
  return entries.map((e) => {
    if (e.status === "pending_second_life" && e.second_life_offer && new Date(e.second_life_offer.expires_at) <= now) {
      return declineOrExpireSecondLife(e);
    }
    return e;
  });
}

// ---------------------------------------------------------------------------
// Opponent matching (step 2)
// ---------------------------------------------------------------------------

/**
 * Expanding-band opponent search: ±10 ladder points, widening by ±5 with no
 * ceiling until the pool isn't thin anymore. Only "active" clubs (not the
 * entry itself, not eliminated, not mid-second-life-decision) are eligible.
 * Returns up to SHOWN_OPPONENTS, closest-in-points first. Empty result means
 * "wait for the pool to widen" — there are no byes.
 *
 * Re-run this after any result is logged (played or walkover) — that's the
 * "logging a result refreshes your opponent slate" rule; it's just calling
 * this again with fresh entries, not a separate mechanism.
 */
export function getOpponentPool(entry, allEntries) {
  const R = LADDER_CUP_RULES;
  const eligible = allEntries.filter((e) => e.club_id !== entry.club_id && e.status === "active");
  if (eligible.length === 0) return [];

  let band = R.BAND_START;
  let pool = eligible.filter((e) => Math.abs(e.pts - entry.pts) <= band);
  while (pool.length < R.SHOWN_OPPONENTS && pool.length < eligible.length) {
    band += R.BAND_STEP;
    pool = eligible.filter((e) => Math.abs(e.pts - entry.pts) <= band);
  }
  return pool
    .sort((a, b) => Math.abs(a.pts - entry.pts) - Math.abs(b.pts - entry.pts))
    .slice(0, R.SHOWN_OPPONENTS);
}

// ---------------------------------------------------------------------------
// Walkover claims (step 3)
// ---------------------------------------------------------------------------

/** @typedef {"messaged"|"pending_review"|"approved"|"rejected"} WalkoverClaimStatus */

/**
 * Message opponent once, then wait 24h before a walkover can be claimed.
 * Caller must enforce MAX_CONCURRENT_WALKOVER_CLAIMS (one per shown
 * opponent slot) before creating another — this function doesn't see the
 * claimant's other open claims, only the one it's creating.
 */
export function createWalkoverClaim(claimantClubId, targetClubId, now = new Date()) {
  const claimableAt = new Date(now.getTime() + LADDER_CUP_RULES.WALKOVER_WAIT_HOURS * 60 * 60 * 1000);
  return {
    claimant_club_id: claimantClubId,
    target_club_id: targetClubId,
    messaged_at: now.toISOString(),
    claimable_at: claimableAt.toISOString(),
    status: /** @type {WalkoverClaimStatus} */ ("messaged"),
    proof_url: null,
  };
}

export function isWalkoverClaimable(claim, now = new Date()) {
  return claim.status === "messaged" && new Date(claim.claimable_at) <= now;
}

/** Submits the claim with screenshot proof once the 24h wait has passed — moves it into admin review. */
export function submitWalkoverClaim(claim, proofUrl, now = new Date()) {
  if (!isWalkoverClaimable(claim, now)) {
    throw new Error("Walkover not claimable yet — still inside the 24h wait.");
  }
  return { ...claim, status: "pending_review", proof_url: proofUrl };
}

/**
 * Admin approves a pending claim. This only flips the claim's status — the
 * caller still needs to call recordLadderCupWin({ isWalkover: true, ... })
 * with the claimant as winner and target as loser to actually apply the
 * base-3-points win and run the target through the loss/second-life path
 * ("No-show opponent: counts as a LOSS, triggers their Second Life
 * eligibility same as an actual defeat").
 */
export function approveWalkoverClaim(claim) {
  if (claim.status !== "pending_review") throw new Error("Claim isn't pending review.");
  return { ...claim, status: "approved" };
}

export function rejectWalkoverClaim(claim) {
  if (claim.status !== "pending_review") throw new Error("Claim isn't pending review.");
  return { ...claim, status: "rejected" };
}

// ---------------------------------------------------------------------------
// Hard cutoff & finalization (step 4)
// ---------------------------------------------------------------------------

/**
 * Filters out anything not finalized by the Sunday 10PM (UTC+2) cutoff:
 * matches still mid-play, and walkover claims still inside their 24h
 * window (whether or not they've been submitted for review — if they
 * weren't approved before the cutoff, they don't count).
 *
 * "Anything not finalized by then (mid-match, or a walkover claim still in
 * its 24h window) does not count" — this doesn't undo points already on
 * the board from earlier, finalized results; it only tells the caller
 * which in-flight matches/claims to discard rather than rushing them
 * through after the deadline.
 */
export function finalizeAtCutoff({ matches, walkoverClaims, cutoff }) {
  const cutoffTime = new Date(cutoff).getTime();
  const finalizedMatches = matches.filter((m) => m.finalized_at && new Date(m.finalized_at).getTime() <= cutoffTime);
  const finalizedClaims = walkoverClaims.filter((c) => c.status === "approved" && new Date(c.approved_at || c.claimable_at).getTime() <= cutoffTime);
  return { finalizedMatches, finalizedClaims };
}

/**
 * Final champion = most points at cutoff, tiebreaker chain resolves any
 * tie. No draws exist in this format, so the chain is always decisive.
 * Eliminated clubs (including anyone who declined/timed out their second
 * life) are excluded — only clubs still "active" or "champion" at cutoff
 * can win.
 */
export function crownChampion(entries) {
  const ranked = rankLadderCupStandings(entries.filter((e) => e.status !== "eliminated"));
  return ranked[0] || null;
}

// ---------------------------------------------------------------------------
// Match setup (step 5): home-team assignment, match length, substitutions
// ---------------------------------------------------------------------------

/**
 * "System randomly assigns home team per fixture." Pass a custom `rng`
 * (returning a float in [0,1)) for deterministic tests — defaults to
 * Math.random for real use.
 */
export function assignHomeTeam(clubAId, clubBId, rng = Math.random) {
  return rng() < 0.5 ? { home: clubAId, away: clubBId } : { home: clubBId, away: clubAId };
}

/** Home team picks the match length: 6–15 minutes per half. */
export function isValidMatchLength(minutes) {
  return Number.isInteger(minutes)
    && minutes >= LADDER_CUP_RULES.MATCH_LENGTH_MIN_MINUTES
    && minutes <= LADDER_CUP_RULES.MATCH_LENGTH_MAX_MINUTES;
}

/**
 * 6 substitutions per match, +1 (7 total) if it goes to extra time.
 * Penalties don't grant a further increase — the extra sub is for reaching
 * extra time, not for reaching penalties specifically (which only happens
 * after extra time anyway).
 */
export function substitutionsAllowed(decidedBy) {
  const R = LADDER_CUP_RULES;
  return decidedBy === "extra_time" || decidedBy === "penalties"
    ? R.BASE_SUBSTITUTIONS + R.EXTRA_TIME_SUBSTITUTIONS
    : R.BASE_SUBSTITUTIONS;
}

// ---------------------------------------------------------------------------
// Step 10: result logging
// ---------------------------------------------------------------------------

/**
 * Given a submitted scoreline, works out which side won and validates that
 * the scores are actually consistent with reaching that stage — you can't
 * be "decided by regulation" on a level scoreline, and you can't reach
 * extra time or penalties unless the stage before it was level. This is
 * the one gate between "whatever a player typed into a form" and
 * recordLadderCupWin, which trusts winner/loser completely and just
 * applies points — so everything that could make a result nonsensical has
 * to be caught here first.
 *
 * Doesn't touch entries or points itself. Returns { winnerSide: "home" |
 * "away" }; throws an Error with a message safe to show the user directly
 * on anything inconsistent.
 *
 * @param {object} p
 * @param {number} p.homeGoals - regulation-time goals
 * @param {number} p.awayGoals - regulation-time goals
 * @param {number} [p.extraTimeHomeGoals]
 * @param {number} [p.extraTimeAwayGoals]
 * @param {number|null} [p.pensHome]
 * @param {number|null} [p.pensAway]
 */
export function resolveMatchWinner({
  homeGoals, awayGoals, extraTimeHomeGoals = 0, extraTimeAwayGoals = 0,
  pensHome = null, pensAway = null,
}) {
  if (homeGoals !== awayGoals) {
    return { winnerSide: homeGoals > awayGoals ? "home" : "away", decidedBy: "regulation" };
  }
  if (extraTimeHomeGoals !== extraTimeAwayGoals) {
    return { winnerSide: extraTimeHomeGoals > extraTimeAwayGoals ? "home" : "away", decidedBy: "extra_time" };
  }
  if (pensHome == null || pensAway == null) {
    throw new Error("Match finished level — add an extra time or penalty shootout score.");
  }
  if (pensHome === pensAway) {
    throw new Error("Penalties can't be level too — someone has to win.");
  }
  return { winnerSide: pensHome > pensAway ? "home" : "away", decidedBy: "penalties" };
}
