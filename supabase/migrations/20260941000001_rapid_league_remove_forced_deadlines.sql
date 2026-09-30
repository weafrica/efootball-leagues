-- Rapid League — same fix as 20260940 for Rapid Cup, applied to the
-- parallel round-robin feature. Players fill a lobby to 4 and play out
-- the round robin whenever they get to it; nobody already seated gets
-- orphaned by a timer. Countdown UI, push alarm, and reminder
-- notifications are untouched — reset_at/due_at are still set the same
-- way and still drive them, they just no longer trigger anything on
-- the backend.
--
-- 1) join_rapid_league_lobby only reused a lobby while
--    `reset_at > now()`. Fix: match on `status = 'open'` only.
--
-- 2) _rapid_league_sweep_internal already finishes a live league once
--    every stage-1 fixture is actually played (bool_and(played)) —
--    good. It also had a `bool_or(due_at <= now())` fallback that
--    force-finished (refund/declare-winner) a league mid-round-robin
--    once ANY fixture's due_at passed, even with matches unplayed.
--    Fix: drop that fallback. A live league now only finishes once
--    every fixture is actually played. Same trade-off as Rapid Cup: a
--    league where someone never plays their leg now sits 'live'
--    indefinitely rather than auto-resolving — deliberate, but a
--    manual admin "force-resolve" would need to be the recovery path
--    for a truly abandoned one.
--
-- The 'rapid-league-expire-lobbies' cron job (expire_rapid_league_lobbies,
-- with its own one-shot carryover) is unscheduled below: with fix #1, an
-- under-filled lobby is never abandoned in the first place, so there's
-- nothing left for it to carry over or expire. The function itself, and
-- reset_at on rapid_league_lobbies, are left in place (harmless, and
-- reset_at still drives the existing countdown UI).

create or replace function join_rapid_league_lobby(p_entry_fee numeric default 0)
returns rapid_league_lobbies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_league_lobbies;
  v_next_lobby rapid_league_lobbies;
  v_player_count int;
  v_already_seated boolean;
  v_balance numeric;
begin
  if p_entry_fee < 0 or p_entry_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(balance, 0) into v_balance from nets_wallets where user_id = auth.uid();
  v_balance := coalesce(v_balance, 0);
  if p_entry_fee > v_balance * 0.20 then
    raise exception 'Entry fee cannot exceed 20%% of your Nets balance (max %)', floor(v_balance * 0.20);
  end if;

  loop
    -- No time cutoff here anymore — an under-filled lobby stays
    -- joinable for as long as it takes to reach 4.
    select * into v_lobby
    from rapid_league_lobbies
    where status = 'open'
    order by created_at asc
    limit 1
    for update;

    if v_lobby.id is null then
      insert into rapid_league_lobbies default values returning * into v_lobby;
      exit;
    end if;

    select exists (
      select 1 from rapid_league_lobby_players
      where lobby_id = v_lobby.id and user_id = auth.uid()
    ) into v_already_seated;

    if v_already_seated then
      exit;
    end if;

    select count(*) into v_player_count
    from rapid_league_lobby_players
    where lobby_id = v_lobby.id;

    if v_lobby.status <> 'open' or v_player_count >= 4 then
      continue;
    end if;

    exit;
  end loop;

  insert into rapid_league_lobby_players (lobby_id, user_id, entry_fee)
  values (v_lobby.id, auth.uid(), p_entry_fee)
  on conflict (lobby_id, user_id) do nothing;

  select count(*) into v_player_count
  from rapid_league_lobby_players
  where lobby_id = v_lobby.id;

  if v_player_count >= 4 and v_lobby.status = 'open' then
    insert into rapid_league_lobbies default values returning * into v_next_lobby;

    update rapid_league_lobbies
    set status = 'filling', started_at = now(), next_lobby_id = v_next_lobby.id
    where id = v_lobby.id
    returning * into v_lobby;
  end if;

  return v_lobby;
end;
$$;

create or replace function _rapid_league_sweep_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_all_played boolean;
begin
  for v_row in
    select id as lobby_id, league_id from rapid_league_lobbies
    where status = 'live' and league_id is not null
  loop
    select bool_and(played)
    into v_all_played
    from fixtures
    where league_id = v_row.league_id and stage = 1;

    -- Finish only once every fixture is actually played — no more
    -- forced finish on any fixture's due_at passing. due_at is still
    -- set and still drives the existing countdown/reminder UI; it just
    -- isn't read here anymore.
    if coalesce(v_all_played, false) then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$$;

-- Nothing left for the expiry cron to do (see fix #1 above) — unschedule
-- it. expire_rapid_league_lobbies() itself is left defined, unused.
select cron.unschedule(jobid) from cron.job where jobname = 'rapid-league-expire-lobbies';
