// src/formats/ladderCup.js
//
// WEAFRICA SURVIVAL LADDER CUP — rules engine.
//
// Pure functions only — no React, no Supabase. Everything here operates on
// plain JS objects so it can be unit-tested standalone and called from
// wherever the app applies a logged result (an edge function, a Supabase
// RPC, or client code before writing back). Field names mirror the rest of
// the codebase's format engines (`pts`, `w`, `l`, `gd`) but this format has
// no draws, so there's no `d`.
//
// FORMATS registration (add to the FORMATS array in App.jsx):
//   { id: "ladder_cup", label: "Survival Ladder Cup", kind: "ladder_cup",
//     desc: "Ranked ladder with one elimination life each. Most points by the Sunday cutoff wins.",
//     available: true }
// It gets its own `kind` (not "knockout" or "round_robin") so a club active
// in a Ladder Cup doesn't block/get blocked by unrelated formats under the
// one-active-fun-league-per-kind join rule.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LADDER_CUP_RULES = {
  BAND_START: 10,            // opponent matching starts at ±10 ladder points
  BAND_STEP: 5,               // widens ±15, ±20, ±25... no ceiling
  SHOWN_OPPONENTS: 5,         // always show up to 5 live opponents
  SECOND_LIFE_WINDOW_HOURS: 24,
  SECOND_LIFE_DEDUCTION: 6,   // points deducted on re-entry, floored at 0
  WALKOVER_WAIT_HOURS: 24,    // must message + wait this long before claiming
  MAX_CONCURRENT_WALKOVER_CLAIMS: 5, // one per shown opponent slot
  HEATER_STREAK_START: 3,     // heater bonus kicks in at a 3-win streak
  HEATER_BADGE_TIERS: [3, 5, 7], // visual stack thresholds (7+ is the top tier)
  GIANT_SLAYER_MIN_UPSETS: 2, // badge appears once you have 2+ upset wins
  BASE_WIN_POINTS: 3,
  UPSET_BONUS: 1,
  HEATER_BONUS: 1,
  BOUNTY_BONUS: 2,
  // OPEN DECISION (see ruleset "STILL OPEN"): does extra-time scoring count
  // toward goal difference? Penalties never do, that's settled. Regulation
  // always does. This flag is the one switch to flip once that's decided.
  COUNT_EXTRA_TIME_IN_GD: false,
};

// Match length is home team's choice, 6–15 minutes per half — captured on
// the match record but has no scoring effect, so it's just a range constant
// for form validation, not used by the engine below.
export const MATCH_LENGTH_MIN_MINUTES = 6;
export const MATCH_LENGTH_MAX_MINUTES = 15;

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
    gd: 0,               // regulation-time goal difference only (see COUNT_EXTRA_TIME_IN_GD)
    streak: 0,            // current consecutive-win streak, resets to 0 on any loss
    status: /** @type {LadderCupStatus} */ ("active"),
    second_life_used: false,
    second_life_offer: null, // { offered_at, expires_at } while status === "pending_second_life"
    toughest_opponent_beaten_pts: 0, // for tiebreaker #3
    badges: {
      heater_tier: 0,       // 0 = none, 1/2/3 = 3/5/7+ stack
      giant_slayer: 0,      // count of upset wins
      second_life: false,   // permanent single badge once re-entered
      walkover: 0,           // count of walkover wins claimed & approved
      bounty_hunter: 0,      // count of bounty wins
    },
  };
}

// ---------------------------------------------------------------------------
// Standings & ranking
// ---------------------------------------------------------------------------

/**
 * Sorts entries by the tiebreaker chain and assigns rank_position.
 * Ties (equal on all three criteria) share adjacent ranks are NOT collapsed —
 * standard competition ranking (1, 2, 2, 4 style) is left to the caller if
 * wanted; this just returns a total order with rank_position = index + 1,
 * since the ruleset only defines the ordering, not display of dead heats.
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
 * Computes the points a win is worth, with full breakdown for badge/UI display.
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

function heaterTierForStreak(streak) {
  const tiers = LADDER_CUP_RULES.HEATER_BADGE_TIERS;
  let tier = 0;
  for (let i = 0; i < tiers.length; i++) if (streak >= tiers[i]) tier = i + 1;
  return tier; // 0 none, 1 = 3+, 2 = 5+, 3 = 7+
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
    badges: {
      ...winner.badges,
      heater_tier: heaterTierForStreak(streakAfterThisWin),
      giant_slayer: winner.badges.giant_slayer + (breakdown.upset ? 1 : 0),
      walkover: winner.badges.walkover + (isWalkover ? 1 : 0),
      bounty_hunter: winner.badges.bounty_hunter + (breakdown.bounty ? 1 : 0),
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
 * Applies a loss (regulation defeat OR a no-show walkover loss — both go
 * through this same path). Streak always resets. If the club still has its
 * one life, they're moved into the 24h second-life decision window instead
 * of being eliminated outright; if they've already used it, this is final.
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
    badges: { ...entry.badges, second_life: true },
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
// Opponent matching
// ---------------------------------------------------------------------------

/**
 * Expanding-band opponent search: ±10 ladder points, widening by ±5 with no
 * ceiling until the pool isn't thin anymore. Only "active" clubs (not the
 * entry itself, not eliminated, not mid-second-life-decision) are eligible.
 * Returns up to SHOWN_OPPONENTS, closest-in-points first. Empty result means
 * "wait for the pool to widen" — there are no byes.
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
// Walkovers
// ---------------------------------------------------------------------------

/** @typedef {"messaged"|"claimable"|"pending_review"|"approved"|"rejected"} WalkoverClaimStatus */

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

/** Caller must enforce MAX_CONCURRENT_WALKOVER_CLAIMS (one per shown opponent) before calling this. */
export function submitWalkoverClaim(claim, proofUrl, now = new Date()) {
  if (!isWalkoverClaimable(claim, now)) {
    throw new Error("Walkover not claimable yet — still inside the 24h wait.");
  }
  return { ...claim, status: "pending_review", proof_url: proofUrl };
}

/** Admin approval turns a claim into a real result — feed this into recordLadderCupWin as a walkover win. */
export function approveWalkoverClaim(claim) {
  if (claim.status !== "pending_review") throw new Error("Claim isn't pending review.");
  return { ...claim, status: "approved" };
}

export function rejectWalkoverClaim(claim) {
  if (claim.status !== "pending_review") throw new Error("Claim isn't pending review.");
  return { ...claim, status: "rejected" };
}

// ---------------------------------------------------------------------------
// Hard cutoff & finalization
// ---------------------------------------------------------------------------

/**
 * Filters out anything not finalized by the Sunday 10PM (UTC+2) cutoff:
 * matches still mid-play, and walkover claims still inside their 24h window
 * (whether or not they've been submitted for review — if they weren't
 * approved before the cutoff, they don't count).
 */
export function finalizeAtCutoff({ matches, walkoverClaims, cutoff }) {
  const cutoffTime = new Date(cutoff).getTime();
  const finalizedMatches = matches.filter((m) => m.finalized_at && new Date(m.finalized_at).getTime() <= cutoffTime);
  const finalizedClaims = walkoverClaims.filter((c) => c.status === "approved" && new Date(c.approved_at || c.claimable_at).getTime() <= cutoffTime);
  return { finalizedMatches, finalizedClaims };
}

/** Final champion = most points at cutoff, tiebreaker chain resolves any tie. No draws exist, so this is always decisive down to the chain. */
export function crownChampion(entries) {
  const ranked = rankLadderCupStandings(entries.filter((e) => e.status !== "eliminated"));
  return ranked[0] || null;
}
