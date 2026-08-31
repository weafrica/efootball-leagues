-- Nets — (1) close a real privilege-escalation hole on the internal
-- reward-crediting functions, (2) add the Buy Nets feature (nets_purchases
-- table + admin-gated approve/reject RPCs).
--
-- ── PART 1: the grant hole ──────────────────────────────────────────────
--
-- Every "internal-only" function below was written with a comment saying
-- something like "deliberately NO grant to authenticated" and relying on
-- that omission to stay unreachable from the client. That doesn't actually
-- lock anything down. Supabase projects set default privileges so that
-- *any* newly created function in the public schema is automatically
-- granted EXECUTE to anon, authenticated AND service_role — and on top of
-- that, Postgres itself grants EXECUTE to PUBLIC on every new function
-- unless it's explicitly revoked. Neither of those defaults were ever
-- undone anywhere in this migration history (there is no `revoke` in any
-- prior file). The practical result: right now, any signed-in player can
-- almost certainly call e.g. `supabase.rpc('_nets_credit_internal', {...})`
-- directly and mint themselves unlimited free Nets — same for the other
-- five functions below, each a live route to crediting rewards with a
-- caller-supplied amount instead of a server-computed one.
--
-- Fix: explicitly revoke EXECUTE from public/anon/authenticated on each of
-- them. service_role is deliberately left alone — the iKhokha webhook runs
-- as service_role and needs to keep calling _nets_credit_internal directly
-- (see create-nets-payment / ikhokha-webhook).
--
-- Safe to run more than once.

revoke all on function _nets_credit_internal(uuid, bigint, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function _credit_league_fixture_reward(uuid, boolean) from public, anon, authenticated;
revoke all on function _credit_ladder_battle_match_reward(uuid, uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function _apply_ladder_cup_match_win(uuid) from public, anon, authenticated;
revoke all on function _credit_knockout_fixture_reward(uuid, boolean) from public, anon, authenticated;
revoke all on function _credit_random_match_reward(uuid, uuid, uuid, boolean, uuid, uuid) from public, anon, authenticated;

-- ── PART 2: nets_purchases — standalone Nets top-ups ────────────────────
--
-- Same shape as `members` for a cash league, but not tied to a league:
-- one row per top-up attempt. Same two payment options as PaymentModal —
-- iKhokha card (auto-approved via webhook) or bank transfer / Mukuru
-- (manual proof upload, admin reviews).
create table if not exists nets_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rand_amount numeric(10,2) not null check (rand_amount > 0),
  nets_amount bigint not null check (nets_amount > 0),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'approved', 'rejected')),
  payment_method text check (payment_method in ('card', 'bank_transfer')),
  payment_proof_path text,
  created_at timestamptz not null default now(),
  payment_reviewed_at timestamptz,
  payment_reviewed_by uuid references auth.users(id)
);

create index if not exists nets_purchases_user_idx on nets_purchases (user_id, created_at desc);
create index if not exists nets_purchases_pending_idx on nets_purchases (payment_status, created_at);

alter table nets_purchases enable row level security;

-- Everyone can read their own purchases; admins can read everyone's (same
-- pattern as nets_wallets/nets_transactions above).
drop policy if exists "nets_purchases_select" on nets_purchases;
create policy "nets_purchases_select" on nets_purchases for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- A signed-in user can start their own pending purchase (this is just a
-- request to pay, same trust level as inserting a pending `members` row
-- for a cash league entry — it credits nothing by itself). No update
-- policy: the only way a purchase's status ever changes is via the RPCs
-- below or the webhook (service_role), never a direct client write.
drop policy if exists "nets_purchases_insert_own" on nets_purchases;
create policy "nets_purchases_insert_own" on nets_purchases for insert
  to authenticated
  with check (user_id = auth.uid() and payment_status = 'pending');

-- ─────────────────────────────────────────────────────────────────────────
-- approve_nets_purchase / reject_nets_purchase — admin-only. Approving
-- credits the wallet via _nets_credit_internal (server-computed from the
-- purchase row, never a client-supplied amount) and flips the purchase to
-- approved in the same transaction, so a purchase can never be marked
-- approved without the matching credit landing.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function approve_nets_purchase(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purchase nets_purchases%rowtype;
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'approve_nets_purchase: admin only';
  end if;

  select * into v_purchase from nets_purchases where id = p_purchase_id for update;
  if not found then
    raise exception 'approve_nets_purchase: purchase not found';
  end if;
  if v_purchase.payment_status <> 'pending' then
    raise exception 'approve_nets_purchase: purchase already reviewed';
  end if;

  perform _nets_credit_internal(
    v_purchase.user_id, v_purchase.nets_amount, 'nets_purchase',
    concat('Top-up — R', v_purchase.rand_amount), 'nets_purchase', p_purchase_id::text, null
  );

  update nets_purchases
  set payment_status = 'approved', payment_reviewed_at = now(), payment_reviewed_by = auth.uid()
  where id = p_purchase_id;
end;
$$;

grant execute on function approve_nets_purchase(uuid) to authenticated;

create or replace function reject_nets_purchase(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'reject_nets_purchase: admin only';
  end if;

  update nets_purchases
  set payment_status = 'rejected', payment_reviewed_at = now(), payment_reviewed_by = auth.uid()
  where id = p_purchase_id and payment_status = 'pending';

  if not found then
    raise exception 'reject_nets_purchase: purchase not found or already reviewed';
  end if;
end;
$$;

grant execute on function reject_nets_purchase(uuid) to authenticated;
