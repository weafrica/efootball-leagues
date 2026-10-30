-- Shop phase 1, step 2: orders may now only be created through
-- place_shop_order() (which checks prices and stock on the server).
--
-- !! Apply this ONLY after the phase 1 app version is live. Shoppers on an
-- older cached copy of the shop would otherwise be unable to order until
-- they refresh. !!
--
-- Also closes a hole: "anyone can insert order items" (with check true) let
-- anyone add lines to any order.
drop policy if exists "anyone can insert orders" on public.shop_orders;
drop policy if exists "shop_orders_insert" on public.shop_orders;
drop policy if exists "anyone can insert order items" on public.shop_order_items;
drop policy if exists "shop_order_items_insert" on public.shop_order_items;
