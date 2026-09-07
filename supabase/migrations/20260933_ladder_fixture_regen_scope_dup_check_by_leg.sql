-- Repo-drift backfill, part 3. Applied live via Supabase:apply_migration
-- as `ladder_fixture_regen_scope_dup_check_by_leg` in a prior session,
-- confirmed still running via pg_get_functiondef on 2026-09-07.
--
-- Bug: the duplicate-pairing check before each insert only matched on
-- league + week + player pair, not `leg`. In a double round-robin the
-- same pair legitimately gets fixtured twice (leg 1 home, leg 2 away).
-- Any league whose week's schedule got generated across two separate
-- calls (leg 1 in one call, leg 2 attempted in a later call) had that
-- second call see leg 1's existing row and silently skip inserting leg
-- 2 for every pairing — leaving the league stuck at leg1-only. Leagues
-- generated start-to-finish in one uninterrupted call were unaffected.
-- This sits on the live weekly cron path
-- (ladder-close-week-sunday -> _ladder_close_week_internal ->
-- _ladder_open_week_internal -> _ladder_sync_fixtures_internal ->
-- this function), so a future partial regen is protected too, not just
-- the tier 17/18 manual repairs done this session.
--
-- Fix: duplicate check now also matches on `leg`.
--
-- Safe to run more than once.

create or replace function _generate_round_robin_fixtures_internal(
  p_league_id uuid,
  p_week_number integer,
  p_player_ids uuid[],
  p_week_start_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[] := p_player_ids;
  v_n integer;
  v_rounds_single integer;
  v_rounds_total integer;
  v_step_hours numeric;
  v_home uuid;
  v_away uuid;
  v_inserted integer := 0;
  v_r integer;
  v_i integer;
  v_last uuid;
  v_leg2 boolean;
  v_countdown timestamptz;
  v_local timestamp;
  v_dow integer;
  v_close_at timestamptz;
  v_window_hours numeric;
  v_leg integer;
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_round_robin_fixtures_internal: need at least 2 players';
  end if;

  delete from ladder_fixtures f
  where f.league_id = p_league_id and f.week_number = p_week_number and f.status = 'pending'
    and not exists (select 1 from ladder_reward_ledger r where r.fixture_id = f.id);

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid; -- bye slot, same as the JS version
  end if;
  v_n := array_length(v_ids, 1);
  v_rounds_single := v_n - 1;
  v_rounds_total := 2 * v_rounds_single; -- double round robin: home leg + away leg

  v_local := p_week_start_at at time zone 'UTC';
  v_dow := extract(dow from v_local)::integer; -- 0 = Sunday .. 6 = Saturday
  v_close_at := (date_trunc('day', v_local) + (((7 - v_dow) % 7) * interval '1 day') + interval '23 hours 59 minutes')
                at time zone 'UTC';
  if v_close_at <= p_week_start_at then
    v_close_at := v_close_at + interval '7 days';
  end if;
  v_window_hours := greatest(0, extract(epoch from (v_close_at - p_week_start_at)) / 3600.0 - 24);

  v_step_hours := case when v_rounds_total > 1 then v_window_hours / (v_rounds_total - 1) else 0 end;

  for v_r in 0 .. v_rounds_total - 1 loop
    v_countdown := p_week_start_at + ((v_r * v_step_hours) + 24) * interval '1 hour';
    v_leg2 := v_r >= v_rounds_single;
    v_leg := case when v_leg2 then 2 else 1 end;

    for v_i in 1 .. v_n / 2 loop
      if v_leg2 then
        v_home := v_ids[v_n - v_i + 1];
        v_away := v_ids[v_i];
      else
        v_home := v_ids[v_i];
        v_away := v_ids[v_n - v_i + 1];
      end if;

      if v_home is not null and v_away is not null then
        if not exists (
          select 1 from ladder_fixtures
          where league_id = p_league_id and week_number = p_week_number
            and least(home_user_id, away_user_id) = least(v_home, v_away)
            and greatest(home_user_id, away_user_id) = greatest(v_home, v_away)
            and status in ('played', 'forfeited', 'pending')
            and leg = v_leg
        ) then
          insert into ladder_fixtures
            (league_id, week_number, home_user_id, away_user_id, status, countdown_expires_at, leg)
          values
            (p_league_id, p_week_number, v_home, v_away, 'pending', v_countdown, v_leg);
          v_inserted := v_inserted + 1;
        end if;
      end if;
    end loop;

    v_last := v_ids[v_n];
    for v_i in reverse v_n .. 3 loop
      v_ids[v_i] := v_ids[v_i - 1];
    end loop;
    v_ids[2] := v_last;
  end loop;

  return v_inserted;
end;
$$;
