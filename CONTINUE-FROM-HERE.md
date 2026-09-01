# Continue-from-here notes
_Written after the session that finished item 3 (history-cleanup audit) in `league-ladder-fix-plan-status.md`_

## Project facts
- Repo: `efootball-leagues-repo` (weafrica.co.za)
- Live Supabase project: `weafrica Leagues`, project ref `jobgzxljuczzqljwavyq`
- No CI/CD — migrations are applied manually. **Always check live vs. repo before trusting a file.** `pg_get_functiondef` on the live project is the source of truth, not the repo.

## What's done this session
- **Item 3** (League-by-league history cleanup) — ✅ now fully done. Ran the same three checks League 2 got — duplicate played/forfeited fixtures, fixtures involving players not actually rostered that week, duplicate reward-ledger payouts — against every tier the status doc had flagged as unaudited (1, 10, 11, 12, 14), and against the whole ladder while at it.
  - **False alarm caught and corrected:** a naive duplicate-pairing check flags 2 rows per pairing in *every* tier — that's the double round-robin's home leg + away leg (see `20260920`'s comment), not a bug. Re-scoped the check by `leg` as well as pairing before trusting it.
  - Result: **zero true duplicate fixtures, zero orphaned fixtures, zero duplicate payouts, ladder-wide.** No SQL was needed — nothing to fix.
  - Spot-checked Tier 12's placement trail (it's fully drained — 0 actives left in week 2) to be sure nobody got stranded: all 6 of its week-1 players trace correctly to their next-week destination (1 promoted → Tier 10 active, 2 relegated → Tier 11 active, 3 eliminated → correctly carry nothing forward).
  - **Housekeeping spotted, not fixed:** `ladder_leagues` has 4 empty shell rows — tiers 14, 15, 16, 17 — zero memberships, zero fixtures in any of them. 15–17 were all created at the identical timestamp `2026-08-31 23:59:47`, which looks like a leftover cascade from the pre-`20260919` overflow bug (relegated player exiled several tiers down, then corrected by hand, leaving the empty league rows behind). Harmless, nothing points at them — just clutter. Low-priority cleanup: `delete from ladder_leagues where tier in (14,15,16,17)`.
  - Also noted in passing (not part of item 3, no action taken): Ben, changara05, and Fabio's — the three players item 4 fixed in Tier 13 last session — have since all been manually moved into Tier 11 together (joined_at timestamps Aug 31–Sep 1), so Tier 13 is now correctly drained to zero for week 2. This matches item 6's Tier 10/11 consolidation; nothing to do here.

## Full status — see `league-ladder-fix-plan-status.md` for details
| Item | Status |
|---|---|
| 1. Audit core system vs. live | ✅ Done |
| 2. Auction-winner labeling bug | ✅ Done, live |
| 3. League history cleanup | ✅ **Done — all tiers audited clean this session** |
| 4. Re-close each league's real week 1 | ✅ Done (prior session) — Tier 13/Ben fixed, decay step removed |
| 5. Promotion/relegation skip-unaffordable fix | ⏳ Decided, **still not deployed live** — repo migration `20260916` has it, live DB doesn't |
| 6. Roster cap recheck | 🔄 Paused pending item 13 (per prior session's notes) — worth re-checking headcounts now that item 3's audit is clean, since some of the placements it was worried about (Tier 12) now check out fine |
| 7. "Asked to join again" complaint | ⏳ Waiting on you: admin view or member's own page? |
| 8. Wall of Fame display | ✅ Done |
| 9. Minor bid edge case | ⏳ Low priority, not investigated |
| 10. Relegation teleport bug | ✅ Fixed |
| 11. Sunday auto-close/open not firing | ✅ Fixed |
| 12. Redesign build spec (Phases A–G) | ⏳ Not started — Phase A recommended next |
| 13. Full week-1 → week-2 placement audit | ⏳ Not started — blocks resuming item 6's cascade |

## Recommended next step
Three candidates, your call:
- **Item 5** — deploy the skip-unaffordable promotion fix that's already written (`20260916`) but not live. Quick, low-risk, already decided.
- **Item 13** — the full placement audit that's blocking item 6's cascade resume. Item 3's clean result today is a good sign, but item 13 checks a different thing (promoted/relegated/stayer landing in the *right* tier, not just fixture/payout integrity), so it's still open.
- **The orphaned tier 14–17 shells** — trivial delete, whenever convenient.

## Gotchas learned this session (don't repeat these)
- This is a **double round-robin**: every pairing legitimately gets 2 fixtures (leg 1 home, leg 2 away). Don't flag 2-per-pairing as a duplicate — scope any duplicate check by `leg` too, or you'll drown in false positives across every league.
- Tier numbers and league IDs are not stable landmarks across sessions — leagues get consolidated, drained, and recreated. Before auditing "Tier N," re-query live for what's actually in it now; don't assume the tier layout from an older status doc still holds.
- Empty `ladder_leagues` rows (0 memberships, 0 fixtures) can be leftover from corrected overflow-cascade bugs — harmless, but worth a periodic `select tier from ladder_leagues where id not in (select distinct league_id from ladder_memberships)` sweep to catch clutter like tiers 14–17.
