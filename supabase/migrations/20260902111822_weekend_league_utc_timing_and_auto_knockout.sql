-- WEEKEND LEAGUE ("Three-Day Titans League") — move off SAST-anchored
-- timing onto plain UTC clock times, and make the ENTIRE knockout bracket
-- advance automatically (every round, not just group-stage -> round 1),
-- with a 2-hour per-match auto-forfeit and a hard Sunday 23:59 UTC
-- tournament deadline. No admin action required anywhere in the cycle.
--
-- New timing model (all UTC, no SAST offset applied anywhere in this flow):
--   * League opens: Friday 17:00 UTC (was Friday 18:00 SAST = 16:00 UTC).
--   * Group stage ends / knockout kicks off: starts_at + 24h = Saturday
--     17:00 UTC (was Saturday 17:00 SAST = 15:00 UTC).
--   * Each knockout match: 2-hour window. Neither side submits within it ->
--     BOTH teams eliminated (mirrors the app's own existing no-show rule —
--     findNoShowTeamIds/isFixtureLocked in src/App.jsx: "a no-show tie ...
--     both teams are eliminated"). The fixture row stays played=false
--     forever, same as every other no-show in this app — only the teams'
--     eliminated flag changes.
--   * Hard stop: Sunday 23:59 UTC. Anything still pending at that instant
--     is forfeited (both sides) the same way, and no further round is
--     generated past that point — whoever is left standing (if exactly
--     one club) is champion by survival; the bracket simply doesn't force
--     a result past the deadline.
--   * Every knockout match here is single-leg (the previous two-legged-tie
--     option doesn't fit a 2-hour window) — a scoreline tie falls back to
--     penalties (pens_home/pens_away) exactly like the app's existing
--     final-round rule (advanceKnockout in App.jsx), just applied to every
--     round instead of only the final, since there's no time for a decider
--     leg here. This is an explicit deviation from a league's configured
--     knockout_legs for Weekend League knockout play specifically.
--   * The nightly 9pm-9am SAST pause no longer applies to knockout timing
--     here — a 2-hour window and a fixed weekend-end deadline don't leave
--     room for it. (Still shown as a spotlight badge elsewhere; unrelated.)
--
-- Supersedes the Saturday-only weekly cron from 20260925 with a frequent
-- (10-minute) sweep that handles group-stage advance AND every knockout
-- round AND per-match forfeiting in one pass. The Monday-00:00-open cron
-- (20260901071500) is untouched except for what its function computes
-- internally (Friday 17:00 UTC instead of Friday 18:00 SAST).
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. _next_utc_dow_hour — plain-UTC counterpart to
--    _weekend_league_next_sast_dow_hour: next moment p_from's UTC
--    wall-clock reaches p_dow (0=Sun..6=Sat) at p_hour:00, strictly after
--    p_from. No SAST offset — this league now runs on UTC clock times.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _next_utc_dow_hour(p_from timestamptz, p_dow integer, p_hour integer)
returns timestamptz
language plpgsql
as $$
declare
  v_days_ahead integer := (p_dow - extract(dow from p_from)::integer + 7) % 7;
  v_candidate timestamptz;
begin
  v_candidate := date_trunc('day', p_from) + (v_days_ahead || ' days')::interval + (p_hour || ' hours')::interval;
  if v_candidate <= p_from then
    v_candidate := v_candidate + interval '7 days';
  end if;
  return v_candidate;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. _weekend_league_open_new_internal — same clone-and-reset shape as
--    20260901071500 / the progress-reset fix, just anchored to Friday
--    17:00 UTC instead of Friday 18:00 SAST.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _weekend_league_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new leagues%rowtype;
  v_new_id uuid;
  v_next_start timestamptz;
begin
  v_next_start := _next_utc_dow_hour(now(), 5, 17); -- next Friday 17:00 UTC

  if exists (
    select 1 from leagues
    where created_by_admin = true and format <> 'ladder_cup' and starts_at = v_next_start
  ) then
    return null;
  end if;

  select * into v_prev
  from leagues
  where created_by_admin = true
    and format <> 'ladder_cup'
    and extract(dow from starts_at) in (5, 6, 0)
  order by starts_at desc
  limit 1;

  if not found then
    return null;
  end if;

  v_new := v_prev;
  v_new.id := gen_random_uuid();
  v_new.created_at := now();
  v_new.starts_at := v_next_start;
  v_new.entry_closes_at := v_next_start;
  v_new.prizes_paid_at := null;
  v_new.current_stage := 1;
  v_new.final_stage_started := false;
  v_new.groups_count := null;
  v_new.group_stage_due_at := null;

  insert into leagues select (v_new).*
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. _weekend_league_advance_one_group_stage — group stage -> knockout
--    round 1. Standings/qualifier computation unchanged from 20260925.
--    What changes: round-1 fixtures now get a flat 2-hour due_at (no more
--    pausable/tie-window due-date math) and are always single-leg.
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
  v_qualifier_ids uuid[];
  v_non_qualifier_ids uuid[];
  v_pool uuid[];
  v_pool_count integer;
  v_now timestamptz := now();
  v_due timestamptz;
  v_i integer;
  v_home uuid;
  v_away uuid;
begin
  select * into v_league from leagues where id = p_league_id for update;
  if not found or v_league.final_stage_started or v_league.format <> 'groups_knockout' then
    return;
  end if;
  if v_league.group_stage_due_at is null or v_league.group_stage_due_at > v_now then
    return;
  end if;

  v_groups_count := v_league.groups_count;
  if v_groups_count is null or v_groups_count < 1 then
    return;
  end if;
  v_group_qualifiers := greatest(1, coalesce(v_league.group_qualifiers, 2));

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
    return;
  end if;

  if array_length(v_non_qualifier_ids, 1) > 0 then
    update teams set eliminated = true where id = any(v_non_qualifier_ids);
  end if;

  select array_agg(team_id order by random()) into v_pool
  from unnest(v_qualifier_ids) as team_id;
  v_pool_count := array_length(v_pool, 1);
  v_due := v_now + interval '2 hours';

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
      values (p_league_id, 1, 1, 2, v_home, v_away, true, 1, 0, v_due, v_now);
    else
      insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
      values (p_league_id, 1, 1, 2, v_home, v_away, false, 0, 0, v_due, v_now);
    end if;

    v_i := v_i + 2;
  end loop;

  update leagues set current_stage = 2, final_stage_started = true where id = p_league_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. _weekend_league_advance_knockout_internal — the new piece: drives
--    the knockout bracket forward one round at a time, fully unattended.
--    Called repeatedly (every sweep tick) for any league currently in its
--    knockout stage. Per call, for the CURRENT round only:
--      a) resolve every played tie -> mark the losing team eliminated
--         (score, falling back to pens_home/pens_away on a scoreline draw
--         — same rule advanceKnockout's final-round branch uses in
--         App.jsx, just applied every round here since there's no time
--         for a decider leg). A scoreline draw with no/equal pens yet is
--         left unresolved — that tie blocks the round exactly like it
--         would in the app's own admin-driven flow, until a pens result
--         comes in or the 2-hour window expires it below.
--      b) forfeit any fixture still unplayed past its due_at (or past the
--         weekend's hard deadline) — BOTH teams eliminated, fixture stays
--         played=false, mirrors findNoShowTeamIds/isFixtureLocked exactly.
--      c) if any tie in the round is still unresolved after (a)+(b),
--         stop here — not ready to advance yet.
--      d) otherwise, gather survivors (this round's teams still not
--         eliminated). 0 or 1 left -> tournament's over, nothing more to
--         schedule. 2+ -> shuffle, pair off (bye = instant win, same as
--         round 1), insert as round+1 with a fresh 2-hour due_at — unless
--         the hard deadline has already passed, in which case no further
--         round is generated (whatever's resolved stands).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _weekend_league_advance_knockout_internal(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league leagues%rowtype;
  v_deadline timestamptz;
  v_current_round integer;
  v_now timestamptz := now();
  v_survivors uuid[];
  v_pool uuid[];
  v_pool_count integer;
  v_new_round integer;
  v_due timestamptz;
  v_i integer;
  v_home uuid;
  v_away uuid;
  v_row record;
  v_winner uuid;
  v_loser uuid;
begin
  select * into v_league from leagues where id = p_league_id for update;
  if not found or not v_league.final_stage_started or v_league.format <> 'groups_knockout' then
    return;
  end if;

  v_deadline := date_trunc('day', v_league.starts_at) + interval '2 days 23 hours 59 minutes';

  select max(round) into v_current_round from fixtures where league_id = p_league_id and stage = 2;
  if v_current_round is null then
    return; -- knockout marked started but round 1 was never generated — nothing to do
  end if;

  -- (a) resolve decisive/pens results for this round
  for v_row in
    select f.id, f.home_team_id, f.away_team_id, f.home_score, f.away_score, f.pens_home, f.pens_away
    from fixtures f
    join teams th on th.id = f.home_team_id
    join teams ta on ta.id = f.away_team_id
    where f.league_id = p_league_id and f.stage = 2 and f.round = v_current_round
      and f.played = true and f.away_team_id is not null
      and not th.eliminated and not ta.eliminated
  loop
    v_winner := null; v_loser := null;
    if v_row.home_score > v_row.away_score then
      v_winner := v_row.home_team_id; v_loser := v_row.away_team_id;
    elsif v_row.away_score > v_row.home_score then
      v_winner := v_row.away_team_id; v_loser := v_row.home_team_id;
    elsif v_row.pens_home is not null and v_row.pens_away is not null and v_row.pens_home <> v_row.pens_away then
      if v_row.pens_home > v_row.pens_away then
        v_winner := v_row.home_team_id; v_loser := v_row.away_team_id;
      else
        v_winner := v_row.away_team_id; v_loser := v_row.home_team_id;
      end if;
    end if;
    if v_loser is not null then
      update teams set eliminated = true where id = v_loser;
    end if;
  end loop;

  -- (b) forfeit expired/deadline-passed pending fixtures — both eliminated
  for v_row in
    select f.home_team_id, f.away_team_id
    from fixtures f
    join teams th on th.id = f.home_team_id
    join teams ta on ta.id = f.away_team_id
    where f.league_id = p_league_id and f.stage = 2 and f.round = v_current_round
      and f.played = false and f.away_team_id is not null
      and not th.eliminated and not ta.eliminated
      and (f.due_at <= v_now or v_now >= v_deadline)
  loop
    update teams set eliminated = true where id in (v_row.home_team_id, v_row.away_team_id);
  end loop;

  -- (c) anything in this round still unresolved (both sides alive, and
  -- either not played yet, or played-but-still-level-with-no-pens-winner)?
  if exists (
    select 1
    from fixtures f
    join teams th on th.id = f.home_team_id
    join teams ta on ta.id = f.away_team_id
    where f.league_id = p_league_id and f.stage = 2 and f.round = v_current_round
      and f.away_team_id is not null and not th.eliminated and not ta.eliminated
      and (
        f.played = false
        or (f.home_score = f.away_score and (f.pens_home is null or f.pens_away is null or f.pens_home = f.pens_away))
      )
  ) then
    return;
  end if;

  if v_now >= v_deadline then
    return; -- hard stop — round resolved, but no further round past the deadline
  end if;

  -- (d) gather this round's survivors and seed the next round
  select array_agg(distinct t.id) into v_survivors
  from teams t
  where t.league_id = p_league_id and not t.eliminated
    and t.id in (
      select home_team_id from fixtures where league_id = p_league_id and stage = 2 and round = v_current_round
      union
      select away_team_id from fixtures where league_id = p_league_id and stage = 2 and round = v_current_round
    );

  if v_survivors is null or array_length(v_survivors, 1) < 2 then
    return; -- champion decided (or nobody left) — nothing more to schedule
  end if;

  select array_agg(id order by random()) into v_pool from unnest(v_survivors) as id;
  v_pool_count := array_length(v_pool, 1);
  v_new_round := v_current_round + 1;
  v_due := v_now + interval '2 hours';

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
      values (p_league_id, v_new_round, 1, 2, v_home, v_away, true, 1, 0, v_due, v_now);
    else
      insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
      values (p_league_id, v_new_round, 1, 2, v_home, v_away, false, 0, 0, v_due, v_now);
    end if;

    v_i := v_i + 2;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. _weekend_league_sweep_internal — unified cron entrypoint: advances
--    any due group stage, then advances/forfeits every in-progress
--    knockout bracket. Replaces the old Saturday-only fixed-time cron —
--    this one runs frequently so it can catch each 2-hour knockout window
--    as it expires, not just once a week.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _weekend_league_sweep_internal()
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
      and extract(dow from starts_at) in (5, 6, 0)
  loop
    perform _weekend_league_advance_one_group_stage(v_id);
  end loop;

  for v_id in
    select id from leagues
    where format = 'groups_knockout'
      and created_by_admin = true
      and final_stage_started = true
      and extract(dow from starts_at) in (5, 6, 0)
  loop
    perform _weekend_league_advance_knockout_internal(v_id);
  end loop;
end;
$$;

-- Retire the old fixed-weekly-time cron — superseded by the frequent sweep.
select cron.unschedule('weekend-league-saturday-group-stage-advance')
where exists (select 1 from cron.job where jobname = 'weekend-league-saturday-group-stage-advance');

select cron.schedule(
  'weekend-league-sweep-frequent',
  '*/10 * * * *', -- every 10 minutes
  $$select _weekend_league_sweep_internal();$$
);
