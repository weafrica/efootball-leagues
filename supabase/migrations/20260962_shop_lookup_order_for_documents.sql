-- Guest order lookup now also returns the buyer's name and the delivery
-- address, so the invoice / receipt a guest opens from "Track an order" is
-- complete. Still only returned to someone who gave the order number plus the
-- phone number or email used at checkout.
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
