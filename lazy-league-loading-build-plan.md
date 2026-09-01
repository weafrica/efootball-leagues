# Build Plan: Load League Banners Only, Fetch Details on Click

## Status — verified against the live repo (`src/App.jsx`, `src/LeagueDetail.jsx`) this session
**Items 1–3 and 5 are done, live in the codebase. Item 4 is done but implemented differently than proposed (stronger, not weaker). Item 2 has one real gap (no loading skeleton). Item 6 turns out not to apply at all. Item 7 is an operational to-do that can't be checked from code.**

This plan was apparently written before (or without knowledge of) the actual implementation — the code doesn't just partially match this plan, it deliberately re-scoped several items after a real audit found broader Home-wide usage than this doc assumed. Details below, item by item.

---

## 1. Split `LEAGUE_LIST_SELECT` into a summary select and a detail select — ✅ Done, but narrower split than proposed

Implemented as `LEAGUE_SUMMARY_SELECT` / `LEAGUE_SELECT` (not `LEAGUE_LIST_SELECT` / `LEAGUE_DETAIL_SELECT` as this doc names them — same idea, different names).

**What actually got cut to detail-only:** just `comments` and the three narrow ladder-cup sub-tables (`ladder_cup_walkover_claims`, `ladder_cup_second_life_offers`, `ladder_cup_pool_sightings`) — tracked as `LEAGUE_DETAIL_ONLY_KEYS`.

**What this doc proposed cutting but the actual audit kept full-width in the summary, on purpose:** `teams`, `fixtures`, `members`, `ladder_cup_entries`, `ladder_cup_matches` are all still `(*)` in `LEAGUE_SUMMARY_SELECT`, not narrowed to specific columns and not deferred to detail. The code's own comment documents why: these are genuinely read **Home-wide** (across *all* leagues at once, not just one open league) by `attentionScore`'s `result_submissions` check, `LeagueReactionBar`, `computeMyUpcomingFixtures`/`computeMyProgress`'s fixture scans, and the platform-wide Leaderboard/season/head-to-head passes — narrowing or deferring them the way this doc proposed would have broken those screens. This doc's audit (the numbered field list under "Drop entirely from the summary") didn't catch that Home-wide usage; the actual implementation's audit did.

`result_submissions` also stayed in summary, but narrowed to specific columns (`id, fixture_id, status, created_at, submitted_by, submitted_by_username, photo_path, home_score, away_score, pens_home, pens_away`) rather than `(*)` — a lighter-touch version of what this doc proposed for the whole summary select.

**Net effect:** less aggressive than this doc's proposal, but for a real reason, not an oversight — worth keeping in mind if anyone revisits this select later and is tempted to "finish" narrowing `teams`/`fixtures`/`members` per the original plan. Don't, without re-running that Home-wide usage audit first.

## 2. Fetch the detail select on click, merge it into state — ✅ Mostly done — one real gap

The fetch-on-click-and-merge mechanics are implemented essentially exactly as this doc describes: an effect keyed on `activeLeagueId` fetches `LEAGUE_SELECT` for that one league and merges it in via `mergeLeaguesById`, tagging the row with `_detailLoadedAt` once loaded.

**Gap: no loading state.** This doc explicitly calls for "a loading state in `LeagueDetail` while this is in flight (skeleton or spinner)." That part wasn't built — `LeagueDetail.jsx` reads `league.comments || []` and similar with no check for whether detail has loaded yet, so a freshly opened league's comments (and the three detail-only ladder-cup collections) just render as empty/absent and silently pop in once the fetch resolves, rather than showing a skeleton. Minor UX gap, not a correctness one — worth a follow-up if the pop-in is noticeable in practice.

## 3. Don't let a background summary refresh clobber an already-loaded detail — ✅ Done, exactly as specified

This is the part the doc flagged as the critical gotcha, and it's fully handled: `mergeSummaryPreservingDetail` (module scope) preserves the `LEAGUE_DETAIL_ONLY_KEYS` fields from the existing row whenever a narrower summary row comes in for a league that already has `_detailLoadedAt` set, and `mergeLeaguesById` routes every summary-shaped row through it. `loadLeagues()` itself also uses this on every bulk reload. Confirmed correct in the code, not just present.

## 4. Add a freshness guard so reopening a league doesn't always refetch — ✅ Done, but stronger than proposed (no TTL)

This doc proposed a 20–30 second cache window, "mirroring the guest-data `GUEST_DATA_CACHE_MS` pattern." Two corrections:
- **That constant doesn't exist anywhere in the codebase** — checked directly, no `GUEST_DATA_CACHE_MS` or equivalent. The guest-data flow has no time-based cache at all.
- **What's actually implemented for the signed-in flow is stronger than a TTL:** the `activeLeagueId` effect only fetches detail when the league is missing `_detailLoadedAt` entirely — once a league's detail has loaded in a session, reopening it later never triggers an automatic refetch on that path, no matter how much time has passed. Freshness while a league is open instead comes from the 30-second poll and the two realtime subscriptions (see #5) — not from re-checking on every open. This fully covers the "rapid open → close → reopen" case this doc worried about, and then some.

## 5. Confirm polling/realtime stay scoped to the open league only — ✅ Done, exactly as specified

Confirmed in the code: `useVisibilityPoll(refreshActiveLeagueCb, 30000, !!activeLeagueId)` and the `ladder_cup_walkover_claims`/`ladder_cup_matches` realtime subscriptions are all gated on `!!activeLeagueId`. `refreshActiveLeagueCb` calls `refreshLeague(activeLeagueId)`, which branches on `_detailLoadedAt` — since the open league always has detail loaded by the time this poll is running, it correctly always re-fetches via `LEAGUE_SELECT` (full detail), not the summary shape. No change needed, matches this doc's expectation precisely.

## 6. Do the same split for the guest landing page — ❌ Not done, and turns out not to apply

Checked both halves of this doc's own stated condition ("if guests can even drill into one — if not, this step may not apply and can be dropped"):
- Guest data (`guestData`) is still one bulk `Promise.all` fetch — `teams`, `fixtures`, `leagues`, `extras`, `ladder` all loaded upfront together, exactly as this doc describes the current (pre-fix) state. No `public_league_detail` view or equivalent exists.
- **Guests cannot drill into an individual league at all.** `PublicLeagueCard` renders everything about a league inline from the bulk `guestData` already in memory — including "View all matches," which is a plain `useState` show/hide toggle over already-fetched fixtures, not a new fetch. There's no guest-side equivalent of `activeLeagueId`/a league-detail screen to fetch into.

So per this doc's own fallback clause: **this step doesn't apply and should be dropped**, not just deprioritized. If guest drill-in ever gets built as a feature, this split would become relevant again and should be revisited then — but there's nothing to build against today's guest UI.

## 7. Measure before/after — ⏳ Still open, can't be verified from code

This is an operational step (watching the Supabase dashboard's Egress panel), not something a repo/live-DB audit can confirm either way. Given items 1–3 and 5 are confirmed live, this measurement is worth actually doing if it hasn't been — but no code-side signal can substitute for checking the real dashboard numbers.
