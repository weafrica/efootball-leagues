-- Nets — daily login reward: 1N, once per (UTC) calendar day, for simply
-- being signed in. Self-service RPC, not admin-granted and not tied to
-- any match/league — same _nets_credit_internal ledger write every other
-- reward uses, just with its own eligibility check instead of a match
-- result or finalize step.
--
-- last_login_reward_at lives on nets_wallets (one row per user already)
-- rather than a new table — cheapest place to track "last time this user
-- claimed", same 1:1-with-user shape the wallet itself has.
--
-- "Daily" = once per UTC calendar day, not a rolling 24h window — so the
-- reward becomes claimable again right at UTC midnight regardless of
-- exactly what time yesterday's claim landed. Locks the wallet row (for
-- update) before checking/crediting so two near-simultaneous calls in the
-- same day can't both slip past the check and double-credit.
--
-- claim_daily_login_reward() is deliberately idempotent within a day —
-- the client can call it on every sign-in/session-restore without
-- worrying about double-crediting; only the first call each day actually
-- credits, every later one that day just reports claimed = false.
--
-- The drop before create or replace is required, not just defensive —
-- Postgres refuses create or replace when a function's return type
-- changes (error 42P13), so a bare create or replace here would break on
-- any DB that already has a same-named function with a different
-- signature (e.g. a partial/earlier run of this migration).
--
-- Safe to run more than once.

alter table nets_wallets add column if not exists last_login_reward_at timestamptz;

drop function if exists claim_daily_login_reward();

create or replace function claim_daily_login_reward()
returns table(claimed boolean, balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_last timestamptz;
  v_balance bigint;
begin
  if v_user_id is null then
    raise exception 'claim_daily_login_reward: must be signed in';
  end if;

  insert into nets_wallets (user_id, balance)
  values (v_user_id, 0)
  on conflict (user_id) do nothing;

  select last_login_reward_at, balance into v_last, v_balance
  from nets_wallets where user_id = v_user_id for update;

  if v_last is not null and (v_last at time zone 'utc')::date = (now() at time zone 'utc')::date then
    return query select false, v_balance;
    return;
  end if;

  v_balance := _nets_credit_internal(v_user_id, 1, 'daily_login_reward');

  update nets_wallets set last_login_reward_at = now() where user_id = v_user_id;

  return query select true, v_balance;
end;
$$;

grant execute on function claim_daily_login_reward() to authenticated;
