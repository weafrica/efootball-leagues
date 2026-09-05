-- WEEKEND LEAGUE (Three-Day Titans League) — move the hard tournament-end
-- deadline from Sunday 23:59 UTC to Sunday 11:59 UTC.
--
-- Only the v_deadline line changes (interval '2 days 23 hours 59 minutes'
-- -> '2 days 11 hours 59 minutes'); everything else in
-- _weekend_league_advance_knockout_internal (per-round resolution,
-- 2-hour per-match forfeit, next-round generation) is unchanged from
-- 20260902111822. Applied directly to the live project and verified
-- there before this file was written: for the current live instance
-- (starts_at Fri 2026-09-04 17:00 UTC), the new deadline computes to
-- Sun 2026-09-06 11:59 UTC.
--
-- Anything still pending at the new deadline is forfeited (both sides,
-- same no-show rule as always) and no further knockout round is
-- generated past that point, same as before — just twelve hours earlier
-- in the day.
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

  v_deadline := date_trunc('day', v_league.starts_at) + interval '2 days 11 hours 59 minutes';

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
