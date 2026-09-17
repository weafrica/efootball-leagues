-- Rapid League lobby "resets in mm:ss" timer: make it purely cosmetic.
--
-- expire_rapid_league_lobbies() previously marked a past-due open lobby
-- 'expired' (which hides it from the banner, since the frontend only
-- queries status in open/filling/live) and only carried its joined
-- players forward into a fresh lobby ONCE (carryover_generation = 0). A
-- second time past reset_at with the same players still waiting would
-- have silently dropped them -- the old lobby goes 'expired' with no
-- replacement carrying their entries. That's the "removes the clubs that
-- joined" behavior being fixed here, for all three sizes (4/8/16) since
-- they all share this one function.
--
-- New behavior: reset_at simply rolls forward by another window whenever
-- it's passed -- same lobby row, same id, same joined players, status
-- untouched. The countdown on the banner will visibly restart, but
-- nothing about who's joined ever changes because of it. A lobby only
-- ever leaves 'open' by actually filling (join_rapid_league_lobby flips
-- it to 'filling' once club_count players are seated).
--
-- Note: this function is not currently on any cron job (rapid-league-
-- expire-lobbies was removed by 20260941_rapid_league_remove_forced_
-- deadlines, confirmed via `select * from cron.job`), so nothing
-- currently calls this automatically -- this redefinition is a
-- safety net in case it's ever re-scheduled or called manually, so it
-- can never again be the thing that drops a joined club.
--
-- Applied to project jobgzxljuczzqljwavyq on 2026-09-17.
--
-- Also confirmed (no DB change needed): RapidLeagueBanner.jsx has never
-- used RapidCupEpicExtras.jsx's useCountdownDrumroll / useLeagueStartAlarm
-- (the Web Audio countdown drumroll + league-start alarm loop Rapid Cup's
-- banner uses) -- that was excluded by design in the original file, and
-- stays excluded in the version delivered alongside this migration.

create or replace function public.expire_rapid_league_lobbies()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- Cosmetic refresh only: push the "resets in" countdown forward again
  -- for any open lobby whose reset_at has passed. No status change, no
  -- new lobby, no player carried or dropped -- the same lobby with the
  -- same joined players just keeps sitting open.
  update rapid_league_lobbies
  set reset_at = now() + interval '2 hours'
  where status = 'open' and reset_at <= now();

  -- Still keep one open lobby per size in existence, same as before, in
  -- case this is ever the only thing responsible for seeding them.
  insert into rapid_league_lobbies (club_count)
  select v.club_count
  from (values (4), (8), (16)) as v(club_count)
  where not exists (
    select 1 from rapid_league_lobbies
    where status = 'open' and club_count = v.club_count and reset_at > now()
  );
end;
$function$;
