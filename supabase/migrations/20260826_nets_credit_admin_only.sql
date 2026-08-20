-- Nets — close the open nets_credit hole.
--
-- ROOT CAUSE: nets_credit (20260825_nets_wallet.sql) accepts any p_user_id
-- and p_amount from any authenticated caller — the admin-only check was
-- left commented out. The only thing stopping a normal user from opening
-- devtools and running
--   supabase.rpc('nets_credit', { p_user_id: <own id>, p_amount: 999999, p_reason: 'x' })
-- and minting themselves Nets directly was that the client UI happens to
-- only call it from the admin console (App.jsx's grantNets/account
-- management screen). RLS/RPC security can't rely on the client being
-- well-behaved — this closes the actual hole.
--
-- Fix: require the caller to be a row in public.admins, same convention
-- already used for nets_wallets/nets_transactions SELECT policies and
-- get_activity_log. No future reward/prize crediting should call this
-- RPC directly from the client either — those go through their own
-- SECURITY DEFINER RPCs that compute the amount server-side and call
-- nets_credit internally (as the same security definer), not through a
-- client-supplied amount.
--
-- Safe to run more than once.

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

  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'nets_credit: admin only';
  end if;

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

-- Grant unchanged — execute is still available to any authenticated user,
-- the function body itself now enforces admin membership so a non-admin
-- calling it gets a clean "admin only" exception instead of silently
-- crediting a wallet.
grant execute on function nets_credit(uuid, bigint, text, text, text, text) to authenticated;
