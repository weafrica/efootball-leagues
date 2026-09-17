-- Follow-up to 20260946_rapid_league_club_count_8_and_16.sql.
--
-- 1) Fixture window scales with club count instead of a flat 24h for
--    every size: 4 clubs -> 24h, 8 -> 48h, 16 -> 96h. More clubs means
--    more matches per player (3 / 7 / 15), so the window needs to grow
--    with it or the larger formats would be structurally more likely to
--    hit forfeits than the 4-club one ever was.
--
-- 2) No league auto-closes on a timer anymore, for all three sizes.
--    _rapid_league_sweep_internal used to call
--    _rapid_league_forfeit_expired_fixtures_internal first, which force-
--    played (0-0 forfeit) any fixture past its due_at -- that's what was
--    silently finishing a league once due_at passed, even with unplayed
--    matches left. That call is removed: the sweep now only finishes a
--    league once bool_and(played) is genuinely true, i.e. every fixture
--    was actually played. due_at / the scaled window above is now purely
--    a target players see in the UI, not an enforcement deadline.
--
--    _rapid_league_forfeit_expired_fixtures_internal itself is left in
--    place (unused by cron now, confirmed nothing else in the schema
--    calls it) rather than dropped, in case an admin tool wants to call
--    it manually later.
--
-- Applied to project jobgzxljuczzqljwavyq on 2026-09-17. No changes to
-- cron.job needed -- rapid-league-sweep already just calls
-- _rapid_league_sweep_internal(), which this redefines in place.

create or replace function public.generate_rapid_league_fixtures(p_lobby_id uuid)
 returns rapid_league_lobbies
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_league_id uuid;
  v_now timestamptz := now();
  v_due_at timestamptz;
  v_player record;
  v_team_ids uuid[] := '{}';
  v_new_team_id uuid;
  v_club_count int;
  v_window interval;
  v_league_name text;
  i int;
  j int;
begin
  select * into v_lobby from rapid_league_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid League lobby % not found', p_lobby_id;
  end if;

  if v_lobby.status <> 'filling' or v_lobby.league_id is not null then
    return v_lobby;
  end if;

  v_club_count := v_lobby.club_count;

  v_window := case v_club_count
    when 4 then interval '24 hours'
    when 8 then interval '48 hours'
    when 16 then interval '96 hours'
    else interval '24 hours'
  end;
  v_due_at := coalesce(v_lobby.started_at, v_now) + v_window;

  if v_club_count = 4 then
    v_league_name := 'Rapid League — ' || to_char(v_now, 'DD Mon HH24:MI');
  else
    v_league_name := 'Rapid League ' || v_club_count || ' — ' || to_char(v_now, 'DD Mon HH24:MI');
  end if;

  insert into leagues (name, format, league_type, created_by_admin, starts_at)
  values (v_league_name, 'single_round_robin', 'fun', true, v_now)
  returning id into v_league_id;

  for v_player in
    select lp.user_id, coalesce(p.efootball_username, 'Player ' || substr(lp.user_id::text, 1, 6)) as display_name, p.phone
    from rapid_league_lobby_players lp
    left join profiles p on p.user_id = lp.user_id
    where lp.lobby_id = p_lobby_id
    order by random()
  loop
    insert into teams (league_id, name, phone)
    values (v_league_id, v_player.display_name, v_player.phone)
    returning id into v_new_team_id;

    v_team_ids := v_team_ids || v_new_team_id;

    insert into members (league_id, user_id, display_name, phone, team_id)
    values (v_league_id, v_player.user_id, v_player.display_name, v_player.phone, v_new_team_id);
  end loop;

  if coalesce(array_length(v_team_ids, 1), 0) <> v_club_count then
    raise exception 'Rapid League lobby % did not have exactly % players (had %)',
      p_lobby_id, v_club_count, coalesce(array_length(v_team_ids, 1), 0);
  end if;

  for i in 1..(v_club_count - 1) loop
    for j in (i + 1)..v_club_count loop
      insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
      values (v_league_id, 1, 1, 1, v_team_ids[i], v_team_ids[j], false, 0, 0, v_due_at, v_now);
    end loop;
  end loop;

  update rapid_league_lobbies
  set status = 'live', league_id = v_league_id
  where id = p_lobby_id
  returning * into v_lobby;

  return v_lobby;
end;
$function$;

create or replace function public._rapid_league_sweep_internal()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row record;
  v_all_played boolean;
begin
  -- No forced forfeit on due_at anymore -- a league only finishes once
  -- every fixture has genuinely been played. See migration header.
  for v_row in
    select id as lobby_id, league_id from rapid_league_lobbies
    where status = 'live' and league_id is not null
  loop
    select bool_and(played)
    into v_all_played
    from fixtures
    where league_id = v_row.league_id and stage = 1;

    if coalesce(v_all_played, false) then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$function$;
