-- Rapid League sizes: adds 8-club and 16-club siblings to the existing
-- 4-club single round robin.
--
-- Deliberately parameterised rather than copied into rapid_league8_* /
-- rapid_league16_* table sets: every mechanic the 4-club format has
-- (entry fee 0-400 + 20%-of-balance cap, fee raises with the 40-minute
-- lock, compute_rapid_cup_payout math, potbox/winbox collection,
-- 2-minute result auto-accept, 24h fixture forfeit sweep, lobby
-- carryover, alarm bookkeeping) is keyed off the lobby row, not off the
-- number 4 -- so one column carries all three sizes with no divergence
-- and no second copy of the payout logic to keep in sync.
--
-- Existing rows backfill to club_count = 4, so the live 4-club format
-- behaves exactly as before.
--
-- Untouched on purpose, because they were already size-agnostic:
--   _rapid_league_finish_lobby_internal  (standings/tiebreak work off
--     "every stage-1 fixture in this league", never a count of 4)
--   _rapid_league_sweep_internal, _rapid_league_forfeit_expired_fixtures_internal
--   _rapid_league_result_auto_sweep_internal
--   raise_rapid_league_entry_fee, stop_rapid_league_alarm
--   collect_rapid_league_potbox, collect_rapid_league_winbox
-- Applied to project jobgzxljuczzqljwavyq on 2026-09-17.

alter table rapid_league_lobbies
  add column if not exists club_count integer not null default 4;

alter table rapid_league_lobbies
  drop constraint if exists rapid_league_lobbies_club_count_check;
alter table rapid_league_lobbies
  add constraint rapid_league_lobbies_club_count_check
  check (club_count in (4, 8, 16));

create index if not exists rapid_league_lobbies_status_club_count_idx
  on rapid_league_lobbies (club_count, status, created_at);

-- ---------------------------------------------------------------------
-- join -- now picks the open lobby of the requested size.
-- The old single-argument signature is dropped rather than overloaded:
-- two functions both callable with one argument would be ambiguous.
-- p_club_count defaults to 4, so any existing caller that passes only
-- p_entry_fee keeps landing in the 4-club queue.
-- ---------------------------------------------------------------------

drop function if exists public.join_rapid_league_lobby(numeric);

create or replace function public.join_rapid_league_lobby(
  p_entry_fee numeric default 0,
  p_club_count integer default 4
)
 returns rapid_league_lobbies
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_next_lobby rapid_league_lobbies;
  v_player_count int;
  v_already_seated boolean;
  v_balance numeric;
begin
  if p_club_count not in (4, 8, 16) then
    raise exception 'Rapid League size must be 4, 8 or 16 clubs';
  end if;

  if p_entry_fee < 0 or p_entry_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(balance, 0) into v_balance from nets_wallets where user_id = auth.uid();
  v_balance := coalesce(v_balance, 0);
  if p_entry_fee > v_balance * 0.20 then
    raise exception 'Entry fee cannot exceed 20%% of your Nets balance (max %)', floor(v_balance * 0.20);
  end if;

  loop
    -- No time cutoff here — an under-filled lobby stays joinable for as
    -- long as it takes to reach its club count.
    select * into v_lobby
    from rapid_league_lobbies
    where status = 'open' and club_count = p_club_count
    order by created_at asc
    limit 1
    for update;

    if v_lobby.id is null then
      insert into rapid_league_lobbies (club_count) values (p_club_count) returning * into v_lobby;
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

    if v_lobby.status <> 'open' or v_player_count >= p_club_count then
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

  if v_player_count >= v_lobby.club_count and v_lobby.status = 'open' then
    insert into rapid_league_lobbies (club_count) values (v_lobby.club_count) returning * into v_next_lobby;

    update rapid_league_lobbies
    set status = 'filling', started_at = now(), next_lobby_id = v_next_lobby.id
    where id = v_lobby.id
    returning * into v_lobby;
  end if;

  return v_lobby;
end;
$function$;

-- ---------------------------------------------------------------------
-- fixtures -- round robin sized to the lobby.
-- 4 clubs -> 6 matches, 8 -> 28, 16 -> 120. The 24h due_at is inherited
-- unchanged from the 4-club format; see the note in the PR description
-- about whether 16 clubs wants a longer window.
-- ---------------------------------------------------------------------

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
  v_club_count int;
  v_league_name text;
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

  v_club_count := v_lobby.club_count;
  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '24 hours';

  -- The original 4-club name is kept byte-identical so nothing that
  -- matches on it downstream changes; the new sizes are labelled.
  if v_club_count = 4 then
    v_league_name := 'Rapid League — ' || to_char(v_now, 'DD Mon HH24:MI');
  else
    v_league_name := 'Rapid League ' || v_club_count || ' — ' || to_char(v_now, 'DD Mon HH24:MI');
  end if;

  insert into leagues (name, format, league_type, created_by_admin, starts_at)
  values (v_league_name, 'single_round_robin', 'fun', true, v_now)
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

  if coalesce(array_length(v_team_ids, 1), 0) <> v_club_count then
    raise exception 'Rapid League lobby % did not have exactly % players (had %)',
      p_lobby_id, v_club_count, coalesce(array_length(v_team_ids, 1), 0);
  end if;

  for i in 1..(v_club_count - 1) loop
    for j in (i + 1)..v_club_count loop
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

-- ---------------------------------------------------------------------
-- expire / seeding -- keeps one open lobby per size.
-- Note this is currently not on cron (the rapid-league-expire-lobbies
-- job was removed by 20260941_rapid_league_remove_forced_deadlines);
-- join_rapid_league_lobby self-seeds per size, so the seeding here is a
-- belt-and-braces path if the job is ever re-enabled.
-- ---------------------------------------------------------------------

create or replace function public.expire_rapid_league_lobbies()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby record;
  v_new_lobby rapid_league_lobbies;
  v_size int;
begin
  for v_lobby in
    select * from rapid_league_lobbies
    where status = 'open' and reset_at <= now()
    for update skip locked
  loop
    update rapid_league_lobbies
    set status = 'expired'
    where id = v_lobby.id;

    if v_lobby.carryover_generation = 0 and exists (
      select 1 from rapid_league_lobby_players where lobby_id = v_lobby.id
    ) then
      insert into rapid_league_lobbies (carryover_generation, club_count)
      values (1, v_lobby.club_count)
      returning * into v_new_lobby;

      insert into rapid_league_lobby_players (lobby_id, user_id, entry_fee)
      select v_new_lobby.id, user_id, entry_fee
      from rapid_league_lobby_players
      where lobby_id = v_lobby.id
      on conflict (lobby_id, user_id) do nothing;

      update rapid_league_lobbies
      set next_lobby_id = v_new_lobby.id
      where id = v_lobby.id;
    end if;
  end loop;

  foreach v_size in array array[4, 8, 16] loop
    if not exists (
      select 1 from rapid_league_lobbies
      where status = 'open' and club_count = v_size and reset_at > now()
    ) then
      insert into rapid_league_lobbies (club_count) values (v_size);
    end if;
  end loop;
end;
$function$;

-- ---------------------------------------------------------------------
-- payout -- error message generalised only. The math is untouched and
-- still delegates to compute_rapid_cup_payout.
-- ---------------------------------------------------------------------

create or replace function public.finalize_rapid_league_payout(p_lobby_id uuid, p_winner_user_id uuid)
 returns rapid_league_payouts
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_existing rapid_league_payouts;
  v_total_pool numeric;
  v_max_stake numeric;
  v_winner_stake numeric;
  v_calc record;
  v_payout rapid_league_payouts;
  v_row record;
begin
  select * into v_lobby from rapid_league_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid League lobby % not found', p_lobby_id;
  end if;

  select * into v_existing from rapid_league_payouts where lobby_id = p_lobby_id;
  if v_existing.id is not null then
    return v_existing;
  end if;

  if v_lobby.status <> 'live' or v_lobby.league_id is null then
    raise exception 'Rapid League lobby % is not live with generated fixtures', p_lobby_id;
  end if;

  select sum(entry_fee), max(entry_fee) into v_total_pool, v_max_stake
  from rapid_league_lobby_players where lobby_id = p_lobby_id;

  select entry_fee into v_winner_stake
  from rapid_league_lobby_players
  where lobby_id = p_lobby_id and user_id = p_winner_user_id;

  if v_winner_stake is null then
    raise exception 'User % is not one of the % players in lobby %', p_winner_user_id, v_lobby.club_count, p_lobby_id;
  end if;

  select * into v_calc from compute_rapid_cup_payout(v_total_pool, v_winner_stake, v_max_stake);

  insert into rapid_league_payouts (
    lobby_id, league_id, winner_user_id, total_pool, winner_stake, max_stake,
    base_return, remaining_pool, bonus_share, bonus, organizer_keep, winner_bonus, winner_net_total, leftover
  ) values (
    p_lobby_id, v_lobby.league_id, p_winner_user_id, v_total_pool, v_winner_stake, v_max_stake,
    v_calc.base_return, v_calc.remaining_pool, v_calc.bonus_share, v_calc.bonus,
    v_calc.organizer_keep, v_calc.winner_bonus, v_calc.winner_net_total, v_calc.leftover
  )
  returning * into v_payout;

  insert into rapid_league_payout_recipients (payout_id, user_id, entry_fee, amount)
  values (v_payout.id, p_winner_user_id, v_winner_stake, v_calc.winner_net_total);

  for v_row in
    select user_id, entry_fee
    from rapid_league_lobby_players
    where lobby_id = p_lobby_id and user_id <> p_winner_user_id
  loop
    insert into rapid_league_payout_recipients (payout_id, user_id, entry_fee, amount)
    values (
      v_payout.id, v_row.user_id, v_row.entry_fee,
      case when v_calc.remaining_pool > 0 then v_calc.leftover * (v_row.entry_fee / v_calc.remaining_pool) else 0 end
    );
  end loop;

  update rapid_league_lobbies set status = 'completed' where id = p_lobby_id;

  return v_payout;
end;
$function$;

-- ---------------------------------------------------------------------
-- Grants -- same shape as the original rapid_league migration.
-- ---------------------------------------------------------------------

revoke all on function public.join_rapid_league_lobby(numeric, integer) from public;
grant execute on function public.join_rapid_league_lobby(numeric, integer) to anon, authenticated;

revoke all on function public.generate_rapid_league_fixtures(uuid) from public;
grant execute on function public.generate_rapid_league_fixtures(uuid) to anon, authenticated;

revoke all on function public.expire_rapid_league_lobbies() from public;
grant execute on function public.expire_rapid_league_lobbies() to anon, authenticated;

revoke all on function public.finalize_rapid_league_payout(uuid, uuid) from public;

-- Seed one open lobby for each new size so both banners have somewhere
-- to join immediately (the 4-club one already has its open lobby).
insert into rapid_league_lobbies (club_count)
select 8 where not exists (select 1 from rapid_league_lobbies where club_count = 8 and status = 'open');

insert into rapid_league_lobbies (club_count)
select 16 where not exists (select 1 from rapid_league_lobbies where club_count = 16 and status = 'open');
