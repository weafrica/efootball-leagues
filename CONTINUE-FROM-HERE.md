# Continue-from-here notes
_Written after the session that fixed item 4 (and removed the decay-penalty step) in `league-ladder-fix-plan-status.md`_

## Project facts
- Repo: `efootball-leagues-repo` (weafrica.co.za)
- Live Supabase project: `weafrica Leagues`, project ref `jobgzxljuczzqljwavyq`
- No CI/CD — migrations are applied manually. **Always check live vs. repo before trusting a file** (this has caused several of the bugs already fixed). `pg_get_functiondef` on the live project is the source of truth, not the repo.

## What's done this session
- **Item 4** (Re-run proper closing for each league's real first week): audited every league's week-1 close.
  - Tiers 1–12: already properly closed, no action needed.
  - Tier 13: broken — all week-1 fixtures forfeited (nobody played), and one real player (Ben) got stranded with no week-2 membership at all, because the inactivity-decay step marked him `eliminated` with no fallback seat.
  - **Decision: removed the inactivity-decay step from the weekly close entirely** (not covered by the redesign spec's Phase B, which only flags fall-through's affordability crash — decay had the same "no fallback" problem, worse, since it doesn't even try to re-seat the player). Migration written and applied live:
    - `20260921_ladder_remove_decay_penalty_step.sql`
    - **Not yet pushed to git** — sitting in this repo checkout, needs `git add` / `commit` / `push`.
  - Ben resolved: reverted to `active` week 1, seated `active` in Tier 13 week 2 (same as any normal stayer). No money involved. He's currently alone in Tier 13 for week 2 (his 2 former leaguemates are in Tier 14) — no fixtures generated, needs company or a manual move.

## Full status — see `league-ladder-fix-plan-status.md` for details
| Item | Status |
|---|---|
| 1. Audit core system vs. live | ✅ Done |
| 2. Auction-winner labeling bug | ✅ Done, live |
| 3. League history cleanup | ✅ Done (League 2, and 3/4/5/8) |
| 4. Re-close each league's real week 1 | ✅ Done this session — Tier 13/Ben fixed, decay step removed |
| 5. Promotion/relegation skip-unaffordable fix | ✅ Decided, ⏳ **still not deployed live** — repo migration `20260916` has it, live DB doesn't |
| 6. Roster cap recheck | 🔄 In progress — cap mechanism fixed (earlier session); tiers 1,10,11,12,14 still under 6 (pre-existing data debt, item 3 territory); Tier 13 now also under 6 (1 player, this session) |
| 7. "Asked to join again" complaint | ⏳ Waiting on you: admin view or member's own page? |
| 8. Wall of Fame display | ✅ Done |
| 9. Minor bid edge case | ⏳ Low priority, not investigated |
| 10. Relegation teleport bug | ✅ Fixed (earlier session) |
| 11. Sunday auto-close/open not firing | ✅ Fixed |
| 12. Redesign build spec (Phases A–G) | ⏳ Not started — **Phase A recommended next**, everything else builds on it |

## Recommended next step
Three candidates, your call:
- **Ben** — currently alone in Tier 13 with no fixtures. Needs a decision: leave him waiting for company, or move him somewhere with people.
- **Item 5** — deploy the skip-unaffordable promotion fix that's already written (`20260916`) but not live. Quick, low-risk, already decided.
- **Phase A of the redesign spec (item 12)** — bigger, but everything else in the redesign depends on it.

## Gotchas learned this session (don't repeat these)
- The weekly close runs promotion/relegation → Wall of Fame → fees → bids → fall-through, **then used to run decay penalty last, before opening the next week** (decay step now removed — see item 4). Any step in that chain that changes a member's status away from `'active'` *before* the open-week carry-forward query runs will silently strand that player with no next-week seat, since carry-forward only picks up rows still `'active'`. Worth remembering if a new step is ever added to this pipeline.
- If you ever manually move a player's `league_id` in `ladder_memberships` via raw SQL (not through the proper functions), **their old league keeps stale fixtures for them** — you have to delete those and re-run `_ladder_sync_fixtures_internal` on both the old and new league afterward. This bit us once already (tier 14 leftovers).
- The "6 players per league" rule is enforced by `_rebalance_ladder_overflow_internal` — it only ever pushes overflow one tier down, never to the ladder's bottom (fixed in an earlier session). If you see anyone in a far-flung near-empty tier again, that function (or something calling it wrong) is the first place to check.
