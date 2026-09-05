# Baseline inventory (Step 1 output)

Scratch working file for `BASELINE-SCHEMA-MIGRATION-PLAN.md` Step 1 — not
meant to be a polished doc, just the checklist Step 4 works from. Not
committed as part of the feature; delete once the baseline migration lands.

Method: compared production directly (Supabase project `jobgzxljuczzqljwavyq`,
"weafrica Leagues") against every `create table` / `create function` /
`create trigger` / `create extension` statement actually present in
`supabase/migrations/*.sql`, rather than spinning up a scratch branch and
diffing — same result, no docker required.

## 1. Tables missing a local `create table` (32)

Live in production, zero `create table` anywhere in `supabase/migrations/`:

```
achievements
admins
app_settings
balances
challenge_board_comment_likes
challenge_board_comments
challenge_messages
challenges
comment_likes
comments
fixtures
ladder_comment_likes
ladder_comments
ladder_cup_pool_sightings
ladder_cup_second_life_offers
ladder_result_log
ladder_reward_payout_queue
league_reactions
leagues
members
nets_daily_login_claims
open_challenges
profiles
result_submissions
shop_categories
shop_departments
shop_order_items
shop_orders
shop_products
suggestions
teams
transactions
```

Of these, a subset is at least *referenced* by later migrations (functions
that `insert into`/`select from` them), which confirms they existed before
migration-tracking started rather than being dead code:
`transactions`, `balances`, `comments`, `comment_likes`, `result_submissions`,
`challenges`, `open_challenges`, `ladder_comments`, `ladder_comment_likes`,
`app_settings`, `suggestions`.

The rest have **zero references anywhere** in `supabase/migrations/` — not
just missing creation, the whole subsystem is invisible to the migration
history: `achievements`, `admins`, `challenge_board_comments`,
`challenge_board_comment_likes`, `challenge_messages`, `shop_products`,
`shop_orders`, `shop_order_items`, `shop_departments`, `shop_categories`,
`ladder_result_log`, `league_reactions`, `ladder_cup_second_life_offers`,
`ladder_cup_pool_sightings`, `ladder_reward_payout_queue`,
`nets_daily_login_claims`. Note `ladder_cup_second_life_offers` is
different from the state columns already tracked inline on
`ladder_cup_entries` in `20260811_ladder_cup.sql` (`second_life_used`,
`second_life_offered_at`, `second_life_expires_at`) — this is a separate
history/log table, not a duplicate of that.

`leagues`, `teams`, `members`, `fixtures`, `profiles` — the five named in
the CI failure — are in this list as expected.

## 2. Core helper functions with no local `create function` (6)

All six are referenced across many RLS policies / triggers, so they're
load-bearing, not incidental:

```
is_league_admin
is_member_of_league
is_platform_admin
increment_balance
check_comment_parent_same_league
rls_auto_enable
```

## 3. Triggers on core tables with no local `create trigger` (4)

```
trg_resolve_ladder_fixture      (fixtures)
trg_resolve_league_fixture      (fixtures)
trg_snapshot_fixture_points     (fixtures)
trg_sync_ladder_profile         (profiles)
```

Partial gap, not total: other triggers on the same tables (e.g.
`trg_fixture_notify_next_match` on `fixtures`, `auto_ladder_cup_entry` on
`teams`) ARE captured locally in later feature migrations. The baseline
only needs to backfill the four above.

## 4. RLS policies — counted, not yet dumped verbatim

Policy counts on the six originally-suspected tables (from `pg_policies`):

| table    | policies |
|----------|----------|
| leagues  | 7        |
| teams    | 7        |
| members  | 10       |
| fixtures | 4        |
| profiles | 5        |
| admins   | 1        |

**34 policies total on just these 6** — the other 26 missing tables
haven't been enumerated policy-by-policy. Do that as part of Step 4's
`pg_dump`/policy dump rather than by hand here; a summary count isn't
enough to reconstruct exact `USING`/`WITH CHECK` clauses.

## 5. Extensions relied on but never explicitly created locally (5)

Only one explicit `create extension` exists anywhere in
`supabase/migrations/`:

```
create extension if not exists pg_cron with schema extensions;
```

Live extensions with no matching local statement: `pg_net` (see also the
`enable_pg_net_for_push_test` migration below — tracked in production,
missing from the repo entirely), `pgcrypto`, `uuid-ossp`, `supabase_vault`,
`pg_stat_statements`. Some of these ship enabled by default on every
Supabase project regardless of any migration — confirm which ones actually
need an explicit `create extension` in the baseline vs. which are already
guaranteed, during Step 4 rather than assuming all five need it.

## 6. Malformed migration filenames silently skipped by CI (4)

Not part of the schema gap, but sitting in the same folder and silently
ignored by `supabase test db` because they don't match
`<timestamp>_name.sql`:

```
diagnose-live-close-week-source.sql
fix-ladder-cup-bring-back-prior-clubs-now.sql
fix-league1-week1-now.sql
ladder_cup_monthly_cycle_sanity_check.sql
```

Rename (to a proper timestamp prefix) or delete each as part of Step 3 —
worth opening each file first to check whether it's a one-off fix that
already landed some other way, a diagnostic query that was never meant to
be a migration, or something that still needs applying.

## 7. Migration-history mismatches with production (not a CI blocker, but a deploy risk)

Production's tracked history (`supabase_migrations.schema_migrations`, via
`list_migrations`) only goes back to `20260831103224`. Every local file
dated `20260811`–`20260830` (~55 files, e.g. `20260811_ladder_cup.sql`
itself, `nets_wallet.sql`, `transfer_market.sql`, `20260814_user_activity_log.sql`)
already produced tables that exist live and have data, but none of them
are recorded as applied in production's history table. Same root cause as
#1–#5 (direct SQL-editor/dashboard use instead of `db push`/`apply_migration`),
just less severe since the files do exist — they're only untracked on the
production side, not missing from the repo.

The reverse also happens at least once: `enable_pg_net_for_push_test`
(`20260904093439`) **is** in production's tracked history with no matching
file anywhere in `supabase/migrations/`.

This doesn't block CI (CI always builds from files against an empty DB,
never touches production's history table) but will block or corrupt the
next real `supabase db push` to production unless repaired first — see
Step 6 of the plan.

## 8. Found while writing the baseline (Step 4), not caught in this Step 1 pass

Re-verified independently against live production while assembling
`20260810235959_baseline_schema.sql` — not carried over from any prior
summary:

- The trigger *functions* backing the 4 fixtures/profiles triggers in
  section 3 (`trg_snapshot_fixture_points`, `trg_resolve_ladder_fixture`,
  `trg_resolve_league_fixture`, `sync_ladder_profile`) also have no local
  `create function` anywhere — only the `create trigger` statements were
  flagged above. Now included in the baseline.
- `trg_resolve_ladder_fixture` calls
  `apply_ladder_result(text, uuid, uuid, int, int, uuid, int, int)`,
  which likewise has no local `create function`. Three overloads of
  `apply_ladder_result` exist live (2, 6, and 8 args); only the 8-arg one
  is actually called by this trigger and is the one now in the baseline.
  This function depends on `ladder_ranks`, created much later
  (`20260827_ladder_ranks_and_resolve_trigger.sql`) — including it in
  the pre-`20260811` baseline is safe (Postgres doesn't check a
  function body's table references until the function is actually
  called) but it doesn't semantically belong to the pre-migration era;
  flagging it here rather than implying otherwise.
- `rls_auto_enable()` had no matching `create event trigger` in any
  local file either — the function alone doesn't do anything; the event
  trigger wiring it to `ddl_command_end` was missing too. Both are now
  in the baseline.

## Not yet done in this pass

- Column-level diff per table (types, defaults, not-null, generated
  columns) — Step 4's `pg_dump --schema-only` should be the source of
  truth for this, not a hand-typed list here.
- Verbatim RLS policy bodies (`USING`/`WITH CHECK` expressions) for any
  table, and policy enumeration for the 26 tables beyond the original six.
- Storage buckets / storage policies — not checked in this pass; worth a
  quick look given the plan already flags "a storage bucket created by
  hand" as a plausible category of drift.
- Sequences, views, and materialized views (e.g. `league_home_summary`
  from `20260913_league_home_summary_matview.sql`) — not diffed against
  production in this pass.
