# Postgres Egress Fix — Full Build Plan

**Problem:** 98.4% of Supabase egress is PostgREST. 5GB free-tier cap, ~4GB used with ~19 days left in the billing period. Root cause: every guest/browser fetches the same public data independently, plus several `select("*")` queries pull more columns than needed.

**Guiding rule applied throughout:** cache anything that's *identical for every viewer* and doesn't need to be live-accurate to the second. Never cache anything that's *per-user* (my balance, my rank, my offers) or *time-critical/transactional* (random matchmaking, live bidding, chat). New/first-time users have no baseline to notice staleness against — a 1-hour cache window is safe for shared/public data; anything a user might act on immediately stays live.

---

## Step 0 — Stopgap (do this today, independent of everything else)

**Upgrade to Supabase Pro tier ($25/mo)** — 250GB egress instead of 5GB. This buys runway to build the real fixes properly instead of firefighting the cap mid-optimization. Not a fix, just headroom. Do this immediately given ~1GB of remaining margin.

---

## Step 1 — Extend the existing shared-cache pattern to 1 hour (highest priority, lowest risk)

You already have `guest-data.js` — a serverless endpoint that batches the 8 guest queries server-side and lets Vercel's CDN cache the JSON response for every visitor, instead of each browser hitting Supabase directly.

**Action:** bump the constants in `guest-data.js`:
```js
const CACHE_SECONDS = 3600;       // was 120
const REVALIDATE_SECONDS = 7200;  // was 300
```
`stale-while-revalidate` means the first request after the hour expires still gets an instant response (the last good cached copy) while a background fetch refreshes it — no guest ever waits on Postgres.

**Why first:** already built, one-line change, this alone likely cuts the majority of your egress since it directly targets the 98.4% PostgREST slice and collapses unlimited concurrent guests into ~1 origin read/hour.

**Do not cache:** nothing in this file needs to change scope-wise — it's already guest-only, public-only data.

---

## Step 2 — Finish the `select("*")` sweep

No new infrastructure — pure query cleanup. Every one of these still pulls every column when only a subset is used:

- `TransferMarket.jsx` — `transfer_listings`, `transfer_offers`, `team_sale_listings`, `team_sale_offers`, `item_listings`, `item_offers` (all currently `select("*")`)
- `Shop.jsx` — check its listing/purchase reads for the same pattern
- `LeagueLadderDetail.jsx` — standings/results reads
- `App.jsx` — `challenges` (`select("*")`), `open_challenges` (`select("*")`), `ladder_ranks` (`select("*")`, three separate call sites), `public_team_avatars` (`select("*")`), `ladder_pool_transactions`

**Action:** for each, replace `select("*")` with the explicit column list actually consumed by the component (same approach already used for `LEAGUE_SELECT`/`LEAGUE_SUMMARY_SELECT` in `App.jsx` — follow that existing pattern).

**Why second:** shrinks every request that *does* hit Postgres, including the once-an-hour cache-fill from Step 1 and everything authenticated that can't be cached at all (Step 2 benefits every other step downstream).

---

## Step 3 — Apply the same shared-cache pattern to Leaderboard, League standings, and the Ladder rank list

Build new cached endpoints (same Vercel serverless + `Cache-Control: s-maxage=3600, stale-while-revalidate=7200` pattern as `guest-data.js`) for:

- **Leaderboard.jsx** — the ranked list (points/wins/losses per user). Identical for every viewer.
- **League standings/results** — the public tables/fixtures/results portion of `LeagueDetail.jsx` and `LeagueLadderDetail.jsx`. Only changes when a match result is confirmed — a deliberate action, not something anyone is watching tick over live.
- **Ladder rank list** — the *list* of ranks (`ladder_ranks` full/top-5 queries in `App.jsx`).

**Critical split — do NOT cache alongside the above:**
- **"My own rank"** (`ladder_ranks` filtered `eq("user_id", session.user.id)`) — per-user, stays live, keep on its existing 60s poll + realtime combo.

**Why third:** same proven pattern as Step 1, applied to the next-biggest shared-read surfaces.

---

## Step 4 — Split Transfer Market / Shop into cacheable "browse" vs. live "my offers"

- **Cache (1hr, shared):** the listings themselves — `transfer_listings`, `team_sale_listings`, `item_listings` (what's currently for sale). A classifieds board, not a live auction.
- **Never cache:** `transfer_offers`, `team_sale_offers`, `item_offers` filtered to `buyer_id = myId` or `listing_id`. Per-user, and offers/withdrawals need to be current the moment a user acts.

**Action:** same cached-endpoint pattern as Step 3, but only for the three listings queries — leave every offers query exactly as-is.

**Why fourth:** same shape of win as Step 3, but requires more care not to accidentally cache personal data — sequenced after the team has the pattern down from three prior, simpler applications.

---

## Step 5 — Materialized view + `pg_cron` behind the cached endpoints

Once Steps 1–4 mean Postgres is only hit once/hour per cached route, optimize what happens *during* that hourly hit: replace the live joins (`teams`/`fixtures`/`members`/etc.) with a precomputed, flat `pg_cron`-refreshed materialized view (e.g. `league_home_summary`), refreshed on roughly the same hourly cadence as the cache TTLs above.

**Why fifth:** lower urgency than Steps 1–4 because it only affects the now-rare cache-miss request, not the volume of requests — but a good next step once the caching layer is stable, since it also caps how expensive that one hourly hit is.

---

## Step 6 — R2 snapshot as a fallback/second layer

Once traffic grows past what a single Worker/edge cache handles gracefully, or as a belt-and-suspenders fallback if a cache entry is evicted early: on the same hourly `pg_cron` cadence, write the computed JSON payload to Cloudflare R2 (zero egress fee) instead of only relying on Vercel's CDN cache. Cached endpoints fall through to R2 on a cache miss before ever reaching Postgres directly.

**Why sixth:** genuinely useful at scale, but Steps 1–5 already solve the current problem — this is insurance for growth, not a fix for today's cap.

---

## Step 7 — Realtime: `postgres_changes` → `broadcast`

Not urgent (Realtime is only 1.3% of current egress), but `postgres_changes` subscriptions scale badly with subscriber count in a way `broadcast` channels don't. Migrate opportunistically:

- Keep the *mechanism* (a Supabase Realtime channel) — change the channel type from `.on("postgres_changes", ...)` to a `broadcast` channel driven by a database function/trigger.
- Applies to: the generic `useSupabaseTableWatch`-style subscriptions in `App.jsx` (line ~145), challenge chat (`challenge-chat-*` channel), ladder bid ticker (`watchLadderBidTicker`).

**Why seventh:** do this before guest/user counts grow meaningfully, but it's not blocking the current egress crisis.

---

## Step 8 — Redis/Upstash read-through cache for authenticated hot paths

For per-user reads that Steps 1–7 structurally can't touch (because they're not shareable across users) but are read often: app reads from Redis first, falls back to Postgres on miss, writes invalidate the relevant keys.

**Why eighth/lowest of the "do it" list:** your chart shows the overwhelming majority of egress is guest-facing, shared data — Steps 1–4 should already resolve most of the problem. Revisit this once 1–4 are shipped and you can see what (if anything) is left.

---

## Do NOT change — confirmed must stay fully live

These were explicitly checked and excluded, on purpose, throughout this plan:

- **Random/open challenges** (`open_challenges`, `sendRandomChallenge`, `acceptOpenChallenge`) — matchmaking pool; staleness means accepting a match that's already gone.
- **Ladder bid ticker** (`ladder_bids`, `watchLadderBidTicker`) — live auction with a "current leader" that must be accurate to the second.
- **Challenge chat / comments** (`challenge_messages`, `ladder_comments`, `challenge_board_comments`) — conversations, expected live.
- **Any user's own data anywhere** — own rank, own nets/coin balance, own pending offers, own challenge status.

---

## Considered and parked (not in this build)

- **Build-time static generation** — wrong staleness shape (deploy-cycle lag with no revalidation path); superseded by the ISR/shared-cache approach in Steps 1–4.
- **Self-hosted Postgres read replica** — real operational burden (replication lag, uptime ownership) for marginal gain over Steps 1–6.
- **ReadySet-style caching proxy** — powerful, but more infrastructure than this traffic profile currently justifies. Revisit only if Steps 1–6 aren't enough.

---

## Summary — build order

| # | Step | New infra? | Risk |
|---|------|-----------|------|
| 0 | Pro tier upgrade | No | None |
| 1 | Bump guest-data.js to 1hr TTL | No (existing file) | Very low |
| 2 | `select("*")` sweep | No | Low |
| 3 | Cache Leaderboard/standings/ladder list | New cached endpoints | Low |
| 4 | Cache Transfer Market/Shop listings only | New cached endpoints | Low-medium (must not cache offers) |
| 5 | Materialized view + pg_cron | New DB objects | Medium |
| 6 | R2 snapshot fallback | New infra (R2 + cron) | Medium |
| 7 | Realtime broadcast migration | Refactor existing channels | Medium |
| 8 | Redis/Upstash for authenticated reads | New infra | Medium-high |
