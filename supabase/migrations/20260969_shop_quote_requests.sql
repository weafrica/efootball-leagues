-- "Price on request" products and quote requests (custom print / embroidery).
--  * shop_products.quote_only: no Add to cart, shoppers request a quote instead.
--  * shop_quote_requests: what the shopper asked for, filled by request_shop_quote()
--    only (guests too). The shop owner and helpers read and answer them.
--  * place_shop_order refuses quote-only products, so they can never be bought
--    at a placeholder price through the normal checkout.
alter table public.shop_products
  add column if not exists quote_only boolean not null default false;

create sequence if not exists public.shop_quote_seq start 1001;

create table if not exists public.shop_quote_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('QT-' || nextval('public.shop_quote_seq')),
  product_id uuid references public.shop_products(id) on delete set null,
  product_name text not null,
  qty integer not null check (qty between 1 and 10000),
  details text not null check (length(btrim(details)) between 1 and 1000),
  buyer_name text not null,
  contact_phone text,
  contact_email text,
  user_id uuid,
  status text not null default 'new' check (status in ('new', 'quoted', 'closed')),
  quote_amount numeric check (quote_amount is null or quote_amount >= 0),
  admin_note text check (admin_note is null or length(admin_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shop_quote_requests_created_idx on public.shop_quote_requests (created_at desc);

alter table public.shop_quote_requests enable row level security;
drop policy if exists "quotes team read" on public.shop_quote_requests;
create policy "quotes team read" on public.shop_quote_requests for select using (public.is_shop_team());
drop policy if exists "quotes team update" on public.shop_quote_requests;
create policy "quotes team update" on public.shop_quote_requests for update
  using (public.is_shop_team()) with check (public.is_shop_team());
drop policy if exists "quotes admin delete" on public.shop_quote_requests;
create policy "quotes admin delete" on public.shop_quote_requests for delete using (public.is_shop_admin());
revoke all on public.shop_quote_requests from anon;
revoke all on public.shop_quote_requests from authenticated;
grant select, delete on public.shop_quote_requests to authenticated;
grant update (status, quote_amount, admin_note, updated_at) on public.shop_quote_requests to authenticated;

create or replace function public.request_shop_quote(
  p_product_id uuid, p_name text, p_phone text, p_email text, p_qty int, p_details text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product record;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_row public.shop_quote_requests;
begin
  if coalesce(btrim(p_name), '') = '' or length(p_name) > 80 then
    raise exception 'Please enter your name.' using errcode = '22023';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'Add a phone number or email so we can send you the quote.' using errcode = '22023';
  end if;
  if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then
    raise exception 'That phone number does not look right.' using errcode = '22023';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That email address does not look right.' using errcode = '22023';
  end if;
  if p_qty is null or p_qty < 1 or p_qty > 10000 then
    raise exception 'Enter how many you need.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_details), '') = '' or length(p_details) > 1000 then
    raise exception 'Tell us what you need (up to 1000 characters).' using errcode = '22023';
  end if;
  select id, name, active into v_product from public.shop_products where id = p_product_id;
  if not found or not v_product.active then
    raise exception 'That product is not available.' using errcode = 'P0001';
  end if;
  -- Simple flood guard: at most 5 requests per contact per day.
  if (select count(*) from public.shop_quote_requests
        where created_at > now() - interval '1 day'
          and ((v_phone is not null and contact_phone = v_phone) or (v_email is not null and lower(contact_email) = lower(v_email)))) >= 5 then
    raise exception 'You have sent several requests today. We will get back to you soon.' using errcode = 'P0001';
  end if;
  insert into public.shop_quote_requests (product_id, product_name, qty, details, buyer_name, contact_phone, contact_email, user_id)
  values (v_product.id, v_product.name, p_qty, btrim(p_details), btrim(p_name), v_phone, v_email, auth.uid())
  returning * into v_row;
  return jsonb_build_object('ref', v_row.ref);
end;
$$;
revoke all on function public.request_shop_quote(uuid, text, text, text, int, text) from public;
grant execute on function public.request_shop_quote(uuid, text, text, text, int, text) to anon, authenticated;

-- Quote-only products can't go through checkout.
do $$
declare d text; sig regprocedure := 'public.place_shop_order(jsonb,text,text,text,text,text,text,jsonb,text)'::regprocedure;
begin
  d := pg_get_functiondef(sig);
  if position('quote_only' in d) > 0 then return; end if; -- already patched
  if position('active, personalisable into v_product' in d) = 0 then raise exception 'pattern1 missing'; end if;
  if position(E'raise exception ''An item in your cart is no longer available.'' using errcode = ''P0001'';\n    end if;' in d) = 0 then raise exception 'pattern2 missing'; end if;
  d := replace(d, 'active, personalisable into v_product', 'active, personalisable, quote_only into v_product');
  d := replace(d, E'raise exception ''An item in your cart is no longer available.'' using errcode = ''P0001'';\n    end if;',
    E'raise exception ''An item in your cart is no longer available.'' using errcode = ''P0001'';\n    end if;\n    if v_product.quote_only then\n      raise exception ''% is price on request. Please ask for a quote instead.'', v_product.name using errcode = ''P0001'';\n    end if;');
  execute d;
end $$;
