-- Shop returns & refunds.
--
-- A shopper (signed in or a guest who can prove the order with their phone or
-- email) asks for a return through request_shop_return. Admin approves,
-- rejects, or refunds it through admin_resolve_shop_return. A refund marks the
-- order "refunded" using the existing admin_set_shop_order_status, so stock and
-- any discount code use go back automatically, and it shows in order history.

create table if not exists public.shop_return_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.shop_orders(id) on delete cascade,
  reason text not null check (char_length(reason) between 5 and 1000),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'refunded')),
  admin_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists shop_return_requests_order_idx on public.shop_return_requests (order_id);
create index if not exists shop_return_requests_open_idx on public.shop_return_requests (status) where status in ('requested', 'approved');
alter table public.shop_return_requests enable row level security;

drop policy if exists "returns admin all" on public.shop_return_requests;
create policy "returns admin all" on public.shop_return_requests for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "returns owner read" on public.shop_return_requests;
create policy "returns owner read" on public.shop_return_requests for select
  using (exists (select 1 from public.shop_orders o where o.id = order_id and o.user_id = auth.uid()));

grant select on public.shop_return_requests to authenticated;

-- Shopper asks for a return. Same proof of ownership as lookup_shop_order.
create or replace function public.request_shop_return(p_order_number text, p_contact text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.shop_orders%rowtype;
  v_contact text := lower(trim(coalesce(p_contact, '')));
  v_digits text := regexp_replace(coalesce(p_contact, ''), '\D', '', 'g');
  v_reason text := trim(coalesce(p_reason, ''));
  v_ok boolean := false;
  v_row public.shop_return_requests%rowtype;
begin
  select * into v_order from public.shop_orders
  where order_number = upper(trim(coalesce(p_order_number, '')));

  if found then
    if auth.uid() is not null and v_order.user_id = auth.uid() then
      v_ok := true;
    elsif v_contact <> '' then
      if v_order.buyer_email is not null and lower(v_order.buyer_email) = v_contact then
        v_ok := true;
      elsif length(v_digits) >= 7 and v_order.contact_phone is not null
        and right(regexp_replace(v_order.contact_phone, '\D', '', 'g'), 9) = right(v_digits, 9) then
        v_ok := true;
      end if;
    end if;
  end if;

  if not v_ok then
    perform pg_sleep(0.4);
    raise exception 'We couldn''t find that order.' using errcode = 'P0002';
  end if;
  if v_order.status not in ('shipped', 'delivered', 'fulfilled') then
    raise exception 'Returns can be requested once your order has been sent.' using errcode = 'P0001';
  end if;
  if char_length(v_reason) < 5 then
    raise exception 'Please tell us briefly what is wrong (at least a few words).' using errcode = '22023';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'That is too long. Please keep it under 1000 characters.' using errcode = '22023';
  end if;
  if exists (select 1 from public.shop_return_requests where order_id = v_order.id and status in ('requested', 'approved')) then
    raise exception 'You already have a return request open for this order.' using errcode = 'P0001';
  end if;

  insert into public.shop_return_requests (order_id, reason) values (v_order.id, v_reason) returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'reason', v_row.reason, 'created_at', v_row.created_at);
end;
$$;
revoke all on function public.request_shop_return(text, text, text) from public;
grant execute on function public.request_shop_return(text, text, text) to anon, authenticated;

-- Admin: approve | reject | refund (refund also restocks and gives the discount use back).
create or replace function public.admin_resolve_shop_return(p_return_id uuid, p_action text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.shop_return_requests%rowtype;
  v_status text;
begin
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'Only the shop admin can resolve returns.' using errcode = '42501';
  end if;
  if p_action not in ('approve', 'reject', 'refund') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  select * into r from public.shop_return_requests where id = p_return_id for update;
  if not found then
    raise exception 'Return request not found.' using errcode = 'P0002';
  end if;
  if r.status in ('rejected', 'refunded') then
    raise exception 'This return was already closed.' using errcode = 'P0001';
  end if;
  if p_action = 'approve' and r.status = 'approved' then
    raise exception 'This return is already approved.' using errcode = 'P0001';
  end if;

  if p_action = 'refund' then
    perform public.admin_set_shop_order_status(r.order_id, 'refunded');
  end if;
  v_status := case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'refunded' end;
  update public.shop_return_requests
  set status = v_status,
      admin_note = coalesce(nullif(trim(p_note), ''), admin_note),
      resolved_at = case when v_status = 'approved' then null else now() end
  where id = p_return_id;
end;
$$;
revoke all on function public.admin_resolve_shop_return(uuid, text, text) from public;
grant execute on function public.admin_resolve_shop_return(uuid, text, text) to authenticated;

-- Guest lookup also returns the newest return request.
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
      select jsonb_agg(jsonb_build_object('product_name', i.product_name, 'qty', i.qty, 'unit_price', i.unit_price)
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
