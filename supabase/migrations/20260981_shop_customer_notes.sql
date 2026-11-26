-- Private notes and tags per customer, for the shop team only. Customers are
-- derived from orders, so a note is keyed by contact ("p:<last 9 digits of
-- phone>" or "e:<email>"); the app matches any of a customer's keys.
create table if not exists public.shop_customer_notes (
  contact_key text primary key check (length(contact_key) between 3 and 200),
  note text not null default '' check (length(note) <= 2000),
  tags text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.shop_customer_notes enable row level security;
drop policy if exists "customer notes team read" on public.shop_customer_notes;
create policy "customer notes team read" on public.shop_customer_notes for select using (public.is_shop_team());
drop policy if exists "customer notes team write" on public.shop_customer_notes;
create policy "customer notes team write" on public.shop_customer_notes for all using (public.is_shop_team()) with check (public.is_shop_team());
revoke all on public.shop_customer_notes from anon;
grant select, insert, update, delete on public.shop_customer_notes to authenticated;

create or replace function public.trg_customer_notes_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists customer_notes_touch on public.shop_customer_notes;
create trigger customer_notes_touch before insert or update on public.shop_customer_notes for each row execute function public.trg_customer_notes_touch();
