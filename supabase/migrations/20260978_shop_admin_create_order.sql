-- Staff-created ("draft") orders. Reuses place_shop_order so stock, prices,
-- delivery and discount rules are identical to checkout, then detaches the
-- order from the staff member's account and sets awaiting-payment / paid.
create or replace function public.admin_create_shop_order(
  p_items jsonb, p_buyer_name text, p_phone text default null, p_email text default null,
  p_note text default null, p_delivery jsonb default null, p_discount_code text default null, p_paid boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb; v_id uuid; v_status text := case when p_paid then 'paid' else 'pending_review' end;
begin
  if auth.uid() is null or not public.is_shop_team() then
    raise exception 'Only the shop team can create orders.' using errcode = '42501';
  end if;
  if coalesce(trim(p_phone), '') = '' and coalesce(trim(p_email), '') = '' then
    raise exception 'Add a phone number or email so the customer can track the order.' using errcode = '22023';
  end if;
  v := public.place_shop_order(p_items, 'whatsapp', p_buyer_name, p_phone, p_email,
         trim('[Created by staff] ' || coalesce(p_note, '')), null, p_delivery, p_discount_code, null);
  v_id := (v->>'id')::uuid;
  update public.shop_orders set user_id = null, status = v_status where id = v_id;
  perform public.shop_log('order.created', v->>'order_number', jsonb_build_object('by_staff', true, 'paid', p_paid));
  return v || jsonb_build_object('status', v_status);
end $$;
revoke all on function public.admin_create_shop_order(jsonb, text, text, text, text, jsonb, text, boolean) from public, anon;
grant execute on function public.admin_create_shop_order(jsonb, text, text, text, text, jsonb, text, boolean) to authenticated;
