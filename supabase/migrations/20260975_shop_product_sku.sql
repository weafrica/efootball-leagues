-- SKU and barcode on shop products. SKU is unique (ignoring case) when set.
alter table public.shop_products add column if not exists sku text;
alter table public.shop_products add column if not exists barcode text;
create unique index if not exists shop_products_sku_uniq on public.shop_products (lower(sku)) where sku is not null;
create index if not exists shop_products_barcode_idx on public.shop_products (barcode) where barcode is not null;
