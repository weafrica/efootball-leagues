-- League Ladder — result approval, table 1 of 2: ladder_fixture_result_submissions.
--
-- Brings ladder_fixtures in line with the submit -> confirm/dispute ->
-- admin-escalation pipeline every other result path in this app already
-- has (result_submissions for regular fixtures, ladder_cup_matches for
-- Survivor Ladder Cup). Deliberately built as ONE ROW PER ATTEMPT
-- (ladder_fixtures gets no new columns of its own) rather than the
-- evolving-single-row shape ladder_cup_matches uses — this is the exact
-- same table shape as result_submissions, so the RPCs that follow are
-- near-copies of approve_result_submission / reject_result_submission /
-- respond_to_result_submission (20260828), just retargeted at
-- ladder_fixtures instead of fixtures.
--
-- ladder_fixtures.status/home_score/away_score/played_at are only ever
-- written once a submission here is actually approved (by the opponent,
-- by an admin, or by the 1-hour auto-approve sweep — see
-- 20260891_ladder_fixture_result_auto_approve_sweep.sql) — never at
-- report time. Every existing `status = 'played'` filter (standings,
-- countdown sweep, decay penalty, fee settlement) keeps working
-- unchanged; it never needs to know this table exists.
--
-- Safe to run more than once.

create table if not exists ladder_fixture_result_submissions (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references ladder_fixtures(id) on delete cascade,
  submitted_by uuid not null references auth.users(id),
  home_score integer not null,
  away_score integer not null,
  proof_url text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

-- "All submissions for this fixture" — used both to compute the
-- dispute-cap escalation reason (2+ prior rejections) and to render a
-- fixture's full submission history in the admin queue.
create index if not exists idx_ladder_fixture_result_submissions_fixture
  on ladder_fixture_result_submissions(fixture_id);

-- The admin queue's exact query shape, and the auto-approve sweep's own
-- scan — pending submissions only, same partial-index convention every
-- other "queue" table in this repo uses.
create index if not exists idx_ladder_fixture_result_submissions_pending
  on ladder_fixture_result_submissions(fixture_id)
  where status = 'pending';

alter table ladder_fixture_result_submissions enable row level security;

-- Public read, same as ladder_fixtures itself — a pending/approved/
-- rejected submission is exactly as visible as the fixture it belongs to.
drop policy if exists "ladder_fixture_result_submissions_select" on ladder_fixture_result_submissions;
create policy "ladder_fixture_result_submissions_select" on ladder_fixture_result_submissions for select
  to authenticated
  using (true);

-- No insert/update/delete policies — every write goes through the
-- SECURITY DEFINER RPCs in the migrations that follow (submit / respond /
-- admin approve / admin reject / the auto-approve sweep), same
-- no-direct-writes convention as result_submissions/ladder_cup_matches.

-- League Ladder — result approval, table 2 of 2: ladder_fixture_corrections.
--
-- Audit trail for correct_ladder_fixture_result (20260892) — mirrors
-- ladder_cup_match_corrections (20260822): a confirmed fixture's score
-- can't just be silently overwritten, since standings/promotion/
-- relegation/fee settlement have already run against it. Logging
-- before/after here means an admin correction is traceable even though,
-- unlike Ladder Cup, League Ladder needs no replay engine to apply it —
-- the weekly resolve job already recomputes standings fresh each run
-- (see admin_retrigger_ladder_resolve, 20260864).
create table if not exists ladder_fixture_corrections (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references ladder_fixtures(id) on delete cascade,
  corrected_by uuid references auth.users(id),
  previous_home_score integer,
  previous_away_score integer,
  new_home_score integer not null,
  new_away_score integer not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_fixture_corrections_fixture
  on ladder_fixture_corrections(fixture_id);
