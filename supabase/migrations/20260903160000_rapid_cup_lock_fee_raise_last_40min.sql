-- Rapid Cup — lock entry-fee raises in the last 40 minutes before the
-- cup's 4hr auto-finish (Section 2). Prevents someone spiking their
-- stake right before finalize_rapid_cup_payout() reads the fees.
-- Builds on 20260903150000_rapid_cup_allow_fee_raise_anytime.sql —
-- raises are still allowed any time before that window.

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

  -- Once live, the cup auto-finishes 4hr after started_at (Section 2).
  -- No fee changes in the final 40 minutes of that window.
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
