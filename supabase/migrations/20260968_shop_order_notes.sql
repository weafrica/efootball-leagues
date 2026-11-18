-- Internal notes on shop orders: a private thread per order that only the
-- shop owner and helpers (is_shop_team) can read or add to. The customer never
-- sees these, and they live in their own table (not a column on shop_orders)
-- so a shopper's own read access to their order can never expose them.
create table if not exists public.shop_order_notes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.shop_orders(id) on delete cascade,
  note text not null check (length(btrim(note)) between 1 and 1000),
  author_id uuid,
  author_label text,
  created_at timestamptz not null default now()
);
create index if not exists shop_order_notes_order_idx on public.shop_order_notes (order_id, created_at);

-- The author is always the signed-in user, never whatever the client sends.
create or replace function public.shop_order_notes_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.author_id := auth.uid();
  new.author_label := coalesce(nullif(auth.jwt() ->> 'email', ''), 'team');
  new.note := btrim(new.note);
  return new;
end;
$$;
drop trigger if exists shop_order_notes_stamp on public.shop_order_notes;
create trigger shop_order_notes_stamp before insert on public.shop_order_notes
  for each row execute function public.shop_order_notes_stamp();

alter table public.shop_order_notes enable row level security;
drop policy if exists "order notes team read" on public.shop_order_notes;
create policy "order notes team read" on public.shop_order_notes for select using (public.is_shop_team());
drop policy if exists "order notes team add" on public.shop_order_notes;
create policy "order notes team add" on public.shop_order_notes for insert with check (public.is_shop_team());
drop policy if exists "order notes delete own or admin" on public.shop_order_notes;
create policy "order notes delete own or admin" on public.shop_order_notes for delete
  using (public.is_shop_admin() or (public.is_shop_team() and author_id = auth.uid()));

revoke all on public.shop_order_notes from anon;
grant select, insert, delete on public.shop_order_notes to authenticated;
