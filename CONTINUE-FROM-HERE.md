# Continue-from-here notes
_Rewritten after the session that closed out items 6, 7, 9, 12, and 13, and fixed a live bidding gap — see `league-ladder-fix-plan-status.md` for full detail on every item._

## Project facts
- Repo: `efootball-leagues-repo` (weafrica.co.za)
- Live Supabase project: `weafrica Leagues`, project ref `jobgzxljuczzqljwavyq`
- No CI/CD — migrations are applied manually. **Always check live vs. repo before trusting a file, including this one.** `pg_get_functiondef` on the live project is the source of truth, not any doc.

## Full status — see `league-ladder-fix-plan-status.md` for details
| Item | Status |
|---|---|
| 1. Audit core system vs. live | ✅ Done |
| 2. Auction-winner labeling bug | ✅ Done, live |
| 3. League history cleanup | ✅ Done — all tiers audited clean |
| 4. Re-close each league's real week 1 | ✅ Done — Tier 13/Ben fixed, decay step removed |
| 5. Promotion/relegation skip-unaffordable fix | ✅ Confirmed live — real migration is `20260870`, not the `20260916` earlier notes cited |
| 6. Roster cap recheck | ✅ Done — every tier confirmed live at exactly 6 (1–11), drained tail tiers correctly at 0 |
| 7. "Asked to join again" complaint | ✅ Resolved — traced to item 11's root cause (Sunday cron guard), confirmed live, no stragglers |
| 8. Wall of Fame display | ✅ Done |
| 9. Minor bid edge case | ✅ Fixed live — free (0-fee) leagues can now take a 0-amount bid; migration `ladder_allow_zero_amount_bid_on_free_league` |
| 10. Relegation teleport bug | ✅ Fixed |
| 11. Sunday auto-close/open not firing | ✅ Fixed |
| 12. Redesign build spec (Phases A–G) | ✅ Done — all 7 phases confirmed live; Phase D's one real gap (live bid re-eligibility on fixture results) closed this session |
| 13. Full week-1 → week-2 placement audit | ✅ Done |

## What's actually left
Nothing outstanding on this plan. Tier 13 (the empty league shell, drained, no real matches ever played there) was also removed by request.

## Gotchas learned across these sessions (don't repeat these)
- This is a **double round-robin**: every pairing legitimately gets 2 fixtures (leg 1 home, leg 2 away). Don't flag 2-per-pairing as a duplicate — scope any duplicate check by `leg` too, or you'll drown in false positives across every league.
- Tier numbers and league IDs are not stable landmarks across sessions — leagues get consolidated, drained, and recreated. Before auditing "Tier N," re-query live for what's actually in it now; don't assume the tier layout from an older status doc still holds. Tier 13 in particular was fully deleted this session — if any future note still references it, that league no longer exists.
- Empty `ladder_leagues` rows (0 memberships, 0 fixtures) can be leftover from corrected overflow-cascade bugs — harmless, but worth a periodic `select tier from ladder_leagues where id not in (select distinct league_id from ladder_memberships)` sweep. Rows *with* real history (even fully drained ones) are a judgment call, not an automatic delete — check fixtures/fee-events before removing.
- **Docs drift from live fast, in both directions.** More than once this session a doc claimed something was "not deployed" when it was actually live (item 5's real migration number was wrong; item 12 was marked "not started" when almost the whole redesign was already live). Always verify against `pg_get_functiondef` / a live query before trusting a status doc's claim either way — including this file.
- When adding new bidding logic, remember all four wallet/pool helper functions (`_nets_debit_internal`, `_nets_credit_internal`, `_ladder_pool_credit`, `_ladder_pool_debit`) reject non-positive amounts outright — any code path that might legitimately involve a `0` amount (e.g. the free-tier bid floor) needs to skip those calls explicitly, not just relax its own validation.
- For live-DB sanity checks without touching real data: `set local request.jwt.claim.sub = '<uuid>'` inside a query lets you exercise `auth.uid()`-gated functions as a specific user; wrap the actual test in a small plpgsql probe that catches exceptions and returns `sqlerrm`, so nothing writes unless the call would have genuinely succeeded.
