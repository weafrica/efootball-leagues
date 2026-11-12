-- Shop phase 4a: product options.
--
-- * Variants (size / colour...) with their own stock and an optional price.
--   A product with variants shows the total of its variants as its stock, so
--   every existing stock badge keeps working.
-- * Quantity prices ("buy 3 or more, R90 each"), counted across all variants
--   of a product.
-- * Extra photos (gallery); shop_products.image_url stays the main photo.
-- * Old price (compare_at_price) shown crossed out next to the sale price.
--
-- Prices and stock are still decided on the server: place_shop_order and
-- shop_delivery_options use shop_unit_price(). Products without variants
-- behave exactly as before, so a cached older app keeps working for them.

-- ── Tables ──────────────────────────────────────────────────────────────
alter table public.shop_products
  add column if not exists compare_at_price numeric check (compare_at_price is null or compare_at_price >= 0);

create table if not exists public.shop_product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  price numeric check (price is null or price >= 0),
  stock_qty integer not null default 0 check (stock_qty >= 0),
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists shop_product_variants_product_idx on public.shop_product_variants (product_id, position);

create table if not exists public.shop_price_breaks (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  min_qty integer not null check (min_qty >= 2),
  unit_price numeric not null check (unit_price >= 0),
  unique (product_id, min_qty)
);

create table if not exists public.shop_product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  url text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists shop_product_images_product_idx on public.shop_product_images (product_id, position);

alter table public.shop_order_items
  add column if not exists variant_id uuid references public.shop_product_variants(id) on delete set null,
  add column if not exists variant_name text;

-- ── Access ──────────────────────────────────────────────────────────────
alter table public.shop_product_variants enable row level security;
alter table public.shop_price_breaks enable row level security;
alter table public.shop_product_images enable row level security;

drop policy if exists "variants readable" on public.shop_product_variants;
create policy "variants readable" on public.shop_product_variants for select
  using (active or exists (select 1 from public.admins a where a.user_id = auth.uid()));
drop policy if exists "variants admin write" on public.shop_product_variants;
create policy "variants admin write" on public.shop_product_variants for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "price breaks readable" on public.shop_price_breaks;
create policy "price breaks readable" on public.shop_price_breaks for select using (true);
drop policy if exists "price breaks admin write" on public.shop_price_breaks;
create policy "price breaks admin write" on public.shop_price_breaks for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "product images readable" on public.shop_product_images;
create policy "product images readable" on public.shop_product_images for select using (true);
drop policy if exists "product images admin write" on public.shop_product_images;
create policy "product images admin write" on public.shop_product_images for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

grant select on public.shop_product_variants, public.shop_price_breaks, public.shop_product_images to anon, authenticated;
grant insert, update, delete on public.shop_product_variants, public.shop_price_breaks, public.shop_product_images to authenticated;

-- ── Product stock = total of its active variants ────────────────────────
create or replace function public.shop_sync_variant_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pid uuid := coalesce(new.product_id, old.product_id);
begin
  if exists (select 1 from public.shop_product_variants where product_id = v_pid) then
    update public.shop_products
    set stock_qty = coalesce((select sum(stock_qty) from public.shop_product_variants
                              where product_id = v_pid and active), 0)
    where id = v_pid;
  end if;
  return null;
end;
$$;

drop trigger if exists shop_variants_sync_stock on public.shop_product_variants;
create trigger shop_variants_sync_stock
  after insert or update of stock_qty, active or delete on public.shop_product_variants
  for each row execute function public.shop_sync_variant_stock();

-- ── The price of one unit ───────────────────────────────────────────────
-- Variant price (if set) else product price; then the best quantity price
-- that the product's total quantity in the order qualifies for.
create or replace function public.shop_unit_price(p_product uuid, p_variant uuid, p_total_qty int)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select least(
    coalesce((select v.price from public.shop_product_variants v where v.id = p_variant and v.product_id = p_product),
             (select p.price from public.shop_products p where p.id = p_product)),
    coalesce((select b.unit_price from public.shop_price_breaks b
              where b.product_id = p_product and b.min_qty <= p_total_qty
              order by b.min_qty desc limit 1), 1e12)
  );
$$;
revoke all on function public.shop_unit_price(uuid, uuid, int) from public;
grant execute on function public.shop_unit_price(uuid, uuid, int) to anon, authenticated;

-- ── Delivery pricing: subtotal now uses variant and quantity prices ─────
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
    select x.product_id, x.variant_id, x.qty,
           sum(x.qty) over (partition by x.product_id) as product_qty,
           p.weight_kg, p.length_cm, p.width_cm, p.height_cm
    from jsonb_to_recordset(p_items) as x(product_id uuid, variant_id uuid, qty int)
    join public.shop_products p on p.id = x.product_id
  loop
    v_subtotal := v_subtotal + public.shop_unit_price(r.product_id, r.variant_id, r.product_qty::int) * r.qty;
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

-- ── Place an order: variants and quantity prices ────────────────────────
-- p_items: [{"product_id": uuid, "variant_id": uuid|null, "qty": int}, ...]
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

  -- Same product and option listed twice becomes one line.
  select coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'variant_id', variant_id, 'qty', qty)), '[]'::jsonb)
    into v_norm
  from (
    select x.product_id, x.variant_id, sum(x.qty)::int as qty
    from jsonb_to_recordset(p_items) as x(product_id uuid, variant_id uuid, qty int)
    group by x.product_id, x.variant_id
  ) g;

  -- Lock products, then variants, in a fixed order (no deadlocks, no overselling).
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

  -- Delivery: price it again here from the database.
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
    delivery_method, delivery_address, delivery_point, delivery_fee
  ) values (
    auth.uid(), trim(p_buyer_name), nullif(trim(p_phone), ''), nullif(trim(p_email), ''), p_method, v_status,
    v_total, nullif(trim(p_phone), ''), nullif(trim(p_note), ''), nullif(p_proof_path, ''), true,
    v_dmethod, case when v_dmethod = 'courier' then v_addr else null end,
    case when v_dmethod in ('pudo', 'paxi') then v_point else null end, v_fee
  ) returning * into v_order;

  for v_line in select * from jsonb_array_elements(v_lines) loop
    insert into public.shop_order_items (order_id, product_id, variant_id, variant_name, product_name, unit_price, qty)
    values (v_order.id, (v_line->>'product_id')::uuid, nullif(v_line->>'variant_id', '')::uuid, v_line->>'variant_name',
            v_line->>'name', (v_line->>'price')::numeric, (v_line->>'qty')::int);
    if v_line->>'variant_id' is not null then
      update public.shop_product_variants set stock_qty = stock_qty - (v_line->>'qty')::int
      where id = (v_line->>'variant_id')::uuid;   -- trigger refreshes the product total
    else
      update public.shop_products set stock_qty = stock_qty - (v_line->>'qty')::int
      where id = (v_line->>'product_id')::uuid;
    end if;
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

-- ── Admin status change: put stock back on the right variant ────────────
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
      end if;  -- option deleted since: nothing to put back
    end loop;
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
    update public.shop_orders set stock_deducted = true where id = p_order_id;
  end if;

  update public.shop_orders
  set status = p_status, admin_reviewed_by = auth.uid(), admin_reviewed_at = now()
  where id = p_order_id;
end;
$$;

revoke all on function public.admin_set_shop_order_status(uuid, text) from public;
grant execute on function public.admin_set_shop_order_status(uuid, text) to authenticated;
