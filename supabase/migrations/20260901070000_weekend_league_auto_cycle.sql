-- WEEKEND LEAGUE — auto-open Friday 17:00 SAST, auto-close entry Monday
-- 00:00 SAST. Previously fully manual: an admin created a league by hand
-- and picked dates that happened to fall on the coming Fri-Sun (see
-- weekendWindow()/willBeWeekendLeague in App.jsx & CreateLeague.jsx --
-- that's what makes a league count as "the" Weekend League on the
-- homepage spotlight: created_by_admin = true and starts_at landing in
-- that window). There was no server-side auto-create/auto-close for it at
-- all before this migration -- unlike League Ladder and Ladder Cup, which
-- both already run their own cron cycles.
--
-- Decisions (per user, this session):
--   * No money involved -- league_type stays whatever the previous
--     Weekend League used (expected 'fun'), same as every other setting.
--   * No roster carry-forward -- every player joins fresh each weekend.
--     This falls out for free: team/member rows live in a separate table
--     from `leagues`, so a freshly-inserted leagues row naturally starts
--     with zero members, exactly like an admin creating a brand new
--     league by hand.
--
-- CLONING STRATEGY -- full-row copy, not an explicit column list
--
-- Unlike Ladder Cup's clone (which only ever needs a fixed set of
-- columns, since ladder_cup is always the same format), a Weekend League
-- can be any format an admin picked (double_round_robin, survivor,
-- knockout, groups_knockout...) with format-specific config columns
-- (survivor/groups/knockout settings) this migration can't safely
-- hand-enumerate without a live schema check. So instead of INSERT ...
-- (col list), this copies the *entire* previous row via leagues%rowtype
-- and only overrides the handful of fields that must change for a new
-- instance (id, created_at, starts_at, entry_closes_at, prizes_paid_at).
-- Every other column -- format, its config columns, description,
-- round_period_hours, league_type, created_by, created_by_admin, whatever
-- else exists on the table -- carries over untouched. This is the
-- "everything else stays the same" behavior as literally as SQL allows.
--
-- Safe to run more than once (every function is `create or replace`,
-- `cron.schedule` upserts by job name, the open function is guarded
-- against opening a duplicate for the same upcoming weekend).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. _weekend_league_next_sast_dow_hour -- the next real moment (UTC)
--    at which SAST wall-clock time (fixed UTC+2, no DST, same trick
--    App.jsx's nextSastHourBoundary/isWeekendPauseHour use) reaches
--    `p_hour`:00 on weekday `p_dow` (0=Sun..6=Sat), strictly after
--    p_from. Mirrors _ladder_cup_next_sunday_1159_utc's "never p_from
--    itself" contract, generalized to any day-of-week + hour.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _weekend_league_next_sast_dow_hour(p_from timestamptz, p_dow integer, p_hour integer)
returns timestamptz
language plpgsql
as $$
declare
  v_sast_now timestamp := (p_from + interval '2 hours') at time zone 'UTC';
  v_dow_now integer := extract(dow from v_sast_now)::integer;
  v_days_ahead integer := (p_dow - v_dow_now + 7) % 7;
  v_candidate timestamptz;
begin
  v_candidate := (
    (date_trunc('day', v_sast_now) + (v_days_ahead || ' days')::interval + (p_hour || ' hours')::interval)
    at time zone 'UTC'
  ) - interval '2 hours';
  if v_candidate <= p_from then
    v_candidate := v_candidate + interval '7 days';
  end if;
  return v_candidate;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. _weekend_league_open_new_internal -- opens the next Weekend League,
--    cloning the most recent qualifying one's settings (see header).
--    Identifies "a Weekend League" the same way the frontend already
--    does: created_by_admin = true, not ladder_cup, starts_at falling on
--    a Fri/Sat/Sun in SAST wall-clock terms. Guarded so it never opens two
--    for the same upcoming Friday.
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
  v_next_end timestamptz;
begin
  v_next_start := _weekend_league_next_sast_dow_hour(now(), 5, 17); -- next Friday 17:00 SAST
  v_next_end := _weekend_league_next_sast_dow_hour(v_next_start, 1, 0); -- the Monday 00:00 SAST right after it

  if exists (
    select 1 from leagues
    where created_by_admin = true and format <> 'ladder_cup' and starts_at = v_next_start
  ) then
    return null; -- already opened this weekend's league
  end if;

  select * into v_prev
  from leagues
  where created_by_admin = true
    and format <> 'ladder_cup'
    and extract(dow from ((starts_at + interval '2 hours') at time zone 'UTC')) in (5, 6, 0)
  order by starts_at desc
  limit 1;

  if not found then
    return null; -- no prior Weekend League to clone settings from yet
  end if;

  v_new := v_prev;
  v_new.id := gen_random_uuid();
  v_new.created_at := now();
  v_new.starts_at := v_next_start;
  v_new.entry_closes_at := v_next_end;
  v_new.prizes_paid_at := null;

  insert into leagues select (v_new).*
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. _weekend_league_close_due_internal -- the "auto end" at Monday 00:00
--    SAST: force entry_closes_at to now() for whatever Weekend League is
--    currently running and hasn't already had entry closed. This is the
--    closest existing concept to "close" a regular league has -- there's
--    no separate finished/finalized flag for fun leagues the way
--    ladder_cup has ladder_cup_finalized_at. It does NOT touch fixtures,
--    force a result, or trigger prize-pool finalize -- that still only
--    ever happens the normal way (client-detected completion), unchanged
--    by this migration.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _weekend_league_close_due_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update leagues
  set entry_closes_at = now()
  where created_by_admin = true
    and format <> 'ladder_cup'
    and extract(dow from ((starts_at + interval '2 hours') at time zone 'UTC')) in (5, 6, 0)
    and starts_at <= now()
    and (entry_closes_at is null or entry_closes_at > now());
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Cron -- both are plain weekly cadences (unlike Ladder Cup's old
--    month-end problem, a day-of-week IS directly expressible in cron
--    syntax, so no daily-tick-that-mostly-no-ops trick is needed here).
-- ─────────────────────────────────────────────────────────────────────────
select cron.schedule(
  'weekend-league-friday-open',
  '0 15 * * 5', -- 15:00 UTC = 17:00 SAST, every Friday
  $$select _weekend_league_open_new_internal();$$
);

select cron.schedule(
  'weekend-league-monday-close',
  '0 22 * * 0', -- 22:00 UTC Sunday = 00:00 SAST Monday
  $$select _weekend_league_close_due_internal();$$
);
