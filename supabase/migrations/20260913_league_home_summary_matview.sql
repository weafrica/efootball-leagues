-- Step 5 of the egress plan — precompute the flat payload guest-data.js
-- currently builds by hitting 8 views live on every cache-refill.
--
-- This does NOT change how often Postgres is hit from the internet (that's
-- still bounded by CACHE_SECONDS in api/guest-data.js, unchanged here) — it
-- changes what that one hourly hit costs once it happens: one row read
-- instead of 8 separate queries (aggregating public_leagues,
-- public_league_teams, public_league_fixtures, public_league_extra,
-- public_ladder_full, public_challenge_results, public_team_avatars,
-- app_settings) run against PostgREST every time. Bytes-over-the-wire from
-- guest traffic don't move; DB-side query/CPU cost per refill does.
--
-- league_home_summary is a single-row materialized view holding the exact
-- same shape guest-data.js's handler already assembles by hand (leagues,
-- teams, fixtures, extras, ladder, results, avatarByTeamId,
-- weekendOverride) as one jsonb payload column, refreshed hourly by
-- pg_cron on the same cadence as CACHE_SECONDS. guest-data.js becomes a
-- single `select payload from league_home_summary` instead of a
-- Promise.all of 8 queries.
--
-- No new data exposure: every column here is already selected straight
-- from these same views by the anon-keyed client in api/guest-data.js
-- today, just re-shaped into one row instead of 8 result sets.
--
-- Safe to run more than once.

create materialized view if not exists league_home_summary as
select
  1 as id,
  jsonb_build_object(
    'leagues', coalesce((
      select jsonb_agg(to_jsonb(l))
      from (
        select id, name, format, starts_at, group_stage_due_at, current_stage,
               final_stage_started, survivor_elimination_percent,
               survivor_target_count, groups_count, group_qualifiers
        from public_leagues
      ) l
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(to_jsonb(t))
      from (
        select id, name, eliminated, league_id, group_number
        from public_league_teams
      ) t
    ), '[]'::jsonb),
    'fixtures', coalesce((
      select jsonb_agg(to_jsonb(f))
      from (
        select id, league_id, home_team_id, away_team_id, home_score,
               away_score, played, stage, due_at
        from public_league_fixtures
      ) f
    ), '[]'::jsonb),
    'extras', coalesce((
      select jsonb_agg(to_jsonb(e))
      from (
        select league_id, photo_url, league_type
        from public_league_extra
      ) e
    ), '[]'::jsonb),
    'ladder', coalesce((
      select jsonb_agg(to_jsonb(r))
      from (
        select user_id, username, points, wins, losses
        from public_ladder_full
        order by rank_position asc
      ) r
    ), '[]'::jsonb),
    'results', coalesce((
      select jsonb_agg(to_jsonb(c))
      from (
        select kind, player_one, player_two, player_one_id, player_two_id,
               score_one, score_two, confirmed, result_confirmed_at
        from public_challenge_results
        order by result_confirmed_at desc
        limit 50
      ) c
    ), '[]'::jsonb),
    -- Built the same way guest-data.js's JS loop built it (team_id ->
    -- avatar_url, skipping nulls) — just done once in SQL instead of once
    -- per cache refill in the handler.
    'avatarByTeamId', coalesce((
      select jsonb_object_agg(team_id::text, avatar_url)
      from public_team_avatars
      where avatar_url is not null
    ), '{}'::jsonb),
    'weekendOverride', (
      select weekend_league_override
      from app_settings
      where id = 1
    )
  ) as payload,
  now() as refreshed_at
with data;

-- REFRESH ... CONCURRENTLY needs a unique index to swap rows in place
-- instead of taking an exclusive lock that would block guest-data.js's
-- read for however long the rebuild takes.
create unique index if not exists league_home_summary_id_idx
  on league_home_summary (id);

-- PostgREST exposes materialized views like tables; the anon key is what
-- api/guest-data.js authenticates with, same as it does against the 8
-- source views today.
grant select on league_home_summary to anon, authenticated;

-- Wrapper so pg_cron has a single, stable call target and so a manual
-- refresh (e.g. from the SQL editor, or a future admin action) doesn't
-- need to remember the CONCURRENTLY keyword or the view name.
create or replace function refresh_league_home_summary()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently league_home_summary;
end;
$$;

-- Supabase projects have pg_cron available but not always enabled by
-- default; `create extension if not exists` is a no-op once it's already
-- on. If this statement errors with a permissions issue on your project,
-- enable pg_cron once from the Supabase dashboard (Database → Extensions)
-- and re-run just this migration file.
create extension if not exists pg_cron with schema extensions;

-- Top of every hour — matches CACHE_SECONDS (3600s) in api/guest-data.js.
-- Wall-clock top-of-hour vs. the CDN's relative refill window means the
-- two can drift by up to a few minutes of overlap; harmless at this data
-- freshness bar. cron.schedule upserts by job name, so re-running this
-- migration updates the existing job in place rather than creating
-- duplicates.
select cron.schedule(
  'refresh-league-home-summary-hourly',
  '0 * * * *',
  $$select refresh_league_home_summary();$$
);
