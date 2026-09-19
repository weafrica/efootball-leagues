-- cash_ladder_fixture_generation
-- The last piece needed to make a freshly-started 16-player cash league
-- actually playable: generates its Week 1 schedule automatically the
-- moment the 16th player joins. Mirrors _generate_round_robin_fixtures_internal
-- exactly, writing to cash_ladder_fixtures instead of ladder_fixtures.
-- Tested live: 16 real accounts -> league went active -> 240 fixtures
-- generated (16 players x 15 opponents x 2 legs, correct home/away split).

create or replace function _generate_cash_ladder_round_robin_fixtures_internal(
  p_league_id uuid, p_week_number integer, p_player_ids uuid[], p_week_start_at timestamptz default now()
) returns integer
language plpgsql
security definer
set search_path to 'public'
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
  v_leg integer;
begin
  if array_length(v_ids, 1) is null or array_length(v_ids, 1) < 2 then
    raise exception '_generate_cash_ladder_round_robin_fixtures_internal: need at least 2 players';
  end if;

  delete from cash_ladder_fixtures f
  where f.league_id = p_league_id and f.week_number = p_week_number and f.status = 'pending'
    and not exists (select 1 from cash_ladder_reward_ledger r where r.fixture_id = f.id);

  if array_length(v_ids, 1) % 2 <> 0 then
    v_ids := v_ids || null::uuid;
  end if;
  v_n := array_length(v_ids, 1);
  v_rounds_single := v_n - 1;
  v_rounds_total := 2 * v_rounds_single;

  v_local := p_week_start_at at time zone 'UTC';
  v_dow := extract(dow from v_local)::integer;
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
          select 1 from cash_ladder_fixtures
          where league_id = p_league_id and week_number = p_week_number
            and least(home_user_id, away_user_id) = least(v_home, v_away)
            and greatest(home_user_id, away_user_id) = greatest(v_home, v_away)
            and status in ('played', 'forfeited', 'pending')
            and leg = v_leg
        ) then
          insert into cash_ladder_fixtures
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

create or replace function _cash_ladder_apply_paid_entry(
  p_user_id uuid,
  p_entry_fee_goats bigint,
  p_ref_type text,
  p_ref_id text,
  p_checkout_method text,
  p_gateway_reference text
) returns cash_ladder_memberships
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_league_id uuid;
  v_week_number integer;
  v_row cash_ladder_memberships%rowtype;
  v_league_pool_balance bigint;
  v_roster_count integer;
  v_player_ids uuid[];
begin
  if exists (
    select 1 from cash_ladder_memberships
    where user_id = p_user_id and status = 'active'
  ) then
    raise exception '_cash_ladder_apply_paid_entry: already on the cash ladder';
  end if;

  select t.league_id, t.week_number into v_league_id, v_week_number
  from _cash_ladder_target_league_and_week() t;

  insert into cash_ladder_memberships (user_id, league_id, week_number, status)
  values (p_user_id, v_league_id, v_week_number, 'active')
  returning * into v_row;

  update cash_ladder_leagues set pool_balance = pool_balance + p_entry_fee_goats
  where id = v_league_id
  returning pool_balance into v_league_pool_balance;

  insert into cash_ladder_pool_transactions (amount, balance_after, reason, ref_type, ref_id, user_id, league_id)
  values (p_entry_fee_goats, v_league_pool_balance, 'goats_entry_fee', p_ref_type, p_ref_id, p_user_id, v_league_id);

  insert into cash_ladder_fee_events (
    user_id, week_number, league_id, fee_type, amount, transitioned,
    checkout_method, payment_status, gateway_reference
  ) values (
    p_user_id, v_week_number, v_league_id, 'entry', p_entry_fee_goats, false,
    p_checkout_method, 'paid', p_gateway_reference
  );

  select count(*) into v_roster_count
  from cash_ladder_memberships
  where league_id = v_league_id and status = 'active';

  if v_roster_count >= 16 then
    update cash_ladder_leagues set status = 'active' where id = v_league_id and status = 'forming';

    select array_agg(user_id) into v_player_ids
    from cash_ladder_memberships
    where league_id = v_league_id and status = 'active';

    perform _generate_cash_ladder_round_robin_fixtures_internal(v_league_id, 1, v_player_ids, now());
  end if;

  return v_row;
end;
$function$;

create or replace function admin_generate_cash_ladder_week_fixtures(p_league_id uuid, p_week_number integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_player_ids uuid[];
  v_count integer;
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_generate_cash_ladder_week_fixtures: admin only';
  end if;

  select array_agg(user_id) into v_player_ids
  from cash_ladder_memberships
  where league_id = p_league_id and status = 'active';

  if v_player_ids is null then
    raise exception 'admin_generate_cash_ladder_week_fixtures: no active members in this league';
  end if;

  v_count := _generate_cash_ladder_round_robin_fixtures_internal(p_league_id, p_week_number, v_player_ids, now());
  return v_count;
end;
$function$;
