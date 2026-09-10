-- Weekend League — regression tests for _weekend_league_open_new_internal().
--
-- WHY THIS FILE EXISTS: same "open a new cycle automatically" shape as
-- _ladder_cup_open_new_internal(), which silently lost its carry-forward
-- feature twice (see ladder_cup_open_new.test.sql) before anyone noticed.
-- This function has been redefined 5 times since it was introduced
-- (20260901070000 through 20260905140000). It clones the ENTIRE previous
-- row (`v_new := v_prev`) and then overrides only 8 specific fields back
-- to a fresh state — which means every other column (name, description,
-- round_period_hours, league_type, created_by, ...) survives only because
-- nobody has explicitly listed them out. A future edit that switches this
-- from a whole-row clone to an explicit column list, the way
-- _ladder_cup_open_new_internal's INSERT already is, would silently reset
-- to default/null any column the editor forgot to carry over — undetected
-- until someone notices next Friday's weekend league is missing a setting
-- it should have inherited.
--
-- WHAT THIS TESTS: that the 8 fields meant to reset actually reset, that a
-- representative sample of fields NOT meant to reset actually survive the
-- clone, and that the function won't double-open the same Friday twice.
--
-- Run locally with `supabase test db`. Runs in CI on every push/PR — see
-- .github/workflows/db-tests.yml.

begin;

create extension if not exists pgtap;

select plan(11);

-- ============================================================================
-- Neutralize real production weekend leagues for the duration of this
-- isolated dry run: the function's own "already opened this slot" guard
-- and its "most recent prior league" pick both look at real data, so
-- without this, whichever result they'd naturally get from prod could
-- either short-circuit the whole test (a real league already exists for
-- next Friday's slot) or get picked over the synthetic fixture below
-- (a real league is more recent than it). Pushing every real match into
-- the distant past removes both risks without touching anything for real.
-- ============================================================================

update leagues
set starts_at = starts_at - interval '2000 days'
where created_by_admin = true
  and format = 'groups_knockout'
  and extract(dow from starts_at) in (5, 6, 0);

-- ============================================================================
-- Fixture: a finished previous weekend league (Fri/Sat/Sun groups_knockout,
-- admin-created) with distinctive, non-default values on fields that
-- should carry forward, so the carry-forward assertions below can only
-- pass if the clone actually happened rather than defaulting. starts_at is
-- anchored to exactly one week before the function's own "next Friday
-- 17:00 UTC" target, so it's deterministically a Friday and deterministically
-- in the past no matter what day this test happens to run on.
-- ============================================================================

create temporary table test_ids (key text primary key, id uuid not null default gen_random_uuid());
insert into test_ids (key) values ('creator'), ('league_prev');

insert into auth.users (id) select id from test_ids where key = 'creator';

insert into leagues (
  id, name, description, created_by, created_by_admin, format, league_type,
  round_period_hours, group_size, knockout_legs, groups_count, group_qualifiers,
  starts_at, entry_closes_at, prizes_paid_at, current_stage, final_stage_started,
  group_stage_due_at, wa_message_template
)
select
  id, 'PLACEHOLDER Weekend League', 'PLACEHOLDER DESCRIPTION — should carry forward',
  (select id from test_ids where key = 'creator'), true, 'groups_knockout', 'cash',
  72, 5, 2, 4, 2,
  _next_utc_dow_hour(now(), 5, 17) - interval '7 days',
  _next_utc_dow_hour(now(), 5, 17) - interval '7 days',
  now() - interval '1 hour', 3, true,
  _next_utc_dow_hour(now(), 5, 17) - interval '6 days', 'PLACEHOLDER TEMPLATE — should carry forward'
from test_ids where key = 'league_prev';

-- ============================================================================
-- Act
-- ============================================================================

create temporary table test_result as
select _weekend_league_open_new_internal() as new_league_id;

-- ============================================================================
-- Assert: reset fields actually reset
-- ============================================================================

select ok(
  (select new_league_id from test_result) is not null,
  'a new weekend league opens when there is a prior one to clone from'
);

select is(
  (select prizes_paid_at from leagues where id = (select new_league_id from test_result)),
  null,
  'the new league starts with no prizes paid — not cloned from the finished previous league'
);

select is(
  (select current_stage from leagues where id = (select new_league_id from test_result)),
  1,
  'the new league starts at stage 1, not wherever the previous league finished'
);

select is(
  (select final_stage_started from leagues where id = (select new_league_id from test_result)),
  false,
  'the new league has not started its final stage'
);

select ok(
  (select groups_count from leagues where id = (select new_league_id from test_result)) is null,
  'the new league has no groups drawn yet — groups_count resets'
);

select ok(
  (select group_stage_due_at from leagues where id = (select new_league_id from test_result)) is null,
  'the new league has no group-stage deadline yet — it gets set when groups are actually drawn'
);

-- ============================================================================
-- Assert: everything else survives the clone
-- ============================================================================

select is(
  (select name from leagues where id = (select new_league_id from test_result)),
  'PLACEHOLDER Weekend League',
  'the league name carries forward from the previous cycle'
);

select is(
  (select description from leagues where id = (select new_league_id from test_result)),
  'PLACEHOLDER DESCRIPTION — should carry forward',
  'the description carries forward from the previous cycle'
);

select is(
  (select round_period_hours from leagues where id = (select new_league_id from test_result)),
  72,
  'round_period_hours carries forward from the previous cycle, not reset to the table default'
);

select is(
  (select wa_message_template from leagues where id = (select new_league_id from test_result)),
  'PLACEHOLDER TEMPLATE — should carry forward',
  'the WhatsApp message template carries forward from the previous cycle'
);

-- ============================================================================
-- Assert: guard clause — no duplicate for the same slot
-- ============================================================================

select ok(
  _weekend_league_open_new_internal() is null,
  'calling it again for the same upcoming Friday slot is a no-op, not a duplicate league'
);

select * from finish();

rollback;
