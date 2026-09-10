-- Ladder — regression tests for _generate_round_robin_fixtures_internal().
--
-- WHY THIS FILE EXISTS: this function has been redefined 9 times. It's a
-- circle-method double round-robin scheduler with array rotation and
-- home/away-swap logic that's easy to get subtly wrong in a way that
-- produces no error at all — just a missing pairing, a duplicated
-- pairing, or a pair that never gets a return leg. Nothing about a silent
-- scheduling bug here would be visible without actually checking the
-- generated fixtures against what a correct double round-robin requires;
-- it would just look like a normal week until a player noticed they never
-- got a match against someone, or got two home fixtures against the same
-- opponent and no away one.
--
-- WHAT THIS TESTS: the actual correctness invariant of a double
-- round-robin — every player pairing meets exactly twice, once with each
-- side taking home advantage, split across the two legs — for both an
-- even player count and an odd one (which pads with a bye slot the real
-- players should never end up paired against). Also covers the function's
-- own re-run safety: regenerating a week's fixtures must not touch a
-- fixture that's already been played, or duplicate/lose any pairing.
--
-- Run locally with `supabase test db`. Runs in CI on every push/PR — see
-- .github/workflows/db-tests.yml.

begin;

create extension if not exists pgtap;

select plan(7);

-- ============================================================================
-- Fixture: two isolated ladder leagues (so this test can't collide with
-- real data or with each other) — one with 6 players (even), one with 5
-- (odd, forces a bye slot).
-- ============================================================================

create temporary table test_ids (key text primary key, id uuid not null default gen_random_uuid());
insert into test_ids (key) values
  ('league_even'), ('league_odd'),
  ('p1'), ('p2'), ('p3'), ('p4'), ('p5'), ('p6');

insert into auth.users (id) select id from test_ids where key like 'p%';

insert into ladder_leagues (id, tier) select id, 999 from test_ids where key = 'league_even';
insert into ladder_leagues (id, tier) select id, 998 from test_ids where key = 'league_odd';

-- ============================================================================
-- Act: even player count (6 players — no bye slot needed)
-- ============================================================================

create temporary table test_result_even as
select _generate_round_robin_fixtures_internal(
  (select id from test_ids where key = 'league_even'),
  1,
  array(select id from test_ids where key in ('p1','p2','p3','p4','p5','p6')),
  '2026-01-05 00:00:00+00'::timestamptz
) as inserted;

-- ============================================================================
-- Assert: even case
-- ============================================================================

select is(
  (select inserted from test_result_even),
  30,
  '6 players (even, no bye) produces a full double round-robin: 6*5 = 30 fixtures'
);

select ok(
  not exists (
    select 1 from (
      select least(home_user_id, away_user_id) as p1, greatest(home_user_id, away_user_id) as p2,
             count(*) as cnt, count(distinct leg) as distinct_legs, count(distinct home_user_id) as distinct_home
      from ladder_fixtures
      where league_id = (select id from test_ids where key = 'league_even') and week_number = 1
      group by p1, p2
    ) t
    where cnt <> 2 or distinct_legs <> 2 or distinct_home <> 2
  ),
  'every pair of players meets exactly twice, once with each side as home, split across both legs'
);

-- ============================================================================
-- Act: odd player count (5 players — one bye slot per round)
-- ============================================================================

create temporary table test_result_odd as
select _generate_round_robin_fixtures_internal(
  (select id from test_ids where key = 'league_odd'),
  1,
  array(select id from test_ids where key in ('p1','p2','p3','p4','p5')),
  '2026-01-05 00:00:00+00'::timestamptz
) as inserted;

-- ============================================================================
-- Assert: odd case — the bye slot must never turn into a real fixture
-- ============================================================================

select is(
  (select inserted from test_result_odd),
  20,
  '5 players (odd, one bye per round) still gives every real player a full double round-robin against every other real player: 5*4 = 20 fixtures, and the bye itself never becomes a fixture'
);

select ok(
  not exists (
    select 1 from (
      select least(home_user_id, away_user_id) as p1, greatest(home_user_id, away_user_id) as p2,
             count(*) as cnt, count(distinct leg) as distinct_legs, count(distinct home_user_id) as distinct_home
      from ladder_fixtures
      where league_id = (select id from test_ids where key = 'league_odd') and week_number = 1
      group by p1, p2
    ) t
    where cnt <> 2 or distinct_legs <> 2 or distinct_home <> 2
  ),
  'with an odd player count, every real pairing still meets exactly twice with swapped home/away'
);

-- ============================================================================
-- Act: mark one even-league fixture as played, then regenerate the week
-- ============================================================================

update ladder_fixtures
set status = 'played', home_score = 3, away_score = 1, played_at = now()
where id = (
  select id from ladder_fixtures
  where league_id = (select id from test_ids where key = 'league_even') and week_number = 1
  order by id limit 1
);

create temporary table test_result_regen as
select _generate_round_robin_fixtures_internal(
  (select id from test_ids where key = 'league_even'),
  1,
  array(select id from test_ids where key in ('p1','p2','p3','p4','p5','p6')),
  '2026-01-05 00:00:00+00'::timestamptz
) as inserted;

-- ============================================================================
-- Assert: regeneration is safe — no duplicates, no data loss on the
-- already-played fixture, and the schedule is still a valid double
-- round-robin overall
-- ============================================================================

select is(
  (select count(*)::int from ladder_fixtures
     where league_id = (select id from test_ids where key = 'league_even') and week_number = 1),
  30,
  'regenerating the week still totals exactly 30 fixtures — the played one is kept, everything else regenerates fresh, nothing duplicates'
);

select is(
  (select count(*)::int from ladder_fixtures
     where league_id = (select id from test_ids where key = 'league_even') and week_number = 1
       and status = 'played'),
  1,
  'the already-played fixture survives regeneration untouched — it is not deleted or overwritten'
);

select ok(
  not exists (
    select 1 from (
      select least(home_user_id, away_user_id) as p1, greatest(home_user_id, away_user_id) as p2,
             count(*) as cnt, count(distinct leg) as distinct_legs, count(distinct home_user_id) as distinct_home
      from ladder_fixtures
      where league_id = (select id from test_ids where key = 'league_even') and week_number = 1
      group by p1, p2
    ) t
    where cnt <> 2 or distinct_legs <> 2 or distinct_home <> 2
  ),
  'after regeneration, every pair still meets exactly twice with swapped home/away — regeneration did not break the schedule around the preserved fixture'
);

select * from finish();

rollback;
