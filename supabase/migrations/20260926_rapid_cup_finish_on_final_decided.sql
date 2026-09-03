-- Rapid Cup — finish the lobby as soon as the bracket is actually
-- decided, not only once the shared 4hr due_at deadline passes.
--
-- Bug: _rapid_cup_sweep_internal only called _rapid_cup_finish_lobby_internal
-- when a round-1 fixture's due_at <= now(). due_at is fixed at bracket
-- generation to started_at + 4 hours for every fixture in the cup,
-- including the final (see generate_rapid_cup_bracket /
-- _rapid_cup_advance_bracket_internal). So a cup whose final was played
-- well inside the 4hr window sat with a known champion, an undistributed
-- pool, and rapid_cup_lobbies.status still 'live' (which is also what the
-- home banner's Open/Join logic keys off) until the full 4 hours elapsed.
--
-- Fix: also finish the lobby as soon as the round-2 (final) fixture has
-- been played. _rapid_cup_finish_lobby_internal itself already re-derives
-- the winner from wins -> goals -> even split, and is idempotent (no-ops
-- if a payout row already exists), so calling it earlier is safe. The
-- due_at <= now() branch stays, since it's still needed for the case
-- where nobody ever finishes (or never even starts) the bracket and the
-- cup has to fall back to a refund/forced result at the deadline.
create or replace function _rapid_cup_sweep_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_final_played boolean;
begin
  for v_row in
    select id as lobby_id, league_id from rapid_cup_lobbies
    where status = 'live' and league_id is not null
  loop
    perform _rapid_cup_advance_bracket_internal(v_row.league_id);

    select exists(
      select 1 from fixtures
      where league_id = v_row.league_id and round = 2 and stage = 1 and played = true
    ) into v_final_played;

    if v_final_played or exists (
      select 1 from fixtures
      where league_id = v_row.league_id and round = 1 and stage = 1 and due_at <= now()
    ) then
      perform _rapid_cup_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$$;
