-- Rapid Cup — stop forcibly ending lobbies/cups on a clock. Players fill
-- a lobby to 4 and play the bracket out whenever they get to it; nobody
-- already seated gets orphaned by a timer. The countdown UI, push alarm,
-- and reminder notifications are untouched — they still display/fire on
-- their existing schedule (reset_at / due_at keep being set the same
-- way), they just no longer trigger anything on the backend. They're
-- kept purely for the sense of urgency they create.
--
-- Two separate bugs this fixes:
--
-- 1) join_rapid_cup_lobby only reused a lobby while
--    `reset_at > now()`. Once that 1hr window lapsed on an
--    under-filled lobby (1-3 players, not yet 4), the NEXT joiner
--    silently skipped it and started a brand-new lobby instead —
--    stranding whoever was already waiting. Fix: match on
--    `status = 'open'` only, no time cutoff, so a lobby keeps
--    accepting joiners for as long as it takes to reach 4.
--
-- 2) _rapid_cup_sweep_internal (see 20260926) already finishes a cup
--    as soon as the final is actually played — good — but still had a
--    fallback that force-finished (refund/declare-winner) a cup once
--    its shared 4hr due_at passed, even mid-bracket. Fix: drop that
--    fallback. A live cup now only ever finishes when the final is
--    decided. Trade-off: a cup that's started but never gets finished
--    (someone never plays their leg) now just sits 'live' indefinitely
--    instead of auto-resolving after 4hrs — deliberate, per "play when
--    they can until they're done", but worth knowing: any recovery for
--    a truly abandoned live cup would need to be a manual admin action
--    rather than the automatic timeout that used to be here.
--
-- The 1min 'rapid-cup-expire-lobbies' cron job (expire_rapid_cup_lobbies,
-- plus its once-only member-carryover logic from 20260929) is unscheduled
-- below: with fix #1, an under-filled lobby is never abandoned in the
-- first place, so there's nothing left for it to carry over or expire.
-- The function itself, and reset_at on rapid_cup_lobbies, are left in
-- place (harmless, and reset_at still drives the existing countdown UI).

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
    -- Find the current open lobby; create one if none exists. No time
    -- cutoff here anymore — an under-filled lobby stays joinable for as
    -- long as it takes to reach 4, it never gets abandoned for a fresh
    -- one just because time has passed. Blocking `for update` on
    -- purpose (see 20260903123127_rapid_cup_fix_join_race.sql).
    select * into v_lobby
    from rapid_cup_lobbies
    where status = 'open'
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

create or replace function _rapid_cup_sweep_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_final_played boolean;
begin
  for v_row in
    select id as lobby_id, league_id from rapid_cup_lobbies
    where status = 'live' and league_id is not null
  loop
    perform _rapid_cup_advance_bracket_internal(v_row.league_id);

    select exists(
      select 1 from fixtures
      where league_id = v_row.league_id and round = 2 and stage = 1 and played = true
    ) into v_final_played;

    -- Finish only once the final is actually decided — no more forced
    -- finish on due_at. due_at is still set at bracket generation and
    -- still drives the existing countdown/reminder UI; it just isn't
    -- read here anymore.
    if v_final_played then
      perform _rapid_cup_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$$;

-- Nothing left for the expiry cron to do (see fix #1 above) — unschedule
-- it. expire_rapid_cup_lobbies() itself is left defined, unused.
select cron.unschedule(jobid) from cron.job where jobname = 'rapid-cup-expire-lobbies';
