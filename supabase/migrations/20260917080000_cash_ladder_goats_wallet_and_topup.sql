-- cash_ladder_goats_wallet_and_topup
-- Goats wallet + real-money top-up intake (admin-reviewed, matching the
-- payment-proof pattern already used by cash_ladder_fee_events), plus the
-- functions that turn an approved top-up into: entry fee spent now +
-- balance banked for next cycle.

create table cash_ladder_goats_wallet (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table cash_ladder_goats_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount bigint not null,
  balance_after bigint not null,
  reason text not null,
  ref_type text,
  ref_id text,
  created_at timestamptz not null default now()
);
create index cash_ladder_goats_transactions_user_id_created_at_idx on cash_ladder_goats_transactions (user_id, created_at desc);

create table cash_ladder_goats_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_rand numeric not null check (amount_rand > 0),
  total_goats bigint not null,
  entry_fee_goats bigint not null,
  balance_goats bigint not null,
  checkout_method text,
  payment_proof_path text,
  gateway_reference text,
  payment_status text not null default 'pending_review'
    check (payment_status in ('pending_review','approved','rejected')),
  admin_reviewed_by uuid references auth.users(id),
  admin_reviewed_at timestamptz,
  admin_note text,
  target_league_id uuid,
  target_week_number integer,
  created_at timestamptz not null default now()
);
create index cash_ladder_goats_topups_user_id_idx on cash_ladder_goats_topups (user_id, created_at desc);
create index cash_ladder_goats_topups_status_idx on cash_ladder_goats_topups (payment_status);

alter table cash_ladder_goats_wallet enable row level security;
alter table cash_ladder_goats_transactions enable row level security;
alter table cash_ladder_goats_topups enable row level security;

create policy cash_ladder_goats_wallet_select on cash_ladder_goats_wallet
  for select to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_goats_transactions_select on cash_ladder_goats_transactions
  for select to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_goats_topups_select on cash_ladder_goats_topups
  for select to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );
create policy cash_ladder_goats_topups_insert on cash_ladder_goats_topups
  for insert to authenticated with check (user_id = auth.uid());

create or replace function _cash_ladder_target_league_and_week()
returns table(league_id uuid, week_number integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_league_id uuid;
  v_current_week integer;
  v_week_started boolean;
  v_target_week integer;
begin
  select id into v_league_id
  from cash_ladder_leagues
  where status = 'active'
  order by tier desc
  limit 1;

  if v_league_id is null then
    raise exception '_cash_ladder_target_league_and_week: no Cash Ladder league is open for entry yet';
  end if;

  select current_week into v_current_week from cash_ladder_cycle where id = true;
  v_current_week := coalesce(v_current_week, 0);

  if v_current_week = 0 then
    v_target_week := 1;
  else
    select exists (
      select 1 from cash_ladder_fixtures
      where league_id = v_league_id and week_number = v_current_week and status in ('played', 'forfeited')
    ) into v_week_started;
    v_target_week := case when v_week_started then v_current_week + 1 else v_current_week end;
  end if;

  return query select v_league_id, v_target_week;
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
  v_pool_balance bigint;
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

  update cash_ladder_pool set balance = balance + p_entry_fee_goats, updated_at = now()
  where id = true
  returning balance into v_pool_balance;

  insert into cash_ladder_pool_transactions (amount, balance_after, reason, ref_type, ref_id, user_id)
  values (p_entry_fee_goats, v_pool_balance, 'goats_entry_fee', p_ref_type, p_ref_id, p_user_id);

  insert into cash_ladder_fee_events (
    user_id, week_number, league_id, fee_type, amount, transitioned,
    checkout_method, payment_status, gateway_reference
  ) values (
    p_user_id, v_week_number, v_league_id, 'goats_entry_fee', p_entry_fee_goats, false,
    p_checkout_method, 'approved', p_gateway_reference
  );

  return v_row;
end;
$function$;

create or replace function submit_cash_ladder_goats_topup(
  p_amount_rand numeric,
  p_checkout_method text default null,
  p_payment_proof_path text default null,
  p_gateway_reference text default null
) returns cash_ladder_goats_topups
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_total_goats bigint;
  v_entry_fee_goats bigint;
  v_balance_goats bigint;
  v_row cash_ladder_goats_topups%rowtype;
begin
  if v_user_id is null then
    raise exception 'submit_cash_ladder_goats_topup: must be signed in';
  end if;
  if p_amount_rand is null or p_amount_rand <= 0 then
    raise exception 'submit_cash_ladder_goats_topup: amount_rand must be positive';
  end if;

  v_total_goats := round(p_amount_rand * 3.8);
  v_entry_fee_goats := round(v_total_goats / 2.0);
  v_balance_goats := v_total_goats - v_entry_fee_goats;

  insert into cash_ladder_goats_topups (
    user_id, amount_rand, total_goats, entry_fee_goats, balance_goats,
    checkout_method, payment_proof_path, gateway_reference
  ) values (
    v_user_id, p_amount_rand, v_total_goats, v_entry_fee_goats, v_balance_goats,
    p_checkout_method, p_payment_proof_path, p_gateway_reference
  )
  returning * into v_row;

  return v_row;
end;
$function$;

create or replace function admin_approve_cash_ladder_goats_topup(p_topup_id uuid)
returns cash_ladder_goats_topups
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_topup cash_ladder_goats_topups%rowtype;
  v_wallet_balance bigint;
  v_already_member boolean;
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_approve_cash_ladder_goats_topup: admin only';
  end if;

  select * into v_topup from cash_ladder_goats_topups where id = p_topup_id for update;
  if v_topup.id is null then
    raise exception 'admin_approve_cash_ladder_goats_topup: topup not found';
  end if;
  if v_topup.payment_status <> 'pending_review' then
    raise exception 'admin_approve_cash_ladder_goats_topup: topup already %', v_topup.payment_status;
  end if;

  insert into cash_ladder_goats_wallet (user_id, balance)
  values (v_topup.user_id, v_topup.total_goats)
  on conflict (user_id) do update
    set balance = cash_ladder_goats_wallet.balance + v_topup.total_goats, updated_at = now()
  returning balance into v_wallet_balance;

  insert into cash_ladder_goats_transactions (user_id, amount, balance_after, reason, ref_type, ref_id)
  values (v_topup.user_id, v_topup.total_goats, v_wallet_balance, 'topup', 'cash_ladder_goats_topups', v_topup.id::text);

  select exists (
    select 1 from cash_ladder_memberships where user_id = v_topup.user_id and status = 'active'
  ) into v_already_member;

  if not v_already_member then
    update cash_ladder_goats_wallet
      set balance = balance - v_topup.entry_fee_goats, updated_at = now()
      where user_id = v_topup.user_id
      returning balance into v_wallet_balance;

    insert into cash_ladder_goats_transactions (user_id, amount, balance_after, reason, ref_type, ref_id)
    values (-v_topup.entry_fee_goats, v_wallet_balance, 'entry_fee', 'cash_ladder_goats_topups', v_topup.id::text);

    perform _cash_ladder_apply_paid_entry(
      v_topup.user_id, v_topup.entry_fee_goats,
      'cash_ladder_goats_topups', v_topup.id::text,
      v_topup.checkout_method, v_topup.gateway_reference
    );
  end if;

  update cash_ladder_goats_topups
    set payment_status = 'approved', admin_reviewed_by = v_admin_id, admin_reviewed_at = now()
    where id = p_topup_id
    returning * into v_topup;

  return v_topup;
end;
$function$;

create or replace function admin_reject_cash_ladder_goats_topup(p_topup_id uuid, p_note text default null)
returns cash_ladder_goats_topups
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_admin_id uuid := auth.uid();
  v_row cash_ladder_goats_topups%rowtype;
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_reject_cash_ladder_goats_topup: admin only';
  end if;

  update cash_ladder_goats_topups
    set payment_status = 'rejected', admin_reviewed_by = v_admin_id, admin_reviewed_at = now(), admin_note = p_note
    where id = p_topup_id and payment_status = 'pending_review'
    returning * into v_row;

  if v_row.id is null then
    raise exception 'admin_reject_cash_ladder_goats_topup: topup not found or not pending review';
  end if;

  return v_row;
end;
$function$;

create or replace function join_cash_ladder_league_from_balance()
returns cash_ladder_memberships
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_user_id uuid := auth.uid();
  v_balance bigint;
  v_wallet_balance bigint;
  v_row cash_ladder_memberships%rowtype;
begin
  if v_user_id is null then
    raise exception 'join_cash_ladder_league_from_balance: must be signed in';
  end if;

  select balance into v_balance from cash_ladder_goats_wallet where user_id = v_user_id;
  if v_balance is null or v_balance <= 0 then
    raise exception 'join_cash_ladder_league_from_balance: no Goats balance — top up first';
  end if;

  update cash_ladder_goats_wallet
    set balance = 0, updated_at = now()
    where user_id = v_user_id
    returning balance into v_wallet_balance;

  insert into cash_ladder_goats_transactions (user_id, amount, balance_after, reason, ref_type, ref_id)
  values (-v_balance, v_wallet_balance, 'entry_fee', 'cash_ladder_memberships', null);

  select * into v_row from _cash_ladder_apply_paid_entry(
    v_user_id, v_balance, 'cash_ladder_goats_wallet', null, null, null
  );

  return v_row;
end;
$function$;
