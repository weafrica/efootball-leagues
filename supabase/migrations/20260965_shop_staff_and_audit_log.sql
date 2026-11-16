-- Shop staff roles + audit log.
--
-- The existing `admins` table is shared with the rest of Matchday, so shop
-- helpers get their own list (shop_staff). Staff can see and work through
-- orders (change status up to delivered/cancel/reject, add tracking, approve
-- or decline returns, handle back-in-stock requests). Only admins can refund,
-- edit products, codes, settings, or manage staff.
--
-- Everything that matters is written to shop_audit_log (admins can read it).

create table if not exists public.shop_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  added_by uuid,
  created_at timestamptz not null default now()
);
alter table public.shop_staff enable row level security;

create or replace function public.is_shop_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;
create or replace function public.is_shop_team()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
      or exists (select 1 from public.shop_staff s where s.user_id = auth.uid());
$$;
revoke all on function public.is_shop_admin() from public;
revoke all on function public.is_shop_team() from public;
grant execute on function public.is_shop_admin() to authenticated;
grant execute on function public.is_shop_team() to authenticated;

drop policy if exists "shop_staff admin all" on public.shop_staff;
create policy "shop_staff admin all" on public.shop_staff for all
  using (public.is_shop_admin()) with check (public.is_shop_admin());
drop policy if exists "shop_staff read self" on public.shop_staff;
create policy "shop_staff read self" on public.shop_staff for select using (user_id = auth.uid());
grant select on public.shop_staff to authenticated;

-- Staff can read the order side of the shop (extra policies; admins keep theirs).
drop policy if exists "shop_orders team read" on public.shop_orders;
create policy "shop_orders team read" on public.shop_orders for select using (public.is_shop_team());
drop policy if exists "shop_order_items team read" on public.shop_order_items;
create policy "shop_order_items team read" on public.shop_order_items for select using (public.is_shop_team());
drop policy if exists "status history team read" on public.shop_order_status_history;
create policy "status history team read" on public.shop_order_status_history for select using (public.is_shop_team());
drop policy if exists "returns team read" on public.shop_return_requests;
create policy "returns team read" on public.shop_return_requests for select using (public.is_shop_team());
drop policy if exists "stock alerts team" on public.shop_stock_alerts;
create policy "stock alerts team" on public.shop_stock_alerts for all using (public.is_shop_team()) with check (public.is_shop_team());
drop policy if exists "shop_proofs_team_read" on storage.objects;
create policy "shop_proofs_team_read" on storage.objects for select
  using (bucket_id = 'shop-payment-proofs' and public.is_shop_team());

-- ── Audit log ───────────────────────────────────────────────────────────
create table if not exists public.shop_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_label text,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists shop_audit_log_created_idx on public.shop_audit_log (created_at desc);
alter table public.shop_audit_log enable row level security;
drop policy if exists "audit admin read" on public.shop_audit_log;
create policy "audit admin read" on public.shop_audit_log for select using (public.is_shop_admin());
grant select on public.shop_audit_log to authenticated;

create or replace function public.shop_actor_label(p_uid uuid)
returns text language sql stable security definer set search_path = public, auth as $$
  select coalesce((select s.email from public.shop_staff s where s.user_id = p_uid),
                  (select u.email from auth.users u where u.id = p_uid), 'unknown');
$$;
revoke all on function public.shop_actor_label(uuid) from public;

-- Only records actions by signed-in shop team members.
create or replace function public.shop_log(p_action text, p_target text, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_shop_team() then return; end if;
  insert into public.shop_audit_log (actor_id, actor_label, action, target, detail)
  values (auth.uid(), public.shop_actor_label(auth.uid()), p_action, p_target, coalesce(p_detail, '{}'::jsonb));
end;
$$;
revoke all on function public.shop_log(text, text, jsonb) from public;

create or replace function public.trg_audit_shop_orders()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    perform public.shop_log('order.status', new.order_number, jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.tracking_number is distinct from old.tracking_number or new.courier_name is distinct from old.courier_name then
    perform public.shop_log('order.tracking', new.order_number, jsonb_build_object('courier', new.courier_name, 'tracking', new.tracking_number));
  end if;
  return new;
end;
$$;
drop trigger if exists audit_shop_orders on public.shop_orders;
create trigger audit_shop_orders after update on public.shop_orders for each row
  when (old.status is distinct from new.status or old.tracking_number is distinct from new.tracking_number or old.courier_name is distinct from new.courier_name)
  execute function public.trg_audit_shop_orders();

-- Products: log creation, deletion, and changes to name / price / visibility (not stock, which moves with every order).
create or replace function public.trg_audit_shop_products()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform public.shop_log('product.created', new.name, jsonb_build_object('price', new.price));
  elsif tg_op = 'DELETE' then
    perform public.shop_log('product.deleted', old.name, jsonb_build_object('price', old.price));
  else
    if new.name is distinct from old.name then v_changes := v_changes || jsonb_build_object('name', jsonb_build_array(old.name, new.name)); end if;
    if new.price is distinct from old.price then v_changes := v_changes || jsonb_build_object('price', jsonb_build_array(old.price, new.price)); end if;
    if new.active is distinct from old.active then v_changes := v_changes || jsonb_build_object('active', jsonb_build_array(old.active, new.active)); end if;
    if v_changes <> '{}'::jsonb then perform public.shop_log('product.updated', new.name, v_changes); end if;
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists audit_shop_products on public.shop_products;
create trigger audit_shop_products after insert or update or delete on public.shop_products
  for each row execute function public.trg_audit_shop_products();

create or replace function public.trg_audit_discount_codes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.shop_log('code.created', new.code, jsonb_build_object('kind', new.kind, 'value', new.value));
  elsif tg_op = 'DELETE' then
    perform public.shop_log('code.deleted', old.code, '{}'::jsonb);
  elsif new.active is distinct from old.active or new.value is distinct from old.value then
    perform public.shop_log('code.updated', new.code, jsonb_build_object('active', new.active, 'value', new.value));
  end if;
  return coalesce(new, old);
end;
$$;
drop trigger if exists audit_discount_codes on public.shop_discount_codes;
create trigger audit_discount_codes after insert or update or delete on public.shop_discount_codes
  for each row execute function public.trg_audit_discount_codes();

-- Settings: log which setting changed, never its contents (bank details live here).
create or replace function public.trg_audit_shop_settings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.shop_log('settings.updated', new.key, '{}'::jsonb);
  return new;
end;
$$;
drop trigger if exists audit_shop_settings on public.shop_settings;
create trigger audit_shop_settings after insert or update on public.shop_settings
  for each row execute function public.trg_audit_shop_settings();

-- ── Order actions that staff may use ────────────────────────────────────
create or replace function public.admin_set_shop_order_status(p_order_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order public.shop_orders%rowtype;
  v_restock constant text[] := array['rejected', 'cancelled', 'refunded'];
  r record;
begin
  if not public.is_shop_team() then
    raise exception 'Only the shop team can change an order status.' using errcode = '42501';
  end if;
  if p_status = 'refunded' and not public.is_shop_admin() then
    raise exception 'Only the shop owner can refund an order.' using errcode = '42501';
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

create or replace function public.admin_set_shop_order_tracking(p_order_id uuid, p_courier text, p_tracking text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_shop_team() then
    raise exception 'Only the shop team can add tracking.' using errcode = '42501';
  end if;
  update public.shop_orders
  set courier_name = nullif(trim(coalesce(p_courier, '')), ''), tracking_number = nullif(trim(coalesce(p_tracking, '')), '')
  where id = p_order_id;
  if not found then raise exception 'Order not found.' using errcode = 'P0002'; end if;
end;
$$;
revoke all on function public.admin_set_shop_order_tracking(uuid, text, text) from public;
grant execute on function public.admin_set_shop_order_tracking(uuid, text, text) to authenticated;

create or replace function public.admin_resolve_shop_return(p_return_id uuid, p_action text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.shop_return_requests%rowtype;
  v_status text;
  v_number text;
begin
  if not public.is_shop_team() then
    raise exception 'Only the shop team can resolve returns.' using errcode = '42501';
  end if;
  if p_action not in ('approve', 'reject', 'refund') then
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
  if p_action = 'refund' and not public.is_shop_admin() then
    raise exception 'Only the shop owner can refund an order.' using errcode = '42501';
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
  select order_number into v_number from public.shop_orders where id = r.order_id;
  perform public.shop_log('return.' || v_status, v_number, jsonb_build_object('note', nullif(trim(coalesce(p_note, '')), '')));
end;
$$;
revoke all on function public.admin_resolve_shop_return(uuid, text, text) from public;
grant execute on function public.admin_resolve_shop_return(uuid, text, text) to authenticated;

-- ── Managing staff (admins only) ────────────────────────────────────────
create or replace function public.admin_add_shop_staff(p_email text)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_uid uuid;
begin
  if not public.is_shop_admin() then
    raise exception 'Only the shop owner can add staff.' using errcode = '42501';
  end if;
  if v_email = '' then raise exception 'Enter their email address.' using errcode = '22023'; end if;
  select id into v_uid from auth.users where lower(email) = v_email limit 1;
  if v_uid is null then
    raise exception 'No account uses that email. Ask them to sign up first, then add them.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.admins where user_id = v_uid) then
    raise exception 'That person is already an admin.' using errcode = 'P0001';
  end if;
  insert into public.shop_staff (user_id, email, added_by) values (v_uid, v_email, auth.uid())
  on conflict (user_id) do nothing;
  perform public.shop_log('staff.added', v_email, '{}'::jsonb);
  return jsonb_build_object('user_id', v_uid, 'email', v_email);
end;
$$;
revoke all on function public.admin_add_shop_staff(text) from public;
grant execute on function public.admin_add_shop_staff(text) to authenticated;

create or replace function public.admin_remove_shop_staff(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if not public.is_shop_admin() then
    raise exception 'Only the shop owner can remove staff.' using errcode = '42501';
  end if;
  delete from public.shop_staff where user_id = p_user_id returning email into v_email;
  if v_email is not null then perform public.shop_log('staff.removed', v_email, '{}'::jsonb); end if;
end;
$$;
revoke all on function public.admin_remove_shop_staff(uuid) from public;
grant execute on function public.admin_remove_shop_staff(uuid) to authenticated;
