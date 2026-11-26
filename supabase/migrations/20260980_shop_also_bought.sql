-- "Customers also bought": ids of products that appear in the same orders as
-- p_product_id (cancelled, rejected and refunded orders ignored; hidden
-- products excluded), most co-purchased first. Returns ids only, no customer data.
create or replace function public.shop_also_bought(p_product_id uuid, p_limit int default 6)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(pid order by n desc, pid), '{}'::uuid[]) from (
    select oi2.product_id as pid, count(distinct oi2.order_id) as n
    from public.shop_order_items oi
    join public.shop_orders o on o.id = oi.order_id and o.status not in ('rejected', 'cancelled', 'refunded')
    join public.shop_order_items oi2 on oi2.order_id = oi.order_id and oi2.product_id <> oi.product_id
    join public.shop_products p on p.id = oi2.product_id and p.active
    where oi.product_id = p_product_id and oi2.product_id is not null
    group by oi2.product_id
    order by n desc, oi2.product_id
    limit greatest(1, least(coalesce(p_limit, 6), 12))
  ) t;
$$;
revoke all on function public.shop_also_bought(uuid, int) from public;
grant execute on function public.shop_also_bought(uuid, int) to anon, authenticated;
