-- League Ladder — Phase 1, table 1 of 5: ladder_leagues.
--
-- One row per tier. tier is the source of truth for ordering (1 = top,
-- higher = lower down the ladder) — no fixed ceiling on how high the
-- number goes, since new bottom leagues auto-create as the player base
-- grows (Phase 3).
--
-- Deliberately no insert/update/delete policy: leagues are created by the
-- Phase 3 auto-create-bottom-league logic (SECURITY DEFINER), never
-- directly by a client. This migration seeds nothing — Phase 1's own
-- checklist seeds League 8 by hand afterwards, not as part of this file,
-- since a hardcoded starting tier doesn't belong in a migration that
-- should be safe to re-run.
--
-- Safe to run more than once.

create table if not exists ladder_leagues (
  id uuid primary key default gen_random_uuid(),
  tier integer not null unique,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_leagues_status on ladder_leagues (status);

alter table ladder_leagues enable row level security;

-- Read-only from the client, same as ladder_ranks — the tier list/standings
-- are public within the app, nothing sensitive here.
drop policy if exists "ladder_leagues_select" on ladder_leagues;
create policy "ladder_leagues_select" on ladder_leagues for select
  to authenticated
  using (true);

-- No insert/update/delete policies — every write goes through a
-- SECURITY DEFINER function (Phase 3's auto-create-league logic), same
-- no-direct-writes convention as ladder_ranks/nets_wallets.
