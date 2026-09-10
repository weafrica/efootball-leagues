-- Ladder — regression tests for _credit_ladder_match_reward_internal().
--
-- WHY THIS FILE EXISTS: this function has been redefined 5 times and moves
-- real money — match reward, early-leg bonus, win-streak bonus — out of
-- the shared ladder_pool and into two players' wallets every time it
-- runs. Its own protection against being credited twice for the same
-- fixture is a single `ladder_reward_ledger` insert with
-- `on conflict (fixture_id, user_id) do nothing` — but that only stops a
-- second LEDGER row. The actual wallet credits (_nets_credit_internal)
-- and the pool debits (_ladder_pool_reward_debit) run unconditionally
-- every single call, with no check of the ledger, or of anything else,
-- before doing so. Every one of this function's 6 call sites currently
-- guards against calling it twice by checking the fixture's own
-- status <> 'pending' before transitioning it to 'played' — which is real
-- protection today, but it means safety against double-payment is spread
-- across 6 independent call sites (and counting) instead of living in the
-- one function that actually moves the money. This test checks the
-- function's own behavior in isolation, regardless of how careful any
-- particular caller currently is.
--
-- Run locally with `supabase test db`. Runs in CI on every push/PR — see
-- .github/workflows/db-tests.yml.

begin;

create extension if not exists pgtap;

select plan(8);

-- ============================================================================
-- Fixture: an isolated ladder league whose tier is set far above any real
-- tier so it's guaranteed to be the current max tier itself — that makes
-- the reward formula (4 + round(0.1 * (max_tier - tier))) collapse to a
-- deterministic, known value regardless of what real leagues currently
-- exist: reward = 4 + round(0.1 * 100) = 14, early bonus = round(0.25*14)
-- = 4, streak bonus (streak >= 2) = round(14*0.10) = 1.
-- ============================================================================

create temporary table test_ids (key text primary key, id uuid not null default gen_random_uuid());
insert into test_ids (key) values ('league_ceiling'), ('league_test'), ('home_user'), ('away_user'), ('fixture');

insert into auth.users (id) select id from test_ids where key in ('home_user', 'away_user');

insert into ladder_leagues (id, tier, status) select id, 500, 'active' from test_ids where key = 'league_ceiling';
insert into ladder_leagues (id, tier, status) select id, 400, 'active' from test_ids where key = 'league_test';

insert into ladder_memberships (user_id, league_id, week_number, win_streak)
select id, (select id from test_ids where key = 'league_test'), 1, 1 from test_ids where key = 'home_user';

insert into ladder_memberships (user_id, league_id, week_number, win_streak)
select id, (select id from test_ids where key = 'league_test'), 1, 3 from test_ids where key = 'away_user';

-- Top up the shared pool so this dry run can never trip its own escrow
-- guard, regardless of real production balance/bids at the time this runs.
update ladder_pool set balance = balance + 1000000 where id = true;

insert into ladder_fixtures (id, league_id, week_number, home_user_id, away_user_id, status, home_score, away_score, played_at, leg)
select id, (select id from test_ids where key = 'league_test'), 1,
       (select id from test_ids where key = 'home_user'), (select id from test_ids where key = 'away_user'),
       'played', 3, 1, now(), 1
from test_ids where key = 'fixture';

-- ============================================================================
-- Act: credit the fixture once
-- ============================================================================

select _credit_ladder_match_reward_internal((select id from test_ids where key = 'fixture'));

-- ============================================================================
-- Assert: a single credit pays out correctly
-- ============================================================================

select is(
  (select balance from nets_wallets where user_id = (select id from test_ids where key = 'home_user')),
  19::bigint,
  'the winner is credited match reward (14) + early-leg bonus (4) + win-streak bonus (1) = 19'
);

select is(
  (select balance from nets_wallets where user_id = (select id from test_ids where key = 'away_user')),
  18::bigint,
  'the loser is credited match reward (14) + early-leg bonus (4), no streak bonus = 18'
);

select is(
  (select count(*)::int from ladder_reward_ledger where fixture_id = (select id from test_ids where key = 'fixture')),
  2,
  'exactly one ledger row per participant is recorded for this fixture'
);

select is(
  (select win_streak from ladder_memberships
     where league_id = (select id from test_ids where key = 'league_test') and week_number = 1
       and user_id = (select id from test_ids where key = 'home_user')),
  2,
  'the winner''s streak increments'
);

select is(
  (select win_streak from ladder_memberships
     where league_id = (select id from test_ids where key = 'league_test') and week_number = 1
       and user_id = (select id from test_ids where key = 'away_user')),
  0,
  'the loser''s streak resets to 0'
);

-- ============================================================================
-- Act: credit the SAME fixture a second time — simulating whatever future
-- call site, retry, or race condition might someday invoke this function
-- twice for one fixture without a status-guard catching it first
-- ============================================================================

select _credit_ladder_match_reward_internal((select id from test_ids where key = 'fixture'));

-- ============================================================================
-- Assert: a duplicate credit for the same fixture must not pay out again
-- ============================================================================

select is(
  (select balance from nets_wallets where user_id = (select id from test_ids where key = 'home_user')),
  19::bigint,
  'crediting the same fixture twice does not pay the winner a second time'
);

select is(
  (select balance from nets_wallets where user_id = (select id from test_ids where key = 'away_user')),
  18::bigint,
  'crediting the same fixture twice does not pay the loser a second time'
);

select is(
  (select count(*)::int from ladder_reward_ledger where fixture_id = (select id from test_ids where key = 'fixture')),
  2,
  'the ledger still shows exactly one row per participant after the duplicate call'
);

select * from finish();

rollback;
