-- League Ladder — Phase 1, table 3 of 5: ladder_fixtures.
--
-- One row per round-robin match. countdown_expires_at is nullable at the
-- schema level because Phase 2 generates the row before Phase 6 assigns
-- its staggered countdown time — a fixture can legitimately exist without
-- one yet, mid-rollout. Phase 6's sweep job only ever acts on rows where
-- it's both set and in the past, so a null here just means "not on the
-- clock yet," never an error state.
--
-- home_score/away_score stay null until the match is actually played —
-- deliberately nullable rather than defaulting to 0, so "0-0 played" and
-- "not played yet" are never confusable in a query.
--
-- Safe to run more than once.

create table if not exists ladder_fixtures (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references ladder_leagues(id) on delete cascade,
  week_number integer not null,
  home_user_id uuid not null references auth.users(id) on delete cascade,
  away_user_id uuid not null references auth.users(id) on delete cascade,
  countdown_expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'played', 'forfeited')),
  home_score integer,
  away_score integer,
  played_at timestamptz,
  created_at timestamptz not null default now(),
  check (home_user_id <> away_user_id)
);

-- Standings computation and "this league's fixtures this week" both key
-- off this pair.
create index if not exists idx_ladder_fixtures_league_week
  on ladder_fixtures (league_id, week_number);

-- "My upcoming/past fixtures" — two indexes rather than one on a computed
-- pair, since home and away are separate columns, not a single participant
-- column, matching how existing fixtures/challenges tables in this repo
-- are queried by participant.
create index if not exists idx_ladder_fixtures_home on ladder_fixtures (home_user_id);
create index if not exists idx_ladder_fixtures_away on ladder_fixtures (away_user_id);

-- Phase 6's hourly sweep job's exact query shape: pending fixtures whose
-- countdown has expired. Partial index keeps it cheap even once the table
-- has a season's worth of played history in it.
create index if not exists idx_ladder_fixtures_pending_countdown
  on ladder_fixtures (countdown_expires_at)
  where status = 'pending';

alter table ladder_fixtures enable row level security;

-- Public read — results/standings are visible to any signed-in player.
drop policy if exists "ladder_fixtures_select" on ladder_fixtures;
create policy "ladder_fixtures_select" on ladder_fixtures for select
  to authenticated
  using (true);

-- No insert/update/delete policies yet — fixture generation is Phase 2
-- (SECURITY DEFINER, tied to the Tuesday 12AM cycle job), result
-- submission is a Phase 2 RPC mirroring the existing result-submission
-- flow, and the forfeit sweep is Phase 6 (SECURITY DEFINER). None of
-- those are built yet — this migration is the table only.
