-- Nets — resolve a real conflict between two earlier migrations.
--
-- 20260826_nets_credit_admin_only.sql locked nets_credit down to
-- admin-only callers, correctly closing the "any authenticated user can
-- mint themselves Nets" hole. But that same migration's own comment says
-- future reward-crediting RPCs should "call nets_credit internally...
-- not through a client-supplied amount" — and that doesn't actually
-- work: auth.uid() is resolved from the request's JWT for the whole
-- transaction, regardless of which function is calling which, so a
-- reward RPC calling nets_credit(...) internally still sees the
-- ORIGINAL caller's auth.uid() (a league creator confirming a match
-- result, say) — not an admin — and hits the exact "admin only"
-- exception nets_credit now raises. As it stood, no reward-crediting RPC
-- could actually credit anything.
--
-- Fix: split the actual wallet/ledger write out into
-- _nets_credit_internal — same logic nets_credit already had, no
-- auth.uid()-based check at all, and deliberately never GRANTed to
-- authenticated (or any client-facing role), so it's reachable only from
-- inside another SECURITY DEFINER function running as this function's
-- owner — never directly from the client. nets_credit becomes a thin
-- wrapper: keep its admin check, then delegate the actual write here.
-- Reward-crediting RPCs (see 20260832_league_match_reward_crediting.sql)
-- call this directly, computing their own amount server-side — exactly
-- the shape the original comment intended, now actually possible.
--
-- Safe to run more than once.

create or replace function _nets_credit_internal(
  p_user_id uuid,
  p_amount bigint,
  p_reason text,
  p_note text default null,
  p_ref_type text default null,
  p_ref_id text default null,
  p_team_id uuid default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_balance bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception '_nets_credit_internal: amount must be positive';
  end if;

  insert into nets_wallets (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  update nets_wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = p_user_id
  returning balance into v_new_balance;

  insert into nets_transactions (user_id, amount, balance_after, reason, note, ref_type, ref_id, team_id, created_by)
  values (p_user_id, p_amount, v_new_balance, p_reason, p_note, p_ref_type, p_ref_id, p_team_id, auth.uid());

  return v_new_balance;
end;
$$;

-- Deliberately NO grant to authenticated (or anon) here — this must only
-- ever be reachable from another SECURITY DEFINER function, never
-- directly from a client call, or it reopens the exact hole
-- nets_credit_admin_only closed.

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
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'nets_credit: admin only';
  end if;

  return _nets_credit_internal(p_user_id, p_amount, p_reason, p_note, p_ref_type, p_ref_id, null);
end;
$$;

grant execute on function nets_credit(uuid, bigint, text, text, text, text) to authenticated;
