-- Pre-orders: a product flagged preorder takes orders without stock limits.
-- Stock is neither checked, deducted nor restored for those items, and the
-- order line is named "<product> (pre-order)". See place_shop_order and
-- admin_set_shop_order_status (patched live; definitions below changed as noted).
alter table public.shop_products add column if not exists preorder boolean not null default false;
alter table public.shop_products add column if not exists preorder_note text;
-- place_shop_order: loads preorder with the product; stock checks use
--   "not v_product.preorder and stock < qty"; lines carry 'preorder'; the
--   deduction loop skips preorder lines; item name gets " (pre-order)".
-- admin_set_shop_order_status: restock/deduct loops skip products where preorder.
