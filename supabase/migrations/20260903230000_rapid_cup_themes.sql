-- Rapid Cup — per-cup themes (see src/rapidCupThemes.js).
--
-- Requested: every Rapid Cup should look and be named differently from
-- the last one, the same cycling-identity idea League Ladder already
-- uses per tier (src/ladderTierThemes.js). That needs a stable, ever-
-- increasing number per cup to cycle the theme list on — cup_number
-- below plays the exact role `tier` plays for the ladder.
--
-- A plain sequence (not `serial`/`generated always as identity`) so
-- backfilling existing rows and then catching the sequence up to the
-- real max is a straightforward two-step, rather than fighting an
-- identity column's stricter semantics.
create sequence if not exists rapid_cup_number_seq;

alter table rapid_cup_lobbies add column if not exists cup_number integer;

-- Backfill every existing lobby (including old completed/expired ones)
-- in creation order, so cup #1 really is the first cup that ever ran.
with numbered as (
  select id, row_number() over (order by created_at) as rn
  from rapid_cup_lobbies
  where cup_number is null
)
update rapid_cup_lobbies l set cup_number = n.rn
from numbered n
where n.id = l.id;

select setval(
  'rapid_cup_number_seq',
  coalesce((select max(cup_number) from rapid_cup_lobbies), 1),
  exists (select 1 from rapid_cup_lobbies)
);

alter table rapid_cup_lobbies alter column cup_number set default nextval('rapid_cup_number_seq');
alter table rapid_cup_lobbies alter column cup_number set not null;

-- Every place a lobby row gets created (join_rapid_cup_lobby's own-chain
-- insert, join_rapid_cup_lobby's very first "no open lobby, make one"
-- insert, expire_rapid_cup_lobbies' replacement insert) already just does
-- `insert into rapid_cup_lobbies default values` — the new column default
-- above covers every one of those call sites for free, no need to touch
-- those functions.

-- generate_rapid_cup_bracket — same logic as before, except the league's
-- name is now drawn from the lobby's already-assigned cup_number instead
-- of a plain "Rapid Cup — <timestamp>". Keep this CASE list in sync with
-- RAPID_CUP_THEMES in src/rapidCupThemes.js (same 6 names, same order,
-- same cycling-by-modulo rule) so the league name always matches the
-- theme the frontend actually renders for it.
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
  v_theme_name text;
begin
  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid Cup lobby % not found', p_lobby_id;
  end if;

  -- Already wired up (or not in a state to be) — return as-is, idempotent.
  if v_lobby.status <> 'filling' or v_lobby.league_id is not null then
    return v_lobby;
  end if;

  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '4 hours';

  v_theme_name := case ((coalesce(v_lobby.cup_number, 1) - 1) % 6)
    when 0 then 'Neon Blitz'
    when 1 then 'Inferno Rush'
    when 2 then 'Storm Surge'
    when 3 then 'Golden Strike'
    when 4 then 'Toxic Overdrive'
    else 'Midnight Duel'
  end;

  insert into leagues (name, format, knockout_legs, league_type, created_by_admin, starts_at)
  values ('⚡ ' || v_theme_name || ' — ' || to_char(v_now, 'DD Mon HH24:MI'), 'knockout', 1, 'fun', true, v_now)
  returning id into v_league_id;

  -- One team per lobby player, named/phoned from their profile — random
  -- order so seeding isn't predictable from join order.
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

  return v_lobby;
end;
$$;

grant execute on function generate_rapid_cup_bracket(uuid) to authenticated;
