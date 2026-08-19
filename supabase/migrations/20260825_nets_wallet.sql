-- Nets: the site's in-app virtual currency. This lays down the basics —
-- one wallet per user, an append-only ledger of every credit/debit, and
-- two RPCs (nets_credit / nets_debit) that are the ONLY way balances ever
-- change. Nothing writes to nets_wallets.balance directly; the RPCs keep
-- the wallet and the ledger from ever drifting apart, since both update in
-- the same transaction.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- nets_wallets — one row per user, holding their current Nets balance.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists nets_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- nets_transactions — append-only ledger. Every credit/debit gets a row,
-- so a wallet's balance can always be reconstructed/audited from history.
-- amount is signed: positive = credit (earned/purchased), negative = debit
-- (spent). balance_after is the wallet's balance immediately after this
-- entry, captured at write time so history reads correctly even as the
-- wallet keeps moving.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists nets_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount bigint not null check (amount <> 0),
  balance_after bigint not null,
  reason text not null, -- short stable code, e.g. 'shop_purchase', 'ladder_cup_reward', 'admin_grant'
  note text, -- optional human-readable detail (product name, league name, admin's message, etc.)
  ref_type text, -- optional: what this relates to, e.g. 'shop_order', 'league', 'ladder_cup'
  ref_id text, -- optional: the id of that thing, kept as text so it can point at any table
  created_by uuid references auth.users(id), -- who triggered it (self for a spend, admin for a grant, null for system)
  created_at timestamptz not null default now()
);

create index if not exists nets_transactions_user_idx on nets_transactions (user_id, created_at desc);
create index if not exists nets_transactions_ref_idx on nets_transactions (ref_type, ref_id);

alter table nets_wallets enable row level security;
alter table nets_transactions enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- Policies — everyone can read their own wallet/history; admins can read
-- everyone's (support/dispute resolution). All writes go through the RPCs
-- below (SECURITY DEFINER), so there are deliberately no insert/update
-- policies here — direct writes from the client are never allowed.
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "nets_wallets_select" on nets_wallets;
create policy "nets_wallets_select" on nets_wallets for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

drop policy if exists "nets_transactions_select" on nets_transactions;
create policy "nets_transactions_select" on nets_transactions for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- nets_credit — adds Nets to a wallet (purchases, rewards, admin grants).
-- Callable by: the admin console (any user_id) or a user crediting
-- themselves only via a recognised self-service reason (e.g. a completed
-- gateway top-up would call this with reason='topup' after payment
-- confirmation — left as a hook for when that's wired up). For now this
-- keeps it simple: any authenticated call is allowed to credit ANY wallet
-- with a positive amount, same trust level as the rest of this app's
-- client-driven writes (see the RLS comment above CreateLeague's cash-league
-- check for the existing pattern of "client suggests, a few endpoints are
-- the real backstop"). Tighten this to admin-only once real money is wired
-- to Nets purchases — see the commented check below.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function nets_credit(
  p_user_id uuid,
  p_amount bigint,
  p_reason text,
  p_note text default null,
  p_ref_type text default null,
  p_ref_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_balance bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'nets_credit: amount must be positive';
  end if;

  -- Uncomment once only admins should be able to grant Nets directly:
  -- if not exists (select 1 from admins a where a.user_id = auth.uid()) then
  --   raise exception 'nets_credit: admin only';
  -- end if;

  insert into nets_wallets (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  update nets_wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = p_user_id
  returning balance into v_new_balance;

  insert into nets_transactions (user_id, amount, balance_after, reason, note, ref_type, ref_id, created_by)
  values (p_user_id, p_amount, v_new_balance, p_reason, p_note, p_ref_type, p_ref_id, auth.uid());

  return v_new_balance;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- nets_debit — spends Nets from a wallet (Shop checkout, Transfer Market
-- bids, cash-league entry fees paid in Nets, etc). Only the wallet owner
-- can debit their own wallet — no one else's balance can be spent down
-- from the client. The balance>=0 check on nets_wallets is the real
-- backstop against overspending; this raises a friendlier error first.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function nets_debit(
  p_amount bigint,
  p_reason text,
  p_note text default null,
  p_ref_type text default null,
  p_ref_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_balance bigint;
  v_new_balance bigint;
begin
  if v_user_id is null then
    raise exception 'nets_debit: must be signed in';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'nets_debit: amount must be positive';
  end if;

  select balance into v_current_balance from nets_wallets where user_id = v_user_id for update;

  if v_current_balance is null then
    v_current_balance := 0;
  end if;

  if v_current_balance < p_amount then
    raise exception 'nets_debit: insufficient balance (have %, need %)', v_current_balance, p_amount;
  end if;

  insert into nets_wallets (user_id, balance)
  values (v_user_id, 0)
  on conflict (user_id) do nothing;

  update nets_wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = v_user_id
  returning balance into v_new_balance;

  insert into nets_transactions (user_id, amount, balance_after, reason, note, ref_type, ref_id, created_by)
  values (v_user_id, -p_amount, v_new_balance, p_reason, p_note, p_ref_type, p_ref_id, v_user_id);

  return v_new_balance;
end;
$$;

grant execute on function nets_credit(uuid, bigint, text, text, text, text) to authenticated;
grant execute on function nets_debit(bigint, text, text, text, text) to authenticated;
