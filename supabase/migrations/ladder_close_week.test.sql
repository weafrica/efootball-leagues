-- Ladder — regression tests for _ladder_close_week_internal().
--
-- WHY THIS FILE EXISTS: this is the single most-redefined function in the
-- codebase — 10 separate migrations (20260856 through 20260930) have
-- redefined it, each time adding, removing, or reordering one of its steps
-- (forfeit sweep, promotion/relegation, wall of fame, fee settlement, bid
-- settlement, fall-through, then locking the week and opening the next
-- one). _ladder_cup_open_new_internal() — a much simpler function — was
-- redefined 7 times and silently lost a whole feature twice along the way
-- (see ladder_cup_open_new.test.sql). This function is redefined even more
-- often and orchestrates real money movement (fee settlement, bid
-- settlement) and competitive standing (promotion/relegation, wall of
-- fame), so a future edit that starts from an older copy and silently
-- drops one call is exactly the kind of regression this codebase has
-- already shown it's prone to — just not caught here yet.
--
-- WHAT THIS TESTS: not the business logic of any individual step (each of
-- those has, or should have, its own dedicated test) — just that closing a
-- week actually invokes every one of its 6 steps, in the order the current
-- implementation's own comments say matters (forfeit sweep before
-- promotion/relegation, "so standings still sees a fully-resolved week"),
-- and that it flips the cycle's bidding/lock flags. To test the
-- orchestration in isolation from every sub-step's own fixture
-- requirements, each sub-function is temporarily replaced (this
-- transaction only — rolled back at the end, same as everything else
-- here) with a stub that just records that it was called. This is the
-- same "spy" technique used to unit-test any orchestrator without
-- dragging in every dependency's own setup.
--
-- Run locally with `supabase test db`. Runs in CI on every push/PR — see
-- .github/workflows/db-tests.yml.

begin;

create extension if not exists pgtap;

select plan(10);

-- ============================================================================
-- Spy setup: replace each of the 6 steps _ladder_close_week_internal calls
-- with a stub that logs its own invocation (and, for week-scoped steps,
-- the week number it was called with) into a temp table.
-- ============================================================================

create temporary table _test_close_week_calls (
  step text,
  called_at timestamptz not null default clock_timestamp()
);

create or replace function _ladder_forfeit_expired_fixtures_internal()
returns integer language plpgsql as $$
begin
  insert into _test_close_week_calls (step) values ('forfeit_expired_fixtures');
  return 0;
end;
$$;

create or replace function _ladder_resolve_promotion_relegation_internal()
returns void language plpgsql as $$
begin
  insert into _test_close_week_calls (step) values ('resolve_promotion_relegation');
end;
$$;

create or replace function _ladder_record_wall_of_fame_internal(p_week_number integer)
returns void language plpgsql as $$
begin
  insert into _test_close_week_calls (step) values ('record_wall_of_fame:' || p_week_number);
end;
$$;

create or replace function _ladder_settle_week_fees_internal(p_week_number integer)
returns void language plpgsql as $$
begin
  insert into _test_close_week_calls (step) values ('settle_week_fees:' || p_week_number);
end;
$$;

create or replace function _ladder_settle_bids_internal(p_week_number integer)
returns void language plpgsql as $$
begin
  insert into _test_close_week_calls (step) values ('settle_bids:' || p_week_number);
end;
$$;

create or replace function _ladder_fall_through_internal(p_week_number integer)
returns void language plpgsql as $$
begin
  insert into _test_close_week_calls (step) values ('fall_through:' || p_week_number);
end;
$$;

create or replace function _ladder_open_week_internal()
returns void language plpgsql as $$
begin
  insert into _test_close_week_calls (step) values ('open_week');
end;
$$;

-- ============================================================================
-- Fixture: force the singleton ladder_cycle row to a known, deterministic
-- week so the week-scoped steps are guaranteed to run (the real function
-- skips them when current_week is null or 0).
-- ============================================================================

update ladder_cycle
set current_week = 7, bidding_open = true, fixtures_locked = false
where id = true;

-- ============================================================================
-- Act
-- ============================================================================

select _ladder_close_week_internal();

-- ============================================================================
-- Assert
-- ============================================================================

select ok(
  exists(select 1 from _test_close_week_calls where step = 'forfeit_expired_fixtures'),
  'closing the week sweeps expired fixtures'
);

select ok(
  exists(select 1 from _test_close_week_calls where step = 'resolve_promotion_relegation'),
  'closing the week resolves promotion/relegation'
);

select ok(
  exists(select 1 from _test_close_week_calls where step = 'record_wall_of_fame:7'),
  'closing the week records wall of fame for the week that just closed'
);

select ok(
  exists(select 1 from _test_close_week_calls where step = 'settle_week_fees:7'),
  'closing the week settles that week''s entry fees'
);

select ok(
  exists(select 1 from _test_close_week_calls where step = 'settle_bids:7'),
  'closing the week settles that week''s bids'
);

select ok(
  exists(select 1 from _test_close_week_calls where step = 'fall_through:7'),
  'closing the week runs fall-through for players who neither bid nor got picked'
);

select ok(
  exists(select 1 from _test_close_week_calls where step = 'open_week'),
  'closing the week opens the next week automatically'
);

select ok(
  (select called_at from _test_close_week_calls where step = 'forfeit_expired_fixtures')
    < (select called_at from _test_close_week_calls where step = 'resolve_promotion_relegation'),
  'the forfeit sweep runs before promotion/relegation, so standings reflect a fully-resolved week'
);

select is(
  (select bidding_open from ladder_cycle where id = true),
  false,
  'closing the week closes bidding'
);

select is(
  (select fixtures_locked from ladder_cycle where id = true),
  true,
  'closing the week locks fixtures'
);

select * from finish();

rollback;
