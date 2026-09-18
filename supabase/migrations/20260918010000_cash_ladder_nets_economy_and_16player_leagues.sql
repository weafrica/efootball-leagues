-- cash_ladder_nets_economy_and_16player_leagues
-- Reworks the Cash Ladder to match the corrected design:
--   - Day-to-day match economy (per-fixture rewards, weekly table fee/promotion
--     fee) now runs on the SAME Nets wallet + SAME shared reward pool as the
--     free ladder -- identical formulas, no separate Goats accounting for this.
--   - A Cash Ladder league only "starts" once 16 players have joined. Entries
--     before that sit in a 'forming' league; hitting 16 flips it to 'active'.
--     Entries beyond 16 open a fresh 'forming' league automatically.
--   - Each league now escrows its OWN real-money (Goats) prize pool
--     (cash_ladder_leagues.pool_balance), funded by that league's own
--     entrants -- not the old shared global cash_ladder_pool.
--   - New: finalize_cash_ladder_league_prize_pool() pays that league's pool
--     out 50% / 20% / 15% / 15% (1st / 2nd / 3rd / organizer).
--
-- NOTE on "organizer": there's no per-league organizer role in this schema
-- (unlike the separate Fun Leagues feature), so this treats the 15% as a
-- platform/house cut -- the admin passes whichever user_id should receive it
-- at finalize time. Flag if that's not what you meant.

alter table cash_ladder_leagues add column if not exists pool_balance bigint not null default 0;
alter table cash_ladder_leagues add column if not exists roster_target integer not null default 16;
alter table cash_ladder_leagues add column if not exists prizes_paid_at timestamptz;
alter table cash_ladder_pool_transactions add column if not exists league_id uuid;

alter table cash_ladder_leagues drop constraint ladder_leagues_status_check;
alter table cash_ladder_leagues add constraint cash_ladder_leagues_status_check
  check (status = any (array['forming','active','completed','archived']));

create or replace function _cash_ladder_target_league_and_week()
returns table(league_id uuid, week_number integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_league_id uuid;
  v_roster_count integer;
begin
  select cl.id into v_league_id
  from cash_ladder_leagues cl
  where cl.status = 'forming'
  order by cl.tier asc
  limit 1
  for update;

  if v_league_id is null then
    insert into cash_ladder_leagues (tier, status)
    values (coalesce((select max(tier) from cash_ladder_leagues), 0) + 1, 'forming')
    returning id into v_league_id;
  end if;

  select count(*) into v_roster_count
  from cash_ladder_memberships m
  where m.league_id = v_league_id and m.status = 'active';

  if v_roster_count >= 16 then
    insert into cash_ladder_leagues (tier, status)
    values (coalesce((select max(tier) from cash_ladder_leagues), 0) + 1, 'forming')
    returning id into v_league_id;
  end if;

  return query select v_league_id, 1;
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
    -- fixture generation for a just-started 16-player cash league still needs to be built.
  end if;

  return v_row;
end;
$function$;

create or replace function _credit_cash_ladder_match_reward_internal(p_fixture_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_fixture cash_ladder_fixtures%rowtype;
  v_tier integer;
  v_max_tier integer;
  v_reward bigint;
  v_early_bonus bigint;
  v_winner uuid;
  v_loser uuid;
  v_is_draw boolean;
  v_new_streak integer;
  v_bonus bigint;
begin
  select * into v_fixture from cash_ladder_fixtures where id = p_fixture_id;
  if v_fixture.id is null then
    raise exception '_credit_cash_ladder_match_reward_internal: fixture not found';
  end if;

  select tier into v_tier from cash_ladder_leagues where id = v_fixture.league_id;
  v_max_tier := _ladder_current_max_tier_internal();
  v_reward := _ladder_match_reward_for_tier(v_tier);

  perform _nets_credit_internal(
    v_fixture.home_user_id, v_reward, 'cash_ladder_match_reward', null, 'cash_ladder_fixture', v_fixture.id::text
  );
  perform _nets_credit_internal(
    v_fixture.away_user_id, v_reward, 'cash_ladder_match_reward', null, 'cash_ladder_fixture', v_fixture.id::text
  );
  perform _ladder_pool_reward_debit(
    v_reward, 'cash_ladder_match_reward', v_fixture.home_user_id, 'cash_ladder_fixture', v_fixture.id::text
  );
  perform _ladder_pool_reward_debit(
    v_reward, 'cash_ladder_match_reward', v_fixture.away_user_id, 'cash_ladder_fixture', v_fixture.id::text
  );

  if v_fixture.leg = 1 then
    v_early_bonus := _ladder_early_bonus_for_tier(v_tier);
    if v_early_bonus > 0 then
      perform _nets_credit_internal(
        v_fixture.home_user_id, v_early_bonus, 'cash_ladder_early_bonus', null, 'cash_ladder_fixture', v_fixture.id::text
      );
      perform _nets_credit_internal(
        v_fixture.away_user_id, v_early_bonus, 'cash_ladder_early_bonus', null, 'cash_ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_reward_debit(
        v_early_bonus, 'cash_ladder_early_bonus', v_fixture.home_user_id, 'cash_ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_reward_debit(
        v_early_bonus, 'cash_ladder_early_bonus', v_fixture.away_user_id, 'cash_ladder_fixture', v_fixture.id::text
      );
    end if;
  end if;

  insert into cash_ladder_reward_ledger
    (fixture_id, user_id, league_id, week_number, tier, max_tier_at_credit, paid_at_d, reward_amount)
  values
    (v_fixture.id, v_fixture.home_user_id, v_fixture.league_id, v_fixture.week_number, v_tier, v_max_tier, v_max_tier - v_tier, v_reward),
    (v_fixture.id, v_fixture.away_user_id, v_fixture.league_id, v_fixture.week_number, v_tier, v_max_tier, v_max_tier - v_tier, v_reward)
  on conflict (fixture_id, user_id) do nothing;

  if v_fixture.home_score = v_fixture.away_score then
    v_is_draw := true;
  else
    v_is_draw := false;
    if v_fixture.home_score > v_fixture.away_score then
      v_winner := v_fixture.home_user_id; v_loser := v_fixture.away_user_id;
    else
      v_winner := v_fixture.away_user_id; v_loser := v_fixture.home_user_id;
    end if;
  end if;

  if v_is_draw then
    update cash_ladder_memberships set win_streak = 0
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id in (v_fixture.home_user_id, v_fixture.away_user_id);
  else
    update cash_ladder_memberships set win_streak = 0
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id = v_loser;

    update cash_ladder_memberships set win_streak = win_streak + 1
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id = v_winner
    returning win_streak into v_new_streak;

    v_bonus := _ladder_streak_bonus_for_tier(v_tier, v_new_streak);
    if v_bonus > 0 then
      perform _nets_credit_internal(
        v_winner, v_bonus, 'cash_ladder_streak_bonus', null, 'cash_ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_reward_debit(
        v_bonus, 'cash_ladder_streak_bonus', v_winner, 'cash_ladder_fixture', v_fixture.id::text
      );
    end if;
  end if;
end;
$function$;

create or replace function _cash_ladder_settle_week_fees_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row record;
  v_fee bigint;
  v_earnings bigint;
  v_fee_type text;
  v_reason text;
  v_balance bigint;
begin
  for v_row in
    select m.user_id, m.status, m.league_id, l.tier as league_tier
    from cash_ladder_memberships m
    join cash_ladder_leagues l on l.id = m.league_id
    where m.week_number = p_week_number
      and m.status in ('active', 'promoted')
  loop
    if v_row.status = 'promoted' then
      v_fee_type := 'entry';
      v_reason := 'cash_ladder_entry_fee';
      v_fee := _ladder_entry_fee_for_tier(v_row.league_tier - 1);
      if v_fee <= 0 then
        continue;
      end if;
    else
      select coalesce(sum(amount), 0) into v_earnings
      from nets_transactions
      where user_id = v_row.user_id
        and ref_type = 'cash_ladder_fixture'
        and reason = 'cash_ladder_match_reward'
        and ref_id in (
          select id::text from cash_ladder_fixtures where week_number = p_week_number
        );

      v_fee := round(v_earnings * 0.20);
      if v_fee <= 0 then
        continue;
      end if;
      v_fee_type := 'table';
      v_reason := 'cash_ladder_table_fee';
    end if;

    if exists (
      select 1 from cash_ladder_fee_events
      where user_id = v_row.user_id and week_number = p_week_number and fee_type = v_fee_type
    ) then
      continue;
    end if;

    select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_row.user_id;
    if coalesce(v_balance, 0) < v_fee then
      continue;
    end if;

    perform _nets_debit_internal(
      v_row.user_id, v_fee, v_reason, null, 'cash_ladder_week', p_week_number::text
    );
    perform _ladder_pool_credit(
      v_fee, v_reason, v_row.user_id, 'cash_ladder_week', p_week_number::text
    );

    insert into cash_ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned, payment_status)
    values (v_row.user_id, p_week_number, v_row.league_id, v_fee_type, v_fee, v_row.status = 'promoted', 'paid');
  end loop;
end;
$function$;

create or replace function finalize_cash_ladder_league_prize_pool(
  p_league_id uuid,
  p_first_user_id uuid,
  p_second_user_id uuid,
  p_third_user_id uuid,
  p_organizer_user_id uuid
) returns cash_ladder_leagues
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_league cash_ladder_leagues%rowtype;
  v_pool bigint;
  v_first bigint;
  v_second bigint;
  v_third bigint;
  v_organizer bigint;
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'finalize_cash_ladder_league_prize_pool: admin only';
  end if;

  select * into v_league from cash_ladder_leagues where id = p_league_id for update;
  if v_league.id is null then
    raise exception 'finalize_cash_ladder_league_prize_pool: league not found';
  end if;
  if v_league.prizes_paid_at is not null then
    raise exception 'finalize_cash_ladder_league_prize_pool: prizes already paid for this league';
  end if;

  v_pool := v_league.pool_balance;
  if v_pool <= 0 then
    update cash_ladder_leagues set prizes_paid_at = now() where id = p_league_id returning * into v_league;
    return v_league;
  end if;

  v_first := floor(v_pool * 0.50)::bigint;
  v_second := floor(v_pool * 0.20)::bigint;
  v_third := floor(v_pool * 0.15)::bigint;
  v_organizer := v_pool - v_first - v_second - v_third; -- remainder (>= 15%) absorbs rounding

  if v_first > 0 then
    perform _cash_ladder_goats_credit_internal(p_first_user_id, v_first, 'cash_ladder_prize_1st', null, 'cash_ladder_league', p_league_id::text);
  end if;
  if v_second > 0 then
    perform _cash_ladder_goats_credit_internal(p_second_user_id, v_second, 'cash_ladder_prize_2nd', null, 'cash_ladder_league', p_league_id::text);
  end if;
  if v_third > 0 then
    perform _cash_ladder_goats_credit_internal(p_third_user_id, v_third, 'cash_ladder_prize_3rd', null, 'cash_ladder_league', p_league_id::text);
  end if;
  if v_organizer > 0 then
    perform _cash_ladder_goats_credit_internal(p_organizer_user_id, v_organizer, 'cash_ladder_prize_organizer', null, 'cash_ladder_league', p_league_id::text);
  end if;

  update cash_ladder_leagues
  set pool_balance = 0, prizes_paid_at = now()
  where id = p_league_id
  returning * into v_league;

  return v_league;
end;
$function$;
