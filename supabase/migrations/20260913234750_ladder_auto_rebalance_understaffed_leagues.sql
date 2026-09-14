-- Recreated from the live database: this migration was originally applied
-- directly to production (via the Supabase SQL editor / MCP) and was never
-- committed to this repo, which is why a clean CI rebuild fails when a
-- later migration (20260914120000_ladder_rebalance_understaffed_wiring_fix)
-- calls this function before anything in the repo's migration history has
-- created it.
--
-- Timestamp matches what's already recorded in the live project's
-- migration history table, so this file lines up with production rather
-- than appearing as a new/duplicate migration to apply.

CREATE OR REPLACE FUNCTION public._ladder_rebalance_understaffed_leagues_internal(p_week_number integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_min_tier integer;
  v_max_tier integer;
  v_tier integer;
  v_league_id uuid;
  v_below_league_id uuid;
  v_cnt integer;
  v_need integer;
  v_pull_ids uuid[];
begin
  select min(l.tier), max(l.tier) into v_min_tier, v_max_tier
  from ladder_leagues l
  join ladder_memberships m
    on m.league_id = l.id and m.week_number = p_week_number and m.status = 'active'
  where l.status = 'active';

  if v_min_tier is null then
    return; -- nothing scheduled for this week yet
  end if;

  v_tier := v_min_tier;
  while v_tier < v_max_tier loop
    select id into v_league_id from ladder_leagues where tier = v_tier and status = 'active';
    select id into v_below_league_id from ladder_leagues where tier = v_tier + 1 and status = 'active';

    if v_league_id is not null and v_below_league_id is not null then
      select count(*) into v_cnt
      from ladder_memberships
      where league_id = v_league_id and week_number = p_week_number and status = 'active';

      v_need := 6 - v_cnt;

      if v_need > 0 then
        select array_agg(user_id) into v_pull_ids
        from (
          select user_id
          from ladder_memberships
          where league_id = v_below_league_id and week_number = p_week_number and status = 'active'
          order by joined_at asc
          limit v_need
        ) longest_tenured_below;

        if v_pull_ids is not null and array_length(v_pull_ids, 1) > 0 then
          update ladder_memberships
          set league_id = v_league_id
          where league_id = v_below_league_id
            and week_number = p_week_number
            and user_id = any(v_pull_ids);

          perform _ladder_sync_fixtures_internal(v_league_id, p_week_number);
          perform _ladder_sync_fixtures_internal(v_below_league_id, p_week_number);
        end if;
      end if;
    end if;

    v_tier := v_tier + 1;
  end loop;
end;
$function$;
