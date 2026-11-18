-- Turn an agreed quote into a normal order (status "Sent via WhatsApp", i.e.
-- waiting for payment) so it flows through payment, packing, invoice and
-- tracking like any other. The order carries one line with the quoted total
-- (qty 1), no product link, so it never touches stock.
alter table public.shop_quote_requests
  add column if not exists order_id uuid references public.shop_orders(id) on delete set null;
alter table public.shop_quote_requests drop constraint if exists shop_quote_requests_status_check;
alter table public.shop_quote_requests
  add constraint shop_quote_requests_status_check check (status in ('new', 'quoted', 'ordered', 'closed'));

create or replace function public.admin_create_order_from_quote(p_quote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.shop_quote_requests;
  v_order public.shop_orders%rowtype;
begin
  if not public.is_shop_team() then
    raise exception 'Only the shop team can create orders.' using errcode = '42501';
  end if;
  select * into q from public.shop_quote_requests where id = p_quote_id for update;
  if not found then
    raise exception 'Quote not found.' using errcode = 'P0002';
  end if;
  if q.order_id is not null or q.status = 'ordered' then
    raise exception 'An order was already created from this quote.' using errcode = 'P0001';
  end if;
  if q.status <> 'quoted' or coalesce(q.quote_amount, 0) <= 0 then
    raise exception 'Save a quoted price first.' using errcode = 'P0001';
  end if;

  insert into public.shop_orders (
    user_id, buyer_username, buyer_phone, buyer_email, checkout_method, status,
    subtotal, contact_phone, delivery_note, stock_deducted
  ) values (
    q.user_id, q.buyer_name, q.contact_phone, q.contact_email, 'whatsapp', 'whatsapp_sent',
    q.quote_amount, q.contact_phone, left('Quote ' || q.ref || ': ' || q.details, 400), true
  ) returning * into v_order;

  insert into public.shop_order_items (order_id, product_id, product_name, unit_price, qty)
  values (v_order.id, null, q.qty || ' x ' || q.product_name || ' (quote ' || q.ref || ')', q.quote_amount, 1);

  update public.shop_quote_requests set status = 'ordered', order_id = v_order.id, updated_at = now() where id = q.id;
  return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number);
end;
$$;
revoke all on function public.admin_create_order_from_quote(uuid) from public;
grant execute on function public.admin_create_order_from_quote(uuid) to authenticated;
