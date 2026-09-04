-- Rapid Cup — carry existing members forward into the next lobby cycle
-- when a lobby expires without reaching 4 players, instead of discarding
-- them and making everyone rejoin from scratch. With the player base
-- still small, a lobby not filling within its 1hr window is common —
-- losing 1-3 already-committed players back to a blank lobby (and hoping
-- they notice and rejoin in time) was working against ever getting a 4th.
--
-- Deliberately capped to ONE carry-over per lobby chain, not indefinite:
-- a fresh cycle-0 lobby that expires carries its members into a cycle-1
-- lobby; if THAT one also expires without filling, its members are NOT
-- carried again into a cycle-2 (3rd) lobby — that one just expires
-- normally, same as any other, no add and no special drop either. Two
-- tries (2hrs total) is enough of a nudge without letting the same
-- handful of stale members quietly ping-pong forward forever while the
-- game never actually starts.
--
-- Applied directly to the project (see `select * from supabase_migrations.schema_migrations
-- where name = 'rapid_cup_lobby_member_carryover'`) — this file mirrors
-- that for the repo's own migration history.
alter table rapid_cup_lobbies
  add column if not exists carryover_generation int not null default 0;

create or replace function expire_rapid_cup_lobbies()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby record;
  v_new_lobby rapid_cup_lobbies;
begin
  for v_lobby in
    select * from rapid_cup_lobbies
    where status = 'open' and reset_at <= now()
    for update skip locked
  loop
    update rapid_cup_lobbies
    set status = 'expired'
    where id = v_lobby.id;

    -- Only a first-cycle (generation 0) lobby carries its members
    -- forward, and only if it actually had any to carry.
    if v_lobby.carryover_generation = 0 and exists (
      select 1 from rapid_cup_lobby_players where lobby_id = v_lobby.id
    ) then
      insert into rapid_cup_lobbies (carryover_generation)
      values (1)
      returning * into v_new_lobby;

      insert into rapid_cup_lobby_players (lobby_id, user_id, entry_fee)
      select v_new_lobby.id, user_id, entry_fee
      from rapid_cup_lobby_players
      where lobby_id = v_lobby.id
      on conflict (lobby_id, user_id) do nothing;

      update rapid_cup_lobbies
      set next_lobby_id = v_new_lobby.id
      where id = v_lobby.id;
    end if;
  end loop;

  -- Always leave a fresh, empty, generation-0 lobby open for new joiners —
  -- same guarantee this function has always provided, now also covering
  -- runs where every expiry above already created its own generation-1
  -- replacement.
  if not exists (select 1 from rapid_cup_lobbies where status = 'open' and reset_at > now()) then
    insert into rapid_cup_lobbies default values;
  end if;
end;
$$;

grant execute on function expire_rapid_cup_lobbies() to authenticated;
