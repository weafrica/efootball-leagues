-- Shrinks the Rapid Cup / Rapid League fixture window from 24h back down
-- to 2h, per explicit instruction. Touches every place that window was
-- set to 24h (generate_rapid_cup_bracket, _rapid_cup_advance_bracket_internal's
-- final, generate_rapid_league_fixtures), plus fixes a pre-existing
-- inconsistency this surfaces: raise_rapid_cup_entry_fee and
-- raise_rapid_league_entry_fee were still locking fee changes based on a
-- hardcoded 4-hour "cup/league ends at" assumption that never matched
-- either the old 24h window or this new 2h one. Both now derive from the
-- same 2h window so "last 40 minutes locked" actually means the last 40
-- minutes of the real match window, not an arbitrary unrelated figure.
--
-- Note: 40 minutes out of a 2-hour window is now a third of the whole
-- match locked to fee changes — proportionally much stricter than against
-- the old 24h window. Flagging in case that ratio wasn't meant to change
-- along with the window itself.

create or replace function public.generate_rapid_cup_bracket(p_lobby_id uuid)
 returns rapid_cup_lobbies
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  if v_lobby.status <> 'filling' or v_lobby.league_id is not null then
    return v_lobby;
  end if;

  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '2 hours';

  insert into leagues (name, format, knockout_legs, league_type, created_by_admin, starts_at)
  values ('Rapid Cup — ' || to_char(v_now, 'DD Mon HH24:MI'), 'knockout', 1, 'fun', true, v_now)
  returning id into v_league_id;

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
$function$;

create or replace function public._rapid_cup_advance_bracket_internal(p_league_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_semis record;
  v_winners uuid[] := '{}';
  v_now timestamptz := now();
  v_final_exists boolean;
begin
  perform pg_advisory_xact_lock(hashtext(p_league_id::text)::bigint);

  select exists(select 1 from fixtures where league_id = p_league_id and round = 2 and stage = 1)
  into v_final_exists;

  if v_final_exists then
    return;
  end if;

  for v_semis in
    select home_team_id, away_team_id, played, home_score, away_score, pens_home, pens_away
    from fixtures
    where league_id = p_league_id and round = 1 and leg = 1 and stage = 1
    order by id
  loop
    if not v_semis.played then
      return;
    end if;

    if v_semis.home_score > v_semis.away_score then
      v_winners := v_winners || v_semis.home_team_id;
    elsif v_semis.away_score > v_semis.home_score then
      v_winners := v_winners || v_semis.away_team_id;
    elsif v_semis.pens_home is not null and v_semis.pens_away is not null and v_semis.pens_home <> v_semis.pens_away then
      v_winners := v_winners || (case when v_semis.pens_home > v_semis.pens_away then v_semis.home_team_id else v_semis.away_team_id end);
    else
      return;
    end if;
  end loop;

  if coalesce(array_length(v_winners, 1), 0) <> 2 then
    return;
  end if;

  insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
  values (p_league_id, 2, 1, 1, v_winners[1], v_winners[2], false, 0, 0, v_now + interval '2 hours', v_now);
end;
$function$;

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

  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '2 hours';

  insert into leagues (name, format, league_type, created_by_admin, starts_at)
  values ('Rapid League — ' || to_char(v_now, 'DD Mon HH24:MI'), 'single_round_robin', 'fun', true, v_now)
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

  if array_length(v_team_ids, 1) <> 4 then
    raise exception 'Rapid League lobby % did not have exactly 4 players (had %)', p_lobby_id, array_length(v_team_ids, 1);
  end if;

  for i in 1..3 loop
    for j in (i + 1)..4 loop
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

create or replace function public.raise_rapid_cup_entry_fee(p_lobby_id uuid, p_new_fee numeric)
 returns rapid_cup_lobby_players
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_cup_lobbies;
  v_row rapid_cup_lobby_players;
  v_cup_ends_at timestamptz;
  v_balance numeric;
begin
  if p_new_fee < 0 or p_new_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(balance, 0) into v_balance from nets_wallets where user_id = auth.uid();
  v_balance := coalesce(v_balance, 0);
  if p_new_fee > v_balance * 0.20 then
    raise exception 'Entry fee cannot exceed 20%% of your Nets balance (max %)', floor(v_balance * 0.20);
  end if;

  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id;
  if v_lobby.id is null then
    raise exception 'Rapid Cup lobby % not found', p_lobby_id;
  end if;

  select * into v_row
  from rapid_cup_lobby_players
  where lobby_id = p_lobby_id and user_id = auth.uid()
  for update;

  if v_row.id is null then
    raise exception 'You are not in this Rapid Cup lobby';
  end if;

  if p_new_fee <= v_row.entry_fee then
    raise exception 'Entry fee can only be raised — % is not above your current % Nets', p_new_fee, v_row.entry_fee;
  end if;

  if v_lobby.status not in ('open', 'filling', 'live') then
    raise exception 'This Rapid Cup lobby is no longer accepting fee changes';
  end if;

  if v_lobby.status = 'live' then
    v_cup_ends_at := coalesce(v_lobby.started_at, v_lobby.created_at) + interval '2 hours';
    if v_cup_ends_at - now() <= interval '40 minutes' then
      raise exception 'Entry fees are locked in the last 40 minutes of the cup';
    end if;
  end if;

  update rapid_cup_lobby_players
  set entry_fee = p_new_fee
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

create or replace function public.raise_rapid_league_entry_fee(p_lobby_id uuid, p_new_fee numeric)
 returns rapid_league_lobby_players
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_row rapid_league_lobby_players;
  v_league_ends_at timestamptz;
  v_balance numeric;
begin
  if p_new_fee < 0 or p_new_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(balance, 0) into v_balance from nets_wallets where user_id = auth.uid();
  v_balance := coalesce(v_balance, 0);
  if p_new_fee > v_balance * 0.20 then
    raise exception 'Entry fee cannot exceed 20%% of your Nets balance (max %)', floor(v_balance * 0.20);
  end if;

  select * into v_lobby from rapid_league_lobbies where id = p_lobby_id;
  if v_lobby.id is null then
    raise exception 'Rapid League lobby % not found', p_lobby_id;
  end if;

  select * into v_row
  from rapid_league_lobby_players
  where lobby_id = p_lobby_id and user_id = auth.uid()
  for update;

  if v_row.id is null then
    raise exception 'You are not in this Rapid League lobby';
  end if;

  if p_new_fee <= v_row.entry_fee then
    raise exception 'Entry fee can only be raised — % is not above your current % Nets', p_new_fee, v_row.entry_fee;
  end if;

  if v_lobby.status not in ('open', 'filling', 'live') then
    raise exception 'This Rapid League lobby is no longer accepting fee changes';
  end if;

  if v_lobby.status = 'live' then
    v_league_ends_at := coalesce(v_lobby.started_at, v_lobby.created_at) + interval '2 hours';
    if v_league_ends_at - now() <= interval '40 minutes' then
      raise exception 'Entry fees are locked in the last 40 minutes of the league';
    end if;
  end if;

  update rapid_league_lobby_players
  set entry_fee = p_new_fee
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;
