-- MONTH-END LEAGUE — a new recurring CASH groups_knockout league, built by
-- copying the Weekend League ("Three-Day Titans League") auto-cycle
-- exactly (open cron -> join window -> group stage -> auto-advance to
-- knockout -> knockout auto-advances every round, unattended, until a
-- hard deadline), just re-timed monthly instead of weekly and with its
-- own numbers:
--
--   | Weekend League                        | Month-End League            |
--   |----------------------------------------|------------------------------|
--   | league_type = 'fun'                     | league_type = 'cash'         |
--   | group_size = whatever admin picked      | group_size = 6               |
--   | group_qualifiers = whatever admin picked| group_qualifiers = 3 (top 3  |
--   |                                          | of 6 advance -> 3 eliminated)|
--   | group stage: starts_at + 24h            | group stage: starts_at + 10d |
--   | knockout round window: 2h               | knockout round window: 2d    |
--   | hard deadline: start-of-day + 2d 11:59h | hard deadline: end of the    |
--   |                                          | UTC calendar month it started|
--   | kicks off Friday 17:00 UTC, weekly       | kicks off the 3rd of the     |
--   |                                          | month, 18:00 SAST (16:00     |
--   |                                          | UTC), monthly. Entry closes  |
--   |                                          | 4pm SAST (14:00 UTC) the     |
--   |                                          | same day — 2h before kickoff,|
--   |                                          | not AT kickoff the way       |
--   |                                          | Weekend League's is          |
--
-- Every other mechanic — bye handling, pens fallback on a scoreline draw,
-- forfeiting a fixture that's still pending past its due_at (both teams
-- eliminated, fixture stays played=false — same no-show rule as
-- findNoShowTeamIds/isFixtureLocked in src/App.jsx), no roster
-- carry-forward, full-row clone for each new instance — is copied as-is
-- from the Weekend League's current (20260905143000) behavior.
--
-- IDENTIFICATION — same lesson as 20260905140000_weekend_league_open_
-- scope_to_groups_knockout.sql: pin this down by something structural, or
-- a random admin-created cash groups_knockout league risks getting
-- silently cloned forward as if it were the real Month-End League. Used
-- throughout below: created_by_admin = true, format = 'groups_knockout',
-- league_type = 'cash', and starts_at landing on the 3rd of its UTC
-- calendar month (the SAST 18:00 kickoff on the 3rd always lands on UTC
-- day 3, never rolling into day 2 or 4 — SAST is a fixed +2h, so 18:00
-- SAST is 16:00 UTC, same calendar day).
--
-- BOOTSTRAP — unlike Weekend League (which already had a human-created
-- instance for its auto-cycle to clone forward from), there is no prior
-- Month-End League row to clone from yet, so section 1 below inserts the
-- very first one directly, exactly as if an admin had created it by hand.
-- Every cycle after that clones forward from the previous one, same as
-- Weekend League.
--
-- Client-side half: isMonthEndLeague / monthEndGroupStageCutoffUTC in
-- src/App.jsx, used by doGenerateFixtures so group_stage_due_at is set
-- automatically the moment an admin generates this league's fixtures —
-- mirrors isWeekendLeague / weekendGroupStageCutoffUTC exactly.
--
-- Safe to run more than once: the bootstrap insert is guarded (only
-- inserts if no Month-End League exists yet), every function is `create
-- or replace`, and `cron.schedule` upserts by job name.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. next-3rd-of-month-18:00-SAST, strictly after p_from — the kickoff
--    cadence helper. SAST (Africa/Johannesburg, UTC+2 fixed, no DST) is
--    applied as a flat 2h offset, same trick every other SAST helper in
--    this codebase uses (fmtDate, isWeekendPauseHour, the original
--    _weekend_league_next_sast_dow_hour before Weekend League moved to
--    plain UTC). Unlike month-END helpers (nextMonthEndCutoffSAST,
--    _ladder_cup_last_day_of_month_2359_utc), day 3 exists in every
--    month, so this needs no "walk to the last valid day" fallback.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _month_end_league_next_sast_dom_hour(p_from timestamptz, p_dom integer, p_hour integer)
returns timestamptz
language plpgsql
as $$
declare
  v_sast_now timestamp := (p_from + interval '2 hours') at time zone 'UTC';
  v_candidate timestamptz;
begin
  v_candidate := (
    (date_trunc('month', v_sast_now) + ((p_dom - 1) || ' days')::interval + (p_hour || ' hours')::interval)
    at time zone 'UTC'
  ) - interval '2 hours';
  if v_candidate <= p_from then
    v_candidate := (
      (date_trunc('month', v_sast_now) + interval '1 month' + ((p_dom - 1) || ' days')::interval + (p_hour || ' hours')::interval)
      at time zone 'UTC'
    ) - interval '2 hours';
  end if;
  return v_candidate;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Bootstrap — the first Month-End League instance, exactly as if an
--    admin had created it by hand. starts_at is the next 3rd-of-month
--    18:00 SAST (16:00 UTC) from right now; entry_closes_at is always
--    exactly 2h before that (4pm SAST) — computed as an offset off
--    starts_at rather than its own "next after now" lookup, so the two
--    can never land on different months relative to each other.
-- ─────────────────────────────────────────────────────────────────────────
insert into leagues (
  name, created_by, format, league_type, created_by_admin,
  description, starts_at, entry_closes_at,
  group_size, group_qualifiers, knockout_legs, round_period_hours,
  current_stage, final_stage_started, groups_count, group_stage_due_at
)
select
  'Month-End League', null, 'groups_knockout', 'cash', true,
  'Monthly cash groups & knockout — groups of 6, top 3 advance, 10-day group stage, 2-day knockout rounds.',
  v_start, v_start - interval '2 hours',
  6, 3, 1, 48,
  1, false, null, null
from (select _month_end_league_next_sast_dom_hour(now(), 3, 18) as v_start) s
where not exists (
  select 1 from leagues
  where created_by_admin = true and format = 'groups_knockout' and league_type = 'cash'
    and extract(day from starts_at) = 3
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. _month_end_league_open_new_internal — clone the most recent Month-End
--    League forward into next month, full-row copy (same reasoning as
--    Weekend League's clone: format-specific config, description,
--    round_period_hours, league_type, created_by, created_by_admin, and
--    anything else on the row carries over as-is, so group_size=6/
--    group_qualifiers=3/league_type='cash' persist automatically cycle to
--    cycle unless an admin deliberately changes them).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _month_end_league_open_new_internal()
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
  v_next_start := _month_end_league_next_sast_dom_hour(now(), 3, 18); -- 3rd, 18:00 SAST

  if exists (
    select 1 from leagues
    where created_by_admin = true and format = 'groups_knockout' and league_type = 'cash' and starts_at = v_next_start
  ) then
    return null; -- already opened next month's league
  end if;

  select * into v_prev
  from leagues
  where created_by_admin = true and format = 'groups_knockout' and league_type = 'cash'
    and extract(day from starts_at) = 3
  order by starts_at desc
  limit 1;

  if not found then
    return null; -- no prior Month-End League to clone settings from yet
  end if;

  v_new := v_prev;
  v_new.id := gen_random_uuid();
  v_new.created_at := now();
  v_new.starts_at := v_next_start;
  v_new.entry_closes_at := v_next_start - interval '2 hours'; -- 4pm SAST, 2h before kickoff
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
-- 3. _month_end_league_advance_one_group_stage — group stage -> knockout
--    round 1. Same ranking/qualifier logic as the Weekend League version
--    (points desc, goal difference desc, goals for desc, name asc; an
--    unplayed fixture at cutoff counts as a 0-0 draw worth no points to
--    either side for ranking purposes only — fixture row itself untouched).
--    Round-1 due_at is now + 2 days, not +2 hours.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _month_end_league_advance_one_group_stage(p_league_id uuid)
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
  v_group_qualifiers := greatest(1, coalesce(v_league.group_qualifiers, 3));

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
  v_due := v_now + interval '2 days';

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
-- 4. _month_end_league_advance_knockout_internal — drives the knockout
--    bracket forward one round at a time, fully unattended, exactly like
--    the Weekend League version: resolve decisive/pens results, forfeit
--    (both eliminated) anything past its 2-day due_at or past the hard
--    deadline, and once the round is fully resolved seed the next round
--    for survivors with a fresh 2-day due_at — unless the deadline has
--    passed, in which case no further round is generated.
--
--    Hard deadline here is the end of the UTC calendar month the league
--    started in (23:59:59 UTC on its last day) — the "Month-End" in the
--    name. A 10-day group stage plus 2-day knockout rounds comfortably
--    fits a bracket of real size in the ~20 days left in the month.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _month_end_league_advance_knockout_internal(p_league_id uuid)
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

  v_deadline := (date_trunc('month', v_league.starts_at) + interval '1 month' - interval '1 second');

  select max(round) into v_current_round from fixtures where league_id = p_league_id and stage = 2;
  if v_current_round is null then
    return;
  end if;

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
    return;
  end if;

  select array_agg(distinct t.id) into v_survivors
  from teams t
  where t.league_id = p_league_id and not t.eliminated
    and t.id in (
      select home_team_id from fixtures where league_id = p_league_id and stage = 2 and round = v_current_round
      union
      select away_team_id from fixtures where league_id = p_league_id and stage = 2 and round = v_current_round
    );

  if v_survivors is null or array_length(v_survivors, 1) < 2 then
    return;
  end if;

  select array_agg(id order by random()) into v_pool from unnest(v_survivors) as id;
  v_pool_count := array_length(v_pool, 1);
  v_new_round := v_current_round + 1;
  v_due := v_now + interval '2 days';

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
-- 5. _month_end_league_sweep_internal — unified cron entrypoint, same
--    "advance any due group stage, then advance/forfeit every in-progress
--    knockout" shape as the Weekend League sweep.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _month_end_league_sweep_internal()
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
      and league_type = 'cash'
      and final_stage_started = false
      and group_stage_due_at is not null
      and group_stage_due_at <= now()
      and extract(day from starts_at) = 3
  loop
    perform _month_end_league_advance_one_group_stage(v_id);
  end loop;

  for v_id in
    select id from leagues
    where format = 'groups_knockout'
      and created_by_admin = true
      and league_type = 'cash'
      and final_stage_started = true
      and extract(day from starts_at) = 3
  loop
    perform _month_end_league_advance_knockout_internal(v_id);
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Cron — open on the 27th of each month (00:00 UTC), 6ish days ahead of
--    the 3rd-of-next-month 18:00 SAST kickoff so there's a join window,
--    exactly like Weekend League's Monday-open-for-Friday-kickoff gap.
--    _month_end_league_open_new_internal is itself guarded to no-op until
--    the next kickoff is actually due, so an earlier or later cron tick
--    here is harmless either way. The sweep runs every 10 minutes, same
--    frequency as the Weekend League sweep, so it catches each 2-day
--    knockout window as it expires.
-- ─────────────────────────────────────────────────────────────────────────
select cron.schedule(
  'month-end-league-open',
  '0 0 27 * *', -- 00:00 UTC on the 27th, every month
  $$select _month_end_league_open_new_internal();$$
);

select cron.schedule(
  'month-end-league-sweep-frequent',
  '*/10 * * * *', -- every 10 minutes
  $$select _month_end_league_sweep_internal();$$
);
