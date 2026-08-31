-- League Ladder — result approval, RPC 4 of 4 + sweep: 1-hour admin
-- auto-approve.
--
-- An escalated submission (timeout or dispute-cap — see
-- ladderFixtureResultEscalationReason, App.jsx) still gets first look from
-- an admin, same as everywhere else in this app. But nothing should rot in
-- the queue forever if nobody looks at it: once a submission has been
-- sitting in the admin queue for 1 hour with no action, this sweep
-- auto-approves it via the same _admin_approve_ladder_fixture_result_internal
-- body a human clicking Approve would hit (20260890) — one write path,
-- whether a human or the clock triggers it.
--
-- The 1-hour clock starts when the submission ENTERED the queue, not when
-- it was originally reported — otherwise a dispute-cap escalation (which
-- can happen immediately, on a fixture's third reported result) would
-- already be most of the way through its window before an admin ever saw
-- it. Two cases, mirroring the escalation-reason logic in App.jsx exactly:
--   - dispute-cap: 2+ prior rejected submissions already exist for this
--     fixture -> this submission was admin-queue material from the moment
--     it was created -> deadline = created_at + 1 hour.
--   - timeout: fewer than 2 prior rejections -> this submission only
--     entered the queue once the 30-minute opponent confirm window lapsed
--     (RESULT_CONFIRM_WINDOW_MINUTES, App.jsx) -> deadline =
--     created_at + 30 minutes + 1 hour.
--
-- Mirrors _open_challenges_auto_approve_expired_internal
-- (20260886_open_challenges_walkover_auto_approve.sql) in shape and in the
-- pg_cron scheduling approach; idempotent by construction, since the
-- `status = 'pending'` filter (both here and inside the _internal
-- approve function) means an already-resolved submission is never
-- touched again on a later sweep run.
--
-- Safe to run more than once.

create or replace function _ladder_fixture_result_auto_approve_expired_internal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
  v_count integer := 0;
begin
  for v_sub in
    select s.id
    from ladder_fixture_result_submissions s
    join ladder_fixtures f on f.id = s.fixture_id
    where s.status = 'pending'
      and f.status = 'pending'
      and (
        (
          -- dispute-cap case: fixture already had 2+ rejected attempts
          -- before this one -> queue-eligible from creation.
          (
            select count(*) from ladder_fixture_result_submissions prior
            where prior.fixture_id = s.fixture_id and prior.status = 'rejected'
              and prior.created_at < s.created_at
          ) >= 2
          and s.created_at + interval '1 hour' <= now()
        )
        or
        (
          -- timeout case: queue-eligible only after the 30-minute
          -- opponent confirm window has also elapsed.
          (
            select count(*) from ladder_fixture_result_submissions prior
            where prior.fixture_id = s.fixture_id and prior.status = 'rejected'
              and prior.created_at < s.created_at
          ) < 2
          and s.created_at + interval '30 minutes' + interval '1 hour' <= now()
        )
      )
  loop
    perform _admin_approve_ladder_fixture_result_internal(v_sub.id, null);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Deliberately no grant — internal only, reachable solely from the
-- scheduled sweep below.

create extension if not exists pg_cron with schema extensions;

-- cron.schedule upserts by job name, so re-running this migration updates
-- the existing job in place rather than creating duplicates. Every 15
-- minutes, same cadence 20260886 uses for the equivalent open_challenges
-- sweep — frequent enough that nothing sits auto-approvable-but-not-yet-
-- applied for long.
select cron.schedule(
  'ladder-fixture-result-auto-approve-every-15-min',
  '*/15 * * * *',
  $$select _ladder_fixture_result_auto_approve_expired_internal();$$
);
