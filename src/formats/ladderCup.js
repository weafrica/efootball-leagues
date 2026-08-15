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
// ±100 ladder_rating band that widens until it finds live opponents, no
// byes. ladder_rating is a separate Elo-style number, decoupled from pts —
// see "Matchmaking rating" below. STEP 3 added walkover claims. STEP 4 added cutoff finalization
// and the full tiebreaker chain. STEP 5 added the remaining MATCH FLOW
// mechanics: random home-team assignment, match length validation, and
// substitution counts. The engine now covers the full ruleset. STEP 10
// added resolveMatchWinner, the validation gate a submitted scoreline goes
// through before it's trusted enough to feed to recordLadderCupWin.
// STEP 13 added hasLadderCupCutoffPassed, the one predicate every write
// path (App.jsx) now checks before touching a ladder_cup league — nothing
// here actually fires on a timer; see App.jsx's lazy-check-on-read effect
// for what calls finalizeAtCutoff/crownChampion once the deadline's past.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LADDER_CUP_RULES = {
  SECOND_LIFE_WINDOW_HOURS: 24,
  SECOND_LIFE_DEDUCTION: 6,   // points deducted on re-entry, floored at 0
  HEATER_STREAK_START: 3,     // heater bonus kicks in at a 3-win streak
  // Opponent matching runs entirely off ladder_rating (Elo-style, below) —
  // NOT pts. pts/standings are the league table; ladder_rating is a second,
  // fully separate number that exists only to drive this band search.
  RATING_START: 1000,          // every club's ladder_rating on creation
  RATING_K_FACTOR: 32,         // standard Elo K-factor for one result
  RATING_BAND_START: 100,      // opponent matching starts at ±100 rating
  RATING_BAND_STEP: 50,        // widens ±150, ±200, ±250... no ceiling
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
    // Second, independent rating — see the "Matchmaking rating" section
    // below. Never read by rankLadderCupStandings/the league table.
    ladder_rating: LADDER_CUP_RULES.RATING_START,
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
    // Step 14 (rebirth) — see the "Rebirth" section below. rebirth_count is
    // how many times this club has come back from full elimination;
    // past_lives is a display-only archive of each finished run's final
    // numbers. Neither field is ever read by rankLadderCupStandings,
    // recordLadderCupWin, or anything else that touches live standings —
    // they exist purely so the UI can show a fallen club's history after
    // its stats reset to zero.
    rebirth_count: 0,
    past_lives: [],
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
  // Standard competition ranking ("1224"): entries tied on every tiebreaker
  // field share the same rank_position instead of being split apart by
  // array order. This matters most at the very start of a Ladder Cup,
  // before anyone's played — every club is genuinely tied at 0/0/0 then,
  // and previously got 1, 2, 3... handed out arbitrarily, which fed bogus
  // "ranked above you" / "#1 right now" signals into isUpset and
  // getBountyTargetIds below.
  let rank = 0;
  return sorted.map((e, i) => {
    const prev = sorted[i - 1];
    const tiedWithPrev = i > 0 &&
      e.pts === prev.pts &&
      e.gd === prev.gd &&
      e.toughest_opponent_beaten_pts === prev.toughest_opponent_beaten_pts;
    if (!tiedWithPrev) rank = i + 1;
    return { ...e, rank_position: rank };
  });
}

/** True if `challengerId` beating `opponentId` counts as an upset (opponent ranked above challenger). */
export function isUpset(standingsBeforeMatch, challengerId, opponentId) {
  const ranks = new Map(standingsBeforeMatch.map((e) => [e.club_id, e.rank_position]));
  const mine = ranks.get(challengerId);
  const theirs = ranks.get(opponentId);
  if (mine == null || theirs == null) return false;
  return theirs < mine; // lower rank_position number = higher in the standings; ties (equal rank_position) never count
}

/**
 * ID of the club currently sitting alone at #1, if there is one — the one
 * valid bounty target. A tie for #1 (including the day-one case where no
 * club has played yet and everyone's still 0/0/0) does NOT count: there's
 * no genuine leader to put a bounty on until one club has actually
 * separated itself from the pack.
 */
export function getBountyTargetIds(standingsBeforeMatch) {
  const leaders = standingsBeforeMatch.filter((e) => e.rank_position === 1);
  if (leaders.length !== 1) return new Set();
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

  // ladder_rating moves independently of pts — see computeEloUpdate below.
  // Same call for a played result or an approved walkover: either way one
  // club beat another, which is the only signal Elo needs.
  const { winnerRating, loserRating } = computeEloUpdate(
    winner.ladder_rating ?? LADDER_CUP_RULES.RATING_START,
    loser.ladder_rating ?? LADDER_CUP_RULES.RATING_START,
  );

  const newWinner = {
    ...winner,
    pts: winner.pts + gained,
    w: winner.w + 1,
    gd: winner.gd + gdDelta,
    streak: streakAfterThisWin,
    ladder_rating: winnerRating,
    toughest_opponent_beaten_pts: Math.max(winner.toughest_opponent_beaten_pts, loser.pts),
    badge_counts: {
      ...winner.badge_counts,
      heater_wins: winner.badge_counts.heater_wins + (breakdown.heater ? 1 : 0),
      giant_slayer: winner.badge_counts.giant_slayer + (breakdown.upset ? 1 : 0),
      bounty_hunter: winner.badge_counts.bounty_hunter + (breakdown.bounty ? 1 : 0),
    },
  };

  const loserAfterLoss = applyLoss(loser, now);
  const newLoser = { ...loserAfterLoss, gd: loserAfterLoss.gd - gdDelta, ladder_rating: loserRating };

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
// Rebirth (step 14) — rejoining after full elimination
// ---------------------------------------------------------------------------
//
// "Eliminated" (second life already used, or declined/expired) has always
// been a dead end for match-making — getOpponentPool only ever considers
// status === "active", so a fallen club silently drops out of the ladder on
// its own the moment it's eliminated. It was never removed from the
// standings table, though — every entry, eliminated or not, keeps showing
// there for the record. Rebirth is the missing other half: a fully fallen
// club can choose to rejoin. Its finished run is archived into
// `past_lives` (display-only — see careerLadderCupTotals below; nothing in
// this file ever sums it back into pts/w/l/gd) and its live stats reset to
// a brand-new day-one run, same as the club's very first match.

/** True once a club has exhausted every life — the only state reborn() accepts. */
export function canRejoinLadderCup(entry) {
  return entry.status === "eliminated";
}

/**
 * Archives the just-ended life and resets the entry to day one: 0
 * pts/w/l/gd/streak, a fresh (unused) second life, ladder_rating back to
 * the starting value (so a reborn club's matchmaking isn't anchored to its
 * old run's form), and status back to "active". rebirth_count increments
 * so the UI can badge "2nd life", "3rd life", etc.
 */
export function reborn(entry, now = new Date()) {
  if (!canRejoinLadderCup(entry)) {
    throw new Error("Only a fully eliminated club can be reborn.");
  }
  const finishedLife = {
    life_number: entry.rebirth_count + 1,
    pts: entry.pts,
    w: entry.w,
    l: entry.l,
    gd: entry.gd,
    matches_played: entry.w + entry.l,
    second_life_used: entry.second_life_used,
    toughest_opponent_beaten_pts: entry.toughest_opponent_beaten_pts,
    ladder_rating: entry.ladder_rating,
    badge_counts: { ...entry.badge_counts },
    ended_at: now.toISOString(),
  };
  return {
    ...entry,
    pts: 0,
    w: 0,
    l: 0,
    gd: 0,
    streak: 0,
    status: /** @type {LadderCupStatus} */ ("active"),
    second_life_used: false,
    second_life_offer: null,
    toughest_opponent_beaten_pts: 0,
    ladder_rating: LADDER_CUP_RULES.RATING_START,
    badge_counts: { heater_wins: 0, giant_slayer: 0, second_life: false, bounty_hunter: 0 },
    rebirth_count: entry.rebirth_count + 1,
    past_lives: [...(entry.past_lives || []), finishedLife],
    reborn_at: now.toISOString(),
  };
}

/**
 * Career totals across every finished life plus the current one — for a
 * club profile's "all-time" line. Purely a display aggregate; never fed
 * back into rankLadderCupStandings or any scoring path.
 */
export function careerLadderCupTotals(entry) {
  const lives = entry.past_lives || [];
  return {
    lives_played: lives.length + 1,
    total_pts: lives.reduce((s, l) => s + l.pts, 0) + entry.pts,
    total_w: lives.reduce((s, l) => s + l.w, 0) + entry.w,
    total_l: lives.reduce((s, l) => s + l.l, 0) + entry.l,
    total_matches: lives.reduce((s, l) => s + l.matches_played, 0) + entry.w + entry.l,
  };
}

// A little variety so the announcement doesn't feel copy-pasted every time
// a club comes back — all in the same "this is a big deal" register.
const REBIRTH_ANNOUNCEMENTS = [
  (club, life) => `🔥 RISEN FROM THE ASHES! ${club} has been REBORN into the Survival Ladder Cup — back at 0 pts, hungry for another shot. Their fallen run (${life.pts} pts, ${life.w}W-${life.l}L across ${life.matches_played} matches) is etched into the club's history forever, but the ladder ahead is a clean slate.`,
  (club, life) => `⚡ ${club} REFUSES TO STAY DOWN. Eliminated, but never forgotten — that ${life.w}-win run stays on the record. Now they're back on the ladder at zero, ready to write a new chapter.`,
  (club, life) => `👑 A PHOENIX MOMENT for ${club}! Struck down after ${life.matches_played} battles (${life.pts} pts, ${life.w}W-${life.l}L), they've chosen rebirth. Fresh life, fresh points — same fire.`,
];

/**
 * One line of hype for the toast shown the instant a club is reborn.
 * `finishedLife` is the past_lives entry reborn() just archived, so the
 * copy can quote real numbers back at the club. Pick defaults to random;
 * pass a fixed `pick` for deterministic tests.
 */
export function rebirthAnnouncement(club, finishedLife, pick = Math.floor(Math.random() * REBIRTH_ANNOUNCEMENTS.length)) {
  return REBIRTH_ANNOUNCEMENTS[((pick % REBIRTH_ANNOUNCEMENTS.length) + REBIRTH_ANNOUNCEMENTS.length) % REBIRTH_ANNOUNCEMENTS.length](club, finishedLife);
}

// ---------------------------------------------------------------------------
// Matchmaking rating (Elo-style) — decoupled from pts/the league table
// ---------------------------------------------------------------------------
//
// The league table (pts, w/l/gd/streak, badges, rankLadderCupStandings,
// the tiebreaker chain) is the club's actual standing in this Ladder Cup
// and works exactly as it always has — nothing below touches it.
//
// ladder_rating is a second, independent number whose only job is finding
// the next opponent (getOpponentPool). It starts every club at
// RATING_START and moves with a standard Elo update on every recorded
// win/loss (played or walkover), so the matching band tracks each club's
// run of form rather than the league's own points/tiebreaker rules.

/** Standard Elo expected-score for A against B, given their current ratings. */
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * One Elo update for a single result. Returns the two new ratings —
 * doesn't mutate anything, same "return new values, caller persists them"
 * shape as the rest of this engine.
 */
export function computeEloUpdate(winnerRating, loserRating, kFactor = LADDER_CUP_RULES.RATING_K_FACTOR) {
  const expectedWinner = expectedScore(winnerRating, loserRating);
  const delta = Math.round(kFactor * (1 - expectedWinner));
  return {
    winnerRating: winnerRating + delta,
    loserRating: loserRating - delta,
  };
}

// ---------------------------------------------------------------------------
// Opponent matching (step 2)
// ---------------------------------------------------------------------------

/**
 * Expanding-band opponent search: ±100 ladder_rating, widening by ±50 with
 * no ceiling until the pool isn't thin anymore. Only "active" clubs (not
 * the entry itself, not eliminated, not mid-second-life-decision) are
 * eligible. Returns up to SHOWN_OPPONENTS, closest-in-rating first. Empty
 * result means "wait for the pool to widen" — there are no byes.
 *
 * This is "the ladder" purely as a matchmaking tool — it has no table of
 * its own and never influences the league table (pts/standings) above.
 *
 * Re-run this after any result is logged (played or walkover) — that's the
 * "logging a result refreshes your opponent slate" rule; it's just calling
 * this again with fresh entries, not a separate mechanism.
 */
export function getOpponentPool(entry, allEntries) {
  const R = LADDER_CUP_RULES;
  const myRating = entry.ladder_rating ?? R.RATING_START;
  const eligible = allEntries.filter((e) => e.club_id !== entry.club_id && e.status === "active");
  if (eligible.length === 0) return [];

  const ratingOf = (e) => e.ladder_rating ?? R.RATING_START;
  let band = R.RATING_BAND_START;
  let pool = eligible.filter((e) => Math.abs(ratingOf(e) - myRating) <= band);
  while (pool.length < R.SHOWN_OPPONENTS && pool.length < eligible.length) {
    band += R.RATING_BAND_STEP;
    pool = eligible.filter((e) => Math.abs(ratingOf(e) - myRating) <= band);
  }
  return pool
    .sort((a, b) => Math.abs(ratingOf(a) - myRating) - Math.abs(ratingOf(b) - myRating))
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

/**
 * Step 13: the single predicate that decides whether a league is still
 * "live" for write purposes. `cutoff` is a league's `ladder_cup_cutoff_at`
 * (nullable — leagues created before a cutoff was required, or mid-setup,
 * never block). Shared by every ladder_cup write path in App.jsx
 * (initiating a match, setting its length, logging a result, messaging or
 * submitting/approving a walkover claim, responding to a second-life
 * offer) so "the cup is over" means the same thing everywhere, and by the
 * lazy finalize-on-read effect that decides whether it's time to run
 * finalizeAtCutoff/crownChampion at all.
 */
export function hasLadderCupCutoffPassed(cutoff, now = new Date()) {
  if (!cutoff) return false;
  return new Date(cutoff).getTime() <= now.getTime();
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
