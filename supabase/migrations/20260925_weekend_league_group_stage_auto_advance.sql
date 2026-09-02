-- WEEKEND LEAGUE (groups_knockout format only) — auto-end the group stage
-- and auto-start the knockout bracket, both at 17:00 SAST on Saturday.
--
-- Front-end half (see src/App.jsx):
--   * weekendKnockoutCutoffSAST() — new helper, Saturday 17:00 SAST.
--   * doGenerateFixtures — when an admin starts a Weekend League
--     (isWeekendLeague(league)) with format='groups_knockout', its
--     group_stage_due_at is now set automatically to that cutoff, instead
--     of the admin having to set it by hand the way every other
--     groups_knockout league still does. Still editable afterwards from
--     the same "Group stage due date" control if an admin wants to move it.
--
-- This half (server-side) does the actual auto-advance at that moment:
--   * Any group-stage (stage 1) fixture still unplayed at the 17:00 SAST
--     cutoff is treated, for standings purposes only, as a 0-0 draw
--     worth NO points to either side (an explicit product decision —
--     deliberately not the app's usual no-show penalty of a loss + 4
--     conceded, since this is an automatic cutover, not a reported
--     no-show). The fixture row itself is left untouched (still
--     played=false in the database) — only the qualifier computation
--     below treats it this way. No fixture-reward crediting is touched,
--     so nothing gets paid out for a match that was never actually played.
--   * Per group: rank by (games "played" desc-tiebreak is irrelevant here
--     since every fixture counts as played one way or another) points
--     desc, goal difference desc, goals for desc, name asc — same order
--     computeStandings uses in the frontend. Top group_qualifiers
--     (excluding any team already eliminated) advance; every other
--     eligible team in that group is marked eliminated=true, mirroring
--     advanceGroupsToKnockout's eliminatedIds step.
--   * All qualifiers across every group are pooled and shuffled together,
--     then paired off exactly like knockoutRound1 (an odd one out gets a
--     bye: an instant 1-0, played=true fixture) — same shape
--     knockoutBracketFixtures/knockoutRoundFixtures produce client-side.
--     Two-legged ties (knockout_legs=2) share one due date covering both
--     legs (KNOCKOUT_TIE_WINDOW_MS, 4 days); a round that comes down to a
--     single pair IS the final and is always a single decisive match
--     regardless of knockout_legs, same rule isFinalRoundFixtures encodes
--     client-side. Due dates skip the weekend league's nightly 9pm-9am
--     SAST pause the same way addPausableDuration does.
--   * leagues.current_stage -> 2, final_stage_started -> true.
--
-- Only ever touches format='groups_knockout' leagues that are (a) a
-- Weekend League (created_by_admin, starts_at falling on a Fri/Sat/Sun),
-- (b) still in the group stage (final_stage_started=false), and (c) have
-- a group_stage_due_at that has actually passed — so this cron tick is a
-- no-op on any weekend where nothing is currently mid-group-stage.
--
-- Safe to run more than once — each league is re-checked with
-- final_stage_started=false immediately before it's processed (and inside
-- the same transaction as the fixtures it inserts / the league row it
-- flips), so a league already advanced by an earlier tick (or by an admin
-- manually clicking "Start knockout" before the cutoff hit) is skipped.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. _sast_next_hour_boundary — next moment (UTC) SAST wall-clock reaches
--    p_hour:00, at or after p_from, regardless of weekday. The day-agnostic
--    counterpart to _weekend_league_next_sast_dow_hour (which pins a
--    specific weekday) — mirrors nextSastHourBoundary in src/App.jsx.
--    Used below to walk through the weekend's nightly pause windows.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _sast_next_hour_boundary(p_from timestamptz, p_hour integer)
returns timestamptz
language plpgsql
as $$
declare
  v_sast_now timestamp := (p_from + interval '2 hours') at time zone 'UTC';
  v_candidate timestamptz;
begin
  v_candidate := (date_trunc('day', v_sast_now) + (p_hour || ' hours')::interval) at time zone 'UTC' - interval '2 hours';
  if v_candidate < p_from then
    v_candidate := v_candidate + interval '1 day';
  end if;
  return v_candidate;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. _pausable_due_at — mirrors addPausableDuration in src/App.jsx: adds
--    p_duration_ms of real elapsed time on top of p_from, but (when
--    p_weekend is true) the 9pm-9am SAST pause doesn't count toward that
--    time. Walks forward in active/paused stretches, capped at 10000
--    iterations as the same safety guard the JS version uses.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _pausable_due_at(p_from timestamptz, p_duration_ms bigint, p_weekend boolean)
returns timestamptz
language plpgsql
as $$
declare
  v_cursor timestamptz := p_from;
  v_remaining bigint := p_duration_ms;
  v_guard integer := 0;
  v_sast_hour integer;
  v_next_boundary timestamptz;
  v_step bigint;
begin
  if not p_weekend then
    return p_from + (p_duration_ms || ' milliseconds')::interval;
  end if;
  while v_remaining > 0 and v_guard < 10000 loop
    v_guard := v_guard + 1;
    v_sast_hour := extract(hour from (v_cursor + interval '2 hours') at time zone 'UTC')::integer;
    if v_sast_hour >= 21 or v_sast_hour < 9 then
      v_cursor := _sast_next_hour_boundary(v_cursor, 9);
    else
      v_next_boundary := _sast_next_hour_boundary(v_cursor, 21);
      v_step := least((extract(epoch from (v_next_boundary - v_cursor)) * 1000)::bigint, v_remaining);
      v_cursor := v_cursor + (v_step || ' milliseconds')::interval;
      v_remaining := v_remaining - v_step;
    end if;
  end loop;
  return v_cursor;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. _weekend_league_advance_one_group_stage — does the actual qualifier
--    computation + bracket generation for a single league. Split out from
--    the sweep below so each league's work happens in its own clean
--    variable scope. security definer since it writes teams/fixtures/
--    leagues the same way the admin-only client flow does today.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _weekend_league_advance_one_group_stage(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league leagues%rowtype;
  v_groups_count integer;
  v_group_qualifiers integer;
  v_legs integer;
  v_period_ms bigint;
  v_qualifier_ids uuid[];
  v_non_qualifier_ids uuid[];
  v_pool uuid[];
  v_pool_count integer;
  v_now timestamptz := now();
  v_single_leg_due timestamptz;
  v_tie_due timestamptz;
  v_starts_at timestamptz;
  v_is_final_round boolean;
  v_i integer;
  v_home uuid;
  v_away uuid;
begin
  -- Lock + re-check right before doing anything — guards against this
  -- being invoked twice (a re-run of the sweep, or an admin's manual
  -- "Start knockout" click landing in the same instant).
  select * into v_league from leagues where id = p_league_id for update;
  if not found or v_league.final_stage_started or v_league.format <> 'groups_knockout' then
    return;
  end if;
  if v_league.group_stage_due_at is null or v_league.group_stage_due_at > v_now then
    return;
  end if;

  v_groups_count := v_league.groups_count;
  if v_groups_count is null or v_groups_count < 1 then
    return; -- fixtures were never generated for this league — nothing to advance
  end if;
  v_group_qualifiers := greatest(1, coalesce(v_league.group_qualifiers, 2));
  v_legs := greatest(1, coalesce(v_league.knockout_legs, 1));
  v_period_ms := greatest(1, coalesce(v_league.round_period_hours, 48))::bigint * 3600000;

  -- Per-group standings. Every stage-1 fixture counts as "played" for
  -- ranking purposes even when it never actually got a result — an
  -- unplayed fixture just contributes 0-0 and 0 points to both sides
  -- (the explicit "no points either way" forfeit rule for this automatic
  -- cutover), rather than the app's usual no-show loss+4-conceded
  -- penalty. The fixture rows themselves are left untouched.
  with group_stage_fixtures as (
    select * from fixtures where league_id = p_league_id and stage = 1
  ),
  team_group as (
    select id as team_id, group_number, eliminated, name
    from teams where league_id = p_league_id
  ),
  contrib as (
    select home_team_id as team_id,
           case when played and home_score > away_score then 3 when played and home_score = away_score then 1 else 0 end as pts,
           case when played then home_score else 0 end as gf,
           case when played then away_score else 0 end as ga
    from group_stage_fixtures where away_team_id is not null
    union all
    select away_team_id as team_id,
           case when played and away_score > home_score then 3 when played and home_score = away_score then 1 else 0 end as pts,
           case when played then away_score else 0 end as gf,
           case when played then home_score else 0 end as ga
    from group_stage_fixtures where away_team_id is not null
  ),
  standings as (
    select tg.team_id, tg.group_number, tg.eliminated, tg.name,
           coalesce(sum(c.pts), 0) as pts,
           coalesce(sum(c.gf), 0) - coalesce(sum(c.ga), 0) as gd,
           coalesce(sum(c.gf), 0) as gf
    from team_group tg
    left join contrib c on c.team_id = tg.team_id
    group by tg.team_id, tg.group_number, tg.eliminated, tg.name
  ),
  ranked as (
    select *, row_number() over (
      partition by group_number order by pts desc, gd desc, gf desc, name asc
    ) as rnk
    from standings
    where not eliminated
  )
  select
    coalesce(array_agg(team_id) filter (where rnk <= v_group_qualifiers), '{}'),
    coalesce(array_agg(team_id) filter (where rnk > v_group_qualifiers), '{}')
  into v_qualifier_ids, v_non_qualifier_ids
  from ranked;

  if array_length(v_qualifier_ids, 1) is null or array_length(v_qualifier_ids, 1) < 2 then
    return; -- not enough qualifying clubs to seed a bracket — leave the group stage as-is
  end if;

  if array_length(v_non_qualifier_ids, 1) > 0 then
    update teams set eliminated = true where id = any(v_non_qualifier_ids);
  end if;

  -- Pool every group's qualifiers together and shuffle, exactly like
  -- knockoutRound1(shuffle(qualifiers)) does client-side.
  select array_agg(team_id order by random()) into v_pool
  from unnest(v_qualifier_ids) as team_id;
  v_pool_count := array_length(v_pool, 1);

  v_is_final_round := v_pool_count = 2;
  if v_is_final_round then v_legs := 1; end if;

  v_starts_at := v_now;
  v_single_leg_due := _pausable_due_at(v_now, v_period_ms, true);
  v_tie_due := _pausable_due_at(v_now, 4 * 24 * 3600000, true); -- KNOCKOUT_TIE_WINDOW_MS

  v_i := 1;
  while v_i <= v_pool_count loop
    v_home := v_pool[v_i];
    if v_i + 1 <= v_pool_count then
      v_away := v_pool[v_i + 1];
    else
      v_away := null;
    end if;

    if v_away is null then
      insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
      values (p_league_id, 1, 1, 2, v_home, v_away, true, 1, 0, v_single_leg_due, v_starts_at);
    elsif v_legs <> 2 then
      insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
      values (p_league_id, 1, 1, 2, v_home, v_away, false, 0, 0, v_single_leg_due, v_starts_at);
    else
      insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
      values
        (p_league_id, 1, 1, 2, v_home, v_away, false, 0, 0, v_tie_due, v_starts_at),
        (p_league_id, 1, 2, 2, v_away, v_home, false, 0, 0, v_tie_due, v_starts_at);
    end if;

    v_i := v_i + 2;
  end loop;

  update leagues set current_stage = 2, final_stage_started = true where id = p_league_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. _weekend_league_group_stage_sweep_internal — the cron entrypoint.
--    Finds every Weekend League (created_by_admin, starts_at on a
--    Fri/Sat/Sun) still in its group stage with a group_stage_due_at that
--    has passed, and advances each one in turn.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _weekend_league_group_stage_sweep_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in
    select id from leagues
    where format = 'groups_knockout'
      and created_by_admin = true
      and final_stage_started = false
      and group_stage_due_at is not null
      and group_stage_due_at <= now()
      and extract(dow from ((starts_at + interval '2 hours') at time zone 'UTC')) in (5, 6, 0)
  loop
    perform _weekend_league_advance_one_group_stage(v_id);
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Cron — Saturday 17:00 SAST = Saturday 15:00 UTC, every week.
-- ─────────────────────────────────────────────────────────────────────────
select cron.unschedule('weekend-league-saturday-group-stage-advance')
where exists (select 1 from cron.job where jobname = 'weekend-league-saturday-group-stage-advance');

select cron.schedule(
  'weekend-league-saturday-group-stage-advance',
  '0 15 * * 6', -- 15:00 UTC Saturday = 17:00 SAST Saturday
  $$select _weekend_league_group_stage_sweep_internal();$$
);
