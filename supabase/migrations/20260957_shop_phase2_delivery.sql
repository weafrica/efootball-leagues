-- Shop phase 2: delivery.
--
-- * Products get a weight and size (used to price delivery and to decide
--   whether a parcel fits a PAXI bag).
-- * Orders record how they are delivered: method, address or pick-up point,
--   fee, courier and tracking number.
-- * Delivery prices live in shop_settings ('delivery_config', JSON) and are
--   edited by admin in the app. Every method starts switched off; with none
--   switched on, checkout behaves exactly as before (no delivery step).
-- * shop_delivery_options() prices the cart for every method on the server;
--   place_shop_order() re-prices it, so the fee can't be changed from the
--   browser.
--
-- Fees are fixed prices you set. The Courier Guy / Pudo live rate API and the
-- PAXI portal can replace them later without changing the checkout screens.

-- ── Columns ─────────────────────────────────────────────────────────────
alter table public.shop_products
  add column if not exists weight_kg numeric check (weight_kg is null or weight_kg >= 0),
  add column if not exists length_cm numeric check (length_cm is null or length_cm >= 0),
  add column if not exists width_cm numeric check (width_cm is null or width_cm >= 0),
  add column if not exists height_cm numeric check (height_cm is null or height_cm >= 0);

alter table public.shop_orders
  add column if not exists delivery_method text,
  add column if not exists delivery_address jsonb,
  add column if not exists delivery_point text,
  add column if not exists delivery_fee numeric not null default 0,
  add column if not exists courier_name text,
  add column if not exists tracking_number text;

alter table public.shop_orders drop constraint if exists shop_orders_delivery_method_check;
alter table public.shop_orders add constraint shop_orders_delivery_method_check
  check (delivery_method is null or delivery_method in ('collection', 'courier', 'pudo', 'paxi'));

-- ── Config (all methods off until the admin sets prices) ────────────────
insert into public.shop_settings (key, value) values ('delivery_config', $json$
{
  "default_weight_kg": 0.5,
  "free_over": 0,
  "collection": { "enabled": false, "address": "", "hours": "" },
  "courier": { "enabled": false, "fee": 0, "days": "2 to 4 working days" },
  "pudo":    { "enabled": false, "fee": 0, "days": "2 to 4 working days" },
  "paxi":    { "enabled": false, "standard_fee": 109.95, "large_fee": 139.95, "days": "3 to 5 working days" }
}
$json$) on conflict (key) do nothing;

-- ── Price delivery for a cart ───────────────────────────────────────────
-- p_items: [{"product_id": uuid, "qty": int}, ...]
-- Returns [{method, label, enabled, available, fee, days, note}] for every
-- method that is switched on.
create or replace function public.shop_delivery_options(p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg jsonb;
  v_default_w numeric;
  v_free_over numeric;
  v_subtotal numeric := 0;
  v_weight numeric := 0;
  v_longest numeric := 0;
  r record;
  v_out jsonb := '[]'::jsonb;
  v_fee numeric;
  v_free boolean;
  v_bag text;
begin
  select coalesce(nullif(value, '')::jsonb, '{}'::jsonb) into cfg from public.shop_settings where key = 'delivery_config';
  cfg := coalesce(cfg, '{}'::jsonb);
  v_default_w := coalesce((cfg->>'default_weight_kg')::numeric, 0.5);
  v_free_over := coalesce((cfg->>'free_over')::numeric, 0);

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return v_out;
  end if;

  for r in
    select p.price, p.weight_kg, p.length_cm, p.width_cm, p.height_cm, (e->>'qty')::int as qty
    from jsonb_array_elements(p_items) e
    join public.shop_products p on p.id = (e->>'product_id')::uuid
  loop
    v_subtotal := v_subtotal + r.price * r.qty;
    v_weight := v_weight + coalesce(r.weight_kg, v_default_w) * r.qty;
    v_longest := greatest(v_longest, coalesce(r.length_cm, 0), coalesce(r.width_cm, 0), coalesce(r.height_cm, 0));
  end loop;

  v_free := v_free_over > 0 and v_subtotal >= v_free_over;

  if coalesce((cfg->'collection'->>'enabled')::boolean, false) then
    v_out := v_out || jsonb_build_object(
      'method', 'collection', 'label', 'Collect from us', 'available', true, 'fee', 0,
      'days', null, 'note', trim(both from concat_ws(E'\n', nullif(cfg->'collection'->>'address', ''), nullif(cfg->'collection'->>'hours', ''))));
  end if;

  if coalesce((cfg->'courier'->>'enabled')::boolean, false) then
    v_fee := case when v_free then 0 else coalesce((cfg->'courier'->>'fee')::numeric, 0) end;
    v_out := v_out || jsonb_build_object(
      'method', 'courier', 'label', 'Courier to your door', 'available', true, 'fee', v_fee,
      'days', cfg->'courier'->>'days', 'note', case when v_free then 'Free delivery on this order' else null end);
  end if;

  if coalesce((cfg->'pudo'->>'enabled')::boolean, false) then
    v_fee := case when v_free then 0 else coalesce((cfg->'pudo'->>'fee')::numeric, 0) end;
    v_out := v_out || jsonb_build_object(
      'method', 'pudo', 'label', 'Pudo locker', 'available', true, 'fee', v_fee,
      'days', cfg->'pudo'->>'days', 'note', case when v_free then 'Free delivery on this order' else null end);
  end if;

  if coalesce((cfg->'paxi'->>'enabled')::boolean, false) then
    -- Standard bag: 45 x 37 cm, 5 kg. Large bag: 64 x 51 cm, 10 kg.
    v_bag := case
      when v_weight <= 5 and v_longest <= 45 then 'standard'
      when v_weight <= 10 and v_longest <= 60 then 'large'
      else null end;
    if v_bag is null then
      v_out := v_out || jsonb_build_object(
        'method', 'paxi', 'label', 'PAXI at a PEP store', 'available', false, 'fee', 0,
        'days', null, 'note', 'Too big or heavy for a PAXI bag');
    else
      v_fee := case when v_free then 0
                    when v_bag = 'standard' then coalesce((cfg->'paxi'->>'standard_fee')::numeric, 0)
                    else coalesce((cfg->'paxi'->>'large_fee')::numeric, 0) end;
      v_out := v_out || jsonb_build_object(
        'method', 'paxi', 'label', 'PAXI at a PEP store', 'available', true, 'fee', v_fee,
        'days', cfg->'paxi'->>'days', 'note', case when v_free then 'Free delivery on this order' else null end);
    end if;
  end if;

  return v_out;
end;
$$;

revoke all on function public.shop_delivery_options(jsonb) from public;
grant execute on function public.shop_delivery_options(jsonb) to anon, authenticated;

-- ── Place an order (now with delivery) ──────────────────────────────────
-- p_delivery: {"method": "courier|pudo|paxi|collection",
--              "address": {"street","suburb","city","province","postal_code"},
--              "point": "locker or PAXI point name / code"}
-- Older app versions call without it; that is allowed while no delivery
-- method is switched on, and stored as "no delivery step".
drop function if exists public.place_shop_order(jsonb, text, text, text, text, text, text);

create or replace function public.place_shop_order(
  p_items jsonb,
  p_method text,
  p_buyer_name text,
  p_phone text default null,
  p_email text default null,
  p_note text default null,
  p_proof_path text default null,
  p_delivery jsonb default null
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
  v_options jsonb;
  v_opt jsonb;
  v_dmethod text := nullif(p_delivery->>'method', '');
  v_addr jsonb := p_delivery->'address';
  v_point text := nullif(trim(coalesce(p_delivery->>'point', '')), '');
  v_fee numeric := 0;
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

  -- Delivery: price it again here from the database.
  v_options := public.shop_delivery_options(p_items);
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
    delivery_method, delivery_address, delivery_point, delivery_fee
  ) values (
    auth.uid(), trim(p_buyer_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''), p_method, v_status,
    v_total, nullif(trim(p_phone), ''), nullif(trim(p_note), ''), nullif(p_proof_path, ''), true,
    v_dmethod, case when v_dmethod = 'courier' then v_addr else null end,
    case when v_dmethod in ('pudo', 'paxi') then v_point else null end, v_fee
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
    'subtotal', v_order.subtotal, 'delivery_fee', v_order.delivery_fee,
    'total', v_order.subtotal + v_order.delivery_fee,
    'status', v_order.status, 'items', v_lines);
end;
$$;

revoke all on function public.place_shop_order(jsonb, text, text, text, text, text, text, jsonb) from public;
grant execute on function public.place_shop_order(jsonb, text, text, text, text, text, text, jsonb) to anon, authenticated;

-- ── Guest lookup now includes delivery and tracking ─────────────────────
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
    'subtotal', v_order.subtotal,
    'delivery_fee', v_order.delivery_fee,
    'delivery_method', v_order.delivery_method,
    'delivery_point', v_order.delivery_point,
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
