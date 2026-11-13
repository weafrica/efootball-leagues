-- Optional link to a product's post on the shop's Facebook page. Set by admin
-- in the product editor; shoppers get a "See this on Facebook" button.
alter table public.shop_products add column if not exists facebook_url text;
