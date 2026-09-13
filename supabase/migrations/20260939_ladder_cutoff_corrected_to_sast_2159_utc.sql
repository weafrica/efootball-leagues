-- The League Ladder's weekly cutoff is meant to be 11:59 PM South African
-- time (SAST, UTC+2, no DST) — i.e. 21:59 UTC. 20260876 "corrected" this to
-- a literal 23:59 UTC on the assumption the spec meant UTC directly; that
-- assumption was wrong. This migration reverts the wall-clock cutoff back
-- to 21:59 UTC (= 23:59 SAST) without reintroducing the AT TIME ZONE
-- 'Africa/Johannesburg' conversion 20260876 removed — SAST has no DST, so
-- a fixed 2-hour offset applied as a literal UTC time is exact and avoids
-- any timezone-name lookup.
--
-- 1. Reschedule the close/open cron job 2 hours earlier.
select cron.schedule(
  'ladder-close-week-sunday',
  '59 21 * * 0', -- 21:59 UTC = 23:59 SAST, Sunday
  $$select _ladder_close_week_internal();$$
);

-- 2. Match the fixture-release window math to the same corrected cutoff,
-- so fixtures still get a full 24h play window ending 2 hours earlier too.
CREATE OR REPLACE FUNCTION public._generate_round_robin_fixtures_internal(p_league_id uuid, p_week_number integer, p_player_ids uuid[], p_week_start_at timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Cutoff is 21:59 UTC (= 23:59 SAST, UTC+2, no DST) — see this migration.
  v_close_at := (date_trunc('day', v_local) + (((7 - v_dow) % 7) * interval '1 day') + interval '21 hours 59 minutes')
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
$function$;
