-- Rapid Cup Push Alarm — Step 4 (see RAPID-CUP-PUSH-ALARM-BUILD-PLAN.md,
-- Section 5). Fires the real phone notification from the exact moment the
-- lobby actually goes live — the instant the 4th player joins and this RPC
-- runs — rather than depending on any client noticing the change.
--
-- Uses pg_net (async — does not block or slow down bracket generation) to
-- call the already-deployed send-rapid-cup-push Edge Function with the
-- lobby_id, which resolves the 4 players and sends to every device they
-- have registered.
--
-- The service-role key needed to call the function is read from Supabase
-- Vault (secret name 'rapid_cup_push_service_role_key') — NOT hardcoded
-- here, so it never lands in this file or in git history.
--
-- Wrapped in its own begin/exception block: if the push call fails for any
-- reason (network hiccup, bad key, function down), the bracket itself has
-- already been created above and that must not be rolled back or fail the
-- whole RPC just because the notification didn't go out — the players can
-- still see their match in-app either way. The failure is only logged.
create or replace function generate_rapid_cup_bracket(p_lobby_id uuid)
returns rapid_cup_lobbies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_league_id uuid;
  v_now timestamptz := now();
  v_due_at timestamptz;
  v_player record;
  v_team_ids uuid[] := '{}';
  v_new_team_id uuid;
  v_service_key text;
begin
  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid Cup lobby % not found', p_lobby_id;
  end if;

  -- Already wired up (or not in a state to be) — return as-is, idempotent.
  if v_lobby.status <> 'filling' or v_lobby.league_id is not null then
    return v_lobby;
  end if;

  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '4 hours';

  insert into leagues (name, format, knockout_legs, league_type, created_by_admin, starts_at)
  values ('Rapid Cup — ' || to_char(v_now, 'DD Mon HH24:MI'), 'knockout', 1, 'fun', true, v_now)
  returning id into v_league_id;

  -- One team per lobby player, named/phoned from their profile — random
  -- order so seeding isn't predictable from join order.
  for v_player in
    select lp.user_id, coalesce(p.efootball_username, 'Player ' || substr(lp.user_id::text, 1, 6)) as display_name, p.phone
    from rapid_cup_lobby_players lp
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

  if array_length(v_team_ids, 1) <> 4 then
    raise exception 'Rapid Cup lobby % did not have exactly 4 players (had %)', p_lobby_id, array_length(v_team_ids, 1);
  end if;

  insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
  values
    (v_league_id, 1, 1, 1, v_team_ids[1], v_team_ids[2], false, 0, 0, v_due_at, v_now),
    (v_league_id, 1, 1, 1, v_team_ids[3], v_team_ids[4], false, 0, 0, v_due_at, v_now);

  update rapid_cup_lobbies
  set status = 'live', league_id = v_league_id
  where id = p_lobby_id
  returning * into v_lobby;

  -- Push Alarm Step 4: notify all 4 players' devices that the lobby just
  -- went live. Best-effort — never let a notification problem undo or
  -- fail the bracket generation itself (see file header).
  begin
    select decrypted_secret into v_service_key
    from vault.decrypted_secrets
    where name = 'rapid_cup_push_service_role_key';

    if v_service_key is not null then
      perform net.http_post(
        url := 'https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/send-rapid-cup-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object('lobby_id', p_lobby_id)
      );
    else
      raise warning 'generate_rapid_cup_bracket: rapid_cup_push_service_role_key not found in Vault — skipping push for lobby %', p_lobby_id;
    end if;
  exception when others then
    raise warning 'generate_rapid_cup_bracket: push notification failed for lobby % — %', p_lobby_id, sqlerrm;
  end;

  return v_lobby;
end;
$$;

grant execute on function generate_rapid_cup_bracket(uuid) to authenticated;
