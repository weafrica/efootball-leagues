-- cash_ladder_stake_weighted_prize_payout
-- Adapts Rapid Cup's "stake more (relative to the season's biggest entry),
-- win more" bonus mechanic to Cash Ladder's 3-winner shape, at explicit
-- request: the goal is giving players who can afford bigger entries a
-- reason to actually pay more, rather than everyone paying the minimum.
--
-- Every top-3 finisher gets their own entry fee back first (a guaranteed
-- floor for placing). What's left is split among the 3 using each
-- finisher's placement weight (50/20/15, same ratio as before) multiplied
-- by their own entry relative to the single biggest entry paid by ANYONE
-- in that season -- exactly Rapid Cup's bonus_share formula, generalized
-- from 1 winner to 3. The organizer's cut of the leftover stays a flat 15%,
-- taken before the winners' bonus split (unchanged from before).
--
-- Verified with a live test before shipping: pool 1000, entries 50/20/20
-- for 1st/2nd/3rd and a non-placing 200 entry setting the cap -> payouts
-- came out 654/116/94 plus 136 to the organizer, summing exactly to the
-- pool, confirming the math.
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
  v_entry_1 bigint;
  v_entry_2 bigint;
  v_entry_3 bigint;
  v_max_entry bigint;
  v_base_sum bigint;
  v_remaining bigint;
  v_organizer_cut bigint;
  v_winners_pool bigint;
  v_bonus_share_1 numeric;
  v_bonus_share_2 numeric;
  v_bonus_share_3 numeric;
  v_raw_1 numeric;
  v_raw_2 numeric;
  v_raw_3 numeric;
  v_raw_total numeric;
  v_bonus_1 bigint;
  v_bonus_2 bigint;
  v_bonus_3 bigint;
  v_payout_1 bigint;
  v_payout_2 bigint;
  v_payout_3 bigint;
  v_paid_total bigint;
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

  select coalesce(amount, 0) into v_entry_1 from cash_ladder_fee_events
    where league_id = p_league_id and user_id = p_first_user_id and fee_type = 'entry' order by created_at desc limit 1;
  select coalesce(amount, 0) into v_entry_2 from cash_ladder_fee_events
    where league_id = p_league_id and user_id = p_second_user_id and fee_type = 'entry' order by created_at desc limit 1;
  select coalesce(amount, 0) into v_entry_3 from cash_ladder_fee_events
    where league_id = p_league_id and user_id = p_third_user_id and fee_type = 'entry' order by created_at desc limit 1;

  select coalesce(max(amount), 0) into v_max_entry
    from cash_ladder_fee_events where league_id = p_league_id and fee_type = 'entry';

  v_base_sum := coalesce(v_entry_1, 0) + coalesce(v_entry_2, 0) + coalesce(v_entry_3, 0);
  v_remaining := greatest(v_pool - v_base_sum, 0);

  v_organizer_cut := floor(v_remaining * 0.15)::bigint;
  v_winners_pool := v_remaining - v_organizer_cut;

  if v_max_entry > 0 then
    v_bonus_share_1 := v_entry_1::numeric / v_max_entry;
    v_bonus_share_2 := v_entry_2::numeric / v_max_entry;
    v_bonus_share_3 := v_entry_3::numeric / v_max_entry;
  else
    v_bonus_share_1 := 0; v_bonus_share_2 := 0; v_bonus_share_3 := 0;
  end if;

  v_raw_1 := 0.50 * v_bonus_share_1;
  v_raw_2 := 0.20 * v_bonus_share_2;
  v_raw_3 := 0.15 * v_bonus_share_3;
  v_raw_total := v_raw_1 + v_raw_2 + v_raw_3;

  if v_raw_total > 0 then
    v_bonus_1 := floor(v_winners_pool * v_raw_1 / v_raw_total)::bigint;
    v_bonus_2 := floor(v_winners_pool * v_raw_2 / v_raw_total)::bigint;
    v_bonus_3 := v_winners_pool - v_bonus_1 - v_bonus_2;
  else
    v_bonus_1 := floor(v_winners_pool * 0.50 / 0.85)::bigint;
    v_bonus_2 := floor(v_winners_pool * 0.20 / 0.85)::bigint;
    v_bonus_3 := v_winners_pool - v_bonus_1 - v_bonus_2;
  end if;

  v_payout_1 := v_entry_1 + v_bonus_1;
  v_payout_2 := v_entry_2 + v_bonus_2;
  v_payout_3 := v_entry_3 + v_bonus_3;
  v_paid_total := v_payout_1 + v_payout_2 + v_payout_3 + v_organizer_cut;

  if v_payout_1 > 0 then
    perform _cash_ladder_goats_credit_internal(p_first_user_id, v_payout_1, 'cash_ladder_prize_1st', null, 'cash_ladder_league', p_league_id::text);
  end if;
  if v_payout_2 > 0 then
    perform _cash_ladder_goats_credit_internal(p_second_user_id, v_payout_2, 'cash_ladder_prize_2nd', null, 'cash_ladder_league', p_league_id::text);
  end if;
  if v_payout_3 > 0 then
    perform _cash_ladder_goats_credit_internal(p_third_user_id, v_payout_3, 'cash_ladder_prize_3rd', null, 'cash_ladder_league', p_league_id::text);
  end if;
  if v_organizer_cut > 0 then
    perform _cash_ladder_goats_credit_internal(p_organizer_user_id, v_organizer_cut, 'cash_ladder_prize_organizer', null, 'cash_ladder_league', p_league_id::text);
  end if;

  update cash_ladder_leagues
  set pool_balance = pool_balance - v_paid_total, prizes_paid_at = now()
  where id = p_league_id
  returning * into v_league;

  return v_league;
end;
$function$;
