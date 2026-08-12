# Survival Ladder Cup — integration notes (all 5 steps — full ruleset covered)

**Step 1** shipped scoring + elimination/second-life. **Step 2** added
opponent matching. **Step 3** added walkover claims. **Step 4** added
cutoff finalization and the full tiebreaker chain. **Step 5** (this
update) adds the remaining MATCH FLOW mechanics: random home-team
assignment, match length validation, and substitution counts. Every rule
in the original ruleset now has a corresponding engine function.

- `src/formats/ladderCup.js` — `assignHomeTeam`, `isValidMatchLength`,
  `substitutionsAllowed` appended at the bottom. Smoke-tested: home
  assignment is ~50/50 over 2000 trials, length validation is exact at
  the 6/15 boundaries and rejects non-integers, sub count is 6 normally
  and 7 once extra time is reached (penalties don't add a further sub —
  they only happen after extra time, so the +1 already applies).
- `supabase/migrations/20260811_ladder_cup.sql` — adds
  `match_length_minutes` to `ladder_cup_matches` (was reserved in the
  comments since step 1, now actually a column) with a matching CHECK
  constraint as a backstop to the app-side validator. Includes an `ALTER
  TABLE ... ADD COLUMN IF NOT EXISTS` for anyone who already ran an
  earlier version of this migration, since `CREATE TABLE IF NOT EXISTS`
  won't retroactively add a column to a table that already exists.

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

const opponents = getOpponentPool(myEntry, allEntries); // up to 5, closest ladder_rating first
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

## 5. Cutoff finalization (step 4)

At the league's `ladder_cup_cutoff_at` (Sunday 10PM UTC+2 — set at league
creation, see the `leagues` column added in step 1):

```js
import { finalizeAtCutoff, crownChampion, rankLadderCupStandings } from "./formats/ladderCup.js";

const { finalizedMatches, finalizedClaims } = finalizeAtCutoff({
  matches: allLadderCupMatches, walkoverClaims: allWalkoverClaims, cutoff: league.ladder_cup_cutoff_at,
});
// finalizedMatches/finalizedClaims are what actually counted — anything
// mid-match or still inside its 24h claim window at the deadline is
// dropped from these lists (their points were never applied to entries in
// the first place, since recordLadderCupWin only runs on a completed
// result — this function is for reporting/audit, not undoing).

const champion = crownChampion(entries); // most points among non-eliminated clubs, tiebreaker chain resolves ties
```

Run this off a scheduled job (Supabase cron / edge function) that fires at
each league's cutoff, or lazily on read once `now >= cutoff`. Either way,
`rankLadderCupStandings(entries)` is what renders the live standings table
all week — it's the same full-tiebreaker ordering used here, so there's no
separate "final standings" code path to keep in sync.

## 6. Match setup (step 5)

```js
import { assignHomeTeam, isValidMatchLength, substitutionsAllowed } from "./formats/ladderCup.js";

const { home, away } = assignHomeTeam(clubAId, clubBId); // random each fixture

// when the home team submits their chosen length:
if (!isValidMatchLength(chosenMinutes)) { /* reject, show 6–15 range */ }

// display-only, e.g. in the match/result UI:
const subsAllowed = substitutionsAllowed(decidedBy); // 6, or 7 once it reaches extra time
```

## 7. Matchmaking rating — decoupled from pts

`ladder_cup_entries.pts` (and w/l/gd/streak/badges) is the league table.
It's unaffected by anything in this section — `rankLadderCupStandings`,
the tiebreaker chain, and `crownChampion` all still read `pts` exactly as
before.

`ladder_rating` is a second, independent number whose only job is
`getOpponentPool`'s band search — "the ladder" as a matchmaking tool, with
no table of its own. Every club starts at 1000 (`RATING_START`) and moves
with a standard Elo update (`computeEloUpdate`, K-factor 32) on every
recorded win/loss, played or approved walkover — `recordLadderCupWin`
computes both the pts change and the rating change in the same call, but
they're independent outputs.

```js
import { computeEloUpdate, getOpponentPool } from "./formats/ladderCup.js";

// recordLadderCupWin already does this internally and returns it on
// winner.ladder_rating / loser.ladder_rating — shown here just to make
// the independence from pts explicit:
const { winnerRating, loserRating } = computeEloUpdate(winnerEntry.ladder_rating, loserEntry.ladder_rating);

// same call as section 3, now banding on ladder_rating instead of pts:
const opponents = getOpponentPool(myEntry, allEntries);
```

Migration: `supabase/migrations/20260813_ladder_cup_rating.sql` adds
`ladder_rating integer not null default 1000` to `ladder_cup_entries`
plus a `(league_id, ladder_rating)` index for the band search. The
JS↔row adapters (`ladderCupEntryFromRow` / `ladderCupRowPatchFromEntry`
in `App.jsx`, `toLadderCupEngineEntries` in `LeagueDetail.jsx`) all round-trip
it now, so both places that call `recordLadderCupWin` and persist the
result — the played-match result path and the walkover-claim approval
path — pick it up automatically.

## 8. Guaranteed ladder placement on join

Every team in a `ladder_cup` league gets its `ladder_cup_entries` row from
a database trigger (`supabase/migrations/20260814_ladder_cup_auto_entry_trigger.sql`),
not app code — `trg_auto_ladder_cup_entry` fires `after insert on teams`
and creates the row in the same transaction whenever the team's league is
`format = 'ladder_cup'`. This covers every path a team can be created
through (self-join, cash-join, admin pre-listing, claiming a pre-listed
club) including any future one, without needing each call site to
remember to do it.

`ensureLadderCupEntry`'s RPC call in `App.jsx` still runs alongside this —
it's now a harmless, idempotent no-op (`on conflict do nothing`) rather
than the only thing standing between a team and a missing ladder entry.
The lazy self-heal effect (`backfilledLadderCupEntriesChecked` in
`App.jsx`) also stays, as a client-side catch-all for anything created
before this trigger existed.

## What's coming next

Nothing left in the ruleset itself — every rule now has an engine
function. What remains is wiring these into the actual UI (FORMATS entry
in `App.jsx`, a Ladder Cup result-logging flow, a standings screen). None
of that changes the engine; it's plumbing existing screens (like
`LeagueDetail.jsx`'s result modal) to call the functions above instead of
the round-robin/knockout logic they call today.
