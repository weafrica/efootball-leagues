-- Ad-free status — Phase 1 foundation. Lays down where ad-free status
-- lives and how it's granted, before any ad component exists to check it.
--
-- Shape deliberately mirrors nets_transactions rather than nets_wallets:
-- ad-free status isn't a cumulative balance, it's "does a currently-valid
-- grant exist for this user" — so this is an append-only ledger of grants,
-- not a single mutable row per user. A user can pick up more than one row
-- over time (a referral grant that lapses, then later a subscription) and
-- that's fine; isAdFree() asks "does ANY row currently cover me," never
-- "what does my one row say."
--
-- The new-user grace period (created_at < 3 days ago) is deliberately NOT
-- a row in this table or a column anywhere — it's pure date math in the
-- client against the auth user's own created_at, which the Supabase JS
-- client already exposes via session.user.created_at. See src/adFree.js.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- ad_free_status — one row per grant. expires_at null = forever
-- (purchase_permanent). A non-null expires_at that's in the past means
-- that grant has simply lapsed — rows are never deleted or edited, a new
-- grant is just a new row (e.g. a renewed subscription).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ad_free_status (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('purchase_permanent', 'subscription', 'referral')),
  expires_at timestamptz, -- null = forever
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) -- admin who granted it, via grant_ad_free()
);

-- Powers "does this user have a currently-valid grant" lookups.
create index if not exists ad_free_status_user_idx on ad_free_status (user_id, expires_at);

alter table ad_free_status enable row level security;

-- Everyone can read their own grants; admins can read everyone's (support,
-- and the admin console showing "why is this user ad-free"). Same pattern
-- as nets_wallets_select / nets_transactions_select. Deliberately no
-- insert/update/delete policy — the only way a row appears is
-- grant_ad_free() below (SECURITY DEFINER), never a direct client write.
drop policy if exists "ad_free_status_select" on ad_free_status;
create policy "ad_free_status_select" on ad_free_status for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- grant_ad_free — admin-only. Same trust model as nets_credit: this IS
-- granted to `authenticated` (the admin console calls it as a signed-in
-- admin), but it self-guards with an admin check as the very first thing
-- it does. That check living INSIDE the function body is what actually
-- makes this safe — see 20260843_secure_grants_and_nets_purchases.sql:
-- Supabase auto-grants EXECUTE to anon/authenticated/public on every new
-- function unless explicitly revoked, so "just don't GRANT it" was never
-- real privacy on its own. Nothing else needs to call this bypassing the
-- check (unlike nets_credit, which reward RPCs needed to reach
-- internally), so there's no need for a matching _ad_free_status_internal
-- split — one function, admin-gated, is the whole thing.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function grant_ad_free(
  p_user_id uuid,
  p_source text,
  p_expires_at timestamptz default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'grant_ad_free: admin only';
  end if;

  if p_user_id is null then
    raise exception 'grant_ad_free: user_id is required';
  end if;

  if p_source not in ('purchase_permanent', 'subscription', 'referral') then
    raise exception 'grant_ad_free: invalid source %', p_source;
  end if;

  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'grant_ad_free: expires_at must be in the future (or null for forever)';
  end if;

  insert into ad_free_status (user_id, source, expires_at, created_by)
  values (p_user_id, p_source, p_expires_at, auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function grant_ad_free(uuid, text, timestamptz) to authenticated;
