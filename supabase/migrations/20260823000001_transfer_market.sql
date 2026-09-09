-- Transfer Market: lets a club's current owner list it for sale, and other
-- members make offers on it. Accepting an offer hands the club over for
-- real — it reassigns the underlying `members` row (user_id, display_name,
-- phone) from seller to buyer, the same way an admin manually reassigning a
-- club would, so the buyer's account is now the one that plays as that club
-- everywhere else in the app (fixtures, results, Ladder, etc.).
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- transfer_listings — one row per club currently for sale (or previously
-- sold/cancelled; rows are kept for history rather than deleted).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists transfer_listings (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  seller_id uuid not null references auth.users(id) on delete cascade,
  asking_price numeric(12,2), -- null = "offers only", no listed price
  description text,
  status text not null default 'active' check (status in ('active','sold','cancelled')),
  buyer_id uuid references auth.users(id),
  sold_price numeric(12,2),
  sold_at timestamptz,
  created_at timestamptz not null default now()
);

-- Only one active listing per club at a time.
create unique index if not exists transfer_listings_one_active_per_team
  on transfer_listings (team_id) where (status = 'active');

create index if not exists transfer_listings_seller_idx on transfer_listings (seller_id);
create index if not exists transfer_listings_status_idx on transfer_listings (status);

-- ─────────────────────────────────────────────────────────────────────────
-- transfer_offers — one row per offer made on a listing.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists transfer_offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references transfer_listings(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  message text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
  created_at timestamptz not null default now()
);

create index if not exists transfer_offers_listing_idx on transfer_offers (listing_id);
create index if not exists transfer_offers_buyer_idx on transfer_offers (buyer_id);

alter table transfer_listings enable row level security;
alter table transfer_offers enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- transfer_listings policies
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "transfer_listings_select" on transfer_listings;
create policy "transfer_listings_select" on transfer_listings for select
  to authenticated
  using (true); -- market is visible platform-wide, like the Shop

drop policy if exists "transfer_listings_insert" on transfer_listings;
create policy "transfer_listings_insert" on transfer_listings for insert
  to authenticated
  with check (
    seller_id = auth.uid()
    and exists (
      select 1 from members m
      where m.league_id = transfer_listings.league_id
        and m.team_id = transfer_listings.team_id
        and m.user_id = auth.uid()
    )
  );

-- Sellers can only edit/cancel their own still-active listing directly.
-- Accepting an offer (which also marks the listing sold) goes through the
-- accept_transfer_offer() function below instead, so the ownership
-- reassignment and the status change happen together or not at all.
drop policy if exists "transfer_listings_update_own" on transfer_listings;
create policy "transfer_listings_update_own" on transfer_listings for update
  to authenticated
  using (seller_id = auth.uid() and status = 'active')
  with check (seller_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────
-- transfer_offers policies
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "transfer_offers_select" on transfer_offers;
create policy "transfer_offers_select" on transfer_offers for select
  to authenticated
  using (
    buyer_id = auth.uid()
    or exists (
      select 1 from transfer_listings l
      where l.id = transfer_offers.listing_id and l.seller_id = auth.uid()
    )
  );

drop policy if exists "transfer_offers_insert" on transfer_offers;
create policy "transfer_offers_insert" on transfer_offers for insert
  to authenticated
  with check (
    buyer_id = auth.uid()
    and exists (
      select 1 from transfer_listings l
      where l.id = transfer_offers.listing_id
        and l.status = 'active'
        and l.seller_id <> auth.uid()
    )
  );

-- A buyer can withdraw their own pending offer directly. Accept/decline (by
-- the seller) go through the functions below.
drop policy if exists "transfer_offers_withdraw_own" on transfer_offers;
create policy "transfer_offers_withdraw_own" on transfer_offers for update
  to authenticated
  using (buyer_id = auth.uid() and status = 'pending')
  with check (buyer_id = auth.uid() and status = 'withdrawn');

-- ─────────────────────────────────────────────────────────────────────────
-- accept_transfer_offer(offer_id) — seller-only. Does three things
-- atomically: reassigns the club's `members` row to the buyer, marks the
-- listing sold, and marks this offer accepted while declining every other
-- pending offer on the same listing.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function accept_transfer_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer transfer_offers%rowtype;
  v_listing transfer_listings%rowtype;
  v_buyer_profile profiles%rowtype;
begin
  select * into v_offer from transfer_offers where id = p_offer_id for update;
  if not found then raise exception 'Offer not found'; end if;
  if v_offer.status <> 'pending' then raise exception 'Offer is no longer pending'; end if;

  select * into v_listing from transfer_listings where id = v_offer.listing_id for update;
  if not found then raise exception 'Listing not found'; end if;
  if v_listing.status <> 'active' then raise exception 'Listing is no longer active'; end if;
  if v_listing.seller_id <> auth.uid() then raise exception 'Only the seller can accept an offer'; end if;

  select * into v_buyer_profile from profiles where user_id = v_offer.buyer_id;

  update members
    set user_id = v_offer.buyer_id,
        display_name = coalesce(v_buyer_profile.efootball_username, display_name),
        phone = coalesce(v_buyer_profile.phone, phone)
    where league_id = v_listing.league_id and team_id = v_listing.team_id;

  update transfer_listings
    set status = 'sold', buyer_id = v_offer.buyer_id, sold_price = v_offer.amount, sold_at = now()
    where id = v_listing.id;

  update transfer_offers set status = 'accepted' where id = v_offer.id;
  update transfer_offers set status = 'declined'
    where listing_id = v_listing.id and id <> v_offer.id and status = 'pending';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- decline_transfer_offer(offer_id) — seller-only.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function decline_transfer_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller uuid;
begin
  select l.seller_id into v_seller
    from transfer_offers o join transfer_listings l on l.id = o.listing_id
    where o.id = p_offer_id;
  if v_seller is null then raise exception 'Offer not found'; end if;
  if v_seller <> auth.uid() then raise exception 'Only the seller can decline an offer'; end if;

  update transfer_offers set status = 'declined' where id = p_offer_id and status = 'pending';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- cancel_transfer_listing(listing_id) — seller-only. Withdraws the listing
-- and declines any outstanding pending offers on it.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function cancel_transfer_listing(p_listing_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update transfer_listings set status = 'cancelled'
    where id = p_listing_id and seller_id = auth.uid() and status = 'active';
  if not found then raise exception 'Listing not found, not yours, or no longer active'; end if;

  update transfer_offers set status = 'declined'
    where listing_id = p_listing_id and status = 'pending';
end;
$$;

grant execute on function accept_transfer_offer(uuid) to authenticated;
grant execute on function decline_transfer_offer(uuid) to authenticated;
grant execute on function cancel_transfer_listing(uuid) to authenticated;
