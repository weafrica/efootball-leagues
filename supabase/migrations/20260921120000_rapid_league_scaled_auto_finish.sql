-- Re-adds a deadline to Rapid League, scaled by club_count (4/8/16 players
-- -> 2/4/8 days) instead of the old flat 4-hour cutoff that was
-- deliberately removed (see that migration's own note: "a league only
-- finishes once every fixture has genuinely been played"). This reverses
-- that decision on request.
--
-- What happens to fixtures nobody played by the deadline: they're left
-- exactly as they already were — unplayed, contributing zero wins and
-- zero goals to either side in _rapid_league_finish_lobby_internal's own
-- wins-then-goals-scored tiebreak. That's the same spirit as the normal
-- (non-Rapid) leagues' own no-show rule for expired fixtures — neither
-- side benefits from a match that didn't happen — just expressed through
-- Rapid League's own scoring model (wins/goals-scored) rather than the
-- normal leagues' points/goal-difference one, since Rapid League doesn't
-- track goals conceded at all, so a literal "-4 goal difference" penalty
-- has nothing to attach to here. No fake scores get written into
-- fixtures — same principle the normal-league version follows: the
-- penalty lives in how the standings/winner get computed, not in the
-- match record itself.
create or replace function public._rapid_league_sweep_internal()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row record;
  v_all_played boolean;
  v_deadline_passed boolean;
begin
  for v_row in
    select id as lobby_id, league_id, started_at, created_at, club_count
    from rapid_league_lobbies
    where status = 'live' and league_id is not null
  loop
    select bool_and(played)
    into v_all_played
    from fixtures
    where league_id = v_row.league_id and stage = 1;

    if coalesce(v_all_played, false) then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
      continue;
    end if;

    -- club_count halved gives the day count directly (4->2, 8->4, 16->8);
    -- coalesce covers any lobby somehow missing club_count, falling back
    -- to the 4-player default's 2-day window.
    v_deadline_passed := coalesce(v_row.started_at, v_row.created_at)
      + make_interval(days => coalesce(v_row.club_count, 4) / 2) <= now();

    if v_deadline_passed then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$function$;
