-- The Kit Room: Items — a third market alongside Club Transfers and Team
-- Sales, for the account-level perks/cosmetics below. Same "list it, take
-- offers, accept one" shape as the other two markets, but with one real
-- difference: these items are entirely virtual and live inside this app's
-- own economy (Nets), unlike a club (a real league registration) or a
-- team sale (a real-world eFootball account handover that happens outside
-- the app). So unlike accept_transfer_offer / accept_team_sale_offer —
-- which only record a price and leave the actual payment to happen
-- out-of-band between buyer and seller — accept_item_offer() below also
-- settles the Nets itself: debits the buyer's wallet, credits the
-- seller's, atomically with marking the deal done.
--
-- Note on scope: this migration only builds the marketplace mechanics
-- (list/offer/accept/settle). None of the 19 item types below are wired
-- up to an actual in-app effect yet (there's no "your profile picture is
-- X" or "this club has custom colors Y" system anywhere else in the app
-- today) — so accepting an offer transfers Nets and records who now
-- "owns" the item, but doesn't itself change what the buyer sees
-- anywhere else. That's future work once each perk has something real to
-- attach to.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- item_listings — one row per item currently for sale (or previously
-- sold/cancelled; rows are kept for history rather than deleted).
-- item_key is a fixed catalog, not free text — see ITEM_CATALOG in
-- TransferMarket.jsx for the matching labels/suggested prices shown in
-- the UI. Keep this check constraint and that JS array in sync.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists item_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null check (item_key in (
    'league_entry_fee_ticket',
    'profile_picture',
    'club_badge_crest',
    'custom_club_colors',
    'username_title_tag',
    'verified_featured_club_status',
    'goal_celebration_animation',
    'victory_screen_skin',
    'voice_commentary_pack',
    'rival_nemesis_tag',
    'create_a_tournament_tool',
    'club_merger_alliance_feature',
    'sponsorship_slot_local_business',
    'season_archive_hall_of_fame_access',
    'rematch_token',
    'raffle_ticket',
    'mystery_box_cosmetic',
    'sponsor_a_player',
    'physical_trophy_medal_upgrade',
    'data_bundle'
  )),
  quantity integer not null default 1 check (quantity > 0),
  asking_price numeric(12,2), -- null = "offers only", no listed price
  description text,
  status text not null default 'active' check (status in ('active','sold','cancelled')),
  buyer_id uuid references auth.users(id),
  sold_price numeric(12,2),
  sold_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists item_listings_seller_idx on item_listings (seller_id);
create index if not exists item_listings_status_idx on item_listings (status);
create index if not exists item_listings_item_key_idx on item_listings (item_key);

-- ─────────────────────────────────────────────────────────────────────────
-- item_offers — one row per offer made on an item listing.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists item_offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references item_listings(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  message text,
  status text not null default 'pending' check (status in ('pending','accepted','declined','withdrawn')),
  created_at timestamptz not null default now()
);

create index if not exists item_offers_listing_idx on item_offers (listing_id);
create index if not exists item_offers_buyer_idx on item_offers (buyer_id);

alter table item_listings enable row level security;
alter table item_offers enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- item_listings policies
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "item_listings_select" on item_listings;
create policy "item_listings_select" on item_listings for select
  to authenticated
  using (true); -- visible platform-wide, like the rest of The Kit Room

drop policy if exists "item_listings_insert" on item_listings;
create policy "item_listings_insert" on item_listings for insert
  to authenticated
  with check (seller_id = auth.uid());

-- Sellers can only edit/cancel their own still-active listing directly.
-- Accepting an offer goes through accept_item_offer() below instead, so
-- the Nets settlement and the status change happen together or not at all.
drop policy if exists "item_listings_update_own" on item_listings;
create policy "item_listings_update_own" on item_listings for update
  to authenticated
  using (seller_id = auth.uid() and status = 'active')
  with check (seller_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────
-- item_offers policies
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "item_offers_select" on item_offers;
create policy "item_offers_select" on item_offers for select
  to authenticated
  using (
    buyer_id = auth.uid()
    or exists (
      select 1 from item_listings l
      where l.id = item_offers.listing_id and l.seller_id = auth.uid()
    )
  );

drop policy if exists "item_offers_insert" on item_offers;
create policy "item_offers_insert" on item_offers for insert
  to authenticated
  with check (
    buyer_id = auth.uid()
    and exists (
      select 1 from item_listings l
      where l.id = item_offers.listing_id
        and l.status = 'active'
        and l.seller_id <> auth.uid()
    )
  );

-- A buyer can withdraw their own pending offer directly. Accept/decline (by
-- the seller) go through the functions below.
drop policy if exists "item_offers_withdraw_own" on item_offers;
create policy "item_offers_withdraw_own" on item_offers for update
  to authenticated
  using (buyer_id = auth.uid() and status = 'pending')
  with check (buyer_id = auth.uid() and status = 'withdrawn');

-- ─────────────────────────────────────────────────────────────────────────
-- accept_item_offer(offer_id) — seller-only. Does four things atomically:
-- debits the offer amount from the buyer's Nets wallet, credits it to the
-- seller's, marks the listing sold, and marks this offer accepted while
-- declining every other pending offer on the same listing. Writes to
-- nets_wallets/nets_transactions directly (rather than going through the
-- nets_credit/nets_debit RPCs) because nets_credit is admin-only from the
-- client (see 20260826_nets_credit_admin_only.sql) — this function is the
-- controlled, narrow path that's allowed to move Nets from one player to
-- another, same trust model as the other internal reward-crediting
-- functions in this app.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function accept_item_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer item_offers%rowtype;
  v_listing item_listings%rowtype;
  v_buyer_balance bigint;
  v_buyer_new_balance bigint;
  v_seller_new_balance bigint;
  v_amount bigint;
begin
  select * into v_offer from item_offers where id = p_offer_id for update;
  if not found then raise exception 'Offer not found'; end if;
  if v_offer.status <> 'pending' then raise exception 'Offer is no longer pending'; end if;

  select * into v_listing from item_listings where id = v_offer.listing_id for update;
  if not found then raise exception 'Listing not found'; end if;
  if v_listing.status <> 'active' then raise exception 'Listing is no longer active'; end if;
  if v_listing.seller_id <> auth.uid() then raise exception 'Only the seller can accept an offer'; end if;

  v_amount := round(v_offer.amount)::bigint;

  if v_amount > 0 then
    -- Debit the buyer.
    select balance into v_buyer_balance from nets_wallets where user_id = v_offer.buyer_id for update;
    if v_buyer_balance is null then v_buyer_balance := 0; end if;
    if v_buyer_balance < v_amount then
      raise exception 'Buyer no longer has enough Nets to cover this offer';
    end if;

    insert into nets_wallets (user_id, balance) values (v_offer.buyer_id, 0) on conflict (user_id) do nothing;
    update nets_wallets set balance = balance - v_amount, updated_at = now()
      where user_id = v_offer.buyer_id returning balance into v_buyer_new_balance;
    insert into nets_transactions (user_id, amount, balance_after, reason, note, ref_type, ref_id, created_by)
      values (v_offer.buyer_id, -v_amount, v_buyer_new_balance, 'item_purchase', v_listing.item_key, 'item_listing', v_listing.id::text, auth.uid());

    -- Credit the seller.
    insert into nets_wallets (user_id, balance) values (v_listing.seller_id, 0) on conflict (user_id) do nothing;
    update nets_wallets set balance = balance + v_amount, updated_at = now()
      where user_id = v_listing.seller_id returning balance into v_seller_new_balance;
    insert into nets_transactions (user_id, amount, balance_after, reason, note, ref_type, ref_id, created_by)
      values (v_listing.seller_id, v_amount, v_seller_new_balance, 'item_sale', v_listing.item_key, 'item_listing', v_listing.id::text, auth.uid());
  end if;

  update item_listings
    set status = 'sold', buyer_id = v_offer.buyer_id, sold_price = v_offer.amount, sold_at = now()
    where id = v_listing.id;

  update item_offers set status = 'accepted' where id = v_offer.id;
  update item_offers set status = 'declined'
    where listing_id = v_listing.id and id <> v_offer.id and status = 'pending';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- decline_item_offer(offer_id) — seller-only.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function decline_item_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller uuid;
begin
  select l.seller_id into v_seller
    from item_offers o join item_listings l on l.id = o.listing_id
    where o.id = p_offer_id;
  if v_seller is null then raise exception 'Offer not found'; end if;
  if v_seller <> auth.uid() then raise exception 'Only the seller can decline an offer'; end if;

  update item_offers set status = 'declined' where id = p_offer_id and status = 'pending';
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- cancel_item_listing(listing_id) — seller-only. Withdraws the listing and
-- declines any outstanding pending offers on it.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function cancel_item_listing(p_listing_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update item_listings set status = 'cancelled'
    where id = p_listing_id and seller_id = auth.uid() and status = 'active';
  if not found then raise exception 'Listing not found, not yours, or no longer active'; end if;

  update item_offers set status = 'declined'
    where listing_id = p_listing_id and status = 'pending';
end;
$$;

grant execute on function accept_item_offer(uuid) to authenticated;
grant execute on function decline_item_offer(uuid) to authenticated;
grant execute on function cancel_item_listing(uuid) to authenticated;
