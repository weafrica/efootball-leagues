create or replace function raise_rapid_cup_entry_fee(p_lobby_id uuid, p_new_fee numeric)
returns rapid_cup_lobby_players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_row rapid_cup_lobby_players;
  v_team_id uuid;
  v_mid_match boolean;
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

  if v_lobby.status = 'live' then
    select m.team_id into v_team_id
    from members m
    where m.league_id = v_lobby.league_id and m.user_id = auth.uid();

    select exists(
      select 1 from fixtures f
      where f.league_id = v_lobby.league_id
        and f.played = false
        and (f.home_team_id = v_team_id or f.away_team_id = v_team_id)
    ) into v_mid_match;

    if v_mid_match then
      raise exception 'Can''t raise your entry fee mid-match — wait until this round is decided';
    end if;
  elsif v_lobby.status not in ('open', 'filling') then
    raise exception 'This Rapid Cup lobby is no longer accepting fee changes';
  end if;

  update rapid_cup_lobby_players
  set entry_fee = p_new_fee
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function raise_rapid_cup_entry_fee(uuid, numeric) to authenticated;
