-- cash_ladder_promotion_relegation
-- Season-end promotion/relegation for the Cash Ladder (bidding intentionally
-- skipped, per instruction). A league never "ends" -- every season, top 3
-- promote up a tier, bottom 3 relegate down a tier, middle 10 stay, mirroring
-- how the free ladder promotes/relegates weekly, just monthly and with fixed
-- top3/bottom3 counts instead of the free ladder's bid-backfilled 1-up/2-down.
--
-- Schema correction included: the free ladder's (user_id, week_number)
-- uniqueness assumes one shared global week clock. Cash leagues start
-- asynchronously (whenever a batch of 16 fills), so this re-scopes
-- uniqueness to (league_id, week_number, user_id) -- each league now tracks
-- its own independent season counter (cash_ladder_leagues.current_season).

alter table cash_ladder_memberships drop constraint cash_ladder_memberships_user_id_week_number_key;
alter table cash_ladder_memberships add constraint cash_ladder_memberships_league_week_user_key
  unique (league_id, week_number, user_id);

alter table cash_ladder_memberships drop constraint ladder_memberships_status_check;
alter table cash_ladder_memberships add constraint cash_ladder_memberships_status_check
  check (status = any (array['active','promoted','relegated','completed','eliminated']));

alter table cash_ladder_leagues add column if not exists current_season integer not null default 1;

-- Fixture generator now spreads a season's double round-robin over ~27 days
-- (was: crammed into a single week to match the free ladder's weekly cutoff).
drop function if exists _generate_cash_ladder_round_robin_fixtures_internal(uuid, integer, uuid[], timestamptz);

create or replace function _generate_cash_ladder_round_robin_fixtures_internal(
  p_league_id uuid, p_week_number integer, p_player_ids uuid[], p_season_start_at timestamptz default now(),
  p_window_days integer default 27
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

  v_window_hours := p_window_days * 24.0;
  v_step_hours := case when v_rounds_total > 1 then v_window_hours / v_rounds_total else 0 end;

  for v_r in 0 .. v_rounds_total - 1 loop
    v_countdown := p_season_start_at + ((v_r + 1) * v_step_hours) * interval '1 hour';
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

create or replace function _cash_ladder_check_and_start_season_internal(p_league_id uuid, p_season_number integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer;
  v_player_ids uuid[];
begin
  select count(*) into v_count
  from cash_ladder_memberships
  where league_id = p_league_id and week_number = p_season_number and status = 'active';

  if v_count >= 16 then
    select array_agg(user_id) into v_player_ids
    from cash_ladder_memberships
    where league_id = p_league_id and week_number = p_season_number and status = 'active';

    perform _generate_cash_ladder_round_robin_fixtures_internal(p_league_id, p_season_number, v_player_ids, now());

    update cash_ladder_leagues set current_season = p_season_number where id = p_league_id;
  end if;
end;
$function$;

create or replace function _cash_ladder_resolve_season_end_internal(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_league cash_ladder_leagues%rowtype;
  v_season integer;
  v_next_season integer;
  v_standings uuid[];
  v_n integer;
  v_top3 uuid[];
  v_bottom3 uuid[];
  v_stayers uuid[];
  v_up_league cash_ladder_leagues%rowtype;
  v_down_league cash_ladder_leagues%rowtype;
  v_earnings bigint;
  v_fee bigint;
  v_balance bigint;
  v_uid uuid;
begin
  select * into v_league from cash_ladder_leagues where id = p_league_id for update;
  if v_league.id is null then
    raise exception '_cash_ladder_resolve_season_end_internal: league not found';
  end if;
  v_season := v_league.current_season;

  if exists (
    select 1 from cash_ladder_fixtures
    where league_id = p_league_id and week_number = v_season and status = 'pending'
  ) then
    raise exception '_cash_ladder_resolve_season_end_internal: this league still has unplayed fixtures for season %', v_season;
  end if;

  select array_agg(s.user_id order by s.pts desc, s.gd desc, s.gf desc, s.user_id asc)
  into v_standings
  from (
    select m.user_id, sum(m.pts) as pts, sum(m.gf) - sum(m.ga) as gd, sum(m.gf) as gf
    from (
      select home_user_id as user_id,
             case when status = 'played' and home_score > away_score then 3
                  when status = 'forfeited' and home_score is not null and away_score is not null and home_score > away_score then 3
                  when status = 'played' and home_score = away_score then 1
                  when status = 'forfeited' and home_score is not null and away_score is not null and home_score = away_score then 1
                  else 0 end as pts,
             case when status = 'played' then home_score
                  when status = 'forfeited' and home_score is not null then home_score else 0 end as gf,
             case when status = 'played' then away_score
                  when status = 'forfeited' and away_score is not null then away_score
                  when status = 'forfeited' then 4 else 0 end as ga
      from cash_ladder_fixtures where league_id = p_league_id and week_number = v_season
      union all
      select away_user_id,
             case when status = 'played' and away_score > home_score then 3
                  when status = 'forfeited' and home_score is not null and away_score is not null and away_score > home_score then 3
                  when status = 'played' and away_score = home_score then 1
                  when status = 'forfeited' and home_score is not null and away_score is not null and away_score = home_score then 1
                  else 0 end,
             case when status = 'played' then away_score
                  when status = 'forfeited' and away_score is not null then away_score else 0 end,
             case when status = 'played' then home_score
                  when status = 'forfeited' and home_score is not null then home_score
                  when status = 'forfeited' then 4 else 0 end
      from cash_ladder_fixtures where league_id = p_league_id and week_number = v_season
    ) m
    group by m.user_id
  ) s;

  v_n := coalesce(array_length(v_standings, 1), 0);
  if v_n <> 16 then
    raise exception '_cash_ladder_resolve_season_end_internal: expected 16 players in this season, found %', v_n;
  end if;

  v_top3 := v_standings[1:3];
  v_bottom3 := v_standings[14:16];
  v_stayers := v_standings[4:13];

  update cash_ladder_memberships set status = 'promoted'
  where league_id = p_league_id and week_number = v_season and user_id = any(v_top3);
  update cash_ladder_memberships set status = 'relegated'
  where league_id = p_league_id and week_number = v_season and user_id = any(v_bottom3);
  update cash_ladder_memberships set status = 'completed'
  where league_id = p_league_id and week_number = v_season and user_id = any(v_stayers);

  v_next_season := v_season + 1;

  select * into v_up_league from cash_ladder_leagues where tier = v_league.tier + 1 and status = 'active';
  select * into v_down_league from cash_ladder_leagues where tier = v_league.tier - 1 and status = 'active';

  foreach v_uid in array v_top3 loop
    if v_up_league.id is not null then
      v_fee := _cash_ladder_entry_fee_for_tier(v_league.tier);
      if v_fee > 0 then
        select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_uid;
        if coalesce(v_balance, 0) >= v_fee then
          perform _nets_debit_internal(v_uid, v_fee, 'cash_ladder_entry_fee', null, 'cash_ladder_season', p_league_id::text);
          perform _ladder_pool_credit(v_fee, 'cash_ladder_entry_fee', v_uid, 'cash_ladder_season', p_league_id::text);
          insert into cash_ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned, payment_status)
          values (v_uid, v_season, p_league_id, 'entry', v_fee, true, 'paid');
        end if;
      end if;
      insert into cash_ladder_memberships (user_id, league_id, week_number, status)
      values (v_uid, v_up_league.id, v_up_league.current_season + 1, 'active')
      on conflict (league_id, week_number, user_id) do nothing;
    else
      insert into cash_ladder_memberships (user_id, league_id, week_number, status)
      values (v_uid, p_league_id, v_next_season, 'active')
      on conflict (league_id, week_number, user_id) do nothing;
    end if;
  end loop;

  foreach v_uid in array (v_stayers || v_bottom3) loop
    select coalesce(sum(amount), 0) into v_earnings
    from nets_transactions
    where user_id = v_uid and ref_type = 'cash_ladder_fixture' and reason = 'cash_ladder_match_reward'
      and ref_id in (select id::text from cash_ladder_fixtures where league_id = p_league_id and week_number = v_season);

    v_fee := round(v_earnings * 0.20);
    if v_fee > 0 then
      select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_uid;
      if coalesce(v_balance, 0) >= v_fee then
        perform _nets_debit_internal(v_uid, v_fee, 'cash_ladder_table_fee', null, 'cash_ladder_season', p_league_id::text);
        perform _ladder_pool_credit(v_fee, 'cash_ladder_table_fee', v_uid, 'cash_ladder_season', p_league_id::text);
        insert into cash_ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned, payment_status)
        values (v_uid, v_season, p_league_id, 'table', v_fee, false, 'paid');
      end if;
    end if;
  end loop;

  foreach v_uid in array v_stayers loop
    insert into cash_ladder_memberships (user_id, league_id, week_number, status)
    values (v_uid, p_league_id, v_next_season, 'active')
    on conflict (league_id, week_number, user_id) do nothing;
  end loop;

  foreach v_uid in array v_bottom3 loop
    if v_down_league.id is not null then
      insert into cash_ladder_memberships (user_id, league_id, week_number, status)
      values (v_uid, v_down_league.id, v_down_league.current_season + 1, 'active')
      on conflict (league_id, week_number, user_id) do nothing;
    else
      insert into cash_ladder_memberships (user_id, league_id, week_number, status)
      values (v_uid, p_league_id, v_next_season, 'active')
      on conflict (league_id, week_number, user_id) do nothing;
    end if;
  end loop;

  perform _cash_ladder_check_and_start_season_internal(p_league_id, v_next_season);
  if v_up_league.id is not null then
    perform _cash_ladder_check_and_start_season_internal(v_up_league.id, v_up_league.current_season + 1);
  end if;
  if v_down_league.id is not null then
    perform _cash_ladder_check_and_start_season_internal(v_down_league.id, v_down_league.current_season + 1);
  end if;
end;
$function$;

create or replace function admin_resolve_cash_ladder_season(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_resolve_cash_ladder_season: admin only';
  end if;
  perform _cash_ladder_resolve_season_end_internal(p_league_id);
end;
$function$;
