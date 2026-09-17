-- Rapid Cup / Rapid League — two separate timers, corrected independently:
--
-- 1. Lobby join countdown (rapid_*_lobbies.reset_at) — shown on the home
--    screen banner as "x/4 joined — resets in mm:ss". This is the
--    "for show" timer that drives whether the lobby is still accepting
--    joiners; it has nothing to do with match length. Was defaulting to
--    1 hour — now 2 hours, both for new lobbies (column default) and
--    the currently open lobby of each type (so the banner picks it up
--    immediately instead of waiting for the next lobby to be created).
--
-- 2. Match fixture deadline (fixtures.due_at) — reverted from the 2h set
--    in 20260943_rapid_cup_league_2h_fixture_window.sql back to 24h.
--    The fee-raise "last 40 minutes" lock in both raise_*_entry_fee
--    functions is updated to match, same reasoning as before: that lock
--    independently recomputes the end time, so it has to track whatever
--    due_at actually uses or it opens/closes at the wrong moment.

-- ─────────────────────────────────────────────────────────────────────────
-- 1a. Lobby join countdown — new default + fix the currently open lobby.
-- ─────────────────────────────────────────────────────────────────────────
alter table rapid_cup_lobbies
  alter column reset_at set default (now() + interval '2 hours');

alter table rapid_league_lobbies
  alter column reset_at set default (now() + interval '2 hours');

update rapid_cup_lobbies
set reset_at = created_at + interval '2 hours'
where status = 'open';

update rapid_league_lobbies
set reset_at = created_at + interval '2 hours'
where status = 'open';

-- ─────────────────────────────────────────────────────────────────────────
-- 1b. Rapid Cup — fixtures back to a 24h due window.
-- ─────────────────────────────────────────────────────────────────────────
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
begin
  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid Cup lobby % not found', p_lobby_id;
  end if;

  if v_lobby.status <> 'filling' or v_lobby.league_id is not null then
    return v_lobby;
  end if;

  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '24 hours';

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

  return v_lobby;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1c. Rapid Cup — fee-raise lock matches the 24h window again.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function raise_rapid_cup_entry_fee(p_lobby_id uuid, p_new_fee numeric)
returns rapid_cup_lobby_players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_row rapid_cup_lobby_players;
  v_cup_ends_at timestamptz;
begin
  if p_new_fee < 0 or p_new_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
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
    v_cup_ends_at := coalesce(v_lobby.started_at, v_lobby.created_at) + interval '24 hours';
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
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1d. Rapid League — fixtures back to a 24h due window.
-- ─────────────────────────────────────────────────────────────────────────
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

  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '24 hours';

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

-- ─────────────────────────────────────────────────────────────────────────
-- 1e. Rapid League — fee-raise lock matches the 24h window again.
-- ─────────────────────────────────────────────────────────────────────────
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
    v_league_ends_at := coalesce(v_lobby.started_at, v_lobby.created_at) + interval '24 hours';
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
