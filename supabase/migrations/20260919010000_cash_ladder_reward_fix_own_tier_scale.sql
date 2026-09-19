-- cash_ladder_reward_fix_own_tier_scale
-- BUGFIX found via live testing: match rewards were being sized using the
-- FREE ladder's tier range (_ladder_current_max_tier_internal /
-- _ladder_match_reward_for_tier), while the cash league's own tier number
-- is just a sequential batch counter (1, 2, 3...) in a totally different
-- numbering space. Mixing the two hugely inflated payouts in testing
-- (8 Nets instead of the correct 5 for a base-tier cash league).
-- Fix: reward sizing now uses the cash-ladder-specific tier functions
-- built earlier (_cash_ladder_match_reward_for_tier etc.) -- same formula
-- shape, but measured within the cash ladder's own tier space. The actual
-- Nets wallet + shared reward pool stay shared with the free ladder, as
-- intended -- only the SIZE of the reward was wrong, not where it's paid from.

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
  v_max_tier := _cash_ladder_current_max_tier_internal();
  v_reward := _cash_ladder_match_reward_for_tier(v_tier);

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
    v_early_bonus := _cash_ladder_early_bonus_for_tier(v_tier);
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

    v_bonus := _cash_ladder_streak_bonus_for_tier(v_tier, v_new_streak);
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
      v_fee := _cash_ladder_entry_fee_for_tier(v_row.league_tier - 1);
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
