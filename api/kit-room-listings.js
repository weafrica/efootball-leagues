// Postgres egress fix (postgres-egress-fix-plan.md Step 4) — bundles the
// three Kit Room "browse" tables (transfer_listings, team_sale_listings,
// item_listings) into one cached response, same Vercel CDN pattern as
// guest-data.js. These are the listings themselves — "what's currently
// for sale" — identical for every viewer, a classifieds board rather than
// a live auction, per the plan's own framing.
//
// Standard 1hr TTL here (unlike the 5-minute window on
// ladder-league-results.js) — there's no admin-correction analog for a
// listing the way there is for a match result. A seller cancelling their
// own listing is handled entirely client-side (see TransferMarket.jsx's
// loadListingsLive/loadTeamListingsLive/loadItemListingsLive) rather than
// by shortening this cache, so the seller sees their own action instantly
// without needing every OTHER viewer's cache to also be short.
//
// Explicitly NOT included here, per the plan's own "do not cache"
// split: transfer_offers / team_sale_offers / item_offers. Those are
// per-user (filtered to buyer_id = myId or a specific listing_id) and
// need to be current the moment someone acts — TransferMarket.jsx's
// loadMyOffers/loadOffersFor etc. are untouched, still live direct
// queries.
import { createClient } from "@supabase/supabase-js";

const CACHE_SECONDS = 3600;
const REVALIDATE_SECONDS = 7200;

// Matches TRANSFER_LISTING_SELECT / TEAM_SALE_LISTING_SELECT /
// ITEM_LISTING_SELECT in src/TransferMarket.jsx — kept as literals here
// rather than imported since this runs in a separate Vercel serverless
// runtime, not bundled with the client (same reasoning as
// ladder-league-results.js).
const TRANSFER_LISTING_SELECT = "id, league_id, team_id, seller_id, status, asking_price, description, sold_price, created_at";
const TEAM_SALE_LISTING_SELECT = "id, seller_id, status, title, asking_price, description, photo_urls, sold_price, created_at";
const ITEM_LISTING_SELECT = "id, seller_id, status, item_key, asking_price, description, sold_price, created_at";

export default async function handler(req, res) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  try {
    const [transferRes, teamRes, itemRes] = await Promise.all([
      supabase.from("transfer_listings").select(TRANSFER_LISTING_SELECT).order("created_at", { ascending: false }),
      supabase.from("team_sale_listings").select(TEAM_SALE_LISTING_SELECT).order("created_at", { ascending: false }),
      supabase.from("item_listings").select(ITEM_LISTING_SELECT).order("created_at", { ascending: false }),
    ]);

    if (transferRes.error || teamRes.error || itemRes.error) {
      // Same reasoning as the other cached endpoints: never cache a
      // partial/broken response, or one table's transient failure freezes
      // a wrong picture at the CDN for everyone until the window expires.
      res.setHeader("Cache-Control", "no-store");
      res.status(502).json({ error: "Upstream fetch failed" });
      return;
    }

    res.setHeader(
      "Cache-Control",
      `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${REVALIDATE_SECONDS}`
    );
    res.status(200).json({
      transferListings: transferRes.data || [],
      teamListings: teamRes.data || [],
      itemListings: itemRes.data || [],
    });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "Upstream fetch failed" });
  }
}
