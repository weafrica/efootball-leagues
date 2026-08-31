# Build Plan: Load League Banners Only, Fetch Details on Click

## Goal
Right now `loadLeagues()` fetches **every league on the platform**, fully expanded — `teams(*)`, `fixtures(*)`, `members(*)`, `ladder_cup_entries(*)`, `ladder_cup_matches(*)`, `ladder_cup_walkover_claims(*)`, `ladder_cup_second_life_offers(*)`, `ladder_cup_pool_sightings(*)` — on every sign-in. That's the entire dataset for every league, for every player, whether or not they ever open most of them.

The fix: the Home screen only needs enough per league to render `LeagueCard` (the banner) and the Home-wide aggregates (Up Next strip, attention badges, progress). Everything else — comments, full member rows, ladder cup sub-tables, admin-only fields — should load only when a player taps a specific league.

This plan is ordered by impact. Do 1–3 first; that's the actual fix. 4–7 are correctness/UX guardrails you need alongside it, not optional polish.

---

## 1. Split `LEAGUE_LIST_SELECT` into a summary select and a detail select (highest priority)

Audit confirmed what `LeagueCard` and the Home-wide helpers (`computeStandings`, `computeMyUpcomingFixtures`, `computeMyProgress`, `resultEscalationReason`, `ladderCupResultEscalationReason`, `LeagueReactionBar`) actually read off a league row. Nothing on Home reads `comments`, full `members` rows (phone numbers, proof photos), or any of the three `ladder_cup_*` sub-tables beyond `ladder_cup_matches`.

**`LEAGUE_SUMMARY_SELECT`** (what Home/`loadLeagues()` fetches — narrow every nested table, same treatment you already gave the `public_*` guest views):
- League columns: `id, name, format, league_type, photo_url, current_stage, final_stage_started, starts_at, group_stage_due_at, groups_count, group_qualifiers, survivor_elimination_percent, survivor_target_count, round_period_hours, entry_closes_at, created_at`
- `teams(id, name, eliminated, league_id, group_number)`
- `fixtures(id, league_id, home_team_id, away_team_id, home_score, away_score, played, stage, due_at)`
- `members(user_id, league_id, payment_status, entry_fee)`
- `result_submissions(id, fixture_id, status, created_at, submitted_by)`
- `ladder_cup_matches(id, league_id, finalized_at, result_status, result_dispute_count, result_reported_at)`
- `league_reactions(id, user_id, reaction)`

Drop entirely from the summary: `comments`, `ladder_cup_entries`, `ladder_cup_walkover_claims`, `ladder_cup_second_life_offers`, `ladder_cup_pool_sightings`, and any team/member/league columns only used on the detail screen (phone numbers, proof photos, `description`, `wa_message_template`, `created_by`, etc.).

**`LEAGUE_DETAIL_SELECT`** = today's `LEAGUE_SELECT` (everything, including `comments`). This becomes the "one league, fully expanded" query — only ever fetched for a single `id`, never for the whole list.

Treat this column audit as a first pass, not gospel — grep every place that reads `l.members`, `l.teams`, etc. off a Home-scope league object before shipping, the same way you already did for `public_leagues`.

## 2. Fetch the detail select on click, merge it into state

- On `LeagueCard`'s `onOpen(l.id)` (i.e. when `activeLeagueId` gets set), fire `supabase.from("leagues").select(LEAGUE_DETAIL_SELECT).eq("id", id).single()` and merge the result into `leagues` via the existing `mergeLeaguesById`.
- This is the same pattern already built for lazy-loading comments (`if (!current || current.comments) return`) — extend that effect (or add a sibling one keyed off `activeLeagueId`) to also backfill the rest of the detail-only fields, not just `comments`.
- Show a loading state in `LeagueDetail` while this is in flight (skeleton or spinner) — the banner data is already in `leagues` from the summary load, so the screen can render immediately with what it has and progressively fill in members/ladder-cup sub-tables/comments.

## 3. Don't let a background summary refresh clobber an already-loaded detail (critical correctness gotcha)

This is the part that will bite you silently if skipped: `mergeLeaguesById` does a shallow merge (`{...existing, ...newRow}`). Once a league has its full detail loaded (comments, full members, etc.), any *other* code path that re-fetches that league with the narrow `LEAGUE_SUMMARY_SELECT` — e.g. some other player's action triggering a summary-level refresh — will overwrite the rich `members` array with the stripped-down summary version, silently downgrading a screen the user already has open.

Fix: track which leagues have detail loaded (e.g. a `detailLoadedAt` timestamp on the row, or a separate `Set` of ids), and make any refresh path choose `LEAGUE_DETAIL_SELECT` instead of `LEAGUE_SUMMARY_SELECT` for a league that already has detail loaded. `refreshLeague`/`refreshLeagues` should branch on this instead of always using one fixed select string.

## 4. Add a freshness guard so reopening a league doesn't always refetch

Mirror the guest-data `GUEST_DATA_CACHE_MS` pattern: if `activeLeagueId` points at a league whose detail was loaded in, say, the last 20–30 seconds, skip the fetch and reuse what's in state. Combined with the 30s poll already running while a league is open (see #5), this mostly matters for the rapid open → close → reopen case.

## 5. Confirm polling/realtime stay scoped to the open league only

`useVisibilityPoll(refreshActiveLeagueCb, 30000, !!activeLeagueId)` and the `ladder_cup_walkover_claims` / `ladder_cup_matches` realtime subscriptions already key off `activeLeagueId`, so they're only touching one league — good, no change needed there. Just make sure `refreshActiveLeagueCb` is pointed at `LEAGUE_DETAIL_SELECT` (via #3's branching), since this is the one place a full detail refetch is actually supposed to happen every 30s.

## 6. Do the same split for the guest landing page (fast follow, not blocking)

The guest `Promise.all` fetch has the same shape at a smaller scale: it pulls `public_league_fixtures` and `public_league_teams` for **every** public league up front to feed Home-wide stats (`totalClubs`, `totalMatches`) and every `PublicLeagueCard`. Once the signed-in split (1–5) is working, apply the identical summary/detail split to the guest views — `public_leagues`/`public_league_teams`/`public_league_fixtures` stay as the summary, and add a `public_league_detail`-style view fetched only when a guest opens a specific league (if guests can even drill into one — if not, this step may not apply and can be dropped).

## 7. Measure before/after

Once 1–3 ship, watch the Supabase dashboard's Egress panel for a few days. `loadLeagues()` firing once per sign-in with the narrow select, instead of the full nested payload, should show up as a clear drop in daily PostgREST egress. If it doesn't move much, that's a signal the per-league detail fetches (from players actually opening leagues) or the guest page (#6) are the bigger contributor, not the bulk load — worth confirming with real numbers rather than assuming.
