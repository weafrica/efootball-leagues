-- Keep every League Ladder tier full (6) from the top down and retire empty
-- tail leagues. Dormant players are NOT demoted.
--
-- 1. _ladder_compact_tiers_internal(week): packs the week's active members
--    into contiguous tiers of 6, ordered by (current tier, last week's
--    points, goal difference). A seat vacated anywhere is filled from below,
--    cascading all the way down; only the last tier can hold a remainder.
-- 2. _ladder_archive_empty_tail_leagues_internal(week): leagues numbered
--    above the last populated tier are set to 'archived' so they stop
--    counting as the ladder's max tier (which decides the free-entry tier).
-- 3. _ensure_ladder_league_internal now reactivates an archived tier when
--    something needs it again (overflow, promotion, relegation).
-- 4. _ladder_open_week_internal runs 1 and 2 after the existing overflow /
--    understaffed rebalances and before fixtures are generated.

create or replace function public._ensure_ladder_league_internal(p_tier integer)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_status text;
begin
  select id, status into v_id, v_status from ladder_leagues where tier = p_tier;
  if v_id is null then
    insert into ladder_leagues (tier, status)
    values (p_tier, 'active')
    returning id into v_id;
  elsif v_status <> 'active' then
    update ladder_leagues set status = 'active' where id = v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function public._ladder_compact_tiers_internal(p_week_number integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row record;
  v_league_id uuid;
  v_moved integer := 0;
begin
  for v_row in
    with prev_results as (
      select home_user_id as uid,
             case when home_score > away_score then 3 when home_score = away_score then 1 else 0 end as pts,
             home_score - away_score as gd
      from ladder_fixtures
      where week_number = p_week_number - 1 and status = 'played'
      union all
      select away_user_id,
             case when away_score > home_score then 3 when away_score = home_score then 1 else 0 end,
             away_score - home_score
      from ladder_fixtures
      where week_number = p_week_number - 1 and status = 'played'
    ),
    prev as (
      select uid, sum(pts) as pts, sum(gd) as gd from prev_results group by uid
    ),
    cur as (
      select m.id, m.user_id, m.league_id, l.tier
      from ladder_memberships m
      join ladder_leagues l on l.id = m.league_id
      where m.week_number = p_week_number and m.status = 'active'
    ),
    ranked as (
      select c.*,
             row_number() over (
               order by c.tier, coalesce(p.pts, 0) desc, coalesce(p.gd, 0) desc, c.user_id
             ) as rn
      from cur c
      left join prev p on p.uid = c.user_id
    )
    select id, user_id, league_id, tier, ((rn - 1) / 6) + 1 as new_tier
    from ranked
    where ((rn - 1) / 6) + 1 <> tier
  loop
    v_league_id := _ensure_ladder_league_internal(v_row.new_tier);
    update ladder_memberships set league_id = v_league_id where id = v_row.id;
    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end;
$function$;

create or replace function public._ladder_archive_empty_tail_leagues_internal(p_week_number integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_last_tier integer;
  v_archived integer;
begin
  select max(l.tier) into v_last_tier
  from ladder_leagues l
  join ladder_memberships m on m.league_id = l.id
  where m.week_number >= p_week_number and m.status = 'active' and l.status = 'active';

  if v_last_tier is null then
    return 0; -- nobody seated yet: never archive anything
  end if;

  update ladder_leagues l
  set status = 'archived'
  where l.status = 'active'
    and l.tier > v_last_tier
    and not exists (
      select 1 from ladder_memberships m
      where m.league_id = l.id and m.week_number >= p_week_number and m.status = 'active'
    );
  get diagnostics v_archived = row_count;
  return v_archived;
end;
$function$;

create or replace function public._ladder_open_week_internal()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_prev_week integer;
  v_new_week integer;
  v_bidding_open boolean;
  v_league record;
begin
  select current_week, bidding_open into v_prev_week, v_bidding_open
  from ladder_cycle where id = true for update;
  if v_bidding_open then
    raise exception '_ladder_open_week_internal: week % is still open — close it before opening a new one', v_prev_week;
  end if;
  v_new_week := v_prev_week + 1;
  if v_prev_week > 0 then
    for v_league in select id from ladder_leagues where status = 'active' loop
      insert into ladder_memberships (user_id, league_id, week_number, status)
      select user_id, v_league.id, v_new_week, 'active'
      from ladder_memberships
      where league_id = v_league.id and week_number = v_prev_week and status = 'active'
      on conflict (user_id, week_number) do nothing;
    end loop;
  end if;

  perform _rebalance_ladder_overflow_internal(v_new_week);

  -- Fixed timing: run understaffed-tier top-up here, once this week's
  -- memberships actually exist, and before fixtures are generated from them.
  perform _ladder_rebalance_understaffed_leagues_internal(v_new_week);

  -- Full cascade: fill any remaining gap from below so every tier is at 6
  -- (last tier holds the remainder), then archive empty tail leagues.
  perform _ladder_compact_tiers_internal(v_new_week);
  perform _ladder_archive_empty_tail_leagues_internal(v_new_week);

  for v_league in select id from ladder_leagues where status = 'active' loop
    perform _ladder_sync_fixtures_internal(v_league.id, v_new_week);
  end loop;
  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$function$;
