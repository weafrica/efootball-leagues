-- Lets the shop owner keep chosen products out of the Facebook / Instagram
-- catalogue feed (/shop-feed.xml). Default false = included.
alter table public.shop_products
  add column if not exists exclude_from_catalogue boolean not null default false;
