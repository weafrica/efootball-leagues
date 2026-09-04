# Baseline Schema Migration — Build Plan

## Why this exists

`supabase test db` always starts from a completely empty database and
replays every file in `supabase/migrations/` in order. The very first file,
`20260811_ladder_cup.sql`, already assumes `leagues` and `teams` exist —
but no migration anywhere in the repo creates them. That means the core
schema (`leagues`, `teams`, `members`, `fixtures`, `profiles`, and
whatever else predates migration-tracking) was set up by hand at some
point, directly against the live database, and was never captured as a
migration. CI has therefore never been able to succeed from a clean slate.

The fix is a one-time **baseline migration**: a single file, dated before
`20260811_ladder_cup.sql`, that recreates every foundational object
exactly as it exists live. Once that's in place, a fresh database built
from `supabase/migrations/` matches production, and CI actually means
something.

This is a bigger job than a normal feature migration — it touches
everything, and a mistake here (a missing `not null`, a dropped default,
a wrong foreign key) could quietly diverge local dev / CI from
production in a way that's hard to notice later. Move carefully, verify
at every step, and don't skip the diffing steps even though they're
tedious.

---

## Step 1 — Inventory what's actually missing

Don't assume the gap is only `leagues`/`teams`. Anything created by hand
in the SQL editor or dashboard (extensions, storage buckets, cron jobs,
a stray column added via the table editor) could be missing too.

1. Spin up a scratch Supabase branch (or a fresh local `supabase start`)
   and apply only what's in `supabase/migrations/` today.
2. Compare its schema against production:
   - Every table in `information_schema.tables` (public schema) —
     anything present live but absent locally is missing.
   - Every function/trigger in `information_schema.routines` /
     `pg_trigger` — same comparison.
   - Every extension in `pg_extension` (`pgcrypto`, `uuid-ossp`,
     `pg_net`, `pgtap`, `vault`/`supabase_vault`, etc.) — note this
     turned up `enable_pg_net_for_push_test` already missing locally
     during the last PR; there may be others.
   - RLS policies (`pg_policies`) — a table can exist locally but with
     the wrong (or no) policies, which won't show up as a "missing
     table" but will silently break access.
3. Write the full list down (a scratch file is fine, doesn't need to be
   committed) before writing a single line of the actual migration —
   this is the checklist Step 4 works from.

## Step 2 — Decide the cutoff point

Everything dated `20260811_ladder_cup.sql` or later already has a real
migration file and should NOT be touched — only what predates
migration-tracking goes in the baseline. Confirm the exact boundary by
checking whether `20260811_ladder_cup.sql` (and a few files right after
it) apply cleanly once the baseline exists — if they still fail on a
missing relation, the cutoff needs to move later than currently assumed.

## Step 3 — Handle the two malformed files first

`fix-ladder-cup-bring-back-prior-clubs-now.sql` and
`fix-league1-week1-now.sql` are being silently skipped (bad filename
pattern) rather than actually running in CI. Before touching the
baseline, decide what these are:

- If they're genuinely one-off **data** fixes (their names suggest this
  — "bring back prior clubs now", "fix league1 week1 now") that already
  ran against production once and should never run again, move them out
  of `supabase/migrations/` entirely — e.g. into a `supabase/scripts/`
  or `archive/` folder — so they stop being silently ignored and stop
  looking like part of the migration history.
- If either one actually contains schema changes that production needs
  and local doesn't have, fold that part into the baseline migration
  instead (Step 4) and archive the rest.

Don't rename them to fit the timestamp pattern and leave them in
place — replaying a one-off data fix against a fresh CI database is very
likely wrong (it was written assuming specific rows already existed).

## Step 4 — Write the baseline migration

1. Generate the create-statements for everything on the Step 1 list —
   `pg_dump --schema-only` (or the equivalent read via the SQL editor /
   MCP `execute_sql` against `information_schema` /
   `pg_get_functiondef`) against production is the reliable way to get
   exact column types, defaults, and constraints rather than
   reconstructing them from memory.
2. Assemble one file: `supabase/migrations/<timestamp-before-20260811>_baseline_schema.sql`
   (something like `20260801000000_baseline_schema.sql` — anything
   earlier than `20260811090000`, the first real migration's timestamp).
3. Order matters within the file: extensions first, then tables with no
   foreign-key dependencies, then tables that reference them, then
   functions/triggers, then RLS policies last (policies reference tables
   that must already exist).
4. Match the existing repo's comment style — a short header explaining
   this file exists to capture pre-migration-era manual schema changes,
   so nobody mistakes it for a normal feature migration later.

## Step 5 — Verify against a completely fresh database

1. `supabase stop` / `supabase db reset` locally (or rely on CI) to
   apply every migration from scratch, baseline included.
2. Re-run the Step 1 comparison (fresh local schema vs. production) —
   the diff should now be empty, or only contain expected drift (e.g.
   rows of actual data, which migrations never carry).
3. Run `supabase test db` locally and confirm the existing pgTAP suite
   (`ladder_cup_open_new.test.sql`, plus the next-match trigger tests if
   those get added) passes clean.

## Step 6 — Push and confirm CI

1. Commit the baseline migration, the two moved/archived fix files, and
   nothing else in this PR — keep it isolated so a problem here is easy
   to bisect.
2. Push and watch `.github/workflows/db-tests.yml` — it should now get
   past `20260811_ladder_cup.sql` and run every migration through to the
   current tip.
3. If it fails on a later migration instead of at the start, that's
   real progress (the baseline worked) — it just means Step 1's
   inventory missed something that migration also depends on. Add it to
   the baseline and repeat Step 5.

## Step 7 — Prevent this from happening again

Once CI is green, the drift shouldn't reopen as long as every future
schema change goes through a migration file (whether applied via
`supabase db push` or the MCP `apply_migration` tool, which records it
the same way) rather than the SQL editor or table editor directly. Worth
a one-line note in the repo's README or CONTRIBUTING file to that
effect, since that's exactly how this gap opened up in the first place.
