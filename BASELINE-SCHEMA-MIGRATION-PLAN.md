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

## Step 2 — Decide the cutoff point ✅ done

Everything dated `20260811_ladder_cup.sql` or later already has a real
migration file and should NOT be touched — only what predates
migration-tracking goes in the baseline. The plan originally called for
confirming this by applying the baseline + early files against a live
database, but that requires Step 4's baseline to already exist. Did a
static check instead, without waiting on Step 4:

- **Confirmed `20260811_ladder_cup.sql` really is the earliest file.**
  Sorting every numeric-prefixed filename, nothing predates it. The four
  malformed-name files (Step 3) don't change this — they're excluded from
  CI's ordering entirely regardless of what date is in their content.
- **Traced every foreign-key `references` clause across all 165 files**
  (11 distinct target tables: `item_listings`, `ladder_cup_matches`,
  `ladder_fixtures`, `ladder_league_comments`, `ladder_leagues`,
  `leagues`, `rapid_cup_lobbies`, `rapid_cup_payouts`,
  `team_sale_listings`, `teams`, `transfer_listings`, plus
  Supabase-managed `auth.users`). Every one of them is either created by
  an earlier local migration, or is `leagues`/`teams` — both already on
  the Step 1 baseline-gap list. **No local file references a table that
  is neither local-created nor covered by the planned baseline** — so
  nothing forces the cutoff later than `20260811_ladder_cup.sql`.
- **Checked for creation syntax the Step 1 `create table` grep could have
  missed** — `create table ... as select`, `select ... into <table>`
  (vs. a PL/pgSQL variable), and `alter table ... rename to`. None exist
  anywhere in the repo; every `select ... into` hit is a PL/pgSQL local
  variable (`v_match`, `v_fixture`, etc.), not a table. So the 32-table
  gap from Step 1 is real, not an artifact of a renamed or
  differently-created table hiding in plain sight.
- **Checked the two same-day files** (`20260811_ladder_cup.sql` and
  `20260811_ladder_cup_start.sql`, which sort in that order) for a
  forward-reference between them — `_start.sql` doesn't create or
  reference anything `_ladder_cup.sql` doesn't already provide, so their
  same-day ordering isn't a problem.

**Conclusion: the cutoff stays exactly where the plan assumed** — the
baseline migration should be dated any time before `20260811_ladder_cup.sql`
(e.g. `20260810235959_baseline_schema.sql`). This is a strong static
signal, not a substitute for actually replaying the migrations once the
baseline exists (Step 5's job) — dynamic SQL, a role/grant ordering issue,
or a sequence/default that isn't declared as a plain `references` clause
wouldn't show up in a text search. Re-verify with a real `supabase test db`
run after Step 4, and treat this as confirmation the assumption was
reasonable, not as skipping Step 5.

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

## Step 4 — Write the baseline migration ✅ done

Pulled exact DDL for every object on the Step 1 list directly from
production (project `jobgzxljuczzqljwavyq`) via SQL introspection
(`information_schema.columns`, `pg_get_constraintdef`, `pg_indexes`,
`pg_policies`, `pg_get_functiondef`, `pg_get_triggerdef`,
`pg_extension`) rather than reconstructing by hand, per the plan.
Two files landed in `supabase/migrations/`:

- `20260810235959_baseline_schema.sql` — the baseline itself: 4
  extensions, 30 tables, PK/UNIQUE constraints, FK constraints, CHECK
  constraints, non-constraint indexes, RLS enable + all policies on
  those 30 tables, the 3 helper functions
  (`is_league_admin`/`is_member_of_league`/`is_platform_admin`) plus
  `increment_balance` and `check_comment_parent_same_league`, the
  `rls_auto_enable()` event-trigger function **and** the matching
  `create event trigger` (the function alone does nothing without it —
  not previously wired up in any local file), and the 4
  fixtures/profiles triggers together with their trigger functions.
- `20260811_ladder_cup_second_life_offers_baseline.sql` — everything
  that could NOT go in the baseline because it depends on
  `ladder_cup_entries`/`ladder_cup_matches`, which are only created by
  `20260811_ladder_cup.sql` itself: the whole
  `ladder_cup_second_life_offers` table, and the
  `comments.ladder_cup_match_id` foreign key (the column and its index
  are still in the baseline — only the FK constraint had to wait).
  Filename chosen so it sorts after `20260811_ladder_cup.sql` under
  plain lexical ordering — verified against this repo's actual file
  list, not assumed.

**Two things this pass found that Step 1's original inventory missed**
(re-verified independently against live production and the local
migration files, not taken on faith from a prior summary):

1. The 4 fixtures/profiles trigger *functions* themselves
   (`trg_snapshot_fixture_points`, `trg_resolve_ladder_fixture`,
   `trg_resolve_league_fixture`, `sync_ladder_profile`) also have no
   local `create function` anywhere — Step 1 only flagged the missing
   `create trigger` statements, not that the functions they call are
   equally uncaptured. Included in the baseline alongside their
   triggers.
2. `trg_resolve_ladder_fixture` calls
   `apply_ladder_result(text, uuid, uuid, int, int, uuid, int, int)`,
   which also has no local `create function` anywhere — a third,
   previously uncaught gap. Three overloads of `apply_ladder_result`
   exist live; only the 8-argument one this trigger actually calls is
   included here. This function depends on `ladder_ranks` (created by
   `20260827_ladder_ranks_and_resolve_trigger.sql`, well after this
   baseline's cutoff) — safe to include anyway since Postgres doesn't
   validate a function body's table references at `CREATE FUNCTION`
   time, only at call time. Flagged in `BASELINE-INVENTORY.md` as a
   fourth gap category, distinct from the pre-`20260811` baseline this
   file otherwise covers.

## Step 5 — Verify against a fresh database ✅ done (free path, no branch)

Rather than spend on a Supabase branch, installed Postgres 16 locally
(sandbox-only, no cost), stubbed the minimal Supabase surface the
baseline actually depends on (`auth.users`, `auth.uid()`, the `anon`/
`authenticated`/`service_role` roles — confirmed by grep these are
the *only* Supabase-specific dependencies in the file), and ran the
real files against it with `psql -v ON_ERROR_STOP=1`. This caught two
real bugs a static FK/text trace could not, since Postgres validates
function calls in `CREATE POLICY` clauses and duplicate PK constraints
at execution time, not via static reference-matching:

1. **Function-ordering bug in `baseline_schema.sql`**: `is_league_admin`,
   `is_member_of_league`, and `is_platform_admin` were defined in
   section 5, *after* the section-4 policies that call them inside
   their `USING`/`WITH CHECK` clauses. Postgres resolves those calls at
   `CREATE POLICY` time, not lazily — this failed immediately on a real
   run (`function is_platform_admin(uuid) does not exist`). Fixed by
   moving those three function definitions into a new section 3b,
   before section 4. Section 5 keeps the remaining functions
   (`increment_balance`, `check_comment_parent_same_league`,
   `rls_auto_enable`), none of which are called from policies in this
   file.
2. Confirmed (not a bug): `20260811_ladder_cup_second_life_offers_baseline.sql`
   only succeeds when run after the real `20260811_ladder_cup.sql`,
   exactly as its own header comment says — tested standalone first
   (expected failure: `ladder_cup_entries` doesn't exist yet), then in
   the correct sequence (clean).

**Full clean run, in true Supabase apply order** (baseline →
`20260811_ladder_cup.sql` → `20260811_ladder_cup_second_life_offers_baseline.sql`):
0 errors. 32 baseline tables + 3 from `ladder_cup.sql` = 35 tables, all
FKs/indexes/RLS policies/functions/triggers created successfully.

**Known, deliberate gap in this local test:** the `pg_net` extension
is Supabase-hosted-only and isn't installable on vanilla Postgres, so
it was commented out *only in the disposable test copy* — the real
repo file still has `create extension if not exists pg_net ...`
untouched. This is an environment limitation of local testing, not a
migration bug; it would need either a Supabase branch or the actual
linked project to verify.

**Not yet done:** running the *full* 167-migration history (not just
these two new files) end-to-end — that would still need a Supabase
branch or `supabase db reset` against the real CLI/project, since a
generic local Postgres can't stand in for Supabase-specific pieces
used later in the history (`pg_net`, `cron`, `storage`, `vault`, etc.).
Also worth noting from the earlier static pass: several migration
filenames past `20260900` mix 8-digit dates with 14-digit timestamps
(e.g. `20260901_x.sql` vs `20260901052706_y.sql`); lexicographic
sort — which is what Supabase actually uses to order migrations —
runs the 14-digit ones first on the same day. Doesn't affect this
baseline's own ordering, but worth being aware of for that later
range.

## Step 4 — Write the baseline migration (original plan, kept for reference)

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
