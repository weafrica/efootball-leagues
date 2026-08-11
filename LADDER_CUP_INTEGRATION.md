# Survival Ladder Cup — integration notes

Two files to drop in, plus the wiring below.

- `src/formats/ladderCup.js` — the rules engine. Pure functions, no
  React/Supabase imports, so it's callable from client code or a Supabase
  edge function. Smoke-tested (scoring, second-life state machine, opponent
  band widening all check out against the ruleset).
- `supabase/migrations/20260811_ladder_cup.sql` — schema. Written against
  this repo's existing `leagues`/`teams` naming; adjust FK names if yours
  differ before running.

## 1. Register the format

In `src/App.jsx`, add to `FORMATS`:

```js
{ id: "ladder_cup", label: "Survival Ladder Cup", kind: "ladder_cup",
  desc: "Ranked ladder, one elimination life each. Most points by the Sunday cutoff wins.",
  available: true },
```

Its own `kind` (not `round_robin`/`knockout`) means it doesn't interact
with the one-active-fun-league-per-kind join lock — matches the ruleset's
"open to both fun and cash leagues, not restricted," which is already the
default for any format that doesn't add its own extra check.

## 2. CreateLeague.jsx

Follow the existing `survivor`/`groups` pattern (config object only sent
when that format is picked):

```js
const [ladderCutoff, setLadderCutoff] = useState(""); // Sunday 10PM UTC+2 target
// ...
ladderCup: format === "ladder_cup" ? { cutoffAt: new Date(ladderCutoff).toISOString() } : null,
```

`startsAt` already exists in the form for "Tuesday 12:00 AM" — no new field
needed there, just the cutoff.

## 3. Applying a logged result

Wherever results currently get written back (the result-logging modal's
submit handler), for a `ladder_cup` league call:

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

## 4. Opponent slate

`getOpponentPool(entry, allEntries)` returns up to 5, band-widened. Re-run
it after any result is logged (played or walkover) — "logging a result
refreshes your opponent slate" is just: call this again and re-render.

## 5. Still-open items from the ruleset — implemented as flags, not resolved

- **Match length (6–15 min, home team's choice):** captured in
  `ladder_cup_matches.match_length_minutes` and validated by
  `MATCH_LENGTH_MIN_MINUTES`/`MAX_MINUTES` in the engine, but it has no
  effect on scoring — nothing to decide there yet, just storage.
- **Extra time → GD:** `LADDER_CUP_RULES.COUNT_EXTRA_TIME_IN_GD` (currently
  `false`). Regulation always counts, penalties never do (both settled);
  this one constant is the switch once extra-time's GD treatment is decided.
- **Opponent refresh:** engine is poll-on-action by design (call
  `getOpponentPool` again after logging a result) — matches the recommended
  default. Swapping in a live subscription later is additive, doesn't
  change the engine.
- **Walkover proof storage:** `ladder_cup_walkover_claims.proof_url` is a
  plain text column — point it at whatever bucket/signed-URL scheme
  `result-proofs` already uses (`src/utils/blobUpload.js` / `mediaUrl.js`),
  no new upload path needed.
