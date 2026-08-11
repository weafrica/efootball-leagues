-- WEAFRICA SURVIVAL LADDER CUP — schema migration
--
-- Assumes the existing `leagues` / `teams` (clubs) / results tables already
-- used by round_robin/knockout/groups_knockout formats. This adds the
-- ladder-cup-specific state on top rather than reinventing club/league
-- storage. Adjust table/column names to match your actual schema before
-- running — written against the naming this repo already uses
-- (leagues.format, teams.eliminated, teams.points/gd style columns).

-- 1. Per-club Ladder Cup state (one row per team per ladder_cup league)
create table if not exists ladder_cup_entries (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  pts integer not null default 0,
  w integer not null default 0,
  l integer not null default 0,
  gd integer not null default 0,
  streak integer not null default 0,
  status text not null default 'active'
    check (status in ('active', 'pending_second_life', 'eliminated', 'champion')),
  second_life_used boolean not null default false,
  second_life_offered_at timestamptz,
  second_life_expires_at timestamptz,
  toughest_opponent_beaten_pts integer not null default 0,
  badge_heater_tier smallint not null default 0,
  badge_giant_slayer integer not null default 0,
  badge_second_life boolean not null default false,
  badge_walkover integer not null default 0,
  badge_bounty_hunter integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, team_id)
);

create index if not exists idx_ladder_cup_entries_league on ladder_cup_entries(league_id);
create index if not exists idx_ladder_cup_entries_status on ladder_cup_entries(league_id, status);

-- 2. Match results (regulation / extra time / penalties, home-team-chosen length)
create table if not exists ladder_cup_matches (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  home_team_id uuid not null references teams(id),
  away_team_id uuid not null references teams(id),
  -- STILL OPEN in the ruleset: match length is captured here but has no
  -- scoring effect yet. 6–15 minutes per half, home team's choice.
  match_length_minutes smallint check (match_length_minutes between 6 and 15),
  home_goals integer,
  away_goals integer,
  extra_time_home_goals integer,
  extra_time_away_goals integer,
  penalties_home integer,
  penalties_away integer,
  decided_by text check (decided_by in ('regulation', 'extra_time', 'penalties')),
  is_walkover boolean not null default false,
  winner_team_id uuid references teams(id),
  proof_url text,
  finalized_at timestamptz, -- null while mid-match / unconfirmed; cutoff logic filters on this
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_cup_matches_league on ladder_cup_matches(league_id);

-- 3. Walkover claims (up to 5 concurrent per club, one per shown opponent slot)
create table if not exists ladder_cup_walkover_claims (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  claimant_team_id uuid not null references teams(id),
  target_team_id uuid not null references teams(id),
  messaged_at timestamptz not null default now(),
  claimable_at timestamptz not null, -- messaged_at + 24h, set by app/trigger
  status text not null default 'messaged'
    check (status in ('messaged', 'pending_review', 'approved', 'rejected')),
  proof_url text,
  approved_at timestamptz,
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_cup_claims_league on ladder_cup_walkover_claims(league_id);
-- Enforce "up to 5 concurrent claims, one per shown opponent" at the app
-- layer (needs the live opponent slate to validate against) — a DB
-- constraint alone can't express "one per shown opponent slot".
create unique index if not exists uq_ladder_cup_claim_per_target
  on ladder_cup_walkover_claims(claimant_team_id, target_team_id)
  where status in ('messaged', 'pending_review');

-- 4. League-level cutoff config
alter table leagues
  add column if not exists ladder_cup_cutoff_at timestamptz;
  -- Set to the Sunday 10PM UTC+2 deadline when a ladder_cup league is created.
  -- FORMATS entry uses kind: 'ladder_cup' — see LADDER_CUP_INTEGRATION.md.
