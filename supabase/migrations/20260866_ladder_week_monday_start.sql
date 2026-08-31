-- League Ladder — shift the weekly cycle's open time from Tuesday 12:00 AM
-- SAST to Monday 12:00 AM SAST. Close time (Sunday 10:00 PM SAST) is
-- unchanged — it was already correct, so 20260856's close-week cron job
-- is left untouched.
--
-- Two things need to move together, same coupling 20260862's header
-- called out for the original Tue->Sat window:
--
-- 1. The open-week cron schedule itself (was Monday 22:00 UTC = Tuesday
--    00:00 SAST; now Sunday 22:00 UTC = Monday 00:00 SAST).
-- 2. _generate_round_robin_fixtures_internal's release-stagger window,
--    which used to assume its anchor (v_week_start_at, "the moment the
--    cron fires") was Tuesday 12AM and spread releases across 118 hours
--    ending Saturday 10PM (24h short of the old Sunday 10PM close). The
--    window is now 6 days shorter... no — it's a full day LONGER, since
--    the week itself gained a day (Mon->Sun instead of Tue->Sun): 142
--    hours, still ending at the same clock time, Saturday 10PM, just one
--    day later relative to the new Monday start. Mirrors
--    leagueLadder.js's LADDER_COUNTDOWN_WINDOW_HOURS change (118 -> 142) —
--    see that file for the worked-example arithmetic. Both need updating
--    together, same "reimplemented in SQL, kept in sync by hand"
--    convention as the rest of this codebase's pure/SQL pairs.
--
-- _ladder_open_week_internal itself needs no change — it already just
-- captures v_week_start_at := now() and threads it through, whatever day
-- the cron happens to fire on.
--
-- Job name kept as 'ladder-open-week-tuesday' rather than renamed: this
-- codebase's cron.schedule calls upsert by job name (re-running updates
-- the existing job in place), so keeping the name is what avoids leaving
-- a stale duplicate job behind. The name is now just cosmetically stale,
-- not functionally wrong.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _generate_round_robin_fixtures_internal — identical to 20260862's
-- version except v_step_hours' window constant: 142.0 instead of 118.0.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _generate_round_robin_fixtures_internal(
  p_league_id uuid,
  p_week_number integer,
  p_player_ids uuid[],
  p_week_start_at timestamptz default now()
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := p_player_ids;
  v_n integer;
  v_rounds integer;
  v_step_hours numeric;
  v_home uuid;
  v_away uuid;
  v_inserted integer := 0;
  v_r integer;
  v_i integer;
  v_last uuid;
  v_countdown timestamptz;
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_round_robin_fixtures_internal: need at least 2 players';
  end if;

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid; -- bye slot, same as the JS version
  end if;
  v_n := array_length(v_ids, 1);
  v_rounds := v_n - 1;
  v_step_hours := case when v_rounds > 1 then 142.0 / (v_rounds - 1) else 0 end;

  for v_r in 0 .. v_rounds - 1 loop
    v_countdown := p_week_start_at + ((v_r * v_step_hours) + 24) * interval '1 hour';

    for v_i in 1 .. v_n / 2 loop
      v_home := v_ids[v_i];
      v_away := v_ids[v_n - v_i + 1];
      if v_home is not null and v_away is not null then
        insert into ladder_fixtures (league_id, week_number, home_user_id, away_user_id, status, countdown_expires_at)
        values (p_league_id, p_week_number, v_home, v_away, 'pending', v_countdown);
        v_inserted := v_inserted + 1;
      end if;
    end loop;

    -- rotate: pop the last element, insert it right after the fixed first
    -- element — same shift App.jsx's/leagueLadder.js's ids.splice(1, 0,
    -- ids.pop()) performs, just 1-indexed.
    v_last := v_ids[v_n];
    for v_i in reverse v_n .. 3 loop
      v_ids[v_i] := v_ids[v_i - 1];
    end loop;
    v_ids[2] := v_last;
  end loop;

  return v_inserted;
end;
$$;

create extension if not exists pg_cron with schema extensions;

-- pg_cron runs in UTC; SAST is UTC+2 (no daylight saving). Monday 12:00 AM
-- SAST is Sunday 22:00 UTC. cron.schedule upserts by job name, so this
-- updates the existing 'ladder-open-week-tuesday' job's fire time in
-- place rather than creating a second job.
select cron.schedule(
  'ladder-open-week-tuesday',
  '0 22 * * 0', -- Sunday 22:00 UTC = Monday 00:00 SAST
  $$select _ladder_open_week_internal();$$
);
