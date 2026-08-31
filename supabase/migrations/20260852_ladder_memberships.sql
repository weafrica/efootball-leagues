-- League Ladder — Phase 1, table 2 of 5: ladder_memberships.
--
-- Source of truth for "who's where, which week" — one row per player per
-- week_number, referencing whichever league they sit in for that week.
-- unique(user_id, week_number) rather than unique(user_id, league_id,
-- week_number): a player is in exactly one league per week by
-- definition, so week_number alone is enough to pin down "their" row —
-- constraining on league_id too would just let a data bug slip through
-- (two rows for the same person/week in different leagues) instead of
-- being caught by the database.
--
-- status starts at 'active' when the week's roster locks in (Tuesday
-- 12AM) and is updated to 'promoted' / 'relegated' / 'auction_won' /
-- 'eliminated' by Phase 3's resolve job once that week's outcome is known
-- — it describes what happened to this row's player *that week*, not
-- their state going into the next one (next week gets its own new row).
--
-- Safe to run more than once.

create table if not exists ladder_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  league_id uuid not null references ladder_leagues(id) on delete cascade,
  week_number integer not null,
  status text not null default 'active'
    check (status in ('active', 'promoted', 'relegated', 'auction_won', 'eliminated')),
  joined_at timestamptz not null default now(),
  unique (user_id, week_number)
);

-- Standings/roster queries are always "give me everyone in league X for
-- week N" — this is the index that query actually uses.
create index if not exists idx_ladder_memberships_league_week
  on ladder_memberships (league_id, week_number);

-- "Which league is user X in right now" — the other common lookup.
create index if not exists idx_ladder_memberships_user
  on ladder_memberships (user_id, week_number desc);

alter table ladder_memberships enable row level security;

-- Public read — standings and rosters are visible to any signed-in
-- player, same as ladder_ranks.
drop policy if exists "ladder_memberships_select" on ladder_memberships;
create policy "ladder_memberships_select" on ladder_memberships for select
  to authenticated
  using (true);

-- No insert/update/delete policies — rows are written only by Phase 3's
-- resolve job (weekly roster roll-forward) and whatever join-a-league
-- flow Phase 2/3 ends up adding, both SECURITY DEFINER, never a direct
-- client write.
