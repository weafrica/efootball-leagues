# Continue-from-here notes
_Written after the session that fixed items 3 and 10 in `league-ladder-fix-plan-status.md`_

## Project facts
- Repo: `efootball-leagues-repo` (weafrica.co.za)
- Live Supabase project: `weafrica Leagues`, project ref `jobgzxljuczzqljwavyq`
- No CI/CD — migrations are applied manually. **Always check live vs. repo before trusting a file** (this has caused several of the bugs already fixed). `pg_get_functiondef` on the live project is the source of truth, not the repo.

## What's done this session
- **Item 3** (League-by-league history cleanup): tiers 3, 4, 5, 8 audited — clean, nothing removed.
- **Item 10** (new): relegated players were being teleported to random far-away tiers instead of dropping one tier. Root cause + fix + a second crash it exposed are documented in item 10. Two migrations written and applied live:
  - `20260919_ladder_overflow_push_one_tier_not_bottom.sql`
  - `20260920_ladder_fixture_regen_order_independent_played_check.sql`
  - **Not yet pushed to git** — files are sitting in this repo checkout, need `git add` / `commit` / `push` (commands given in chat).
- Follow-up sweep across *all* leagues for the same fixture/payout problems — found and cleaned one leftover (stray fixtures in tier 14 from a manual data fix). No migration needed for that, just noted in item 10.

## Full status — see `league-ladder-fix-plan-status.md` for details
| Item | Status |
|---|---|
| 1. Audit core system vs. live | ✅ Done |
| 2. Auction-winner labeling bug | ✅ Done, live |
| 3. League history cleanup | ✅ Done (League 2, and now 3/4/5/8) |
| 4. Re-close each league's real week 1 | ⏳ Not started — **now unblocked**, depends only on item 3 which is done |
| 5. Promotion/relegation skip-unaffordable fix | ✅ Decided, ⏳ **not yet deployed live** — repo migration `20260916` has it, live DB doesn't |
| 6. Roster cap recheck | 🔄 In progress — cap mechanism fixed (item 10); tiers 1,10,11,12,14 still under 6 (pre-existing debt, item 3 territory) |
| 7. "Asked to join again" complaint | ⏳ Waiting on you: admin view or member's own page? |
| 8. Wall of Fame display | ✅ Done |
| 9. Minor bid edge case | ⏳ Low priority, not investigated |
| 10. Relegation teleport bug | ✅ Fixed this session |
| 11. Sunday auto-close/open not firing | ✅ Fixed |
| 12. Redesign build spec (Phases A–G) | ⏳ Not started — **Phase A recommended next**, everything else builds on it |

## Recommended next step
Two candidates, your call:
- **Item 5** — deploy the skip-unaffordable promotion fix that's already written (`20260916`) but not live. Quick, low-risk, already decided.
- **Phase A of the redesign spec (item 12)** — bigger, but everything else in the redesign depends on it.

Either way, **item 4** (re-close each league's real week 1) is now unblocked and worth doing once you're ready, since item 3 cleared the blocker.

## Gotchas learned this session (don't repeat these)
- If you ever manually move a player's `league_id` in `ladder_memberships` via raw SQL (not through the proper functions), **their old league keeps stale fixtures for them** — you have to delete those and re-run `_ladder_sync_fixtures_internal` on both the old and new league afterward. This bit us once already (tier 14 leftovers).
- The "6 players per league" rule is enforced by `_rebalance_ladder_overflow_internal` — as of this session it only ever pushes overflow one tier down, never to the ladder's bottom. If you see anyone in a far-flung near-empty tier again, that function (or something calling it wrong) is the first place to check.
