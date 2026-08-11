# Survival Ladder Cup — integration notes (step 1 of 3)

This step ships **scoring + elimination/second-life only**. Opponent
matching, walkover claims, and cutoff finalization are separate steps —
not built yet, not referenced below.

- `src/formats/ladderCup.js` — the engine slice. Pure functions, no
  React/Supabase imports. Smoke-tested: scoring breakdown, second-life
  accept/re-loss all check out against the ruleset.
- `supabase/migrations/20260811_ladder_cup.sql` — `ladder_cup_entries` +
  `ladder_cup_matches` only. Adjust FK names if your `leagues`/`teams`
  columns differ before running.

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

## What's coming next (not in this step)

- Opponent matching (±10 band, widens ±15/±20/…, always show 5, no byes)
- Walkover claims (message → 24h wait → claim with proof → admin review)
- Hard cutoff finalization + the full 3-level tiebreaker (points → GD →
  toughest opponent beaten) — `rankLadderCupStandings` here only sorts by
  points, since matching/scoring don't need the rest yet
- Match length field (6–15 min, home team's choice) — no scoring effect,
  just needs a form field + column whenever it's added
