-- Random (open) challenge results that go unconfirmed currently just sit
-- in the admin's "escalated" queue (escalatedOpenChallenges / Community
-- Results' escalated section — flagged there after 30 minutes, per
-- App.jsx's RESULT_CONFIRM_WINDOW_MINUTES) until an admin manually clicks
-- Approve — same effect as adminApproveOpenChallengeResult's update. This
-- adds a scheduled sweep that does that update automatically once a
-- LONGER 2-hour grace period has passed, so random-challenge walkovers no
-- longer wait on an admin at all, while still leaving admins the existing
-- 30-min-to-2-hour window to catch and reject a wrong or bad-faith score
-- before it auto-confirms.
--
-- Direct (ladder) challenges — the `challenges` table / adminGrantLadderWalkover
-- — are intentionally NOT touched here: that path stays admin-only, since
-- it's a distinct decision (grant walkover vs. cancel), not just "confirm
-- the reported score." This migration only covers open_challenges, per
-- request ("walkovers from random challenges").
--
-- Two different windows, both intentional:
--   - 30 minutes: still shows the row in the admin's escalated queue
--     (App.jsx, unchanged) — admins can act any time from here on.
--   - 2 hours: this sweep's own auto-approve threshold — if nobody's
--     rejected it by then, it confirms on its own.
--
-- Sweep runs every 15 minutes — frequent enough that nothing sits
-- auto-approvable-but-not-yet-applied for long, without needing the
-- 5-minute cadence a shorter window would've called for.
--
-- Idempotent by construction: the `result_status = 'pending'` filter means
-- an already-confirmed row is never touched again on a later sweep run,
-- and the existing trg_resolve_open_challenge trigger (20260846) still
-- fires exactly as it does for a manual admin approval, crediting the
-- flat 1N participation reward to both sides.
--
-- Safe to run more than once.

create or replace function _open_challenges_auto_approve_expired_internal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update open_challenges
  set result_status = 'confirmed', result_confirmed_at = now()
  where result_status = 'pending'
    and result_reported_at is not null
    and result_reported_at <= now() - interval '2 hours';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Deliberately no grant — internal only, reachable solely from the
-- scheduled sweep below (same convention as every other _*_internal
-- function in this codebase).

create extension if not exists pg_cron with schema extensions;

-- cron.schedule upserts by job name, so re-running this migration updates
-- the existing job in place rather than creating duplicates.
select cron.schedule(
  'open-challenges-auto-approve-every-15-min',
  '*/15 * * * *',
  $$select _open_challenges_auto_approve_expired_internal();$$
);

-- If 20260886 was already applied with the old 5-minute/30-minute job
-- under a different job name, unschedule it so there's only one sweep
-- running (cron.schedule above only upserts jobs sharing the exact same
-- name — a renamed job creates a second, separate one instead of
-- replacing it).
select cron.unschedule('open-challenges-auto-approve-every-5-min')
where exists (select 1 from cron.job where jobname = 'open-challenges-auto-approve-every-5-min');
