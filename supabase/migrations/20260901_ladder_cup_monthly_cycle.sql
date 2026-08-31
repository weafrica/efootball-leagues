-- SURVIVAL LADDER CUP — switch the auto-cycle from weekly (Sunday 11:59
-- UTC) to monthly: auto-end on the last day of the month, auto-start on
-- the first. Replaces 20260895_ladder_cup_auto_weekly_cycle.sql's cadence
-- only — the finalize/crown/Wall-of-Fame/prize-pool machinery it shipped
-- (_ladder_cup_finalize_internal, _ladder_cup_auto_finalize_due_sweep_internal,
-- finalize_ladder_cup, _ladder_cup_open_new_internal) is untouched below
-- except where noted.
--
-- WHY A DAILY TICK, NOT A DIRECT CRON EXPRESSION
--
-- Standard cron syntax (what pg_cron's `schedule` takes) has no "last day
-- of the month" field — months are 28/29/30/31 days, so there's no fixed
-- day-of-month that's correct every month. The robust fix is the same one
-- everyone reaches for: schedule a tick every day at 23:59 UTC, and have
-- the function itself check whether *today* happens to be the last day of
-- the month (i.e. tomorrow is the 1st) before doing anything. Handles
-- February/leap years/30-vs-31-day months for free, with no calendar table.
--
-- WHY "REMOVE 6 FROM THE TITLE"
--
-- _ladder_cup_open_new_internal (20260895) auto-numbers each reopened cup
-- by bumping a trailing "#N" on the previous cup's name — that's how the
-- currently-live cup ended up named "...#6" after 5 weekly reopens. Under
-- the new monthly cadence that counter is stale/confusing (it counted
-- *weeks*, not months), so this migration (a) stops appending/bumping any
-- "#N" going forward — reopened cups just keep the exact same name — and
-- (b) one-time strips any existing trailing "#N" off whatever ladder_cup
-- league is currently live, per section 4 below.
--
-- Safe to run more than once — same idempotency shape as 20260895 (every
-- function is `create or replace`, `cron.schedule`/`cron.unschedule` are
-- both safe to repeat, the name-strip and cutoff-realign backfills are
-- no-ops once already applied).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. _ladder_cup_last_day_of_month_2359_utc — the next month-end 23:59 UTC
--    strictly after p_from (mirrors _ladder_cup_next_sunday_1159_utc's
--    "never p_from itself" contract, just walking to month-end instead of
--    to Sunday).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_last_day_of_month_2359_utc(p_from timestamptz default now())
returns timestamptz
language plpgsql
as $$
declare
  v_utc timestamp := p_from at time zone 'UTC';
  v_candidate timestamptz;
begin
  v_candidate := ((date_trunc('month', v_utc) + interval '1 month' - interval '1 day')::date
                   + interval '23 hours 59 minutes') at time zone 'UTC';
  if v_candidate <= p_from then
    v_candidate := ((date_trunc('month', v_utc) + interval '2 months' - interval '1 day')::date
                     + interval '23 hours 59 minutes') at time zone 'UTC';
  end if;
  return v_candidate;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. _ladder_cup_is_last_day_of_month_utc — true iff p_at's UTC calendar
--    date is the last day of its month (i.e. tomorrow is the 1st).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_is_last_day_of_month_utc(p_at timestamptz default now())
returns boolean
language sql
stable
as $$
  select extract(day from ((p_at at time zone 'UTC')::date + 1)) = 1;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. _ladder_cup_open_new_internal — replaces 20260895's version. Same
--    "clone the most recent ladder_cup league's settings" behavior, minus
--    the "#N" auto-numbering (see comment block above for why) and using
--    the new monthly cutoff instead of next-Sunday.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new_id uuid;
begin
  if exists (select 1 from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null) then
    return null; -- a cup is already live — never open a second one
  end if;

  select * into v_prev from leagues where format = 'ladder_cup' order by created_at desc limit 1;
  if not found then
    return null; -- no prior Ladder Cup to clone settings from — nothing to auto-open yet
  end if;

  insert into leagues (
    name, created_by, format, entry_closes_at, starts_at, description,
    round_period_hours, created_by_admin, league_type, ladder_cup_cutoff_at
  )
  values (
    v_prev.name, v_prev.created_by, 'ladder_cup', null, now(), v_prev.description,
    v_prev.round_period_hours, v_prev.created_by_admin, v_prev.league_type,
    _ladder_cup_last_day_of_month_2359_utc(now())
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. One-time cleanup for the currently-live cup: strip any trailing
--    "#N" the old weekly numbering left on its name, and realign its
--    cutoff onto the new monthly clock (mirrors 20260895's own section 10
--    backfill). Idempotent — a name with no trailing "#N" is left as-is,
--    and re-running just recomputes the same "next month-end" instant.
-- ─────────────────────────────────────────────────────────────────────────
update leagues
set name = trim(regexp_replace(name, '\s*#\d+\s*$', ''))
where format = 'ladder_cup' and ladder_cup_finalized_at is null
  and name ~ '#\d+\s*$';

update leagues
set ladder_cup_cutoff_at = _ladder_cup_last_day_of_month_2359_utc(now())
where format = 'ladder_cup' and ladder_cup_finalized_at is null;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. _ladder_cup_monthly_cycle_tick — the daily entry point. No-ops on
--    every day except the last day of the month; on that day, does the
--    same "finish whatever's due, then immediately start the next one"
--    as the old weekly tick.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_monthly_cycle_tick()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not _ladder_cup_is_last_day_of_month_utc(now()) then
    return;
  end if;
  perform _ladder_cup_auto_finalize_due_sweep_internal();
  perform _ladder_cup_open_new_internal();
end;
$$;

-- Retire the old weekly cron job — one active ladder_cup cron job at a
-- time, or a still-scheduled Sunday tick could fire in the same week as
-- (or ahead of) the new monthly one.
select cron.unschedule('ladder-cup-weekly-cycle-sunday')
where exists (select 1 from cron.job where jobname = 'ladder-cup-weekly-cycle-sunday');

select cron.schedule(
  'ladder-cup-monthly-cycle-daily-check',
  '59 23 * * *', -- every day at 23:59 UTC; the function itself no-ops unless today is month-end
  $$select _ladder_cup_monthly_cycle_tick();$$
);
