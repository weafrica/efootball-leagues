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

**The gap is bigger than the CI log suggests.** A direct comparison
against the live project (see `supabase/BASELINE-INVENTORY.md`, produced
by Step 1) found ~32 tables with no `create table` anywhere in
`supabase/migrations/` — not just the five named above — plus core
RLS-helper functions (`is_league_admin`, `is_member_of_league`,
`is_platform_admin`, `increment_balance`,
`check_comment_parent_same_league`, `rls_auto_enable`), four triggers on
`fixtures`/`profiles`, 34+ RLS policies on just the six original tables,
and several extensions (`pgcrypto`, `uuid-ossp`, `supabase_vault`,
`pg_stat_statements`) that are relied on but never explicitly
`create extension`'d anywhere locally.

**Separately, production's own migration history is incomplete too.**
Supabase's tracked history (`list_migrations`) only goes back to
`20260831103224`. Every local file dated `20260811` through `20260830`
(~55 files — `ladder_cup.sql`, `nets_wallet.sql`, `transfer_market.sql`,
`user_activity_log.sql`, etc.) already produced tables that exist live,
but none of them are recorded as applied in production's history table —
same root cause (SQL editor / dashboard use instead of `db push` or the
MCP `apply_migration` tool), just later and less severe, since the files
do exist locally — they're only untracked on the production side. The
inverse also happens at least once: `enable_pg_net_for_push_test`
(`20260904093439`) **is** in production's tracked history but has no
matching file in the repo at all.

This means there are really three separate gaps to close, not one:
1. Objects that exist live with no local migration file (the baseline,
   Steps 3–6 below).
2. Local migration files (`20260811`–`20260830`) that were applied to
   production but never recorded in its history table — production will
   try to re-run them on the next real `db push` unless repaired.
3. At least one migration recorded in production's history with no local
   file at all — the opposite direction of gap #2.

The fix for gap #1 is a one-time **baseline migration**: a single file,
dated before `20260811_ladder_cup.sql`, that recreates every foundational
object exactly as it exists live. Once that's in place, a fresh database
built from `supabase/migrations/` matches production, and CI actually
means something. Gaps #2 and #3 don't block CI (CI always builds from
files, not from production's history table) but need a
`supabase migration repair` pass against production before this ships,
or the next real deploy will fail or drift — see Step 6.

This is a bigger job than a normal feature migration — it touches
everything, and a mistake here (a missing `not null`, a dropped default,
a wrong foreign key) could quietly diverge local dev / CI from
production in a way that's hard to notice later. Move carefully, verify
at every step, and don't skip the diffing steps even though they're
tedious.

---

## Step 1 — Inventory what's actually missing ✅ done

Don't assume the gap is only `leagues`/`teams`. Anything created by hand
in the SQL editor or dashboard (extensions, storage buckets, cron jobs,
a stray column added via the table editor) could be missing too.

Instead of spinning up a scratch branch and diffing, this pass compared
production directly (via the Supabase MCP connection — `list_tables`,
`execute_sql` against `information_schema`/`pg_policies`/`pg_extension`)
against every `create table`/function/trigger/extension statement
actually present in `supabase/migrations/`. Same result a branch-diff
would give, without the docker spin-up. Full output in
`supabase/BASELINE-INVENTORY.md` (scratch — not meant to be committed as
part of the feature; delete it once the baseline migration lands).
Headline numbers:

- **32 tables** live with no `create table` anywhere locally — far more
  than the `leagues`/`teams`/`members`/`fixtures`/`profiles` the CI log
  suggested. Several (`shop_products`, `achievements`,
  `challenge_board_comments`, `ladder_cup_second_life_offers`,
  `ladder_reward_payout_queue`, `nets_daily_login_claims`, etc.) aren't
  even *referenced* by any local migration, meaning whole subsystems were
  built entirely by hand.
- **6 core RLS-helper/utility functions** (`is_league_admin`,
  `is_member_of_league`, `is_platform_admin`, `increment_balance`,
  `check_comment_parent_same_league`, `rls_auto_enable`) with no
  `create function` locally, despite being load-bearing for RLS across
  most tables.
- **4 triggers** on `fixtures`/`profiles` — `trg_resolve_ladder_fixture`,
  `trg_resolve_league_fixture`, `trg_snapshot_fixture_points`,
  `trg_sync_ladder_profile` — with no local `create trigger` (other
  triggers on the same tables, like `trg_fixture_notify_next_match`, ARE
  captured locally — this is a partial gap, not "the table has zero
  triggers locally").
- **34 RLS policies** just on the six originally-suspected tables
  (`leagues` 7, `teams` 7, `members` 10, `fixtures` 4, `profiles` 5,
  `admins` 1) — the other ~26 missing tables haven't been enumerated
  policy-by-policy yet; do that as part of Step 4's dump rather than by
  hand.
- **5 extensions** (`pgcrypto`, `uuid-ossp`, `supabase_vault`,
  `pg_stat_statements`, and `pg_net` specifically via the
  `enable_pg_net_for_push_test` migration) relied on but with no explicit
  `create extension` in any local file. Only `pg_cron` has one. Some of
  these may ship enabled by default on every Supabase project regardless
  — worth confirming during Step 4 rather than assuming they all need to
  be in the baseline.
- **4 malformed migration filenames** sitting in the folder and silently
  skipped by CI, not just the two named in the original log:
  `diagnose-live-close-week-source.sql`,
  `fix-ladder-cup-bring-back-prior-clubs-now.sql`,
  `fix-league1-week1-now.sql`, `ladder_cup_monthly_cycle_sanity_check.sql`.
- Production's own migration history table (`list_migrations`) starts at
  `20260831103224` — see "Why this exists" above for what that implies
  for Steps 2 and 6.

This is the checklist Step 4 works from. Re-run the RLS-policy and
column-level comparison per-table while writing the baseline (Step 4.1)
rather than trusting this summary count — policy details (not just
counts) matter and weren't fully dumped here, and column-level types/
defaults/constraints haven't been diffed at all yet.

## Step 2 — Decide the cutoff point

Everything dated `20260811_ladder_cup.sql` or later already has a real
migration file and should NOT be touched — only what predates
migration-tracking goes in the baseline. Confirm the exact boundary by
checking whether `20260811_ladder_cup.sql` (and a few files right after
it) apply cleanly once the baseline exists — if they still fail on a
missing relation, the cutoff needs to move later than currently assumed.

## Step 3 — Handle the four malformed files first

Step 1 found four files, not two, being silently skipped (bad filename
pattern) rather than actually running in CI:
`fix-ladder-cup-bring-back-prior-clubs-now.sql`,
`fix-league1-week1-now.sql`, `diagnose-live-close-week-source.sql`, and
`ladder_cup_monthly_cycle_sanity_check.sql`. Before touching the
baseline, decide what each one is:

- If they're genuinely one-off **data** fixes or ad-hoc diagnostic
  queries (the names suggest this — "bring back prior clubs now", "fix
  league1 week1 now", "diagnose... source", "sanity check") that already
  ran against production once (or were never meant to run as a migration
  at all) and should never run again, move them out of
  `supabase/migrations/` entirely — e.g. into a `supabase/scripts/` or
  `archive/` folder — so they stop being silently ignored and stop
  looking like part of the migration history.
- If any of them actually contains schema changes that production needs
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
