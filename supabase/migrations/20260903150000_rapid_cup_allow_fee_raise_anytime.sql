-- Rapid Cup — product decision: players can now raise their entry fee
-- at ANY point while the cup is active (open, filling, or live) — not
-- just when their own match happens to be unplayed. Removes the
-- mid-match block that shipped in 20260903120000_rapid_cup_raise_entry_fee.sql.
--
-- Still blocked once the lobby is no longer active (completed/expired)
-- — payout is computed from the fees on record at that point, so
-- changes after finalize_rapid_cup_payout() has run can't be allowed.

create or replace function raise_rapid_cup_entry_fee(p_lobby_id uuid, p_new_fee numeric)
returns rapid_cup_lobby_players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_row rapid_cup_lobby_players;
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

  update rapid_cup_lobby_players
  set entry_fee = p_new_fee
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function raise_rapid_cup_entry_fee(uuid, numeric) to authenticated;
