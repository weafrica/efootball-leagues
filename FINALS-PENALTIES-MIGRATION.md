# Finals & penalties — knockout rule change + required DB migration

## What changed in the app code

**1. Non-final knockout ties level on aggregate now advance both clubs.**
Previously (`advanceKnockout` in `src/App.jsx`), a tie that finished level
on aggregate blocked the round from advancing until an admin manually
edited a score to force a winner. Now: outside the final, a level tie just
sends both clubs through to the next round — no admin intervention needed.
(A tie where *both* legs went unplayed past the deadline is still treated
as a double no-show and both clubs are eliminated, same as before.)

**2. The final is always a single decisive match, and goes to penalties
if it's level.** Whichever round pairs down to exactly one real tie (no
other simultaneous tie, not a bye) is treated as the final — `knockoutRoundFixtures`
now forces that round to a single leg regardless of the league's
"home & away" setting. If it ends level after regulation, `advanceKnockout`
won't create a champion until a decisive penalty score is entered.

**3. Penalty scores are entered through the existing result flow** — the
same score box an admin fills in (`FixtureScoreRow`, `OpponentFinder`) or a
player submits for approval (`SubmitResultModal`) now shows two extra
"pens" fields *only* when the fixture is the final and the score entered
is level. Nothing changes for any other match.

## Required database migration

This adds two nullable columns the app now writes to. Run this in the
Supabase SQL editor:

```sql
alter table public.fixtures
  add column if not exists pens_home integer,
  add column if not exists pens_away integer;

alter table public.result_submissions
  add column if not exists pens_home integer,
  add column if not exists pens_away integer;
```

### One more thing to check: `approve_result_submission`

Per `LADDER-FIXES-AND-BACKUP.md`, this project's SQL migration files
(`ladder-migration.sql` etc.) don't match what's actually live in Supabase,
and the security-definer function `approve_result_submission` (referenced
in `src/App.jsx` around `approveResult`) isn't in this repo at all — so I
can't safely rewrite it blind.

**What to do:** open that function's definition in the Supabase SQL editor
(Database → Functions, or `select pg_get_functiondef('public.approve_result_submission'::regclass)`
if it's not showing in the UI) and find the line(s) that copy
`home_score`/`away_score` from `result_submissions` into `fixtures` when a
submission is approved. Add `pens_home` and `pens_away` to that same copy,
e.g. if it currently does something like:

```sql
update public.fixtures
set played = true, home_score = s.home_score, away_score = s.away_score, played_at = now()
where id = s.fixture_id;
```

change it to:

```sql
update public.fixtures
set played = true, home_score = s.home_score, away_score = s.away_score,
    pens_home = s.pens_home, pens_away = s.pens_away, played_at = now()
where id = s.fixture_id;
```

**Why this matters:** without that change, a player-submitted penalty
score will save correctly to `result_submissions`, but once an admin taps
"Approve" it won't carry over to the `fixtures` row — the match will stay
stuck looking level. Admin-direct entry (`recordResult`, i.e. the score
box any admin fills in themselves) doesn't go through this RPC at all, so
it works today without any SQL change — this only affects the
player-submits-then-admin-approves path.

While you're in there, grab a fresh schema backup per the existing
`LADDER-FIXES-AND-BACKUP.md` instructions — it'll save the next person
from re-deriving this function from scratch again.
