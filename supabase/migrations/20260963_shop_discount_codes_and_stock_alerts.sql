-- Shop: discount codes and back-in-stock requests.
--
-- Discount codes are checked and applied on the server (shop_check_discount
-- for the "Apply" button, place_shop_order when the order is placed), so a
-- code can't be faked from the browser. Codes are not readable by shoppers,
-- so they can't be listed or guessed from the app; only admin sees them.
-- The discount comes off the items total (delivery is not discounted) and is
-- stored on the order. Cancelling / rejecting / refunding an order gives the
-- code its use back.
--
-- Back-in-stock requests: a shopper leaves an email or phone number for an
-- out-of-stock product; admin sees who is waiting and messages them.

-- ── Discount codes ──────────────────────────────────────────────────────
create table if not exists public.shop_discount_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  kind text not null check (kind in ('percent', 'fixed')),
  value numeric not null check (value > 0),
  min_spend numeric not null default 0 check (min_spend >= 0),
  starts_at timestamptz,
  expires_at timestamptz,
  max_uses integer check (max_uses is null or max_uses > 0),
  used_count integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100)
);
create unique index if not exists shop_discount_codes_code_key on public.shop_discount_codes (upper(code));
alter table public.shop_discount_codes enable row level security;

drop policy if exists "discount codes admin only" on public.shop_discount_codes;
create policy "discount codes admin only" on public.shop_discount_codes for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
grant select, insert, update, delete on public.shop_discount_codes to authenticated;

alter table public.shop_orders
  add column if not exists discount_code text,
  add column if not exists discount_amount numeric not null default 0;

-- Why a code can't be used for this items total (null = it can).
create or replace function public.shop_discount_problem(r public.shop_discount_codes, p_subtotal numeric)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when r.id is null then 'That code isn''t valid.'
    when not r.active then 'That code isn''t valid.'
    when r.starts_at is not null and r.starts_at > now() then 'That code isn''t active yet.'
    when r.expires_at is not null and r.expires_at < now() then 'That code has expired.'
    when r.max_uses is not null and r.used_count >= r.max_uses then 'That code has been used up.'
    when p_subtotal < r.min_spend then 'Spend R' || trim(to_char(r.min_spend, 'FM999999990.00')) || ' or more to use this code.'
    else null end;
$$;

create or replace function public.shop_discount_amount(r public.shop_discount_codes, p_subtotal numeric)
returns numeric
language sql
immutable
as $$
  select case when r.kind = 'percent' then least(p_subtotal, round(p_subtotal * r.value / 100, 2))
              else least(p_subtotal, r.value) end;
$$;

-- "Apply" button: what would this code take off this cart?
-- p_items: [{"product_id", "variant_id", "qty"}]
create or replace function public.shop_check_discount(p_code text, p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  r public.shop_discount_codes;
  v_subtotal numeric := 0;
  v_problem text;
  x record;
begin
  if v_code = '' then
    return jsonb_build_object('ok', false, 'message', 'Enter a code.');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', false, 'message', 'Your cart is empty.');
  end if;

  for x in
    select i.product_id, i.variant_id, i.qty, sum(i.qty) over (partition by i.product_id)::int as product_qty
    from jsonb_to_recordset(p_items) as i(product_id uuid, variant_id uuid, qty int)
    join public.shop_products p on p.id = i.product_id
  loop
    v_subtotal := v_subtotal + public.shop_unit_price(x.product_id, x.variant_id, x.product_qty) * x.qty;
  end loop;

  select * into r from public.shop_discount_codes where upper(code) = v_code;
  v_problem := public.shop_discount_problem(r, v_subtotal);
  if v_problem is not null then
    perform pg_sleep(0.3);
    return jsonb_build_object('ok', false, 'message', v_problem);
  end if;
  return jsonb_build_object('ok', true, 'code', r.code, 'kind', r.kind, 'value', r.value,
                            'discount', public.shop_discount_amount(r, v_subtotal));
end;
$$;
revoke all on function public.shop_check_discount(text, jsonb) from public;
grant execute on function public.shop_check_discount(text, jsonb) to anon, authenticated;

-- ── Place an order: now with an optional discount code ──────────────────
drop function if exists public.place_shop_order(jsonb, text, text, text, text, text, text, jsonb);

create or replace function public.place_shop_order(
  p_items jsonb,
  p_method text,
  p_buyer_name text,
  p_phone text default null,
  p_email text default null,
  p_note text default null,
  p_proof_path text default null,
  p_delivery jsonb default null,
  p_discount_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_product record;
  v_variant record;
  v_has_variants boolean;
  v_total numeric := 0;
  v_unit numeric;
  v_name text;
  v_order public.shop_orders%rowtype;
  v_status text;
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_options jsonb;
  v_opt jsonb;
  v_dmethod text := nullif(p_delivery->>'method', '');
  v_addr jsonb := p_delivery->'address';
  v_point text := nullif(trim(coalesce(p_delivery->>'point', '')), '');
  v_fee numeric := 0;
  v_norm jsonb;
  v_code text := upper(trim(coalesce(p_discount_code, '')));
  v_disc public.shop_discount_codes;
  v_discount numeric := 0;
  v_problem text;
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

  if exists (select 1 from jsonb_to_recordset(p_items) as x(qty int) where coalesce(x.qty, 0) < 1 or x.qty > 99) then
    raise exception 'Invalid quantity.' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'variant_id', variant_id, 'qty', qty)), '[]'::jsonb)
    into v_norm
  from (
    select x.product_id, x.variant_id, sum(x.qty)::int as qty
    from jsonb_to_recordset(p_items) as x(product_id uuid, variant_id uuid, qty int)
    group by x.product_id, x.variant_id
  ) g;

  perform 1 from public.shop_products
    where id in (select (e->>'product_id')::uuid from jsonb_array_elements(v_norm) e)
    order by id for update;
  perform 1 from public.shop_product_variants
    where id in (select (e->>'variant_id')::uuid from jsonb_array_elements(v_norm) e where e->>'variant_id' is not null)
    order by id for update;

  for r in
    select x.product_id, x.variant_id, x.qty,
           sum(x.qty) over (partition by x.product_id)::int as product_qty
    from jsonb_to_recordset(v_norm) as x(product_id uuid, variant_id uuid, qty int)
  loop
    select id, name, price, stock_qty, active into v_product from public.shop_products where id = r.product_id;
    if not found or not v_product.active then
      raise exception 'An item in your cart is no longer available.' using errcode = 'P0001';
    end if;
    select exists (select 1 from public.shop_product_variants where product_id = r.product_id and active) into v_has_variants;
    v_name := v_product.name;

    if v_has_variants then
      if r.variant_id is null then
        raise exception 'Choose an option for %.', v_product.name using errcode = '22023';
      end if;
      select id, name, stock_qty, active into v_variant
      from public.shop_product_variants where id = r.variant_id and product_id = r.product_id;
      if not found or not v_variant.active then
        raise exception 'An option of % is no longer available.', v_product.name using errcode = 'P0001';
      end if;
      if v_variant.stock_qty < r.qty then
        raise exception '% (%) only has % left in stock.', v_product.name, v_variant.name, v_variant.stock_qty using errcode = 'P0001';
      end if;
      v_name := v_product.name || ' (' || v_variant.name || ')';
    else
      if r.variant_id is not null then
        raise exception 'An option of % is no longer available.', v_product.name using errcode = 'P0001';
      end if;
      if v_product.stock_qty < r.qty then
        raise exception '% only has % left in stock.', v_product.name, v_product.stock_qty using errcode = 'P0001';
      end if;
    end if;

    v_unit := public.shop_unit_price(r.product_id, r.variant_id, r.product_qty);
    v_total := v_total + v_unit * r.qty;
    v_lines := v_lines || jsonb_build_object(
      'product_id', r.product_id, 'variant_id', r.variant_id,
      'name', v_name, 'variant_name', case when v_has_variants then v_variant.name else null end,
      'price', v_unit, 'qty', r.qty);
  end loop;

  -- Discount code (re-checked here, locked so a limited code can't be over-used).
  if v_code <> '' then
    select * into v_disc from public.shop_discount_codes where upper(code) = v_code for update;
    v_problem := public.shop_discount_problem(v_disc, v_total);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = 'P0001';
    end if;
    v_discount := public.shop_discount_amount(v_disc, v_total);
  end if;

  v_options := public.shop_delivery_options(v_norm);
  if jsonb_array_length(v_options) > 0 then
    if v_dmethod is null then
      raise exception 'Choose how you want to receive your order.' using errcode = '22023';
    end if;
    select o into v_opt from jsonb_array_elements(v_options) o where o->>'method' = v_dmethod limit 1;
    if v_opt is null or not coalesce((v_opt->>'available')::boolean, false) then
      raise exception 'That delivery option is not available for this order.' using errcode = 'P0001';
    end if;
    v_fee := (v_opt->>'fee')::numeric;
    if v_dmethod = 'courier' then
      if coalesce(trim(v_addr->>'street'), '') = '' or coalesce(trim(v_addr->>'city'), '') = ''
         or coalesce(trim(v_addr->>'postal_code'), '') = '' then
        raise exception 'Enter your street address, city and postal code.' using errcode = '22023';
      end if;
    elsif v_dmethod in ('pudo', 'paxi') then
      if v_point is null then
        raise exception 'Enter the locker or PAXI point you want to collect from.' using errcode = '22023';
      end if;
    end if;
  else
    v_dmethod := null; v_addr := null; v_point := null; v_fee := 0;
  end if;

  v_status := case when p_method = 'whatsapp' then 'whatsapp_sent' else 'pending_review' end;

  insert into public.shop_orders (
    user_id, buyer_username, buyer_phone, buyer_email, checkout_method, status,
    subtotal, contact_phone, delivery_note, payment_proof_path, stock_deducted,
    delivery_method, delivery_address, delivery_point, delivery_fee,
    discount_code, discount_amount
  ) values (
    auth.uid(), trim(p_buyer_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''), p_method, v_status,
    v_total, nullif(trim(p_phone), ''), nullif(trim(p_note), ''), nullif(p_proof_path, ''), true,
    v_dmethod, case when v_dmethod = 'courier' then v_addr else null end,
    case when v_dmethod in ('pudo', 'paxi') then v_point else null end, v_fee,
    case when v_discount > 0 then v_disc.code else null end, v_discount
  ) returning * into v_order;

  if v_discount > 0 then
    update public.shop_discount_codes set used_count = used_count + 1 where id = v_disc.id;
  end if;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    insert into public.shop_order_items (order_id, product_id, variant_id, variant_name, product_name, unit_price, qty)
    values (v_order.id, (v_line->>'product_id')::uuid, nullif(v_line->>'variant_id', '')::uuid, v_line->>'variant_name',
            v_line->>'name', (v_line->>'price')::numeric, (v_line->>'qty')::int);
    if v_line->>'variant_id' is not null then
      update public.shop_product_variants set stock_qty = stock_qty - (v_line->>'qty')::int
      where id = (v_line->>'variant_id')::uuid;
    else
      update public.shop_products set stock_qty = stock_qty - (v_line->>'qty')::int
      where id = (v_line->>'product_id')::uuid;
    end if;
  end loop;

  return jsonb_build_object(
    'id', v_order.id, 'order_number', v_order.order_number,
    'subtotal', v_order.subtotal, 'discount', v_order.discount_amount, 'delivery_fee', v_order.delivery_fee,
    'total', v_order.subtotal - v_order.discount_amount + v_order.delivery_fee,
    'status', v_order.status, 'items', v_lines);
end;
$$;

revoke all on function public.place_shop_order(jsonb, text, text, text, text, text, text, jsonb, text) from public;
grant execute on function public.place_shop_order(jsonb, text, text, text, text, text, text, jsonb, text) to anon, authenticated;

-- ── Admin status change: stock AND the discount code's use come back ────
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
    for r in select product_id, variant_id, variant_name, qty from public.shop_order_items
             where order_id = p_order_id and product_id is not null loop
      if r.variant_id is not null then
        update public.shop_product_variants set stock_qty = stock_qty + r.qty where id = r.variant_id;
      elsif r.variant_name is null then
        update public.shop_products set stock_qty = stock_qty + r.qty where id = r.product_id;
      end if;
    end loop;
    if v_order.discount_code is not null and v_order.discount_amount > 0 then
      update public.shop_discount_codes set used_count = greatest(0, used_count - 1) where upper(code) = upper(v_order.discount_code);
    end if;
    update public.shop_orders set stock_deducted = false where id = p_order_id;
  elsif not (p_status = any (v_restock)) and not v_order.stock_deducted then
    for r in select product_id, variant_id, variant_name, qty from public.shop_order_items
             where order_id = p_order_id and product_id is not null loop
      if r.variant_id is not null then
        update public.shop_product_variants set stock_qty = greatest(0, stock_qty - r.qty) where id = r.variant_id;
      elsif r.variant_name is null then
        update public.shop_products set stock_qty = greatest(0, stock_qty - r.qty) where id = r.product_id;
      end if;
    end loop;
    if v_order.discount_code is not null and v_order.discount_amount > 0 then
      update public.shop_discount_codes set used_count = used_count + 1 where upper(code) = upper(v_order.discount_code);
    end if;
    update public.shop_orders set stock_deducted = true where id = p_order_id;
  end if;

  update public.shop_orders
  set status = p_status, admin_reviewed_by = auth.uid(), admin_reviewed_at = now()
  where id = p_order_id;
end;
$$;

revoke all on function public.admin_set_shop_order_status(uuid, text) from public;
grant execute on function public.admin_set_shop_order_status(uuid, text) to authenticated;

-- ── Guest lookup also returns the discount ──────────────────────────────
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
    perform pg_sleep(0.4);
    return null;
  end if;

  return jsonb_build_object(
    'order_number', v_order.order_number,
    'status', v_order.status,
    'created_at', v_order.created_at,
    'buyer_name', v_order.buyer_username,
    'subtotal', v_order.subtotal,
    'discount_amount', v_order.discount_amount,
    'discount_code', v_order.discount_code,
    'delivery_fee', v_order.delivery_fee,
    'delivery_method', v_order.delivery_method,
    'delivery_point', v_order.delivery_point,
    'delivery_address', v_order.delivery_address,
    'courier_name', v_order.courier_name,
    'tracking_number', v_order.tracking_number,
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

-- ── Back-in-stock requests ──────────────────────────────────────────────
create table if not exists public.shop_stock_alerts (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  variant_id uuid references public.shop_product_variants(id) on delete cascade,
  contact text not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists shop_stock_alerts_product_idx on public.shop_stock_alerts (product_id) where notified_at is null;
alter table public.shop_stock_alerts enable row level security;

drop policy if exists "stock alerts admin only" on public.shop_stock_alerts;
create policy "stock alerts admin only" on public.shop_stock_alerts for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
grant select, update, delete on public.shop_stock_alerts to authenticated;

-- Shoppers (guests too) leave a request through this function only.
create or replace function public.request_stock_alert(p_product_id uuid, p_variant_id uuid, p_contact text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact text := trim(coalesce(p_contact, ''));
  v_digits text := regexp_replace(v_contact, '\D', '', 'g');
begin
  if v_contact !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(v_digits) < 7 then
    raise exception 'Enter a valid email or phone number.' using errcode = '22023';
  end if;
  if length(v_contact) > 120 then
    raise exception 'That looks too long.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.shop_products where id = p_product_id and active) then
    raise exception 'That product isn''t available.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shop_stock_alerts
             where product_id = p_product_id and variant_id is not distinct from p_variant_id
               and lower(contact) = lower(v_contact) and notified_at is null) then
    return; -- already on the list
  end if;
  insert into public.shop_stock_alerts (product_id, variant_id, contact) values (p_product_id, p_variant_id, v_contact);
end;
$$;
revoke all on function public.request_stock_alert(uuid, uuid, text) from public;
grant execute on function public.request_stock_alert(uuid, uuid, text) to anon, authenticated;
