-- League Ladder — Phase 3: promotion & relegation engine.
--
-- Adds the Sunday-10PM resolve step that Phase 2's _ladder_close_week_internal
-- deliberately left as flags-only, and updates Tuesday's _ladder_open_week_internal
-- to (a) leave room for the promotion arrivals the resolve step already wrote,
-- and (b) rebalance any league whose incoming roster would exceed 8.
--
-- SCOPE NOTE (mirrors leagueLadder.js's resolveLadderWeek header): per the
-- plan's own Phase 3 checklist, this migration only tests promotion/
-- relegation COUNTS in isolation. Relegated players get their closing
-- week's ladder_memberships row marked 'relegated' and nothing else — no
-- next-week row, in any league. They stay "in limbo" until Phase 5's
-- buy-back auction gives them one (either back into their old league, or
-- falling through to the league below if they lose the bid). That means
-- every standard league will visibly shrink week over week under this
-- migration alone (loses 3: 1 promoted + 2 relegated; gains only 1: the
-- auto-promoted arrival from below) — expected per the plan, not a bug to
-- chase, until Phase 5 lands.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _ensure_ladder_league_internal — get-or-create a ladder_leagues row for a
-- tier. Used both for promotion arrivals (target tier is always < an
-- existing tier, so this is normally a pure lookup) and for the bottom-
-- league auto-create/overflow-split case (target tier is one past the
-- current max, so this is normally the create branch). Internal only, same
-- no-grant convention as every other _*_internal function in this file —
-- leagues are never created directly by a client.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ensure_ladder_league_internal(p_tier integer)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from ladder_leagues where tier = p_tier;
  if v_id is null then
    insert into ladder_leagues (tier, status)
    values (p_tier, 'active')
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rebalance_ladder_overflow_internal — plan's "auto-create a new bottom
-- league... split and rebalance" bullet. Checked generically across every
-- league's incoming roster for p_week_number, rather than hardcoded to
-- "the bottom league": under this phase's own arrival rules (only 1
-- promotion arrival per league, nothing yet feeds a league beyond its
-- 8-cap) this can't actually fire anywhere except wherever the bottom tier
-- ends up, but checking generically means it keeps working unchanged once
-- a new-player-join flow (plan §1: "new players always join at the
-- bottom-most league") lands later and starts growing that roster for
-- real.
--
-- Rebalancing rule: when a league's incoming roster exceeds 8, peel off
-- the most-recently-joined arrivals (by joined_at) — not existing stayers
-- — into a freshly created league one tier below the current max, until
-- the original league is back at 8. Moving the newest arrivals rather than,
-- say, the lowest standings or an arbitrary id keeps the disruption on
-- players who just joined/moved anyway, not someone who'd already settled
-- into that league.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rebalance_ladder_overflow_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overflow_league record;
  v_max_tier integer;
  v_overflow_ids uuid[];
  v_new_league_id uuid;
begin
  for v_overflow_league in
    select league_id, count(*) as cnt
    from ladder_memberships
    where week_number = p_week_number
    group by league_id
    having count(*) > 8
  loop
    select max(tier) into v_max_tier from ladder_leagues where status = 'active';

    select array_agg(user_id) into v_overflow_ids
    from (
      select user_id
      from ladder_memberships
      where league_id = v_overflow_league.league_id and week_number = p_week_number
      order by joined_at desc
      limit (v_overflow_league.cnt - 8)
    ) newest_arrivals;

    if v_overflow_ids is not null and array_length(v_overflow_ids, 1) > 0 then
      v_new_league_id := _ensure_ladder_league_internal(v_max_tier + 1);
      update ladder_memberships
      set league_id = v_new_league_id
      where league_id = v_overflow_league.league_id
        and week_number = p_week_number
        and user_id = any(v_overflow_ids);
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_resolve_promotion_relegation_internal — the Sunday-10PM resolve
-- step proper. For every active league, standings are computed straight
-- from ladder_fixtures (same win=3/draw=1/loss=0 scoring, same
-- played-status-first/points/gd/gf/user_id tie-break as
-- leagueLadder.js's computeStandings + resolveLadderWeek — reimplemented
-- in SQL for the same reason _generate_round_robin_fixtures_internal
-- reimplements generateRoundRobinFixtures: a SQL function can't call out
-- to client-side JS. If either algorithm ever changes, both need updating
-- together — scripts/test-league-ladder.mjs is the tested reference.
--
-- A league with fewer than 2 active players that week never got fixtures
-- generated in the first place (Phase 2's own guard), so its standings
-- array here comes back empty and it's skipped entirely — matching
-- resolveLadderWeek's own "empty standings, nobody moves" behavior.
-- ─────────────────────────────────────────────────────────────────────────
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
                    when status = 'played' and home_score = away_score then 1
                    else 0 end as pts,
               case when status in ('played', 'forfeited') then 1 else 0 end as played,
               case when status = 'played' then home_score else 0 end as gf,
               case when status = 'played' then away_score when status = 'forfeited' then 4 else 0 end as ga
        from ladder_fixtures
        where league_id = v_league.id and week_number = v_week
        union all
        select away_user_id,
               case when status = 'played' and away_score > home_score then 3
                    when status = 'played' and away_score = home_score then 1
                    else 0 end,
               case when status in ('played', 'forfeited') then 1 else 0 end,
               case when status = 'played' then away_score else 0 end,
               case when status = 'played' then home_score when status = 'forfeited' then 4 else 0 end
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
    -- see this migration's own header for why (Phase 5's territory).
    if v_promoted is not null then
      v_target_league_id := _ensure_ladder_league_internal(v_league.tier - 1);
      insert into ladder_memberships (user_id, league_id, week_number, status)
      values (v_promoted, v_target_league_id, v_next_week, 'active')
      on conflict (user_id, week_number) do nothing;
    end if;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_close_week_internal — now runs the resolve step before flipping
-- the cycle flags, instead of Phase 2's flags-only version.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_close_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _ladder_resolve_promotion_relegation_internal();

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_open_week_internal — restructured into two passes so the
-- overflow rebalance sees each league's FULL incoming roster (carried-
-- forward stayers plus whatever the Sunday resolve job already wrote)
-- before fixtures are generated from it, instead of generating fixtures
-- league-by-league as each one's carry-forward finished (Phase 2's
-- original shape, which never needed this because nothing else was
-- writing into v_new_week rows yet).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_open_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_week integer;
  v_new_week integer;
  v_bidding_open boolean;
  v_league record;
  v_player_ids uuid[];
begin
  select current_week, bidding_open into v_prev_week, v_bidding_open
  from ladder_cycle where id = true for update;

  if v_bidding_open then
    raise exception '_ladder_open_week_internal: week % is still open — close it before opening a new one', v_prev_week;
  end if;

  v_new_week := v_prev_week + 1;

  -- Pass 1: carry every currently-active stayer forward into the new week,
  -- same league. Movers are excluded automatically — Phase 3's resolve job
  -- (run at last Sunday's close) already flipped their CLOSING week's
  -- status away from 'active', so this query's own `status = 'active'`
  -- filter skips them without any extra logic here.
  if v_prev_week > 0 then
    for v_league in select id from ladder_leagues where status = 'active' loop
      insert into ladder_memberships (user_id, league_id, week_number, status)
      select user_id, v_league.id, v_new_week, 'active'
      from ladder_memberships
      where league_id = v_league.id and week_number = v_prev_week and status = 'active';
    end loop;
  end if;

  -- Every league's incoming roster for v_new_week is now fully known
  -- (stayers just carried forward, plus any promotion arrivals the Sunday
  -- resolve job already wrote directly into their new league) — safe to
  -- split off overflow before generating fixtures from it.
  perform _rebalance_ladder_overflow_internal(v_new_week);

  -- Pass 2: generate this week's fixtures per league, from the
  -- now-finalized roster.
  for v_league in select id from ladder_leagues where status = 'active' loop
    select array_agg(user_id) into v_player_ids
    from ladder_memberships
    where league_id = v_league.id and week_number = v_new_week and status = 'active';

    if array_length(v_player_ids, 1) >= 2 then
      perform _generate_round_robin_fixtures_internal(v_league.id, v_new_week, v_player_ids);
    end if;
  end loop;

  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$$;

-- Deliberately no grants on any function above — same internal-only,
-- reachable-only-from-a-scheduled-job convention as the rest of this file.
