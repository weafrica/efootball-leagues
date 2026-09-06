-- League Ladder — players are unhappy that pending fixtures get auto-
-- forfeited mid-week, the moment their individual countdown_expires_at
-- passes (the 'ladder-forfeit-sweep-hourly' cron job from 20260862).
-- A player who's still arranging a time with their opponent on, say,
-- Wednesday can lose the match outright before the week is even over.
--
-- Fix: stop forfeiting on the hourly sweep, but keep everything the
-- countdown itself does — countdown_expires_at is still stamped per
-- fixture at generation time (unchanged), CountdownBadge still ticks it
-- down in the UI (unchanged), players still see exactly how much time
-- is left. Only the *action* of turning an expired-but-unplayed fixture
-- into a forfeit moves from "the moment it expires, any hour of the
-- week" to "once, in bulk, at Sunday's week-close" — so nobody gets
-- forfeited before the week is actually over.
--
-- Two changes:
--
-- 1. Unschedule 'ladder-forfeit-sweep-hourly'. The function it called,
--    _ladder_forfeit_expired_fixtures_internal, is untouched — same
--    "pending + countdown_expires_at < now() -> forfeited, 4-0 both
--    ways, no match reward" logic as before (20260862). It's just no
--    longer on an hourly trigger.
--
-- 2. _ladder_close_week_internal (Sunday 23:59 UTC, per 20260917) now
--    calls that same function FIRST, before
--    _ladder_resolve_promotion_relegation_internal(). By Sunday every
--    fixture's countdown_expires_at for the closing week has passed
--    regardless (the release schedule is Tue 12AM through Sat 10PM with
--    a 24h play window, per 20260862), so this one sweep catches every
--    still-pending fixture for the week and forfeits it before
--    standings are computed for promotion/relegation — same as today,
--    just batched into Sunday instead of spread across the week.
--
-- Safe to run more than once.

select cron.unschedule(jobid) from cron.job where jobname = 'ladder-forfeit-sweep-hourly';

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

  -- Forfeit sweep moved here from the hourly cron (see migration header):
  -- catch every still-pending, countdown-expired fixture in one go, right
  -- before standings are computed, so promotion/relegation still sees a
  -- fully-resolved week exactly like it did when the sweep ran hourly.
  perform _ladder_forfeit_expired_fixtures_internal();

  perform _ladder_resolve_promotion_relegation_internal();

  if v_week is not null and v_week > 0 then
    perform _ladder_record_wall_of_fame_internal(v_week);
    perform _ladder_settle_week_fees_internal(v_week);
    perform _ladder_settle_bids_internal(v_week);
    perform _ladder_fall_through_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;

  perform _ladder_open_week_internal();
end;
$$;
