-- Gift cards, step 1: the admin can issue a card with a rand balance and a
-- code to hand to the customer. (Redeeming at checkout is the next step.)
-- Cards are admin-only data: shoppers cannot list or guess them, and the
-- balance is only ever changed by server functions, with a log row each time.
create table if not exists public.shop_gift_cards (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  initial_amount numeric(10,2) not null check (initial_amount > 0),
  balance numeric(10,2) not null check (balance >= 0),
  note text,
  expires_at timestamptz,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists shop_gift_cards_code_key on public.shop_gift_cards (upper(code));
alter table public.shop_gift_cards enable row level security;
drop policy if exists "gift cards admin read" on public.shop_gift_cards;
create policy "gift cards admin read" on public.shop_gift_cards for select using (public.is_shop_admin());
grant select on public.shop_gift_cards to authenticated;

create table if not exists public.shop_gift_card_log (
  id uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.shop_gift_cards(id) on delete cascade,
  order_id uuid references public.shop_orders(id) on delete set null,
  delta numeric(10,2) not null,
  reason text not null check (reason in ('issued', 'redeemed', 'refunded', 'adjusted')),
  created_at timestamptz not null default now()
);
create index if not exists shop_gift_card_log_card_idx on public.shop_gift_card_log (gift_card_id, created_at);
alter table public.shop_gift_card_log enable row level security;
drop policy if exists "gift card log admin read" on public.shop_gift_card_log;
create policy "gift card log admin read" on public.shop_gift_card_log for select using (public.is_shop_admin());
grant select on public.shop_gift_card_log to authenticated;

-- A hard-to-guess code like GC-7KQ2-M9XD (no 0/O/1/I), from the database's
-- secure random generator.
create or replace function public.shop_new_gift_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
  out text := '';
  i int;
begin
  bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  for i in 0..7 loop
    out := out || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  return 'GC-' || substr(out, 1, 4) || '-' || substr(out, 5, 4);
end;
$$;
revoke all on function public.shop_new_gift_code() from public, anon, authenticated;

create or replace function public.admin_issue_gift_card(p_amount numeric, p_note text default null, p_expires date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_card public.shop_gift_cards;
  v_try int := 0;
begin
  if not public.is_shop_admin() then
    raise exception 'Only a shop admin can issue gift cards.' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 50000 then
    raise exception 'Enter an amount from R1 to R50 000.' using errcode = '22023';
  end if;
  loop
    v_code := public.shop_new_gift_code();
    exit when not exists (select 1 from public.shop_gift_cards where upper(code) = v_code);
    v_try := v_try + 1;
    if v_try > 10 then raise exception 'Could not make a unique code. Try again.'; end if;
  end loop;
  insert into public.shop_gift_cards (code, initial_amount, balance, note, expires_at, created_by)
  values (v_code, round(p_amount, 2), round(p_amount, 2), nullif(btrim(coalesce(p_note, '')), ''),
          case when p_expires is null then null else (p_expires + time '23:59:59')::timestamptz end, auth.uid())
  returning * into v_card;
  insert into public.shop_gift_card_log (gift_card_id, delta, reason) values (v_card.id, v_card.balance, 'issued');
  perform public.shop_log('giftcard.issued', v_card.code, jsonb_build_object('amount', v_card.balance));
  return jsonb_build_object('id', v_card.id, 'code', v_card.code, 'balance', v_card.balance);
end;
$$;
revoke all on function public.admin_issue_gift_card(numeric, text, date) from public, anon;
grant execute on function public.admin_issue_gift_card(numeric, text, date) to authenticated;

create or replace function public.admin_set_gift_card_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_code text;
begin
  if not public.is_shop_admin() then
    raise exception 'Only a shop admin can change gift cards.' using errcode = '42501';
  end if;
  update public.shop_gift_cards set active = p_active where id = p_id returning code into v_code;
  if v_code is null then raise exception 'Gift card not found.' using errcode = 'P0002'; end if;
  perform public.shop_log(case when p_active then 'giftcard.enabled' else 'giftcard.disabled' end, v_code, '{}'::jsonb);
end;
$$;
revoke all on function public.admin_set_gift_card_active(uuid, boolean) from public, anon;
grant execute on function public.admin_set_gift_card_active(uuid, boolean) to authenticated;
