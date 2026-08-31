-- League Ladder — Go-live: seed League 8 in production.
--
-- 20260851_ladder_leagues.sql deliberately seeds nothing (a hardcoded
-- starting tier doesn't belong in a migration meant to be safe to
-- re-run every time). Phase 1's own checklist calls out seeding League
-- 8 "by hand" as a separate step for exactly that reason.
--
-- This is that step, committed as its own idempotent migration instead
-- of a one-off SQL console insert, so production has a recorded,
-- re-runnable source for how the ladder went live rather than a change
-- that only exists in someone's query history.
--
-- Without this row: the Ladder nav entry is already visible to every
-- user (no feature flag gates it), but there is no league for anyone
-- to join into, so joinLadder has nothing to attach a membership to,
-- and Tuesday's open-week cron finds zero active players and no-ops.
-- Inserting League 8 here is what makes the first real weekly cycle
-- possible.
--
-- No test users are inserted alongside it — Phase 1's "insert 8 test
-- users into ladder_memberships" instruction was for dev/staging only,
-- scoped to validating round-robin/tie-break logic before Phase 2 was
-- built. In production, real users join League 8 themselves through
-- the app's existing join flow (LADDER_JOIN_FEE_NETS in economy.js).
--
-- Safe to run more than once.

insert into ladder_leagues (tier, status)
values (8, 'active')
on conflict (tier) do nothing;
