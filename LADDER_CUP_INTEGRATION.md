# Survival Ladder Cup — integration notes (steps 1–3)

**Step 1** shipped scoring + elimination/second-life. **Step 2** added
opponent matching. **Step 3** (this update) adds walkover claims. Cutoff
finalization is the remaining step — not built yet, not referenced below.

- `src/formats/ladderCup.js` — same file as before, with the walkover
  claim functions appended at the bottom. Smoke-tested: 24h gate enforced,
  base-3-only scoring even mid-heater-streak, no-show loser runs through
  the same loss/second-life path as a real defeat.
- `supabase/migrations/20260811_ladder_cup.sql` — adds
  `ladder_cup_walkover_claims`. `ladder_cup_entries`/`ladder_cup_matches`
  unchanged from step 1.

## 1. Register the format

In `src/App.jsx`, add to `FORMATS`:

```js
{ id: "ladder_cup", label: "Survival Ladder Cup", kind: "ladder_cup",
  desc: "Ranked ladder, one elimination life each. Most points by the Sunday cutoff wins.",
  available: true },
```

Own `kind` so it doesn't interact with the one-active-fun-league-per-kind
join lock other formats share.

## 2. Applying a logged result

Wherever results currently get written back for other formats, for a
`ladder_cup` league call:

```js
import { recordLadderCupWin, rankLadderCupStandings, expireStaleSecondLifeOffers } from "./formats/ladderCup.js";

const standingsBefore = rankLadderCupStandings(entries);
const { winner, loser, winnerPointsBreakdown } = recordLadderCupWin({
  winner: winnerEntry, loser: loserEntry, standingsBeforeMatch: standingsBefore,
  isWalkover, winnerGoals, loserGoals, decidedBy, extraTimeGoalsWinner, extraTimeGoalsLoser,
});
```

Persist `winner`/`loser` back to `ladder_cup_entries`, then re-run
`rankLadderCupStandings` on the full set so the *next* match's bounty-target
check sees the fresh #1. Call `expireStaleSecondLifeOffers(entries)` on read
(or on a cron) so lapsed 24h offers convert to final elimination without
needing a response.

Second-life accept/decline UI just needs two buttons calling
`acceptSecondLife(entry)` / `declineOrExpireSecondLife(entry)` and writing
the result back.

## 3. Opponent slate (step 2)

```js
import { getOpponentPool } from "./formats/ladderCup.js";

const opponents = getOpponentPool(myEntry, allEntries); // up to 5, closest points first
```

Call it wherever the "who can I challenge" screen renders, and again
after any result is logged (played or walkover) to refresh the slate —
that's the whole mechanism, no extra state to track. An empty result means
there's genuinely no one in range yet; show a "waiting for opponents"
state rather than treating it as an error.

## 4. Walkover claims (step 3)

```js
import { createWalkoverClaim, isWalkoverClaimable, submitWalkoverClaim, approveWalkoverClaim, recordLadderCupWin } from "./formats/ladderCup.js";

// Player messages an opponent from the opponent slate:
const claim = createWalkoverClaim(myClubId, targetClubId);
// persist to ladder_cup_walkover_claims (status: "messaged")

// 24h later, player submits with a screenshot — UI should only show the
// claim button once isWalkoverClaimable(claim) is true:
const submitted = submitWalkoverClaim(claim, proofUrl);
// persist (status: "pending_review")

// Admin approves:
const approved = approveWalkoverClaim(submitted);
// then apply it as a real result, same path as any logged match:
const standingsBefore = rankLadderCupStandings(entries);
const { winner, loser } = recordLadderCupWin({
  winner: claimantEntry, loser: targetEntry, standingsBeforeMatch: standingsBefore,
  isWalkover: true, winnerGoals: 0, loserGoals: 0,
});
```

Enforce "up to 5 concurrent claims, one per shown opponent slot" in the UI
layer by checking against `getOpponentPool(myEntry, allEntries)` before
letting a new claim start — the DB only blocks a duplicate claim against
the same target, not the 5-slot cap overall.

## What's coming next (not in this step)

- Hard cutoff finalization + the full 3-level tiebreaker (points → GD →
  toughest opponent beaten) — `rankLadderCupStandings` here only sorts by
  points, since matching/scoring don't need the rest yet
- Match length field (6–15 min, home team's choice) — no scoring effect,
  just needs a form field + column whenever it's added
