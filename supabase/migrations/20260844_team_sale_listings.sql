-- The Kit Room: Team Sales — lets any member sell their own eFootball team
-- (the actual in-game squad/account, not a league `teams` row) to another
-- member. Unlike transfer_listings (which reassigns a league club's
-- `members` row automatically on accept), a team sale here is a real-world
-- eFootball account/squad handover that happens outside this app, so
-- accepting an offer just marks the deal done and lets buyer/seller see
-- each other's contact details to complete it — same "we just facilitate
-- the introduction" shape as the rest of the Transfer Market's messaging.
--
-- Every listing requires exactly 4 photos (proof of the squad/account,
-- e.g. squad screen, stats, ratings, formation) uploaded to Vercel Blob
-- under the "team-sale-photos/" prefix — see api/blob-upload.js and
-- src/utils/blobUpload.js.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- team_sale_listings — one row per eFootball team currently for sale (or
-- previously sold/cancelled; rows are kept for history rather than deleted).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists team_sale_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  asking_price numeric(12,2), -- null = "offers only", no listed price
  photo_urls text[] not null,
  status text not null default 'active' check (status in ('active','sold','cancelled')),
  buyer_id uuid references auth.users(id),
  sold_price numeric(12,2),
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  constraint team_sale_listings_exactly_4_photos check (array_length(photo_urls, 1) = 4)
);

create index if not exists team_sale_listings_seller_idx on team_sale_listings (seller_id);
create index if not exists team_sale_listings_status_idx on team_sale_listings (status);

-- ─────────────────────────────────────────────────────────────────────────
-- team_sale_offers — one row per offer made on a team sale listing.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists team_sale_offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references team_sale_listings(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  message text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
  created_at timestamptz not null default now()
);

create index if not exists team_sale_offers_listing_idx on team_sale_offers (listing_id);
create index if not exists team_sale_offers_buyer_idx on team_sale_offers (buyer_id);

alter table team_sale_listings enable row level security;
alter table team_sale_offers enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- team_sale_listings policies
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "team_sale_listings_select" on team_sale_listings;
create policy "team_sale_listings_select" on team_sale_listings for select
  to authenticated
  using (true); -- visible platform-wide, like the rest of The Kit Room

drop policy if exists "team_sale_listings_insert" on team_sale_listings;
create policy "team_sale_listings_insert" on team_sale_listings for insert
  to authenticated
  with check (
    seller_id = auth.uid()
    and array_length(photo_urls, 1) = 4
  );

-- Sellers can only edit/cancel their own still-active listing directly.
-- Accepting an offer goes through accept_team_sale_offer() below instead.
drop policy if exists "team_sale_listings_update_own" on team_sale_listings;
create policy "team_sale_listings_update_own" on team_sale_listings for update
  to authenticated
  using (seller_id = auth.uid() and status = 'active')
  with check (seller_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────
-- team_sale_offers policies
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "team_sale_offers_select" on team_sale_offers;
create policy "team_sale_offers_select" on team_sale_offers for select
  to authenticated
  using (
    buyer_id = auth.uid()
    or exists (
      select 1 from team_sale_listings l
      where l.id = team_sale_offers.listing_id and l.seller_id = auth.uid()
    )
  );

drop policy if exists "team_sale_offers_insert" on team_sale_offers;
create policy "team_sale_offers_insert" on team_sale_offers for insert
  to authenticated
  with check (
    buyer_id = auth.uid()
    and exists (
      select 1 from team_sale_listings l
      where l.id = team_sale_offers.listing_id
        and l.status = 'active'
        and l.seller_id <> auth.uid()
    )
  );

-- A buyer can withdraw their own pending offer directly. Accept/decline (by
-- the seller) go through the functions below.
drop policy if exists "team_sale_offers_withdraw_own" on team_sale_offers;
create policy "team_sale_offers_withdraw_own" on team_sale_offers for update
  to authenticated
  using (buyer_id = auth.uid() and status = 'pending')
  with check (buyer_id = auth.uid() and status = 'withdrawn');

-- ─────────────────────────────────────────────────────────────────────────
-- accept_team_sale_offer(offer_id) — seller-only. Marks the listing sold
-- and this offer accepted while declining every other pending offer on the
-- same listing. No in-app ownership reassignment happens here (there's no
-- league `teams`/`members` row backing a team sale) — buyer and seller
-- complete the actual eFootball account handover between themselves once
-- the deal is marked done.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function accept_team_sale_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer team_sale_offers%rowtype;
  v_listing team_sale_listings%rowtype;
begin
  select * into v_offer from team_sale_offers where id = p_offer_id for update;
  if not found then raise exception 'Offer not found'; end if;
  if v_offer.status <> 'pending' then raise exception 'Offer is no longer pending'; end if;

  select * into v_listing from team_sale_listings where id = v_offer.listing_id for update;
  if not found then raise exception 'Listing not found'; end if;
  if v_listing.status <> 'active' then raise exception 'Listing is no longer active'; end if;
  if v_listing.seller_id <> auth.uid() then raise exception 'Only the seller can accept an offer'; end if;

  update team_sale_listings
    set status = 'sold', buyer_id = v_offer.buyer_id, sold_price = v_offer.amount, sold_at = now()
    where id = v_listing.id;

  update team_sale_offers set status = 'accepted' where id = v_offer.id;
  update team_sale_offers set status = 'declined'
    where listing_id = v_listing.id and id <> v_offer.id and status = 'pending';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- decline_team_sale_offer(offer_id) — seller-only.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function decline_team_sale_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller uuid;
begin
  select l.seller_id into v_seller
    from team_sale_offers o join team_sale_listings l on l.id = o.listing_id
    where o.id = p_offer_id;
  if v_seller is null then raise exception 'Offer not found'; end if;
  if v_seller <> auth.uid() then raise exception 'Only the seller can decline an offer'; end if;

  update team_sale_offers set status = 'declined' where id = p_offer_id and status = 'pending';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- cancel_team_sale_listing(listing_id) — seller-only. Withdraws the listing
-- and declines any outstanding pending offers on it.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function cancel_team_sale_listing(p_listing_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update team_sale_listings set status = 'cancelled'
    where id = p_listing_id and seller_id = auth.uid() and status = 'active';
  if not found then raise exception 'Listing not found, not yours, or no longer active'; end if;

  update team_sale_offers set status = 'declined'
    where listing_id = p_listing_id and status = 'pending';
end;
$$;

grant execute on function accept_team_sale_offer(uuid) to authenticated;
grant execute on function decline_team_sale_offer(uuid) to authenticated;
grant execute on function cancel_team_sale_listing(uuid) to authenticated;
