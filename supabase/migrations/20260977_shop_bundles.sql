-- Product bundles: a bundle is a normal shop product whose stock comes from
-- its components. Orders deduct (and cancellations restore) the components.
create table if not exists public.shop_bundle_items (
  bundle_id uuid not null references public.shop_products(id) on delete cascade,
  product_id uuid not null references public.shop_products(id) on delete restrict,
  qty integer not null default 1 check (qty >= 1 and qty <= 99),
  primary key (bundle_id, product_id),
  check (bundle_id <> product_id)
);
create index if not exists shop_bundle_items_product_idx on public.shop_bundle_items (product_id);
alter table public.shop_bundle_items enable row level security;
drop policy if exists "bundle items readable" on public.shop_bundle_items;
create policy "bundle items readable" on public.shop_bundle_items for select using (true);
drop policy if exists "bundle items admin write" on public.shop_bundle_items;
create policy "bundle items admin write" on public.shop_bundle_items for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
grant select on public.shop_bundle_items to anon, authenticated;
grant insert, update, delete on public.shop_bundle_items to authenticated;
-- place_shop_order / admin_set_shop_order_status are also patched (see live DB):
--   bundle lines check min(floor(component stock / qty)), deduct components, and
--   a final guard raises if any component went negative; status changes restock
--   or re-deduct the components of bundle lines.
