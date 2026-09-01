-- Overflow used to always exile the newest arrival to a brand new
-- league at the very bottom of the whole ladder (max_tier + 1) — meant
-- for new joiners piling up in the entry league, but this ran on every
-- league every week, so relegated players sometimes got sent 10+ tiers
-- too far. Fix: push the extra person only one tier below the league
-- they're already in (creating that tier if needed). For the entry
-- league this is unchanged (it IS the bottom tier already). Loops in
-- case pushing one league down causes that tier to overflow too.
--
-- CONFIRMED VIA LIVE DIAGNOSTICS: 4 relegated players in week 2 were
-- found sitting in tiers 14-17 instead of one tier below where they
-- were relegated from (e.g. relegated from tier 1, landed in tier 17
-- instead of tier 2). Those 4 rows were corrected by hand as part of
-- deploying this fix; this migration only prevents recurrence.
create or replace function _rebalance_ladder_overflow_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overflow_league record;
  v_overflow_ids uuid[];
  v_new_league_id uuid;
  v_split_happened boolean := false;
  v_any_overflow boolean;
  v_guard integer := 0;
begin
  loop
    v_guard := v_guard + 1;
    exit when v_guard > 50; -- safety cap against runaway cascades

    v_any_overflow := false;

    for v_overflow_league in
      select m.league_id, l.tier as tier, count(*) as cnt
      from ladder_memberships m
      join ladder_leagues l on l.id = m.league_id
      where m.week_number = p_week_number
      group by m.league_id, l.tier
      having count(*) > 6
    loop
      v_any_overflow := true;

      select array_agg(user_id) into v_overflow_ids
      from (
        select user_id
        from ladder_memberships
        where league_id = v_overflow_league.league_id and week_number = p_week_number
        order by joined_at desc
        limit (v_overflow_league.cnt - 6)
      ) newest_arrivals;

      if v_overflow_ids is not null and array_length(v_overflow_ids, 1) > 0 then
        v_new_league_id := _ensure_ladder_league_internal(v_overflow_league.tier + 1);
        update ladder_memberships
        set league_id = v_new_league_id
        where league_id = v_overflow_league.league_id
          and week_number = p_week_number
          and user_id = any(v_overflow_ids);

        perform _ladder_sync_fixtures_internal(v_new_league_id, p_week_number);
        perform _ladder_sync_fixtures_internal(v_overflow_league.league_id, p_week_number);
        v_split_happened := true;
      end if;
    end loop;

    exit when not v_any_overflow;
  end loop;

  if v_split_happened then
    perform _ladder_retroactive_topup_internal(p_week_number);
  end if;
end;
$$;
