-- New ladder players join the LAST ACTIVE tier league: the highest-numbered
-- league that actually has active members for the current (or a later) week.
-- Previously join_ladder_league picked the highest tier with status = 'active',
-- which included empty shells (e.g. an overflow league created by
-- _ensure_ladder_league_internal but never populated), so newcomers were seated
-- alone in an inactive league while lower-numbered leagues had free seats.
-- If that last populated league is already full (6), the existing
-- _rebalance_ladder_overflow_internal call below pushes the newest arrival to
-- tier + 1 as before.
create or replace function public.join_ladder_league()
returns ladder_memberships
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_league_id uuid;
  v_current_week integer;
  v_week_started boolean;
  v_target_week integer;
  v_row ladder_memberships%rowtype;
  v_roster_count integer;
  v_final_league_id uuid;
begin
  if v_user_id is null then
    raise exception 'join_ladder_league: must be signed in';
  end if;

  select current_week into v_current_week from ladder_cycle where id = true;
  v_current_week := coalesce(v_current_week, 0);

  -- Last active tier: highest tier that really has active members this week
  -- (or later). Empty shell leagues are skipped.
  select l.id into v_league_id
  from ladder_leagues l
  where l.status = 'active'
    and exists (
      select 1 from ladder_memberships m
      where m.league_id = l.id
        and m.status = 'active'
        and m.week_number >= v_current_week
    )
  order by l.tier desc
  limit 1;

  -- Fallback (nothing populated yet, e.g. brand-new ladder).
  if v_league_id is null then
    select id into v_league_id
    from ladder_leagues
    where status = 'active'
    order by tier asc
    limit 1;
  end if;

  if v_league_id is null then
    raise exception 'join_ladder_league: no League Ladder league is open for entry yet';
  end if;

  if v_current_week = 0 then
    v_target_week := 1;
  else
    select exists (
      select 1 from ladder_fixtures
      where league_id = v_league_id and week_number = v_current_week and status in ('played', 'forfeited')
    ) into v_week_started;

    v_target_week := case when v_week_started then v_current_week + 1 else v_current_week end;
  end if;

  if exists (
    select 1 from ladder_memberships
    where user_id = v_user_id and status = 'active' and week_number >= v_current_week
  ) then
    raise exception 'join_ladder_league: already on the ladder';
  end if;

  insert into ladder_memberships (user_id, league_id, week_number, status)
  values (v_user_id, v_league_id, v_target_week, 'active')
  returning * into v_row;

  select count(*) into v_roster_count
  from ladder_memberships
  where league_id = v_league_id and week_number = v_target_week and status = 'active';

  if v_roster_count >= 6 then
    perform _rebalance_ladder_overflow_internal(v_target_week);
  end if;

  select league_id into v_final_league_id
  from ladder_memberships
  where user_id = v_user_id and week_number = v_target_week and status = 'active';

  perform _ladder_sync_fixtures_internal(v_final_league_id, v_target_week);

  return v_row;
end;
$function$;
