-- League Ladder — Phase 1, table 5 of 5: ladder_pool + its transaction
-- ledger.
--
-- Per the confirmed §5 economy model, Nets are drawn from and returned to
-- a single shared pool rather than minted fresh per transaction: Entry
-- Fee, Table Fee, and Winning Bid Commission all credit the pool; Match
-- Reward, Placement Bonus, and bid refunds all debit it. Building this
-- now (Phase 1) rather than bolting it on when Phase 4 needs it, per the
-- plan's own reasoning — retrofitting a closed-loop economy after other
-- code already assumes an open one is much harder than starting closed.
--
-- ladder_pool is a singleton: exactly one row, ever. The `id boolean
-- primary key default true check (id)` shape is a standard Postgres
-- singleton-table pattern — it makes a second row impossible at the
-- constraint level (a boolean primary key only has two possible values,
-- and the check forbids the other one), rather than relying on
-- application code to never insert twice.
--
-- _ladder_pool_credit / _ladder_pool_debit mirror _nets_credit_internal's
-- shape (20260831): plain internal functions, never GRANTed to
-- authenticated, reachable only from inside another SECURITY DEFINER
-- function. They don't move money into/out of a *player's* nets_wallets
-- row — that's a separate, still-unbuilt piece (see note below) — they
-- only track the pool's own running balance and audit trail. Phase 4
-- wires these together with the player-facing side.
--
-- NOTE FOR PHASE 4, flagged now while it's fresh: nets_debit() only ever
-- debits auth.uid() (the calling user) — there is no _nets_debit_internal
-- counterpart to _nets_credit_internal, so nothing today can debit an
-- arbitrary player's wallet from a server-side job. The Sunday 10PM
-- resolve job charging every player's Entry Fee/Table Fee in one pass
-- needs exactly that. This migration does not add it — it's nets.js
-- infrastructure, not part of the League Ladder's own data model — but
-- Phase 4 cannot charge fees without it, so budget time for it there.
--
-- Safe to run more than once.

create table if not exists ladder_pool (
  id boolean primary key default true check (id),
  balance bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into ladder_pool (id, balance)
values (true, 0)
on conflict (id) do nothing;

create table if not exists ladder_pool_transactions (
  id uuid primary key default gen_random_uuid(),
  amount bigint not null, -- positive = credited to the pool, negative = debited from it
  balance_after bigint not null,
  reason text not null,
  ref_type text,
  ref_id text,
  user_id uuid references auth.users(id) on delete set null, -- the player involved, if any (e.g. whose Entry Fee this was)
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_pool_transactions_user
  on ladder_pool_transactions (user_id, created_at desc);
create index if not exists idx_ladder_pool_transactions_ref
  on ladder_pool_transactions (ref_type, ref_id);

alter table ladder_pool enable row level security;
alter table ladder_pool_transactions enable row level security;

-- The pool's total balance is a fine thing to show publicly (ladder
-- economy transparency, matches the "public bid ticker" spirit) — not
-- sensitive the way an individual wallet is.
drop policy if exists "ladder_pool_select" on ladder_pool;
create policy "ladder_pool_select" on ladder_pool for select
  to authenticated
  using (true);

-- The transaction ledger names individual players, though — same
-- own-row-or-admin visibility as nets_transactions, not fully public.
drop policy if exists "ladder_pool_transactions_select" on ladder_pool_transactions;
create policy "ladder_pool_transactions_select" on ladder_pool_transactions for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- No insert/update/delete policies — the two functions below are the only
-- way this table's balance ever changes.

create or replace function _ladder_pool_credit(
  p_amount bigint,
  p_reason text,
  p_user_id uuid default null,
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
    raise exception '_ladder_pool_credit: amount must be positive';
  end if;

  update ladder_pool
  set balance = balance + p_amount, updated_at = now()
  where id = true
  returning balance into v_new_balance;

  insert into ladder_pool_transactions (amount, balance_after, reason, ref_type, ref_id, user_id)
  values (p_amount, v_new_balance, p_reason, p_ref_type, p_ref_id, p_user_id);

  return v_new_balance;
end;
$$;

create or replace function _ladder_pool_debit(
  p_amount bigint,
  p_reason text,
  p_user_id uuid default null,
  p_ref_type text default null,
  p_ref_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_balance bigint;
  v_new_balance bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception '_ladder_pool_debit: amount must be positive';
  end if;

  select balance into v_current_balance from ladder_pool where id = true for update;

  if v_current_balance < p_amount then
    raise exception '_ladder_pool_debit: insufficient pool balance (have %, need %)', v_current_balance, p_amount;
  end if;

  update ladder_pool
  set balance = balance - p_amount, updated_at = now()
  where id = true
  returning balance into v_new_balance;

  insert into ladder_pool_transactions (amount, balance_after, reason, ref_type, ref_id, user_id)
  values (-p_amount, v_new_balance, p_reason, p_ref_type, p_ref_id, p_user_id);

  return v_new_balance;
end;
$$;

-- Deliberately no grant to authenticated (or anon) on either function —
-- same reasoning as _nets_credit_internal: reachable only from inside
-- another SECURITY DEFINER function (Phase 4's fee-settlement job), never
-- directly from a client call.
