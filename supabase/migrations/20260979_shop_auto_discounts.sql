-- Automatic (no-code) discounts. place_shop_order applies the better of a typed
-- code or the best active automatic rule; an automatic discount is stored on the
-- order as discount_code = 'AUTO: <name>' and never consumes a code's uses.
create table if not exists public.shop_auto_discounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  kind text not null check (kind in ('percent', 'fixed')),
  value numeric not null check (value > 0),
  min_spend numeric not null default 0 check (min_spend >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (kind <> 'percent' or value <= 100)
);
alter table public.shop_auto_discounts enable row level security;
drop policy if exists "auto discounts readable" on public.shop_auto_discounts;
create policy "auto discounts readable" on public.shop_auto_discounts for select using (active or exists (select 1 from public.admins a where a.user_id = auth.uid()));
drop policy if exists "auto discounts admin write" on public.shop_auto_discounts;
create policy "auto discounts admin write" on public.shop_auto_discounts for all
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
grant select on public.shop_auto_discounts to anon, authenticated;
grant insert, update, delete on public.shop_auto_discounts to authenticated;

create or replace function public.shop_auto_discount(p_subtotal numeric)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(t) from (
    select d.name,
           case when d.kind = 'percent' then least(p_subtotal, round(p_subtotal * d.value / 100, 2)) else least(p_subtotal, d.value) end as amount
    from public.shop_auto_discounts d
    where d.active and d.min_spend <= p_subtotal
    order by 2 desc, d.created_at limit 1
  ) t where t.amount > 0;
$$;
revoke all on function public.shop_auto_discount(numeric) from public;
grant execute on function public.shop_auto_discount(numeric) to anon, authenticated;
-- place_shop_order (patched live): declares v_auto / v_auto_name, calls
-- shop_auto_discount(v_total) just before the delivery options and keeps the
-- larger of it and the code discount; the order row stores
-- coalesce(v_disc.code, v_auto_name) as discount_code.
