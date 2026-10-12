-- Captures database changes that were applied straight to the live project
-- (jobgzxljuczzqljwavyq) from chat sessions but never saved as migration
-- files, so a fresh replay of this folder matches what is actually live.
-- Every statement here is idempotent (create or replace / if not exists),
-- so it is safe to run again on the live project.
--
-- Contents, in order:
--   1. start_league_by_member           (live as "member_start_league")
--   2. league deletion audit trail      (live as "league_deletion_audit_trail")
--   3. Rapid League result auto-sweep naming the opponent
--   4. Rapid Cup result auto-sweep naming the opponent
--   5. join_ladder is free              (live as "ladder_battles_join_free")
--   6. Rapid League sweep with scaled auto-finish deadline
--      (re-asserts 20260921120000_rapid_league_scaled_auto_finish.sql — that
--       file sorts BEFORE 20260947_rapid_league_scaled_window_no_autoclose.sql,
--       which redefines the same sweep with no deadline, so a fresh replay
--       ended up with the opposite of what is live. This file sorts last.)

-- ---------------------------------------------------------------------------
-- 1. Let any joined member start a league and generate its opening fixtures.
-- ---------------------------------------------------------------------------
create or replace function public.start_league_by_member(
  p_league_id uuid,
  p_fixtures jsonb,
  p_group_assignments jsonb default null,
  p_groups_count int default null,
  p_group_stage_due_at timestamptz default null,
  p_final_stage_started boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_league leagues%rowtype;
  v_row jsonb;
begin
  if auth.uid() is null then
    raise exception 'start_league_by_member: must be signed in';
  end if;

  select * into v_league from leagues where id = p_league_id for update;
  if v_league.id is null then
    raise exception 'League not found';
  end if;

  if v_league.created_by <> auth.uid()
     and not exists (select 1 from admins where user_id = auth.uid())
     and not is_member_of_league(p_league_id, auth.uid()) then
    raise exception 'Not authorized to start this league';
  end if;

  if exists (select 1 from fixtures where league_id = p_league_id) then
    raise exception 'This league has already started';
  end if;

  for v_row in select * from jsonb_array_elements(p_fixtures)
  loop
    insert into fixtures (
      league_id, round, home_team_id, away_team_id, stage, due_at, leg,
      starts_at, played, home_score, away_score
    )
    values (
      p_league_id,
      (v_row->>'round')::int,
      nullif(v_row->>'home_team_id','')::uuid,
      nullif(v_row->>'away_team_id','')::uuid,
      coalesce((v_row->>'stage')::int, 1),
      nullif(v_row->>'due_at','')::timestamptz,
      coalesce((v_row->>'leg')::int, 1),
      nullif(v_row->>'starts_at','')::timestamptz,
      coalesce((v_row->>'played')::boolean, false),
      coalesce((v_row->>'home_score')::int, 0),
      coalesce((v_row->>'away_score')::int, 0)
    );
  end loop;

  if p_group_assignments is not null then
    for v_row in select * from jsonb_array_elements(p_group_assignments)
    loop
      -- league_id check keeps this from ever touching a team outside the
      -- league being started, even if the client somehow sent a bad id.
      update teams set group_number = (v_row->>'group_number')::int
      where id = (v_row->>'team_id')::uuid and league_id = p_league_id;
    end loop;

    update leagues set
      groups_count = coalesce(p_groups_count, groups_count),
      group_stage_due_at = coalesce(p_group_stage_due_at, group_stage_due_at)
    where id = p_league_id;
  end if;

  if p_final_stage_started then
    update leagues set final_stage_started = true where id = p_league_id;
  end if;
end;
$function$;

revoke all on function public.start_league_by_member(uuid, jsonb, jsonb, int, timestamptz, boolean) from public;
grant execute on function public.start_league_by_member(uuid, jsonb, jsonb, int, timestamptz, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Record every league deletion (who, when, what it contained).
-- ---------------------------------------------------------------------------
create table if not exists public.deleted_leagues_audit (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null,
  league_name text,
  league_row jsonb not null,
  member_count integer not null default 0,
  team_count integer not null default 0,
  fixture_count integer not null default 0,
  deleted_by uuid,
  deleted_at timestamptz not null default now()
);

alter table public.deleted_leagues_audit enable row level security;

drop policy if exists "Admins can read the deletion audit trail" on public.deleted_leagues_audit;
create policy "Admins can read the deletion audit trail"
  on public.deleted_leagues_audit for select
  using (exists (select 1 from public.admins where user_id = auth.uid()));

create or replace function public._log_league_deletion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into public.deleted_leagues_audit (league_id, league_name, league_row, member_count, team_count, fixture_count, deleted_by)
  values (
    old.id,
    old.name,
    to_jsonb(old),
    (select count(*) from members where league_id = old.id),
    (select count(*) from teams where league_id = old.id),
    (select count(*) from fixtures where league_id = old.id),
    auth.uid()
  );
  return old;
end;
$function$;

drop trigger if exists log_league_deletion on public.leagues;
create trigger log_league_deletion
  before delete on public.leagues
  for each row execute function public._log_league_deletion();

-- ---------------------------------------------------------------------------
-- 3. Rapid League: auto-accepted results name the opponent.
-- ---------------------------------------------------------------------------
create or replace function public._rapid_league_result_auto_sweep_internal()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sub result_submissions%rowtype;
  v_fixture fixtures%rowtype;
  v_count integer := 0;
  home_name text;
  away_name text;
  pens_suffix text;
  v_submitter_team_id uuid;
  v_opponent_team_id uuid;
  v_opponent_name text;
begin
  for v_sub in
    select s.*
    from result_submissions s
    join rapid_league_lobbies rll on rll.league_id = s.league_id
    where s.status = 'pending'
      and rll.status = 'live'
      and s.created_at + interval '2 minutes' + interval '2 minutes' <= now()
    order by s.created_at
    for update of s skip locked
  loop
    select * into v_fixture from fixtures where id = v_sub.fixture_id for update;
    if not found then
      continue;
    end if;

    if v_fixture.played then
      update result_submissions set status = 'rejected' where id = v_sub.id;
      continue;
    end if;

    if v_sub.home_score is null or v_sub.away_score is null then
      continue;
    end if;
    if v_sub.home_score < 0 or v_sub.away_score < 0
       or (v_sub.pens_home is not null and v_sub.pens_home < 0)
       or (v_sub.pens_away is not null and v_sub.pens_away < 0)
       or (v_sub.pens_home is not null and v_sub.pens_away is not null and v_sub.pens_home = v_sub.pens_away) then
      continue;
    end if;

    update fixtures set
      played = true,
      home_score = v_sub.home_score,
      away_score = v_sub.away_score,
      pens_home = v_sub.pens_home,
      pens_away = v_sub.pens_away,
      played_at = now()
    where id = v_fixture.id
    returning
      (select t.name from teams t where t.id = fixtures.home_team_id),
      (select t.name from teams t where t.id = fixtures.away_team_id)
    into home_name, away_name;

    select m.team_id into v_submitter_team_id
    from members m where m.league_id = v_sub.league_id and m.user_id = v_sub.submitted_by
    limit 1;
    v_opponent_team_id := case
      when v_submitter_team_id = v_fixture.home_team_id then v_fixture.away_team_id
      else v_fixture.home_team_id
    end;
    select m.display_name into v_opponent_name
    from members m where m.league_id = v_sub.league_id and m.team_id = v_opponent_team_id
    limit 1;

    pens_suffix := '';
    if v_sub.pens_home is not null and v_sub.pens_away is not null then
      pens_suffix := format(' (pens %s–%s)', v_sub.pens_home, v_sub.pens_away);
    end if;

    insert into comments (league_id, user_id, username, body)
    values (
      v_sub.league_id, v_sub.submitted_by, v_sub.submitted_by_username,
      format('⚽ Result posted: %s %s – %s %s%s (%s didn''t respond in time — result stands)',
        coalesce(home_name, 'Home'), v_sub.home_score, v_sub.away_score, coalesce(away_name, 'Away'), pens_suffix,
        coalesce(v_opponent_name, 'opponent'))
    );

    update result_submissions set status = 'approved' where id = v_sub.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Rapid Cup: same wording fix.
-- ---------------------------------------------------------------------------
create or replace function public._rapid_cup_result_auto_sweep_internal()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sub result_submissions%rowtype;
  v_fixture fixtures%rowtype;
  v_count integer := 0;
  home_name text;
  away_name text;
  pens_suffix text;
  v_submitter_team_id uuid;
  v_opponent_team_id uuid;
  v_opponent_name text;
begin
  for v_sub in
    select s.*
    from result_submissions s
    join rapid_cup_lobbies rcl on rcl.league_id = s.league_id
    where s.status = 'pending'
      and rcl.status = 'live'
      and s.created_at + interval '2 minutes' + interval '2 minutes' <= now()
    order by s.created_at
    for update of s skip locked
  loop
    select * into v_fixture from fixtures where id = v_sub.fixture_id for update;
    if not found then
      continue;
    end if;

    if v_fixture.played then
      update result_submissions set status = 'rejected' where id = v_sub.id;
      continue;
    end if;

    if v_sub.home_score is null or v_sub.away_score is null then
      continue;
    end if;
    if v_sub.home_score < 0 or v_sub.away_score < 0
       or (v_sub.pens_home is not null and v_sub.pens_home < 0)
       or (v_sub.pens_away is not null and v_sub.pens_away < 0)
       or (v_sub.pens_home is not null and v_sub.pens_away is not null and v_sub.pens_home = v_sub.pens_away) then
      continue;
    end if;

    update fixtures set
      played = true,
      home_score = v_sub.home_score,
      away_score = v_sub.away_score,
      pens_home = v_sub.pens_home,
      pens_away = v_sub.pens_away,
      played_at = now()
    where id = v_fixture.id
    returning
      (select t.name from teams t where t.id = fixtures.home_team_id),
      (select t.name from teams t where t.id = fixtures.away_team_id)
    into home_name, away_name;

    select m.team_id into v_submitter_team_id
    from members m where m.league_id = v_sub.league_id and m.user_id = v_sub.submitted_by
    limit 1;
    v_opponent_team_id := case
      when v_submitter_team_id = v_fixture.home_team_id then v_fixture.away_team_id
      else v_fixture.home_team_id
    end;
    select m.display_name into v_opponent_name
    from members m where m.league_id = v_sub.league_id and m.team_id = v_opponent_team_id
    limit 1;

    pens_suffix := '';
    if v_sub.pens_home is not null and v_sub.pens_away is not null then
      pens_suffix := format(' (pens %s–%s)', v_sub.pens_home, v_sub.pens_away);
    end if;

    insert into comments (league_id, user_id, username, body)
    values (
      v_sub.league_id, v_sub.submitted_by, v_sub.submitted_by_username,
      format('⚽ Result posted: %s %s – %s %s%s (%s didn''t respond in time — result stands)',
        coalesce(home_name, 'Home'), v_sub.home_score, v_sub.away_score, coalesce(away_name, 'Away'), pens_suffix,
        coalesce(v_opponent_name, 'opponent'))
    );

    update result_submissions set status = 'approved' where id = v_sub.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Ladder Battles: joining is free (the 5 Nets fee is gone).
-- ---------------------------------------------------------------------------
create or replace function public.join_ladder()
 returns ladder_ranks
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_username text;
  v_avatar_url text;
  v_row ladder_ranks%rowtype;
begin
  if v_user_id is null then
    raise exception 'join_ladder: must be signed in';
  end if;

  if exists (select 1 from ladder_ranks where user_id = v_user_id) then
    raise exception 'join_ladder: already on the ladder';
  end if;

  select efootball_username, avatar_url into v_username, v_avatar_url
  from profiles where user_id = v_user_id;

  if v_username is null then
    raise exception 'join_ladder: complete your profile before joining the ladder';
  end if;

  insert into ladder_ranks (user_id, username, avatar_url, rank_position)
  values (v_user_id, v_username, v_avatar_url, -floor(extract(epoch from clock_timestamp()) * 1000)::integer)
  returning * into v_row;

  update ladder_ranks set rank_position = rank_position + 1000000;

  with ranked as (
    select user_id,
           row_number() over (order by points desc, wins desc, created_at asc) as new_rank
    from ladder_ranks
  )
  update ladder_ranks lr
  set rank_position = ranked.new_rank
  from ranked
  where lr.user_id = ranked.user_id;

  select * into v_row from ladder_ranks where user_id = v_user_id;
  return v_row;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Rapid League sweep: finish when every match is played, OR when the
--    scaled deadline passes (club_count / 2 days: 4 -> 2, 8 -> 4, 16 -> 8).
-- ---------------------------------------------------------------------------
create or replace function public._rapid_league_sweep_internal()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row record;
  v_all_played boolean;
  v_deadline_passed boolean;
begin
  for v_row in
    select id as lobby_id, league_id, started_at, created_at, club_count
    from rapid_league_lobbies
    where status = 'live' and league_id is not null
  loop
    select bool_and(played)
    into v_all_played
    from fixtures
    where league_id = v_row.league_id and stage = 1;

    if coalesce(v_all_played, false) then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
      continue;
    end if;

    -- club_count halved gives the day count directly (4->2, 8->4, 16->8);
    -- coalesce covers any lobby somehow missing club_count, falling back
    -- to the 4-player default's 2-day window.
    v_deadline_passed := coalesce(v_row.started_at, v_row.created_at)
      + make_interval(days => coalesce(v_row.club_count, 4) / 2) <= now();

    if v_deadline_passed then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$function$;
