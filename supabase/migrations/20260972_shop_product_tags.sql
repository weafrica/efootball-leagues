-- Product tags: short labels the admin adds to a product (e.g. "hoodie",
-- "school", "winter"). Shoppers can search by them and tap a popular tag.
alter table public.shop_products add column if not exists tags text[] not null default '{}';
create index if not exists shop_products_tags_idx on public.shop_products using gin (tags);
