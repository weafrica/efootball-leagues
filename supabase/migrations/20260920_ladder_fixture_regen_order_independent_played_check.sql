-- The "already played, don't regenerate" guard in fixture generation
-- compared home/away in a fixed order, but the round-robin rotation
-- can flip which side is home/away once the roster changes (e.g. a
-- relegated/promoted player lands in a league mid-week, changing the
-- player array the rotation runs over). That let it try to re-insert
-- an already-played pairing with home/away swapped, which collides
-- with the (order-independent) unique pairing index
-- (idx_ladder_fixtures_unique_pairing) and crashes the sync.
--
-- Found while deploying 20260919: rebalancing week 2 tried to sync a
-- league's fixtures after moving a player in and hit this crash on a
-- pairing that had already been played.
create or replace function _generate_round_robin_fixtures_internal(
  p_league_id uuid,
  p_week_number integer,
  p_player_ids uuid[],
  p_week_start_at timestamp with time zone default now()
)
returns integer
language plpgsql
security definer
set search_path = 'public'
as $function$
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
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_round_robin_fixtures_internal: need at least 2 players';
  end if;

  delete from ladder_fixtures
  where league_id = p_league_id and week_number = p_week_number and status = 'pending';

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
            and status in ('played', 'forfeited')
        ) then
          insert into ladder_fixtures
            (league_id, week_number, home_user_id, away_user_id, status, countdown_expires_at, leg)
          values
            (p_league_id, p_week_number, v_home, v_away, 'pending', v_countdown, case when v_leg2 then 2 else 1 end);
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
