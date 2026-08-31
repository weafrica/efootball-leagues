# Ladder Confirm Bug — Fix Log & Schema Backup Guide

This file documents two bugs found and fixed in the Supabase database
backing this app, plus instructions for keeping a backup of the database
schema going forward (so future issues don't require reverse-engineering
the live database from scratch again).

## What was broken

### 1. Confirming a ladder result failed with "UPDATE requires a WHERE clause"

**Cause:** the `trg_resolve_ladder_challenge` trigger (fires on
`challenges` after a result is confirmed) had a bulk rank-shuffle
statement with no `WHERE` clause:

```sql
update public.ladder_ranks set rank_position = rank_position + 1000000;
```

This was intentional (it bumps every rank out of the way before ranks
get recomputed, to avoid colliding with a unique constraint on
`rank_position` mid-statement) — but the database blocks any `UPDATE`
with no `WHERE` clause at all as a safety measure.

**Fix:** added a always-true `WHERE` clause so the intent is preserved:

```sql
update public.ladder_ranks set rank_position = rank_position + 1000000 where user_id is not null;
```

Also set the function to run as `SECURITY DEFINER` so it has permission
to write to `ladder_ranks` regardless of which player triggers it:

```sql
alter function public.trg_resolve_ladder_challenge() security definer;
alter function public.trg_resolve_ladder_challenge() set search_path = public;
```

### 2. "Recent matches" on the Ladder page always showed empty

**Cause:** the app queries a view called `ladder_match_results` for this
section, but that view didn't exist in the database at all (a 404 /
"relation does not exist" error, confirmed in the browser console).

**Fix:** created the view from scratch:

```sql
create or replace view public.ladder_match_results as
select
  id,
  challenger_id,
  opponent_id,
  challenger_username,
  opponent_username,
  challenger_score,
  opponent_score,
  result_confirmed_at
from public.challenges
where is_ladder = true
  and result_status = 'confirmed';

grant select on public.ladder_match_results to anon, authenticated;
```

## Why a schema backup matters

The README for this project references SQL migration files
(`ladder-migration.sql`, `ladder-deadlines-migration.sql`,
`shop-migration.sql`) as the source of truth for the database — but
those files either no longer exist or no longer match what's actually
running live in Supabase. That mismatch is exactly why diagnosing the
bugs above took a long back-and-forth: there was no written record of
what the database was actually doing, so everything had to be pulled
out one query at a time via the SQL Editor.

A schema backup is just a snapshot of everything currently in the
database — every table, view, function, and trigger — saved as a text
file. Keeping one committed to this repo means:

- Future bugs can be diagnosed by reading a file instead of querying
  the live database piece by piece
- If the Supabase project ever needs to be recreated or migrated,
  there's a working reference instead of starting from nothing
- Any accidental changes made directly in the SQL Editor can be
  compared against a known-good version

## How to take a full schema backup

### Option A — full dump via terminal (recommended, ~5 minutes)

Requires Node.js (already needed to run this project locally).

1. In Supabase: **Project Settings → Database → Connection string → URI
   tab**. Copy it. Replace `[YOUR-PASSWORD]` with your real database
   password (there's a **Reset database password** button on the same
   page if you don't have it saved).
2. Open a terminal (Command Prompt / PowerShell on Windows, Terminal on
   Mac) and navigate to this project's folder:
   ```
   cd path/to/efootball-leagues-main
   ```
3. Run:
   ```
   npx supabase db dump --db-url "postgresql://postgres:YOUR_REAL_PASSWORD@db.jobgzxljuczzqljwavyq.supabase.co:5432/postgres" -f supabase/full-schema.sql
   ```
   (approve the CLI install prompt if it appears — type `y`)
4. Commit the resulting `supabase/full-schema.sql` file to this repo.

### Option B — quick copy-paste backup via SQL Editor (2 minutes, no terminal)

Less complete, but captures the part that caused today's bugs
(functions/triggers) and is much faster:

1. Supabase → **SQL Editor**, run:
   ```sql
   select pg_get_functiondef(oid)
   from pg_proc
   where pronamespace = 'public'::regnamespace;
   ```
2. Copy all the results into a text file, save as
   `supabase/functions-backup.txt`, and commit it to this repo.

## Recommended habit going forward

Whenever a new trigger, function, or view is added or changed directly
in the Supabase SQL Editor, re-run one of the backups above and commit
the update — so the repo always reflects what's actually live.
