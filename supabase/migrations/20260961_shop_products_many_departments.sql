-- A product can sit in several departments and several categories.
--
-- shop_products.department_id / category_id stay as the product's main
-- department and category (older app versions and anything else that reads
-- them keep working); these two tables hold the full lists. Existing
-- products are copied across so nothing moves.

create table if not exists public.shop_product_departments (
  product_id uuid not null references public.shop_products(id) on delete cascade,
  department_id uuid not null references public.shop_departments(id) on delete cascade,
  primary key (product_id, department_id)
);
create table if not exists public.shop_product_categories (
  product_id uuid not null references public.shop_products(id) on delete cascade,
  category_id uuid not null references public.shop_categories(id) on delete cascade,
  primary key (product_id, category_id)
);

alter table public.shop_product_departments enable row level security;
alter table public.shop_product_categories enable row level security;

drop policy if exists "product departments readable" on public.shop_product_departments;
create policy "product departments readable" on public.shop_product_departments for select using (true);
drop policy if exists "product departments admin write" on public.shop_product_departments;
create policy "product departments admin write" on public.shop_product_departments for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "product categories readable" on public.shop_product_categories;
create policy "product categories readable" on public.shop_product_categories for select using (true);
drop policy if exists "product categories admin write" on public.shop_product_categories;
create policy "product categories admin write" on public.shop_product_categories for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

grant select on public.shop_product_departments, public.shop_product_categories to anon, authenticated;
grant insert, update, delete on public.shop_product_departments, public.shop_product_categories to authenticated;

insert into public.shop_product_departments (product_id, department_id)
  select id, department_id from public.shop_products where department_id is not null
  on conflict do nothing;
insert into public.shop_product_categories (product_id, category_id)
  select id, category_id from public.shop_products where category_id is not null
  on conflict do nothing;
