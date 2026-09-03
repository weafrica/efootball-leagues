-- League Ladder — bring the LIVE database in line with the unified
-- close+open design (20260875/20260876), which the deployed schema was
-- apparently never fully brought up to date with.
--
-- CONFIRMED VIA LIVE DIAGNOSTICS (not just file inspection):
--   - cron.job still has 'ladder-open-week-tuesday' ACTIVE, scheduled
--     '0 22 * * 0' (Sunday 22:00 UTC) — this was supposed to be
--     unscheduled by 20260875. It fires ~2 hours BEFORE
--     'ladder-close-week-sunday' (23:59 UTC) each week, while
--     bidding_open is still true from the still-running week — so its
--     call to _ladder_open_week_internal() has been hitting that
--     function's own "still open" guard and failing (harmlessly, since
--     it's a separate cron job / separate transaction) every week.
--   - Running _ladder_close_week_internal() manually just now flipped
--     bidding_open to false and fixtures_locked to true, but left
--     current_week unchanged — proof the LIVE function body does not
--     chain into _ladder_open_week_internal() the way every migration
--     from 20260875 onward assumes it does. The live function is an
--     older version.
--
-- Net effect of both gaps together: every player's current-week
-- membership row just got reclassified away from 'active' (to
-- 'promoted' / 'relegated' / 'eliminated') by the close step that DID
-- run, while current_week never advanced to reveal each player's
-- already-written next-week row — so the app currently shows no active
-- membership for anyone and prompts a fresh join, even though the real
-- next-week seats already exist in ladder_memberships.
--
-- This migration:
--   1. Re-applies the unified _ladder_close_week_internal (unchanged
--      logic from 20260875 — chains directly into
--      _ladder_open_week_internal in the same transaction).
--   2. Unschedules 'ladder-open-week-tuesday' for real this time.
--   3. Re-confirms 'ladder-close-week-sunday' fires at 23:59 UTC (it
--      already does live, per the cron.job listing — this is just a
--      safe no-op upsert by job name, kept here so this file is a
--      complete, self-contained statement of intended live state).
--
-- Safe to run more than once.

create or replace function _ladder_close_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week integer;
begin
  select current_week into v_week from ladder_cycle where id = true;

  perform _ladder_resolve_promotion_relegation_internal();

  if v_week is not null and v_week > 0 then
    perform _ladder_record_wall_of_fame_internal(v_week);
    perform _ladder_settle_week_fees_internal(v_week);
    perform _ladder_settle_bids_internal(v_week);
    perform _ladder_fall_through_internal(v_week);
    perform _ladder_apply_decay_penalty_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;

  perform _ladder_open_week_internal();
end;
$$;

select cron.schedule(
  'ladder-close-week-sunday',
  '59 23 * * 0', -- 23:59 UTC every Sunday
  $$select _ladder_close_week_internal();$$
);

-- The actual fix for what's live right now: this job has been firing
-- every week and failing its guard, doing nothing useful, and is now
-- fully redundant with the unified close job above.
select cron.unschedule(jobid) from cron.job where jobname = 'ladder-open-week-tuesday';

-- ─────────────────────────────────────────────────────────────────────────
-- One-time catch-up: advance the stuck clock now so every player's
-- already-written next-week membership row becomes visible immediately,
-- instead of waiting until next Sunday. Safe given _ladder_open_week_internal's
-- own guard: it only proceeds because bidding_open is already false (set
-- by the manual close_week_internal() call already run) — if it were still
-- true this would raise and do nothing, not corrupt anything.
-- ─────────────────────────────────────────────────────────────────────────
select _ladder_open_week_internal();

select current_week, bidding_open, fixtures_locked, updated_at
from ladder_cycle
where id = true;
