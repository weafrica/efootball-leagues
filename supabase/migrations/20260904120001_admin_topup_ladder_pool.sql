-- League Ladder — admin_topup_ladder_pool: lets an admin manually credit
-- ladder_pool by a specific amount, with a note recorded against it.
--
-- This is the deliberate, human-authorized version of "add money to the
-- pool" discussed alongside 20260902/20260903 — NOT an automatic
-- reserve/subsidy that refills itself. An admin decides a specific
-- amount, on purpose, each time; there's no scheduled or triggered path
-- that mints Nets on its own. Given Nets are confirmed to convert to real
-- prizes/marketplace items in future (not yet built), keeping this
-- explicit and attributable — one admin, one amount, one note, per
-- top-up — is the point: it's a decision with a paper trail, not a tap
-- left open.
--
-- Ledgered with its own reason so it's always distinguishable from
-- player-funded pool inflows (ladder_entry_fee, ladder_table_fee) in
-- reporting — anyone auditing ladder_pool_transactions can see exactly
-- how much of the pool's balance came from players vs. from an admin
-- decision, and who made each call and why.
--
-- Same admin-only auth pattern as every other admin_* ladder RPC
-- (admin_cancel_ladder_bid, admin_override_ladder_fixture_result, etc.)
-- — gated on the global `admins` table, no per-league owner concept for
-- League Ladder.
--
-- Safe to run more than once.

create or replace function admin_topup_ladder_pool(p_amount bigint, p_note text default null)
returns ladder_pool
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_pool ladder_pool%rowtype;
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'admin_topup_ladder_pool: admin only';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'admin_topup_ladder_pool: amount must be positive';
  end if;

  perform _ladder_pool_credit(p_amount, 'ladder_pool_admin_topup', v_user_id, 'admin_note', p_note);

  select * into v_pool from ladder_pool where id = true;
  return v_pool;
end;
$$;

grant execute on function admin_topup_ladder_pool(bigint, text) to authenticated;
