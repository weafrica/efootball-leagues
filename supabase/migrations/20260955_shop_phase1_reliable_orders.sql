-- Shop phase 1: reliable orders.
--
-- * Orders are created on the server (place_shop_order): prices and stock are
--   checked against the database, never the shopper's browser, and stock is
--   reserved in the same transaction.
-- * Readable order numbers (WA-10001...), optional buyer email.
-- * Fuller status flow (packed, shipped, delivered, refunded) with a history
--   log, and admin_set_shop_order_status() which also puts stock back when an
--   order is rejected, cancelled or refunded.
-- * Guest order lookup (lookup_shop_order) by order number + phone or email.
-- * shop_settings: EFT bank details are edited by admin in the app instead of
--   being hard-coded placeholders.
-- * Fixes: 'ikhokha_link' was missing from the checkout_method check, so the
--   card-link checkout could not save an order.
--
-- The old direct-insert policies on shop_orders / shop_order_items are left in
-- place so shoppers on a cached older app version can still order. A separate
-- migration (20260956) removes them once the new app is live.

-- ── Settings ────────────────────────────────────────────────────────────
create table if not exists public.shop_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.shop_settings enable row level security;

drop policy if exists "shop_settings readable by everyone" on public.shop_settings;
create policy "shop_settings readable by everyone" on public.shop_settings
  for select using (true);

drop policy if exists "shop_settings admin write" on public.shop_settings;
create policy "shop_settings admin write" on public.shop_settings
  for all using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

-- Starts with the same business account the app already shows for Nets and
-- cash-league payments (src/paymentConfig.js). Admin can edit or clear it in
-- the app (Orders > Bank details shown at checkout); blank hides it.
insert into public.shop_settings (key, value) values ('eft_details',
  E'Bank: Capitec Business\nAccount name: We Africa\nAccount number: 1054081743\nAccount type: Transact\nReference: your order number (shown after you submit)')
  on conflict (key) do nothing;

-- ── Order columns ───────────────────────────────────────────────────────
create sequence if not exists public.shop_order_number_seq start 10001;

alter table public.shop_orders add column if not exists order_number text;
alter table public.shop_orders add column if not exists buyer_email text;
alter table public.shop_orders add column if not exists stock_deducted boolean not null default false;

-- Number the orders that already exist (oldest first).
update public.shop_orders o
set order_number = 'WA-' || nextval('public.shop_order_number_seq')
from (select id from public.shop_orders where order_number is null order by created_at, id) s
where o.id = s.id;

alter table public.shop_orders alter column order_number set not null;
alter table public.shop_orders alter column order_number
  set default ('WA-' || nextval('public.shop_order_number_seq'));
create unique index if not exists shop_orders_order_number_key on public.shop_orders (order_number);

-- ── Allowed values ──────────────────────────────────────────────────────
alter table public.shop_orders drop constraint if exists shop_orders_checkout_method_check;
alter table public.shop_orders add constraint shop_orders_checkout_method_check
  check (checkout_method in ('manual_proof', 'gateway', 'whatsapp', 'ikhokha_link'));

alter table public.shop_orders drop constraint if exists shop_orders_status_check;
alter table public.shop_orders add constraint shop_orders_status_check
  check (status in ('pending_review', 'paid', 'packed', 'shipped', 'delivered',
                    'rejected', 'whatsapp_sent', 'fulfilled', 'cancelled', 'refunded'));

-- ── Status history ──────────────────────────────────────────────────────
create table if not exists public.shop_order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.shop_orders(id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists shop_order_status_history_order_idx
  on public.shop_order_status_history (order_id, created_at);
alter table public.shop_order_status_history enable row level security;

drop policy if exists "status history visible to owner and admin" on public.shop_order_status_history;
create policy "status history visible to owner and admin" on public.shop_order_status_history
  for select using (
    exists (select 1 from public.shop_orders o where o.id = order_id and o.user_id = auth.uid())
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

create or replace function public.shop_log_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.shop_order_status_history (order_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, auth.uid());
  elsif new.status is distinct from old.status then
    insert into public.shop_order_status_history (order_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
  end if;
  return new;
end;
$$;

drop trigger if exists shop_orders_log_status on public.shop_orders;
create trigger shop_orders_log_status
  after insert or update of status on public.shop_orders
  for each row execute function public.shop_log_order_status();

-- Seed one history row for the orders that already exist.
insert into public.shop_order_status_history (order_id, from_status, to_status, created_at)
select o.id, null, o.status, o.created_at
from public.shop_orders o
where not exists (select 1 from public.shop_order_status_history h where h.order_id = o.id);

-- ── Place an order (server-side) ────────────────────────────────────────
create or replace function public.place_shop_order(
  p_items jsonb,
  p_method text,
  p_buyer_name text,
  p_phone text default null,
  p_email text default null,
  p_note text default null,
  p_proof_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_product record;
  v_qty int;
  v_total numeric := 0;
  v_order public.shop_orders%rowtype;
  v_status text;
  v_lines jsonb := '[]'::jsonb;
  v_ids uuid[];
begin
  if p_method not in ('manual_proof', 'whatsapp', 'ikhokha_link') then
    raise exception 'Unsupported checkout method.' using errcode = '22023';
  end if;
  if coalesce(trim(p_buyer_name), '') = '' then
    raise exception 'Please enter your name.' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your cart is empty.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Too many different items in one order.' using errcode = '22023';
  end if;
  if p_method = 'manual_proof' and coalesce(p_proof_path, '') = '' then
    raise exception 'Attach your proof of payment.' using errcode = '22023';
  end if;
  if p_email is not null and trim(p_email) <> '' and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That email address does not look right.' using errcode = '22023';
  end if;

  -- Lock the products in a fixed order so two shoppers buying the same items
  -- at once cannot deadlock or oversell.
  select array_agg(distinct (e->>'product_id')::uuid order by (e->>'product_id')::uuid)
    into v_ids
  from jsonb_array_elements(p_items) e;
  perform 1 from public.shop_products where id = any (v_ids) order by id for update;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := coalesce((v_item->>'qty')::int, 0);
    if v_qty < 1 or v_qty > 99 then
      raise exception 'Invalid quantity.' using errcode = '22023';
    end if;
    select id, name, price, stock_qty, active into v_product
    from public.shop_products where id = (v_item->>'product_id')::uuid;
    if not found or not v_product.active then
      raise exception 'An item in your cart is no longer available.' using errcode = 'P0001';
    end if;
    if v_product.stock_qty < v_qty then
      raise exception '% only has % left in stock.', v_product.name, v_product.stock_qty using errcode = 'P0001';
    end if;
    v_total := v_total + v_product.price * v_qty;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_product.id, 'name', v_product.name, 'price', v_product.price, 'qty', v_qty);
  end loop;

  v_status := case when p_method = 'whatsapp' then 'whatsapp_sent' else 'pending_review' end;

  insert into public.shop_orders (
    user_id, buyer_username, buyer_phone, buyer_email, checkout_method, status,
    subtotal, contact_phone, delivery_note, payment_proof_path, stock_deducted
  ) values (
    auth.uid(), trim(p_buyer_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''), p_method, v_status,
    v_total, nullif(trim(p_phone), ''), nullif(trim(p_note), ''), nullif(p_proof_path, ''), true
  ) returning * into v_order;

  for v_item in select * from jsonb_array_elements(v_lines) loop
    insert into public.shop_order_items (order_id, product_id, product_name, unit_price, qty)
    values (v_order.id, (v_item->>'product_id')::uuid, v_item->>'name',
            (v_item->>'price')::numeric, (v_item->>'qty')::int);
    update public.shop_products
    set stock_qty = stock_qty - (v_item->>'qty')::int
    where id = (v_item->>'product_id')::uuid;
  end loop;

  return jsonb_build_object(
    'id', v_order.id, 'order_number', v_order.order_number,
    'subtotal', v_order.subtotal, 'status', v_order.status, 'items', v_lines);
end;
$$;

revoke all on function public.place_shop_order(jsonb, text, text, text, text, text, text) from public;
grant execute on function public.place_shop_order(jsonb, text, text, text, text, text, text) to anon, authenticated;

-- ── Admin: change an order's status ─────────────────────────────────────
create or replace function public.admin_set_shop_order_status(p_order_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.shop_orders%rowtype;
  v_restock constant text[] := array['rejected', 'cancelled', 'refunded'];
  r record;
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'Only the shop admin can change an order status.' using errcode = '42501';
  end if;
  if p_status not in ('pending_review', 'paid', 'packed', 'shipped', 'delivered',
                      'rejected', 'whatsapp_sent', 'fulfilled', 'cancelled', 'refunded') then
    raise exception 'Unknown status.' using errcode = '22023';
  end if;

  select * into v_order from public.shop_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;

  if p_status = any (v_restock) and v_order.stock_deducted then
    -- Put the stock back, once.
    for r in select product_id, qty from public.shop_order_items where order_id = p_order_id and product_id is not null loop
      update public.shop_products set stock_qty = stock_qty + r.qty where id = r.product_id;
    end loop;
    update public.shop_orders set stock_deducted = false where id = p_order_id;
  elsif not (p_status = any (v_restock)) and not v_order.stock_deducted then
    -- Orders saved by an older app version never reserved stock: do it now.
    for r in select product_id, qty from public.shop_order_items where order_id = p_order_id and product_id is not null loop
      update public.shop_products set stock_qty = greatest(0, stock_qty - r.qty) where id = r.product_id;
    end loop;
    update public.shop_orders set stock_deducted = true where id = p_order_id;
  end if;

  update public.shop_orders
  set status = p_status, admin_reviewed_by = auth.uid(), admin_reviewed_at = now()
  where id = p_order_id;
end;
$$;

revoke all on function public.admin_set_shop_order_status(uuid, text) from public;
grant execute on function public.admin_set_shop_order_status(uuid, text) to authenticated;

-- ── Guest lookup ────────────────────────────────────────────────────────
-- Order number plus the phone number or email used at checkout. Returns only
-- what a shopper needs to see; never the payment proof path or admin fields.
create or replace function public.lookup_shop_order(p_order_number text, p_contact text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.shop_orders%rowtype;
  v_contact text := lower(trim(coalesce(p_contact, '')));
  v_digits text := regexp_replace(coalesce(p_contact, ''), '\D', '', 'g');
  v_ok boolean := false;
begin
  select * into v_order from public.shop_orders
  where order_number = upper(trim(coalesce(p_order_number, '')));

  if found and v_contact <> '' then
    if v_order.buyer_email is not null and lower(v_order.buyer_email) = v_contact then
      v_ok := true;
    elsif length(v_digits) >= 7 and v_order.contact_phone is not null
      and right(regexp_replace(v_order.contact_phone, '\D', '', 'g'), 9) = right(v_digits, 9) then
      v_ok := true;
    end if;
  end if;

  if not v_ok then
    perform pg_sleep(0.4); -- slows down guessing
    return null;
  end if;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'status', v_order.status,
    'created_at', v_order.created_at,
    'subtotal', v_order.subtotal,
    'checkout_method', v_order.checkout_method,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('product_name', i.product_name, 'qty', i.qty, 'unit_price', i.unit_price)
                       order by i.product_name)
      from public.shop_order_items i where i.order_id = v_order.id), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('status', h.to_status, 'at', h.created_at) order by h.created_at)
      from public.shop_order_status_history h where h.order_id = v_order.id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.lookup_shop_order(text, text) from public;
grant execute on function public.lookup_shop_order(text, text) to anon, authenticated;
