# PostgREST Egress — Fix Plan

_weafrica Leagues / efootball-leagues-repo — investigation confirmed 98.4% of egress is PostgREST (database JSON), not images/storage. Root cause: `loadLeagues()` fetches every league on the platform, fully joined, on every sign-in._

---

## Already fixed — no action needed

- **Hourly token-refresh multiplier.** `loadLeagues()` used to re-run its full whole-platform fetch on every `TOKEN_REFRESHED` event (~hourly per tab, more with several tabs open) — not just real sign-ins. Already fixed: `sessionKey` is now derived from `session.user.id` (a stable primitive), so effects keyed on it only fire on a genuine login/logout, not a silent token refresh. Confirmed in code (`App.jsx`, `sessionKey` definition and its comment).
- **Comments and 3 detail-only ladder-cup collections** (`ladder_cup_walkover_claims`, `ladder_cup_second_life_offers`, `ladder_cup_pool_sightings`) are already split out of the bulk load and only fetched once a league is actually opened.

---

## Priority 1 — Narrow the 5 still-full-width tables (ready to implement)

`teams`, `fixtures`, `members`, `ladder_cup_entries`, `ladder_cup_matches` are still fetched with `(*)` in `LEAGUE_SUMMARY_SELECT`. Measured impact: **1.59 MB → 0.71 MB** for these 5 tables — a 55% cut, taking the whole `loadLeagues()` payload from ~1.75 MB to ~0.90 MB per call.

Verified by reading the actual code (two corrections made to the original column list along the way):

| Table | Keep (genuinely used Home-wide) | Drop (detail-only / unused) |
|---|---|---|
| `teams` | `id`, `name`, `phone`, `eliminated` | `group_number` (only used via a separate single-league fetch) |
| `fixtures` | `id`, `home_team_id`, `away_team_id`, `played`, `home_score`, `away_score`, `stage`, `due_at`, `round`, `played_at` | `leg`, `pens_home`, `pens_away`, `starts_at`, plus `ladder_points_home_at_report` / `ladder_points_away_at_report` / `contact_made_at` (confirmed unused anywhere in the frontend, detail screens included) |
| `members` | `user_id`, `team_id`, `display_name`, `payment_status`, **`entry_fee`** | `phone`, `joined_at`, `payment_proof_path`, `payment_reviewed_at`, `payment_reviewed_by`, `wa_reminder_due_at` |
| `ladder_cup_entries` | `team_id`, `pts`, `gd`, `toughest_opponent_beaten_pts` | `w`, `l`, `streak`, `status`, both second-life fields, all 5 badge fields, `ladder_rating`, `rebirth_count`, `past_lives`, `reborn_at`, `first_contact_at` |
| `ladder_cup_matches` | `result_status`, `result_dispute_count`, `result_reported_at`, **`finalized_at`** | everything else — goals/penalties/walkover/proof_url/winner fields |

**Corrections found during verification** (both bolded above):
- `members.entry_fee` was originally flagged "safe to drop" — actually needed Home-wide for the cash-league "pool" total shown on every league card (`LeagueCard`'s `pool` calculation).
- `ladder_cup_matches.finalized_at` was missing from the original "needed" list — actually needed Home-wide for the played-match count on every Ladder Cup league card.

**Risk:** low. Pure column narrowing, no behavior change, every field traced to a specific real usage before being kept or dropped.

---

## Priority 2 — Confirm compression is actually on (free, no code)

Check the Network tab for `Content-Encoding: gzip` or `br` on the `leagues` request. If it's missing, this is a genuinely free win before touching any code.

---

## Priority 3 — Precompute standings/progress server-side instead of downloading raw fixtures

Right now every league card computes its "leader" and "% played" by downloading every fixture for every league and calculating it client-side (`computeStandings`). A Postgres function/view that returns just the finished numbers (leader name, played count, GD) instead of full fixture rows would shrink the `fixtures` payload (684 KB raw) by roughly 90%+.

**This is the single biggest remaining lever — bigger than Priority 1.**

**Risk:** medium. Requires a new SQL function mirroring `computeStandings`'s logic (tie-break rules, no-show penalty handling) and keeping it in sync if that logic ever changes — the same hand-sync discipline this codebase already applies to SQL/JS pairs elsewhere.

---

## Priority 4 — Split "leagues I'm in" from "leagues I could join"

You're an actual member of only a handful of the 57 leagues. Leagues you haven't joined only need name/photo/format + the precomputed summary from Priority 3 (not full teams/members/fixtures) to render their browse card. Leagues you're actually in can keep richer detail.

Combined with Priority 3, this is the real "go further" version of Priority 1 — instead of narrowing columns on all 57 leagues, most of those 57 stop needing a join at all.

**Risk:** medium-high. Real restructuring of what `loadLeagues()` fetches and how Home distinguishes "my leagues" from "browsable leagues."

---

## Priority 5 — Ship compact rows instead of repeated-key JSON

Every one of the 1,457 fixture rows currently repeats field names (`home_team_id`, `away_team_id`, `home_score`...) in the JSON. A Postgres function returning flat arrays instead of an array of objects removes that repetition — 30–50% smaller for the same data, nothing removed.

**Risk:** low-medium. Requires a small serialization layer client-side to turn arrays back into named fields; straightforward but touches how every consumer reads the data.

---

## Priority 6 — Level-of-detail loading (load list first, detail on demand)

Load ultra-minimal cards first (name, crest, status — a few KB total) so Home renders instantly, then fetch each card's standings/progress lazily — only for cards actually scrolled into view — instead of downloading full detail for all 57 leagues up front.

**Risk:** medium. UI/perceived-performance change (cards populate progressively instead of all-at-once), plus new fetch-on-scroll logic.

---

## Priority 7 — Delta sync instead of full reload every sign-in

Client remembers each league's `updated_at` from the last load. Next sign-in, only re-fetch leagues that actually changed since then (`updated_at > watermark`), merging with the cached copy for everything else. Most of the 57 leagues won't have changed between one sign-in and the next.

**Risk:** medium. Needs a reliable `updated_at` on every relevant table (and its child rows) and careful cache-merge logic to avoid showing stale data.

---

## Priority 8 — Push Realtime diffs instead of "something changed, refetch everything"

Realtime is already wired up per table, but a change currently just triggers a full re-fetch (`useRealtimeRefresh`). Push the changed row itself through the Realtime payload instead of using it purely as an invalidation signal.

**Risk:** medium-high. Realtime payloads have their own size/reliability considerations, and merge logic needs to be airtight to avoid client state drifting from the database.

---

## Priority 9 — CDN/edge-cache the parts that are the same for everyone

League standings look identical to every viewer (not personalized). Supabase's own dashboard notes "egress via cache hits is billed separately," implying cached hits are cheaper. Serving the non-personalized slice (standings, leaderboards) through a cached endpoint instead of a live per-request query could make a meaningful chunk of this close to free.

**Risk:** medium. Needs a caching layer (edge function or similar) and a cache-invalidation strategy tied to when results actually change.

---

## Priority 10 — One precomputed "login bundle," refreshed periodically

Instead of assembling the full payload live from raw tables on every request, precompute one small bundle server-side (already containing the Priority 3 standings/progress numbers) and refresh it periodically rather than on-demand per request.

**Risk:** high. Real architecture change — introduces a refresh cadence/staleness tradeoff and a new moving part to operate.

---

## Suggested order of attack

1. **Do now, low risk:** Priority 1 (column narrowing) + Priority 2 (confirm compression) — both ready today, no architecture change.
2. **Next, real win:** Priority 3 (server-side standings) — the biggest remaining lever, moderate effort.
3. **Then, if still needed:** Priority 4 (member vs. browsable split) — builds directly on Priority 3.
4. **Only if egress is still a real problem after the above:** Priorities 5–10, roughly in the order listed, each a bigger architectural commitment than the last.
