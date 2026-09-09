-- Schema-drift fix: these seven public_* views exist on the live project
-- but were never captured in a migration (see supabase/BASELINE-INVENTORY.md,
-- which flags "views and materialized views ... not diffed against
-- production"). Because supabase/migrations is replayed from scratch
-- against a clean database in CI, db-tests never had these views to begin
-- with, which is why 20260913_league_home_summary_matview.sql fails there
-- with "relation ... does not exist" despite working fine on prod.
--
-- Definitions below are pulled verbatim (via pg_get_viewdef) from the live
-- weafrica Leagues project, so this migration is a no-op there (CREATE OR
-- REPLACE VIEW with identical output) and brings CI's fresh database in
-- line with what prod already has.
--
-- Grants here are SELECT-only, matching what these guest-facing views are
-- actually for. (Prod currently also grants anon/authenticated far more —
-- DELETE/INSERT/UPDATE/TRUNCATE/REFERENCES — which looks like accidental
-- over-grant, not intent; that's tracked separately and not replicated
-- here.)

create or replace view public_leagues as
select
  id,
  name,
  format,
  current_stage,
  final_stage_started,
  group_stage_due_at,
  starts_at,
  survivor_elimination_percent,
  survivor_target_count,
  groups_count,
  group_qualifiers
from leagues
where is_platform_admin(created_by);

create or replace view public_league_teams as
select
  t.id,
  t.league_id,
  t.name,
  t.eliminated,
  t.group_number
from teams t
join leagues l on l.id = t.league_id
where is_platform_admin(l.created_by);

create or replace view public_league_fixtures as
select
  f.id,
  f.league_id,
  f.round,
  f.stage,
  f.home_team_id,
  f.away_team_id,
  f.played,
  f.home_score,
  f.away_score,
  f.due_at
from fixtures f
join leagues l on l.id = f.league_id
where is_platform_admin(l.created_by);

create or replace view public_league_extra as
select
  id as league_id,
  description,
  photo_url,
  league_type
from leagues;

create or replace view public_ladder_full as
select
  user_id,
  username,
  rank_position,
  wins,
  losses,
  points
from ladder_ranks
order by rank_position;

create or replace view public_challenge_results as
select
  challenges.id,
  'challenge'::text as kind,
  challenges.challenger_id as player_one_id,
  challenges.challenger_username as player_one,
  challenges.opponent_id as player_two_id,
  challenges.opponent_username as player_two,
  challenges.challenger_score as score_one,
  challenges.opponent_score as score_two,
  coalesce(challenges.result_confirmed_at, challenges.result_reported_at) as result_confirmed_at,
  challenges.result_status = 'confirmed'::text as confirmed
from challenges
where challenges.result_status = any (array['pending'::text, 'confirmed'::text])
union all
select
  open_challenges.id,
  'open'::text as kind,
  open_challenges.creator_id as player_one_id,
  open_challenges.creator_username as player_one,
  open_challenges.accepted_by as player_two_id,
  open_challenges.accepted_by_username as player_two,
  open_challenges.creator_score as score_one,
  open_challenges.accepted_by_score as score_two,
  coalesce(open_challenges.result_confirmed_at, open_challenges.result_reported_at) as result_confirmed_at,
  open_challenges.result_status = 'confirmed'::text as confirmed
from open_challenges
where open_challenges.result_status = any (array['pending'::text, 'confirmed'::text]);

create or replace view public_team_avatars as
select
  m.team_id,
  p.avatar_url
from members m
join profiles p on p.user_id = m.user_id
where m.team_id is not null and p.avatar_url is not null;

grant select on
  public_leagues,
  public_league_teams,
  public_league_fixtures,
  public_league_extra,
  public_ladder_full,
  public_challenge_results,
  public_team_avatars
to anon, authenticated;
