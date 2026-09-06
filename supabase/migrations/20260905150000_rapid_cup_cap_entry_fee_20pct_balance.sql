-- Rapid Cup — cap custom entry fees at 20% of the player's own Nets
-- balance (balances.amount), on top of the existing flat 0-400 range.
-- Applies to both places a player sets their own fee: joining
-- (join_rapid_cup_lobby) and raising it later (raise_rapid_cup_entry_fee).
-- Already applied directly to the live project and verified there; this
-- file just catches version control up.
--
-- A parallel change was made in the frontend (RapidCupFeeSlider.jsx /
-- RapidCupFeeDisplay.jsx) so the slider itself stops at the real cap
-- instead of always going to 400 — but this server-side check is what
-- actually enforces it regardless of what the client sends.
create or replace function join_rapid_cup_lobby(p_entry_fee numeric default 0)
returns rapid_cup_lobbies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_next_lobby rapid_cup_lobbies;
  v_player_count int;
  v_already_seated boolean;
  v_balance numeric;
begin
  if p_entry_fee < 0 or p_entry_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(amount, 0) into v_balance from balances where user_id = auth.uid();
  v_balance := coalesce(v_balance, 0);
  if p_entry_fee > v_balance * 0.20 then
    raise exception 'Entry fee cannot exceed 20%% of your Nets balance (max %)', floor(v_balance * 0.20);
  end if;

  loop
    select * into v_lobby
    from rapid_cup_lobbies
    where status = 'open' and reset_at > now()
    order by created_at asc
    limit 1
    for update;

    if v_lobby.id is null then
      insert into rapid_cup_lobbies default values returning * into v_lobby;
      exit;
    end if;

    select exists (
      select 1 from rapid_cup_lobby_players
      where lobby_id = v_lobby.id and user_id = auth.uid()
    ) into v_already_seated;

    if v_already_seated then
      exit;
    end if;

    select count(*) into v_player_count
    from rapid_cup_lobby_players
    where lobby_id = v_lobby.id;

    if v_lobby.status <> 'open' or v_player_count >= 4 then
      continue;
    end if;

    exit;
  end loop;

  insert into rapid_cup_lobby_players (lobby_id, user_id, entry_fee)
  values (v_lobby.id, auth.uid(), p_entry_fee)
  on conflict (lobby_id, user_id) do nothing;

  select count(*) into v_player_count
  from rapid_cup_lobby_players
  where lobby_id = v_lobby.id;

  if v_player_count >= 4 and v_lobby.status = 'open' then
    insert into rapid_cup_lobbies default values returning * into v_next_lobby;

    update rapid_cup_lobbies
    set status = 'filling', started_at = now(), next_lobby_id = v_next_lobby.id
    where id = v_lobby.id
    returning * into v_lobby;
  end if;

  return v_lobby;
end;
$$;

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
  v_balance numeric;
begin
  if p_new_fee < 0 or p_new_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(amount, 0) into v_balance from balances where user_id = auth.uid();
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
    v_cup_ends_at := coalesce(v_lobby.started_at, v_lobby.created_at) + interval '4 hours';
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

grant execute on function raise_rapid_cup_entry_fee(uuid, numeric) to authenticated;
