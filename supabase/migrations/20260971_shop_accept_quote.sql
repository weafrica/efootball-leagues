-- Customers can look up their quote and accept it online.
-- Proof of ownership is the quote reference plus the phone or email they gave
-- (same rule as lookup_shop_order). Accepting creates the same kind of order
-- the shop team's "Create order" button does, through one shared function.
alter table public.shop_quote_requests add column if not exists accepted_at timestamptz;

-- Shared by the admin button and the customer's accept. Not callable by clients.
create or replace function public.shop_make_order_from_quote(p_quote_id uuid, p_by_customer boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.shop_quote_requests;
  v_order public.shop_orders%rowtype;
begin
  select * into q from public.shop_quote_requests where id = p_quote_id for update;
  if not found then
    raise exception 'Quote not found.' using errcode = 'P0002';
  end if;
  if q.order_id is not null or q.status = 'ordered' then
    raise exception 'An order was already created from this quote.' using errcode = 'P0001';
  end if;
  if q.status <> 'quoted' or coalesce(q.quote_amount, 0) <= 0 then
    raise exception 'This quote is not ready yet.' using errcode = 'P0001';
  end if;

  insert into public.shop_orders (
    user_id, buyer_username, buyer_phone, buyer_email, checkout_method, status,
    subtotal, contact_phone, delivery_note, stock_deducted
  ) values (
    coalesce(auth.uid(), q.user_id), q.buyer_name, q.contact_phone, q.contact_email, 'whatsapp', 'whatsapp_sent',
    q.quote_amount, q.contact_phone, left('Quote ' || q.ref || ': ' || q.details, 400), true
  ) returning * into v_order;

  insert into public.shop_order_items (order_id, product_id, product_name, unit_price, qty)
  values (v_order.id, null, q.qty || ' x ' || q.product_name || ' (quote ' || q.ref || ')', q.quote_amount, 1);

  update public.shop_quote_requests
     set status = 'ordered', order_id = v_order.id, updated_at = now(),
         accepted_at = case when p_by_customer then now() else accepted_at end
   where id = q.id;
  return jsonb_build_object('id', v_order.id, 'order_number', v_order.order_number, 'total', q.quote_amount);
end;
$$;
revoke all on function public.shop_make_order_from_quote(uuid, boolean) from public, anon, authenticated;

create or replace function public.admin_create_order_from_quote(p_quote_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_shop_team() then
    raise exception 'Only the shop team can create orders.' using errcode = '42501';
  end if;
  return public.shop_make_order_from_quote(p_quote_id, false);
end;
$$;
revoke all on function public.admin_create_order_from_quote(uuid) from public;
grant execute on function public.admin_create_order_from_quote(uuid) to authenticated;

-- Finds the quote for a customer who knows its reference and contact detail.
create or replace function public.shop_quote_for_contact(p_ref text, p_contact text)
returns public.shop_quote_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.shop_quote_requests;
  v_contact text := lower(btrim(coalesce(p_contact, '')));
  v_digits text := regexp_replace(coalesce(p_contact, ''), '\D', '', 'g');
  v_ok boolean := false;
begin
  select * into q from public.shop_quote_requests where ref = upper(btrim(coalesce(p_ref, '')));
  if found and v_contact <> '' then
    if q.contact_email is not null and lower(q.contact_email) = v_contact then
      v_ok := true;
    elsif length(v_digits) >= 7 and q.contact_phone is not null
      and right(regexp_replace(q.contact_phone, '\D', '', 'g'), 9) = right(v_digits, 9) then
      v_ok := true;
    end if;
  end if;
  if not v_ok then
    perform pg_sleep(0.4);
    return null;
  end if;
  return q;
end;
$$;
revoke all on function public.shop_quote_for_contact(text, text) from public, anon, authenticated;

create or replace function public.lookup_shop_quote(p_ref text, p_contact text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare q public.shop_quote_requests; v_num text;
begin
  q := public.shop_quote_for_contact(p_ref, p_contact);
  if q.id is null then return null; end if;
  select order_number into v_num from public.shop_orders where id = q.order_id;
  return jsonb_build_object(
    'ref', q.ref, 'product_name', q.product_name, 'qty', q.qty, 'details', q.details,
    'status', q.status, 'quote_amount', q.quote_amount, 'admin_note', q.admin_note,
    'created_at', q.created_at, 'order_number', v_num);
end;
$$;
revoke all on function public.lookup_shop_quote(text, text) from public;
grant execute on function public.lookup_shop_quote(text, text) to anon, authenticated;

create or replace function public.accept_shop_quote(p_ref text, p_contact text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare q public.shop_quote_requests;
begin
  q := public.shop_quote_for_contact(p_ref, p_contact);
  if q.id is null then
    raise exception 'We could not find that quote. Check the reference and your phone or email.' using errcode = 'P0002';
  end if;
  if q.status = 'closed' then
    raise exception 'This quote has been closed. Please contact us.' using errcode = 'P0001';
  end if;
  return public.shop_make_order_from_quote(q.id, true);
end;
$$;
revoke all on function public.accept_shop_quote(text, text) from public;
grant execute on function public.accept_shop_quote(text, text) to anon, authenticated;
