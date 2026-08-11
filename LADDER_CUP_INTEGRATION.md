# Survival Ladder Cup — integration notes (steps 1–2)

**Step 1** shipped scoring + elimination/second-life. **Step 2** (this
update) adds opponent matching. Walkover claims and cutoff finalization
are still separate steps — not built yet, not referenced below.

- `src/formats/ladderCup.js` — same file as step 1, with `getOpponentPool`
  appended at the bottom. Pure functions, no React/Supabase imports.
  Smoke-tested: band widening, no-bye-when-empty, closest-first ordering
  all check out.
- `supabase/migrations/20260811_ladder_cup.sql` — unchanged from step 1.
  Matching runs live off `ladder_cup_entries.pts`/`.status`, no new table.

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

## What's coming next (not in this step)

- Walkover claims (message → 24h wait → claim with proof → admin review)
- Hard cutoff finalization + the full 3-level tiebreaker (points → GD →
  toughest opponent beaten) — `rankLadderCupStandings` here only sorts by
  points, since matching/scoring don't need the rest yet
- Match length field (6–15 min, home team's choice) — no scoring effect,
  just needs a form field + column whenever it's added
