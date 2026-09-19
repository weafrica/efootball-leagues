-- cash_ladder_result_submission_and_withdrawal
-- Match result submission/confirmation flow (mirrors the free ladder exactly,
-- triggers the Nets reward payout on approval) + real-money withdrawal:
-- players request a Goats -> Rand payout, admin pays manually and marks it
-- paid (same proof-based pattern as top-ups), or rejects (auto-refunds Goats).

create or replace function submit_cash_ladder_fixture_result(
  p_fixture_id uuid, p_home_score integer, p_away_score integer, p_proof_url text default null
) returns cash_ladder_fixture_result_submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_fixture cash_ladder_fixtures%rowtype;
  v_locked boolean;
  v_submission cash_ladder_fixture_result_submissions%rowtype;
begin
  if v_user_id is null then
    raise exception 'submit_cash_ladder_fixture_result: must be signed in';
  end if;
  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'submit_cash_ladder_fixture_result: scores must be non-negative';
  end if;

  select * into v_fixture from cash_ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'submit_cash_ladder_fixture_result: fixture not found';
  end if;
  if v_fixture.status <> 'pending' then
    raise exception 'submit_cash_ladder_fixture_result: fixture is not pending';
  end if;

  v_is_admin := exists (select 1 from admins a where a.user_id = v_user_id);

  if not v_is_admin and v_user_id <> v_fixture.home_user_id and v_user_id <> v_fixture.away_user_id then
    raise exception 'submit_cash_ladder_fixture_result: not a participant in this fixture';
  end if;

  select fixtures_locked into v_locked from cash_ladder_cycle where id = true;
  if v_locked and not v_is_admin then
    raise exception 'submit_cash_ladder_fixture_result: fixtures are locked for this week';
  end if;

  if exists (
    select 1 from cash_ladder_fixture_result_submissions
    where fixture_id = p_fixture_id and status = 'pending'
  ) then
    raise exception 'submit_cash_ladder_fixture_result: a result is already awaiting confirmation for this fixture';
  end if;

  insert into cash_ladder_fixture_result_submissions (fixture_id, submitted_by, home_score, away_score, proof_url)
  values (p_fixture_id, v_user_id, p_home_score, p_away_score, p_proof_url)
  returning * into v_submission;

  return v_submission;
end;
$function$;

create or replace function respond_to_cash_ladder_fixture_result_submission(p_submission_id uuid, p_accept boolean)
returns cash_ladder_fixture_result_submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_sub cash_ladder_fixture_result_submissions%rowtype;
  v_fixture cash_ladder_fixtures%rowtype;
begin
  if v_user_id is null then
    raise exception 'respond_to_cash_ladder_fixture_result_submission: must be signed in';
  end if;

  select * into v_sub from cash_ladder_fixture_result_submissions where id = p_submission_id for update;
  if v_sub.id is null then
    raise exception 'respond_to_cash_ladder_fixture_result_submission: submission not found';
  end if;
  if v_sub.status <> 'pending' then
    raise exception 'respond_to_cash_ladder_fixture_result_submission: this result has already been resolved';
  end if;

  select * into v_fixture from cash_ladder_fixtures where id = v_sub.fixture_id for update;
  if v_fixture.id is null then
    raise exception 'respond_to_cash_ladder_fixture_result_submission: fixture not found';
  end if;

  if v_user_id <> v_fixture.home_user_id and v_user_id <> v_fixture.away_user_id then
    raise exception 'respond_to_cash_ladder_fixture_result_submission: not a participant in this fixture';
  end if;
  if v_user_id = v_sub.submitted_by then
    raise exception 'respond_to_cash_ladder_fixture_result_submission: you cannot confirm your own submission — waiting on the other player';
  end if;

  if p_accept then
    if v_fixture.status <> 'pending' then
      update cash_ladder_fixture_result_submissions
      set status = 'rejected', reviewed_by = v_user_id, reviewed_at = now()
      where id = p_submission_id
      returning * into v_sub;
      return v_sub;
    end if;

    update cash_ladder_fixtures
    set home_score = v_sub.home_score, away_score = v_sub.away_score,
        status = 'played', played_at = now()
    where id = v_fixture.id;

    update cash_ladder_fixture_result_submissions
    set status = 'approved', reviewed_by = v_user_id, reviewed_at = now()
    where id = p_submission_id
    returning * into v_sub;

    perform _credit_cash_ladder_match_reward_internal(v_fixture.id);
  else
    update cash_ladder_fixture_result_submissions
    set status = 'rejected', reviewed_by = v_user_id, reviewed_at = now()
    where id = p_submission_id
    returning * into v_sub;
  end if;

  return v_sub;
end;
$function$;

create or replace function _admin_approve_cash_ladder_fixture_result_internal(p_submission_id uuid, p_admin_user_id uuid)
returns cash_ladder_fixture_result_submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sub cash_ladder_fixture_result_submissions%rowtype;
  v_fixture cash_ladder_fixtures%rowtype;
begin
  select * into v_sub from cash_ladder_fixture_result_submissions where id = p_submission_id for update;
  if v_sub.id is null then
    raise exception '_admin_approve_cash_ladder_fixture_result_internal: submission not found';
  end if;
  if v_sub.status <> 'pending' then
    raise exception '_admin_approve_cash_ladder_fixture_result_internal: this result has already been resolved';
  end if;

  select * into v_fixture from cash_ladder_fixtures where id = v_sub.fixture_id for update;
  if v_fixture.id is null then
    raise exception '_admin_approve_cash_ladder_fixture_result_internal: fixture not found';
  end if;

  if v_fixture.status <> 'pending' then
    update cash_ladder_fixture_result_submissions
    set status = 'rejected', reviewed_by = p_admin_user_id, reviewed_at = now()
    where id = p_submission_id
    returning * into v_sub;
    return v_sub;
  end if;

  update cash_ladder_fixtures
  set home_score = v_sub.home_score, away_score = v_sub.away_score,
      status = 'played', played_at = now()
  where id = v_fixture.id;

  update cash_ladder_fixture_result_submissions
  set status = 'approved', reviewed_by = p_admin_user_id, reviewed_at = now()
  where id = p_submission_id
  returning * into v_sub;

  perform _credit_cash_ladder_match_reward_internal(v_fixture.id);

  return v_sub;
end;
$function$;

create or replace function admin_approve_cash_ladder_fixture_result(p_submission_id uuid)
returns cash_ladder_fixture_result_submissions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_approve_cash_ladder_fixture_result: admin only';
  end if;
  return _admin_approve_cash_ladder_fixture_result_internal(p_submission_id, v_admin_id);
end;
$function$;

create or replace function request_cash_ladder_goats_withdrawal(p_amount_goats bigint, p_payout_method text default null)
returns cash_ladder_reward_payout_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_row cash_ladder_reward_payout_queue%rowtype;
begin
  if v_user_id is null then
    raise exception 'request_cash_ladder_goats_withdrawal: must be signed in';
  end if;
  if p_amount_goats is null or p_amount_goats <= 0 then
    raise exception 'request_cash_ladder_goats_withdrawal: amount must be positive';
  end if;

  perform _cash_ladder_goats_debit_internal(
    v_user_id, p_amount_goats, 'cash_ladder_withdrawal_request', null, 'cash_ladder_withdrawal', null
  );

  insert into cash_ladder_reward_payout_queue (user_id, amount, reason, ref_type, status, payout_method)
  values (v_user_id, p_amount_goats, 'withdrawal', 'cash_ladder_goats_wallet', 'pending', p_payout_method)
  returning * into v_row;

  return v_row;
end;
$function$;

create or replace function admin_mark_cash_ladder_payout_paid(p_payout_id uuid, p_payout_method text, p_payout_reference text)
returns cash_ladder_reward_payout_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_row cash_ladder_reward_payout_queue%rowtype;
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_mark_cash_ladder_payout_paid: admin only';
  end if;

  update cash_ladder_reward_payout_queue
  set status = 'paid', paid_at = now(), paid_by = v_admin_id,
      payout_method = coalesce(p_payout_method, payout_method), payout_reference = p_payout_reference
  where id = p_payout_id and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'admin_mark_cash_ladder_payout_paid: payout not found or not pending';
  end if;

  return v_row;
end;
$function$;

create or replace function admin_reject_cash_ladder_payout(p_payout_id uuid, p_note text default null)
returns cash_ladder_reward_payout_queue
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_row cash_ladder_reward_payout_queue%rowtype;
  v_user_id uuid;
  v_amount bigint;
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_reject_cash_ladder_payout: admin only';
  end if;

  select user_id, amount into v_user_id, v_amount
  from cash_ladder_reward_payout_queue where id = p_payout_id and status = 'pending' for update;
  if v_user_id is null then
    raise exception 'admin_reject_cash_ladder_payout: payout not found or not pending';
  end if;

  perform _cash_ladder_goats_credit_internal(
    v_user_id, v_amount, 'cash_ladder_withdrawal_rejected_refund', p_note, 'cash_ladder_withdrawal', p_payout_id::text
  );

  update cash_ladder_reward_payout_queue
  set status = 'rejected', paid_by = v_admin_id
  where id = p_payout_id
  returning * into v_row;

  return v_row;
end;
$function$;
