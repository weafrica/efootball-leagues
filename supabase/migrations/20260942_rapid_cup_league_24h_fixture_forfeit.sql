-- Rapid Cup & Rapid League — per-fixture 24h countdown + forfeit, copied
-- from League Ladder's own pattern (20260862_ladder_fixture_countdown_
-- and_forfeit.sql: countdown column, hourly-style sweep, double-forfeit
-- on expiry, no match reward). The whole cup/league itself still never
-- force-finishes on a clock (20260940/20260941) — players can arrange
-- to play whenever they like — but each INDIVIDUAL fixture now gets a
-- 24h window (was 4h) to be submitted, after which it resolves itself
-- so the tournament can still move forward instead of stalling forever
-- on one missing result.
--
-- 1. due_at on every newly-generated fixture is now +24h (was +4h), for
--    both generate_rapid_cup_bracket and generate_rapid_league_fixtures.
--    _rapid_cup_advance_bracket_internal now also gives the final its
--    OWN fresh 24h window from the moment it's actually created, rather
--    than inheriting whatever was left of the semis' shared due_at —
--    "24h to submit EACH fixture" means each one gets the full window,
--    not a shrinking leftover.
--
-- 2. New `forfeited` flag on fixtures (shared table, harmless default
--    for every other format) — lets the UI show "forfeited" distinctly
--    from a real submitted result, same as ladder_fixtures.status
--    already does for League Ladder.
--
-- 3. Two new sweep functions, folded into the existing every-2-minute
--    _rapid_cup_sweep_internal / _rapid_league_sweep_internal (no new
--    cron jobs needed) rather than a separate hourly job:
--
--    - Rapid League (round robin, no bracket to protect): exactly
--      ladder's own rule — an expired pending fixture becomes a 0-0
--      double-forfeit, no reward. It naturally counts as "played" for
--      the completion check (20260941) already in the sweep, so a
--      league with one no-show fixture still finishes once everything
--      else is done rather than hanging forever.
--
--    - Rapid Cup semis (round 1): unlike a round robin, a knockout MUST
--      produce a winner here or the bracket can never advance to a
--      final. There's no signal to prefer one side over the other on a
--      double no-show, so this picks a coin-flip winner (1-0) rather
--      than leaving the cup stuck. Flagging this explicitly since it's
--      the one genuinely arbitrary call in this migration — happy to
--      swap it for a different rule (e.g. highest stake advances) if
--      you'd rather.
--
--    - Rapid Cup final (round 2): no bracket left to protect, so this
--      is a plain 0-0 double-forfeit like Rapid League's. It falls
--      straight into _rapid_cup_finish_lobby_internal's existing
--      tied-on-wins/tied-on-goals logic (both finalists already have 1
--      semi win each, a 0-0 final keeps them level) and splits the pool
--      evenly between them — no coin flip needed, the payout logic
--      already handles a tie fairly.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- forfeited flag — shared fixtures table, defaults false for every other
-- format untouched by this migration.
-- ─────────────────────────────────────────────────────────────────────────
alter table fixtures add column if not exists forfeited boolean not null default false;

-- ─────────────────────────────────────────────────────────────────────────
-- generate_rapid_cup_bracket — same as the live version, only the
-- interval changed (4 hours -> 24 hours).
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
  v_service_key text;
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

  begin
    select decrypted_secret into v_service_key
    from vault.decrypted_secrets
    where name = 'rapid_cup_push_service_role_key';

    if v_service_key is not null then
      perform net.http_post(
        url := 'https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/send-rapid-cup-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object('lobby_id', p_lobby_id)
      );
    else
      raise warning 'generate_rapid_cup_bracket: rapid_cup_push_service_role_key not found in Vault — skipping push for lobby %', p_lobby_id;
    end if;
  exception when others then
    raise warning 'generate_rapid_cup_bracket: push notification failed for lobby % — %', p_lobby_id, sqlerrm;
  end;

  return v_lobby;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- generate_rapid_league_fixtures — same, interval changed to 24 hours.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function generate_rapid_league_fixtures(p_lobby_id uuid)
returns rapid_league_lobbies
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_cup_advance_bracket_internal — the final now gets its own fresh
-- 24h window from the moment it's created (v_now + 24h) instead of
-- inheriting the semis' shared due_at, which could already be mostly (or
-- entirely) used up by the time both semis actually finish.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rapid_cup_advance_bracket_internal(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_semis record;
  v_winners uuid[] := '{}';
  v_now timestamptz := now();
  v_final_exists boolean;
begin
  perform pg_advisory_xact_lock(hashtext(p_league_id::text)::bigint);

  select exists(select 1 from fixtures where league_id = p_league_id and round = 2 and stage = 1)
  into v_final_exists;

  if v_final_exists then
    return;
  end if;

  for v_semis in
    select home_team_id, away_team_id, played, home_score, away_score, pens_home, pens_away
    from fixtures
    where league_id = p_league_id and round = 1 and leg = 1 and stage = 1
    order by id
  loop
    if not v_semis.played then
      return;
    end if;

    if v_semis.home_score > v_semis.away_score then
      v_winners := v_winners || v_semis.home_team_id;
    elsif v_semis.away_score > v_semis.home_score then
      v_winners := v_winners || v_semis.away_team_id;
    elsif v_semis.pens_home is not null and v_semis.pens_away is not null and v_semis.pens_home <> v_semis.pens_away then
      v_winners := v_winners || (case when v_semis.pens_home > v_semis.pens_away then v_semis.home_team_id else v_semis.away_team_id end);
    else
      return;
    end if;
  end loop;

  if coalesce(array_length(v_winners, 1), 0) <> 2 then
    return;
  end if;

  insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
  values (p_league_id, 2, 1, 1, v_winners[1], v_winners[2], false, 0, 0, v_now + interval '24 hours', v_now);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_cup_forfeit_expired_fixtures_internal — see header. Semis need a
-- decisive (coin-flip) winner to keep the bracket moving; the final just
-- becomes a plain 0-0 double-forfeit, which the existing finish logic
-- already splits fairly between two players tied on wins.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rapid_cup_forfeit_expired_fixtures_internal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_row record;
  v_home_wins boolean;
begin
  for v_row in
    select f.id
    from fixtures f
    join rapid_cup_lobbies rcl on rcl.league_id = f.league_id
    where rcl.status = 'live' and f.round = 1 and f.stage = 1
      and f.played = false and f.due_at is not null and f.due_at <= now()
    for update of f skip locked
  loop
    v_home_wins := random() < 0.5;
    update fixtures
    set played = true, forfeited = true, played_at = now(),
        home_score = case when v_home_wins then 1 else 0 end,
        away_score = case when v_home_wins then 0 else 1 end
    where id = v_row.id;
    v_count := v_count + 1;
  end loop;

  for v_row in
    select f.id
    from fixtures f
    join rapid_cup_lobbies rcl on rcl.league_id = f.league_id
    where rcl.status = 'live' and f.round = 2 and f.stage = 1
      and f.played = false and f.due_at is not null and f.due_at <= now()
    for update of f skip locked
  loop
    update fixtures
    set played = true, forfeited = true, played_at = now(), home_score = 0, away_score = 0
    where id = v_row.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
revoke all on function _rapid_cup_forfeit_expired_fixtures_internal() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_league_forfeit_expired_fixtures_internal — round robin, no
-- bracket to protect: exactly ladder's own double-forfeit rule.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rapid_league_forfeit_expired_fixtures_internal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update fixtures f
  set played = true, forfeited = true, played_at = now(), home_score = 0, away_score = 0
  from rapid_league_lobbies rll
  where rll.league_id = f.league_id
    and rll.status = 'live'
    and f.stage = 1
    and f.played = false
    and f.due_at is not null
    and f.due_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function _rapid_league_forfeit_expired_fixtures_internal() from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Fold both forfeit sweeps into the existing every-2-minute sweeps, ahead
-- of the bracket-advance / completion check each already does — no new
-- cron jobs needed.
-- ─────────────────────────────────────────────────────────────────────────
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
  perform _rapid_cup_forfeit_expired_fixtures_internal();

  for v_row in
    select id as lobby_id, league_id from rapid_cup_lobbies
    where status = 'live' and league_id is not null
  loop
    perform _rapid_cup_advance_bracket_internal(v_row.league_id);

    select exists(
      select 1 from fixtures
      where league_id = v_row.league_id and round = 2 and stage = 1 and played = true
    ) into v_final_played;

    if v_final_played then
      perform _rapid_cup_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
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
  perform _rapid_league_forfeit_expired_fixtures_internal();

  for v_row in
    select id as lobby_id, league_id from rapid_league_lobbies
    where status = 'live' and league_id is not null
  loop
    select bool_and(played)
    into v_all_played
    from fixtures
    where league_id = v_row.league_id and stage = 1;

    if coalesce(v_all_played, false) then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$$;
