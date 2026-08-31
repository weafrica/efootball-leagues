-- League Ladder — Phase 2: weekly-cycle scheduler.
--
-- Adds one thing Phase 1's table list didn't cover: a place to track
-- which week is currently active and whether bidding is open right now.
-- That's cycle STATE (Phase 2's concern), not the static data model
-- (Phase 1's), which is why it wasn't in the original five tables.
--
-- ladder_cycle is a singleton, same pattern as ladder_pool (20260855):
-- `id boolean primary key default true check (id)` makes a second row
-- impossible at the constraint level. current_week is the single source
-- of truth every other query (fixtures, memberships, bids) filters
-- week_number against.
--
-- IMPORTANT SCOPE NOTE: per Phase 2's own checklist, this only "flips
-- status flags" and carries the roster forward unchanged — there is no
-- promotion/relegation logic here (Phase 3), no fee charging (Phase 4),
-- no bidding resolution (Phase 5). Every player 'active' in the closing
-- week is simply copied forward into the new week in the same league.
-- Phase 3 will REPLACE this carry-forward step with real promotion/
-- relegation, not layer on top of it.
--
-- Safe to run more than once.

create table if not exists ladder_cycle (
  id boolean primary key default true check (id),
  current_week integer not null default 0, -- 0 = no week opened yet
  bidding_open boolean not null default false,
  fixtures_locked boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into ladder_cycle (id, current_week, bidding_open, fixtures_locked)
values (true, 0, false, true)
on conflict (id) do nothing;

alter table ladder_cycle enable row level security;

drop policy if exists "ladder_cycle_select" on ladder_cycle;
create policy "ladder_cycle_select" on ladder_cycle for select
  to authenticated
  using (true);

-- No insert/update/delete policies — only the two scheduled functions
-- below ever change this row.

-- ─────────────────────────────────────────────────────────────────────────
-- _generate_round_robin_fixtures_internal — SQL-native reimplementation of
-- leagueLadder.js's generateRoundRobinFixtures. A cron job runs inside
-- Postgres with no way to call out to client-side JS, so this duplicates
-- that function's circle-method algorithm rather than reusing it. The JS
-- version remains the tested reference (scripts/test-league-ladder.mjs);
-- this one was independently verified by hand-tracing a 4-player case
-- against the same algorithm before being wired into the scheduled job
-- below — if the algorithm ever changes, both need updating together.
--
-- Handles an odd-length p_player_ids with a bye, same as the JS version.
-- Inserts directly into ladder_fixtures (pending, null scores, null
-- countdown — Phase 6 assigns countdowns later, exactly as the JS
-- version's header describes). Returns the number of fixtures inserted.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _generate_round_robin_fixtures_internal(
  p_league_id uuid,
  p_week_number integer,
  p_player_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := p_player_ids;
  v_n integer;
  v_home uuid;
  v_away uuid;
  v_inserted integer := 0;
  v_r integer;
  v_i integer;
  v_last uuid;
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_round_robin_fixtures_internal: need at least 2 players';
  end if;

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid; -- bye slot, same as the JS version
  end if;
  v_n := array_length(v_ids, 1);

  for v_r in 0 .. v_n - 2 loop
    for v_i in 1 .. v_n / 2 loop
      v_home := v_ids[v_i];
      v_away := v_ids[v_n - v_i + 1];
      if v_home is not null and v_away is not null then
        insert into ladder_fixtures (league_id, week_number, home_user_id, away_user_id, status)
        values (p_league_id, p_week_number, v_home, v_away, 'pending');
        v_inserted := v_inserted + 1;
      end if;
    end loop;

    -- rotate: pop the last element, insert it right after the fixed first
    -- element — same shift App.jsx's/leagueLadder.js's ids.splice(1, 0,
    -- ids.pop()) performs, just 1-indexed.
    v_last := v_ids[v_n];
    for v_i in reverse v_n .. 3 loop
      v_ids[v_i] := v_ids[v_i - 1];
    end loop;
    v_ids[2] := v_last;
  end loop;

  return v_inserted;
end;
$$;

-- Deliberately no grant to authenticated/anon — internal only, same
-- reasoning as every other _*_internal function in this codebase.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_open_week_internal — Tuesday 12:00 AM. Carries every currently-
-- active player forward into the new week (same league, new
-- ladder_memberships row), generates that week's fixtures per league, and
-- opens bidding. Skips a league with fewer than 2 active players (can't
-- generate a round robin) rather than failing the whole run — logs
-- nothing anywhere yet since there's no admin-facing job-log table; a
-- skipped league just won't have fixtures for that week, visible as an
-- empty fixture list in the UI.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_open_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_week integer;
  v_new_week integer;
  v_league record;
  v_player_ids uuid[];
begin
  select current_week into v_prev_week from ladder_cycle where id = true;
  v_new_week := v_prev_week + 1;

  for v_league in select id from ladder_leagues where status = 'active' loop
    -- Carry every active player from the closing week forward — no
    -- promotion/relegation yet (Phase 3 replaces this).
    if v_prev_week > 0 then
      insert into ladder_memberships (user_id, league_id, week_number, status)
      select user_id, v_league.id, v_new_week, 'active'
      from ladder_memberships
      where league_id = v_league.id and week_number = v_prev_week and status = 'active';
    end if;

    select array_agg(user_id) into v_player_ids
    from ladder_memberships
    where league_id = v_league.id and week_number = v_new_week and status = 'active';

    if array_length(v_player_ids, 1) >= 2 then
      perform _generate_round_robin_fixtures_internal(v_league.id, v_new_week, v_player_ids);
    end if;
  end loop;

  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_close_week_internal — Sunday 10:00 PM. Flags only, per Phase 2's
-- scope: closes bidding and locks fixtures (result-submission RPCs check
-- this flag, see the migration that adds submit_ladder_fixture_result).
-- Does NOT resolve promotion/relegation/fees/bids/forfeits — those are
-- Phases 3-6, all still to come.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_close_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;
end;
$$;

create extension if not exists pg_cron with schema extensions;

-- pg_cron runs in UTC; the plan's cycle times (§2) are wall-clock SAST
-- (UTC+2, no daylight saving), so both times below are shifted back 2
-- hours from what the plan states — Tuesday 12:00 AM SAST is Monday 22:00
-- UTC, Sunday 10:00 PM SAST is Sunday 20:00 UTC. Getting this conversion
-- wrong would mean the cycle silently opens/closes 2 hours off from what
-- players actually see in the app, so it's called out explicitly here
-- rather than left as a bare cron expression.
select cron.schedule(
  'ladder-open-week-tuesday',
  '0 22 * * 1', -- Monday 22:00 UTC = Tuesday 00:00 SAST
  $$select _ladder_open_week_internal();$$
);

select cron.schedule(
  'ladder-close-week-sunday',
  '0 20 * * 0', -- Sunday 20:00 UTC = Sunday 22:00 SAST
  $$select _ladder_close_week_internal();$$
);
