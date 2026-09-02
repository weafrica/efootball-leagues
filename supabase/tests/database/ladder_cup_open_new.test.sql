-- Survivor Ladder Cup — regression tests for _ladder_cup_open_new_internal().
--
-- WHY THIS FILE EXISTS: this function has silently regressed twice already.
-- 20260898/20260899 added club/member/phone carry-forward so owners don't
-- have to manually rejoin every cycle. 20260901 (switch to monthly cadence)
-- and 20260902 (fix the cup's auto-generated name) each redefined this same
-- function starting from an OLDER, pre-carry-forward version of it — silently
-- dropping the carry-forward feature both times, undetected until 20260922
-- had to restore it a third time. There's a standalone manual sanity-check
-- script (ladder_cup_monthly_cycle_sanity_check.sql) that warns future edits
-- to check for exactly this — this file makes that check automatic instead
-- of relying on someone remembering to run it.
--
-- 20260922-follow-up also hardened the function so a single bad row (e.g. a
-- club or member that fails to carry forward for any reason) can never block
-- the rest of the carry-forward or the new cup itself — test 1/3/4/5 below
-- cover that via a deterministic, injected single-row failure. What's being
-- tested is the isolation mechanism itself, not any one specific real-world
-- cause of a row failing.
--
-- Run locally with `supabase test db`. Runs in CI on every push/PR — see
-- .github/workflows/db-tests.yml.

begin;

create extension if not exists pgtap;

select plan(5);

-- ============================================================================
-- Fixture: a finished "previous" Survivor Cup with two clubs, so there's
-- something real for _ladder_cup_open_new_internal() to clone/carry forward.
-- ============================================================================

create temporary table test_ids (key text primary key, id uuid not null default gen_random_uuid());
insert into test_ids (key) values
  ('creator'), ('member_a1'), ('member_a2'), ('member_b1'),
  ('league_prev'), ('team_a'), ('team_b');

insert into auth.users (id)
select id from test_ids where key in ('creator', 'member_a1', 'member_a2', 'member_b1');

-- Deliberately NOT a real month name — so the naming test below can only
-- pass if the function actually computes the current month, not because the
-- CI run happens to land in the same month as some hardcoded fixture value.
insert into leagues (
  id, name, created_by, format, starts_at, ladder_cup_finalized_at, ladder_cup_cutoff_at
)
select id, 'PLACEHOLDER Survivor Cup', (select id from test_ids where key = 'creator'),
       'ladder_cup', now() - interval '20 days', now() - interval '1 minute', now() - interval '1 minute'
from test_ids where key = 'league_prev';

insert into teams (id, league_id, name, phone)
select id, (select id from test_ids where key = 'league_prev'), 'Club A', '+27110000001'
from test_ids where key = 'team_a';

insert into teams (id, league_id, name, phone)
select id, (select id from test_ids where key = 'league_prev'), 'Club B', '+27110000002'
from test_ids where key = 'team_b';

insert into members (league_id, team_id, user_id, display_name)
select (select id from test_ids where key = 'league_prev'), (select id from test_ids where key = 'team_a'),
       (select id from test_ids where key = 'member_a1'), 'A1 (normal)';

insert into members (league_id, team_id, user_id, display_name)
select (select id from test_ids where key = 'league_prev'), (select id from test_ids where key = 'team_a'),
       (select id from test_ids where key = 'member_a2'), 'A2 (will fail on carry-forward)';

insert into members (league_id, team_id, user_id, display_name)
select (select id from test_ids where key = 'league_prev'), (select id from test_ids where key = 'team_b'),
       (select id from test_ids where key = 'member_b1'), 'B1 (normal)';

-- ============================================================================
-- Inject a deterministic, single-row failure that only fires on the
-- carry-forward insert (the fixture rows above already exist by the time
-- this trigger is created, so they're unaffected). This stands in for
-- whatever real-world condition might someday make one member's insert
-- fail — the point being tested is that the function isolates and survives
-- it, not any particular cause.
-- ============================================================================

create function _test_reject_member_on_carry_forward() returns trigger
language plpgsql as $$
begin
  if new.display_name = 'A2 (will fail on carry-forward)' then
    raise exception 'simulated failure for %', new.display_name;
  end if;
  return new;
end;
$$;

create trigger test_reject_member_on_carry_forward
before insert on members
for each row execute function _test_reject_member_on_carry_forward();

-- ============================================================================
-- Act
-- ============================================================================

create temporary table test_result as
select _ladder_cup_open_new_internal() as new_league_id;

-- ============================================================================
-- Assert
-- ============================================================================

select ok(
  (select new_league_id from test_result) is not null,
  'a new cup opens even though one member will fail to carry forward'
);

select is(
  (select name from leagues where id = (select new_league_id from test_result)),
  to_char(now() + interval '1 day', 'FMMonth') || ' Survivor Cup',
  'the new cup is named after the month it is actually starting in, not cloned from the previous cup''s name'
);

select is(
  (select count(*)::int from teams where league_id = (select new_league_id from test_result)),
  2,
  'both clubs carry forward as teams, even though one club has a member that fails to carry forward'
);

select is(
  (select count(*)::int from members m
     join teams t on t.id = m.team_id
    where t.league_id = (select new_league_id from test_result) and t.name = 'Club A'),
  1,
  'Club A carries forward with its one surviving member — the failing member is skipped, not blocking the whole club'
);

select is(
  (select count(*)::int from members m
     join teams t on t.id = m.team_id
    where t.league_id = (select new_league_id from test_result) and t.name = 'Club B'),
  1,
  'Club B (unrelated to the failure) still carries forward normally'
);

select * from finish();

rollback;
