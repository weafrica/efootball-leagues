-- Rapid Cup — fix join_rapid_cup_lobby's `skip locked` race.
--
-- Bug: the lookup of the current open lobby used
--   ... for update skip locked
-- `skip locked` means "if someone else already has this row locked, don't
-- wait — act as if it doesn't exist." With only one open lobby at a time,
-- that's exactly wrong: two players clicking Join within the same instant
-- (very common right as a lobby is about to hit 4) means the second one's
-- lock attempt gets skipped, v_lobby.id comes back null, and they create
-- and get seated in a brand-new empty lobby instead of the real one —
-- splitting a would-be full 4-player lobby into two dead-end ones.
--
-- Fix: use a plain (blocking) `for update` so the second caller queues for
-- the same row instead of bailing, then re-checks the row it eventually
-- gets — because by the time it unblocks, the first caller may have
-- already filled that lobby and chained a new one. Without the re-check,
-- the second caller would just insert itself as a 5th player into a lobby
-- that's already flipped to 'filling'. The loop below keeps searching
-- (or creates a fresh lobby) until it lands on one that's still actually
-- open and under capacity, or on one the caller is already seated in
-- (idempotent re-call).

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
begin
  if p_entry_fee < 0 or p_entry_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  loop
    -- Find the current open, not-yet-expired lobby; create one if none
    -- exists. Blocking `for update` on purpose — see note above.
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

    -- Idempotent re-call: if we're already seated here, use this lobby
    -- regardless of its current status/capacity.
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

    -- Whoever held the lock before us may have just filled this lobby
    -- and flipped it to 'filling' — if so, loop back and find/create a
    -- fresh open one instead of overstuffing this one as a 5th player.
    if v_lobby.status <> 'open' or v_player_count >= 4 then
      continue;
    end if;

    exit;
  end loop;

  -- Seat the player (idempotent — re-calling just returns the same lobby).
  insert into rapid_cup_lobby_players (lobby_id, user_id, entry_fee)
  values (v_lobby.id, auth.uid(), p_entry_fee)
  on conflict (lobby_id, user_id) do nothing;

  select count(*) into v_player_count
  from rapid_cup_lobby_players
  where lobby_id = v_lobby.id;

  if v_player_count >= 4 and v_lobby.status = 'open' then
    -- Auto-chain: open the next lobby immediately so it's never dead.
    insert into rapid_cup_lobbies default values returning * into v_next_lobby;

    update rapid_cup_lobbies
    set status = 'filling', started_at = now(), next_lobby_id = v_next_lobby.id
    where id = v_lobby.id
    returning * into v_lobby;
  end if;

  return v_lobby;
end;
$$;
