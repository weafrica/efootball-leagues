-- Personalised items: a product can offer a free-text "personalise this" box
-- (name, number, embroidery or print wording). The text is validated and
-- stored on the order line, and shown to the shop on the packing slip.
-- Prices, stock and grouping are untouched.

alter table public.shop_products
  add column if not exists personalisable boolean not null default false,
  add column if not exists personalise_label text;
alter table public.shop_order_items
  add column if not exists personalisation text;

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
  v_vname text;   -- (an unassigned record can't be read, which broke carts with no option products)
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

  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'variant_id', variant_id, 'qty', qty, 'personalisation', personalisation)), '[]'::jsonb)
    into v_norm
  from (
    select x.product_id, x.variant_id, sum(x.qty)::int as qty,
           max(left(trim(regexp_replace(coalesce(x.personalisation, ''), '[[:cntrl:]]', ' ', 'g')), 200)) as personalisation
    from jsonb_to_recordset(p_items) as x(product_id uuid, variant_id uuid, qty int, personalisation text)
    group by x.product_id, x.variant_id
  ) g;

  perform 1 from public.shop_products
    where id in (select (e->>'product_id')::uuid from jsonb_array_elements(v_norm) e)
    order by id for update;
  perform 1 from public.shop_product_variants
    where id in (select (e->>'variant_id')::uuid from jsonb_array_elements(v_norm) e where e->>'variant_id' is not null)
    order by id for update;

  for r in
    select x.product_id, x.variant_id, x.qty, x.personalisation,
           sum(x.qty) over (partition by x.product_id)::int as product_qty
    from jsonb_to_recordset(v_norm) as x(product_id uuid, variant_id uuid, qty int, personalisation text)
  loop
    select id, name, price, stock_qty, active, personalisable into v_product from public.shop_products where id = r.product_id;
    if not found or not v_product.active then
      raise exception 'An item in your cart is no longer available.' using errcode = 'P0001';
    end if;
    select exists (select 1 from public.shop_product_variants where product_id = r.product_id and active) into v_has_variants;
    v_name := v_product.name;
    v_vname := null;

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
      v_vname := v_variant.name;
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
      'name', v_name, 'variant_name', v_vname,
      'price', v_unit, 'qty', r.qty,
      'personalisation', case when v_product.personalisable then nullif(r.personalisation, '') else null end);
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
    insert into public.shop_order_items (order_id, product_id, variant_id, variant_name, product_name, unit_price, qty, personalisation)
    values (v_order.id, (v_line->>'product_id')::uuid, nullif(v_line->>'variant_id', '')::uuid, v_line->>'variant_name',
            v_line->>'name', (v_line->>'price')::numeric, (v_line->>'qty')::int, nullif(v_line->>'personalisation', ''));
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
    'order_number', v_order.order_number, 'status', v_order.status, 'created_at', v_order.created_at,
    'buyer_name', v_order.buyer_username, 'subtotal', v_order.subtotal,
    'discount_amount', v_order.discount_amount, 'discount_code', v_order.discount_code,
    'delivery_fee', v_order.delivery_fee, 'delivery_method', v_order.delivery_method,
    'delivery_point', v_order.delivery_point, 'delivery_address', v_order.delivery_address,
    'courier_name', v_order.courier_name, 'tracking_number', v_order.tracking_number,
    'checkout_method', v_order.checkout_method,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('product_name', i.product_name, 'qty', i.qty, 'unit_price', i.unit_price, 'personalisation', i.personalisation)
                       order by i.product_name)
      from public.shop_order_items i where i.order_id = v_order.id), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('status', h.to_status, 'at', h.created_at) order by h.created_at)
      from public.shop_order_status_history h where h.order_id = v_order.id), '[]'::jsonb),
    'return_request', (
      select jsonb_build_object('id', q.id, 'status', q.status, 'reason', q.reason, 'admin_note', q.admin_note, 'created_at', q.created_at)
      from public.shop_return_requests q where q.order_id = v_order.id order by q.created_at desc limit 1)
  );
end;
$$;
revoke all on function public.lookup_shop_order(text, text) from public;
grant execute on function public.lookup_shop_order(text, text) to anon, authenticated;
