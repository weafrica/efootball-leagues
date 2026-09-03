-- WEEKEND LEAGUE ("Three-Day Titans League") — corrected auto-cycle.
-- Supersedes 20260901070000_weekend_league_auto_cycle.sql, which got two
-- things wrong based on guessing instead of the real live data:
--   1. Assumed the league starts 17:00 SAST Friday. The real league
--      (confirmed live) starts 18:00 SAST Friday; 17:00 is only when
--      entry used to close, an hour early.
--   2. Assumed entry should auto-CLOSE at Monday 00:00 SAST. Per
--      clarification, entry should instead stay OPEN from the moment a
--      new instance is created (Monday 00:00 SAST) all the way through
--      to kickoff (Friday 18:00 SAST) — no early cutoff at all. So there
--      is nothing to "close" separately; the old
--      _weekend_league_close_due_internal function/cron did the wrong
--      thing and is retired below.
--
-- Real behavior now:
--   * Monday 00:00 SAST — auto-create the next weekend's league, cloning
--     the most recent qualifying one's settings in full (see the
--     full-row-clone note in the original migration's header — still
--     applies unchanged: format-specific config, description,
--     round_period_hours, league_type, created_by, created_by_admin, and
--     anything else on the row carries over as-is).
--   * The new league's entry_closes_at is set equal to its own starts_at
--     (Friday 18:00 SAST) — i.e. joinable continuously from creation
--     through kickoff, per "join again from Monday until it starts."
--   * No roster carry-forward (unchanged from before) — team/member rows
--     live in a separate table, so a freshly-inserted leagues row starts
--     with zero members for free.
--
-- Safe to run more than once.

-- Retire the previous (incorrect) close-entry cron job and function, and
-- the previous Friday-open job — both replaced by the single Monday tick
-- below.
select cron.unschedule('weekend-league-monday-close')
where exists (select 1 from cron.job where jobname = 'weekend-league-monday-close');

select cron.unschedule('weekend-league-friday-open')
where exists (select 1 from cron.job where jobname = 'weekend-league-friday-open');

drop function if exists _weekend_league_close_due_internal();

-- ─────────────────────────────────────────────────────────────────────────
-- 1. _weekend_league_next_sast_dow_hour — unchanged from the original
--    migration: next real moment (UTC) SAST wall-clock reaches
--    `p_hour`:00 on weekday `p_dow` (0=Sun..6=Sat), strictly after
--    p_from. create-or-replace here too so this file works standalone.
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
-- 2. _weekend_league_open_new_internal — opens the next Weekend League.
--    starts_at = next Friday 18:00 SAST (corrected). entry_closes_at is
--    now set equal to starts_at, not a separate early/late cutoff — open
--    continuously from creation to kickoff. Still identifies "a Weekend
--    League" the same way the frontend does (created_by_admin = true,
--    not ladder_cup, starts_at falling on a Fri/Sat/Sun in SAST), and
--    still guarded against opening two for the same upcoming Friday.
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
  v_next_start := _weekend_league_next_sast_dow_hour(now(), 5, 18); -- next Friday 18:00 SAST

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
  v_new.entry_closes_at := v_next_start; -- open continuously from creation through kickoff
  v_new.prizes_paid_at := null;

  insert into leagues select (v_new).*
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Cron — a single weekly tick, Monday 00:00 SAST = Sunday 22:00 UTC.
-- ─────────────────────────────────────────────────────────────────────────
select cron.schedule(
  'weekend-league-monday-open',
  '0 22 * * 0', -- 22:00 UTC Sunday = 00:00 SAST Monday
  $$select _weekend_league_open_new_internal();$$
);
