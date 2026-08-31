-- League Ladder — make the Sunday resolve step (and, via computeStandings,
-- the live client table) honor a corrected forfeited fixture's real score
-- instead of always hardcoding the flat 4-0 double-forfeit outcome.
--
-- Context: 20260904 let admins call correct_ladder_fixture_result on a
-- 'forfeited' fixture, which writes real numbers into its home_score/
-- away_score (previously always null — see 20260862's forfeit sweep). But
-- this function's standings subquery, same as leagueLadder.js's
-- computeStandings, was written before that was possible and unconditionally
-- ignores home_score/away_score for any 'forfeited' row, ga always 4/gf
-- always 0. Without this fix, an admin's correction changes what's stored
-- but has zero effect on promotion/relegation — a silently broken feature.
--
-- Fix: only fall back to the flat 4-0 both-lose outcome when a forfeited
-- fixture's scores are still null (the untouched auto-forfeit case); once
-- an admin has attached real numbers, score it exactly like a played
-- fixture. Status stays 'forfeited' either way — this only changes what
-- standings/promotion see, not economy.js's Match Reward/streak exclusion,
-- which keys off status alone and is untouched by this migration.
--
-- Safe to run more than once.

create or replace function _ladder_resolve_promotion_relegation_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week integer;
  v_next_week integer;
  v_league record;
  v_standings uuid[];
  v_n integer;
  v_promoted uuid;
  v_relegated uuid[];
  v_remaining_start integer;
  v_remaining_count integer;
  v_relegate_count integer;
  v_target_league_id uuid;
begin
  select current_week into v_week from ladder_cycle where id = true;
  if v_week is null or v_week = 0 then
    return; -- nothing opened yet, nothing to resolve
  end if;
  v_next_week := v_week + 1;

  for v_league in select id, tier from ladder_leagues where status = 'active' order by tier loop
    select array_agg(s.user_id order by (s.played > 0) desc, s.pts desc, s.gd desc, s.gf desc, s.user_id asc)
    into v_standings
    from (
      select m.user_id,
             sum(m.pts) as pts,
             sum(m.played) as played,
             sum(m.gf) as gf,
             sum(m.gf) - sum(m.ga) as gd
      from (
        select home_user_id as user_id,
               case when status = 'played' and home_score > away_score then 3
                    when status = 'forfeited' and home_score is not null and away_score is not null and home_score > away_score then 3
                    when status = 'played' and home_score = away_score then 1
                    when status = 'forfeited' and home_score is not null and away_score is not null and home_score = away_score then 1
                    else 0 end as pts,
               case when status in ('played', 'forfeited') then 1 else 0 end as played,
               case when status = 'played' then home_score
                    when status = 'forfeited' and home_score is not null then home_score
                    else 0 end as gf,
               case when status = 'played' then away_score
                    when status = 'forfeited' and away_score is not null then away_score
                    when status = 'forfeited' then 4
                    else 0 end as ga
        from ladder_fixtures
        where league_id = v_league.id and week_number = v_week
        union all
        select away_user_id,
               case when status = 'played' and away_score > home_score then 3
                    when status = 'forfeited' and home_score is not null and away_score is not null and away_score > home_score then 3
                    when status = 'played' and away_score = home_score then 1
                    when status = 'forfeited' and home_score is not null and away_score is not null and away_score = home_score then 1
                    else 0 end,
               case when status in ('played', 'forfeited') then 1 else 0 end,
               case when status = 'played' then away_score
                    when status = 'forfeited' and away_score is not null then away_score
                    else 0 end,
               case when status = 'played' then home_score
                    when status = 'forfeited' and home_score is not null then home_score
                    when status = 'forfeited' then 4
                    else 0 end
        from ladder_fixtures
        where league_id = v_league.id and week_number = v_week
      ) m
      group by m.user_id
    ) s;

    v_n := coalesce(array_length(v_standings, 1), 0);
    if v_n = 0 then
      continue; -- no fixtures this week for this league — nothing to resolve
    end if;

    -- Promotion: rank 1 only, and only if this isn't League 1 (tier 1 has
    -- nowhere higher to go) — mirrors leagueLadder.js's resolveLadderWeek.
    if v_league.tier > 1 then
      v_promoted := v_standings[1];
    else
      v_promoted := null;
    end if;

    -- Relegation: bottom 2 of whoever's left after the promoted player is
    -- removed, capped at what's actually available. Same degenerate-roster
    -- handling as the JS version — see its header and unit tests for the
    -- exact behavior at each roster size.
    v_remaining_start := case when v_promoted is null then 1 else 2 end;
    v_remaining_count := v_n - (v_remaining_start - 1);
    v_relegate_count := least(2, v_remaining_count);

    if v_relegate_count > 0 then
      v_relegated := v_standings[(v_n - v_relegate_count + 1) : v_n];
    else
      v_relegated := array[]::uuid[];
    end if;

    -- Mark this week's outcome on the CLOSING week's own rows — describes
    -- what happened to this row's player that week, per ladder_memberships'
    -- own convention (see its migration). Stayers are left at their
    -- existing 'active' status, no update needed.
    if v_promoted is not null then
      update ladder_memberships set status = 'promoted'
      where user_id = v_promoted and league_id = v_league.id and week_number = v_week;
    end if;
    if array_length(v_relegated, 1) > 0 then
      update ladder_memberships set status = 'relegated'
      where user_id = any(v_relegated) and league_id = v_league.id and week_number = v_week;
    end if;

    -- Write the promoted player's arrival into tier-1 for next week.
    -- Idempotency guard (on conflict do nothing) in case this job is ever
    -- re-run for a week it already resolved — same "safe to run more than
    -- once" standard as every other migration/job in this file.
    --
    -- Relegated players deliberately get NO next-week row here at all —
    -- see 20260859's own header for why (Phase 5's territory).
    if v_promoted is not null then
      v_target_league_id := _ensure_ladder_league_internal(v_league.tier - 1);
      insert into ladder_memberships (user_id, league_id, week_number, status)
      values (v_promoted, v_target_league_id, v_next_week, 'active')
      on conflict (user_id, week_number) do nothing;
    end if;
  end loop;
end;
$$;

-- Deliberately no grant — same internal-only, reachable-only-from-a-
-- scheduled-job convention as 20260859's original definition.
