-- League Ladder — result approval: backfill for 20260887/20260888.
--
-- Every ladder_fixtures row that was already status='played' before this
-- system existed (played under the old one-shot submit_ladder_fixture_result,
-- or forfeited/finalized some other way) has no
-- ladder_fixture_result_submissions row at all — that table didn't exist
-- yet when they were written. Per the plan (§4 step 8), that's fine on its
-- own: the admin queue only ever looks at status = 'pending', so historical
-- fixtures with no submission row are simply invisible to it, not broken.
--
-- This backfill goes one step further and gives each of them a synthetic
-- 'approved' row anyway, so:
--   * priorRejectedCount/resultEscalationReason (client) and the sweep's
--     dispute-cap check (SQL) see a fixture's full history consistently,
--     whether it predates this migration or not — no special-casing "no
--     rows yet" as a different case from "one approved row."
--   * correct_ladder_fixture_result (20260892) corrects a fixture that
--     already has a submission trail, same as one played under the new
--     flow — nothing downstream needs to know a fixture is "pre-history."
--
-- submitted_by/reviewed_by have no real record of who actually reported or
-- confirmed these historical results, so both are set to the fixture's own
-- home_user_id — an arbitrary but always-valid participant (satisfies the
-- not-null/FK constraints without inventing a fake user), with
-- review_note making it obvious this row is synthetic if anyone inspects
-- the submissions table directly.
--
-- Idempotent: only inserts for a played fixture that doesn't already have
-- ANY ladder_fixture_result_submissions row, so re-running this after more
-- fixtures have legitimately gone through the real flow (and therefore
-- already have their own submission row) touches nothing new.

insert into ladder_fixture_result_submissions (
  fixture_id, submitted_by, home_score, away_score,
  status, reviewed_by, reviewed_at, review_note, created_at
)
select
  f.id, f.home_user_id, f.home_score, f.away_score,
  'approved', f.home_user_id, f.played_at,
  'Backfilled — played before the result-submission approval flow existed',
  coalesce(f.played_at, f.created_at)
from ladder_fixtures f
where f.status = 'played'
  and f.home_score is not null
  and f.away_score is not null
  and not exists (
    select 1 from ladder_fixture_result_submissions s where s.fixture_id = f.id
  );
