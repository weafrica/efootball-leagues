# League Ladder — Fix Plan Status (detailed)

_Matchday / efootball-leagues-repo — weafrica.co.za_
_Updated after the session that closed out items 6 and 13, and cleaned up 4 empty league shells._

---

## 1. Audit core system vs. live — ✅ Done

Compared what the migration files in the repo claim is deployed against what's actually running on the live Supabase project (`weafrica Leagues`, project ref `jobgzxljuczzqljwavyq`). No CI/CD and no `supabase/config.toml` — migrations are applied manually and sometimes never actually make it to production even though the file exists in the repo. **Always check live vs. repo before trusting a file** — `pg_get_functiondef` on the live project is the source of truth, not the repo.

---

## 2. Fix auction-winner labeling bug — ✅ Done

Deployed live. (Migration: `20260918_ladder_auction_winner_active_label_fix.sql`.)

---

## 3. League-by-league history cleanup — ✅ Done

All tiers audited (League 2, tiers 3/4/5/8, and later 1/10/11/12/14). Zero true duplicate fixtures, zero orphaned fixtures, zero duplicate payouts, ladder-wide. The only false-alarm to watch for: a naive duplicate-pairing check flags 2 rows per pairing in every tier — that's the double round-robin's home leg + away leg, not a bug. Scope any duplicate check by `leg` as well as pairing.

---

## 4. Re-run proper closing for each league's real first week — ✅ Done

Tiers 1–12 closed correctly. Tier 13 was broken (all fixtures forfeited, decay penalty wrongly eliminated the sole real stayer, Ben) — fixed by removing the decay step entirely (`20260921_ladder_remove_decay_penalty_step.sql`) and reverting Ben to `active`. (Tier 13 itself was later fully drained and its league row deleted — see Housekeeping below. This history is preserved here for context only; the league no longer exists live.)

---

## 5. Deploy the promotion/relegation fix — ✅ Done, confirmed live

**Decision:** skip unaffordable players during promotion — walk standings in rank order, promote the first player who can afford the destination league's entry fee. Relegation stays "bottom 2 of whoever's left."

**Correction (this session):** the migration number previously cited here (`20260916`) was wrong — that file is actually `ladder_close_week_insufficient_balance_guard` (item 11's fix), unrelated to this item. The real fix is `20260870_ladder_affordability_fallbacks.sql`, which rewrites `_ladder_fall_through_internal` and `_ladder_resolve_promotion_relegation_internal`. Pulled both functions' live `pg_get_functiondef` and confirmed the affordability-skip logic (and the matching relegation-index fix) is already running live — this item was actually done, just mislabeled. No deploy needed.

---

## 6. Recheck roster cap (max 6) — ✅ Done

Cap confirmed live at 6 (`_rebalance_ladder_overflow_internal`, splits when a league exceeds 6). Full cascade now complete:

- Tiers 10–14 consolidated, Tier 1 backfilled (Nikkodm), Tier 2 backfilled (Avuyilegimba) — from the earlier session.
- Maxtentation's misplacement (Tier 3 → correct Tier 2) fixed.
- SAMBULO12345 and 953a1133/collinschileshe900 — both had winning bids that a prior "fix" had wrongly reverted. Restored to their bid-won tiers (Tier 3, Tier 8 respectively); overflow cascade absorbed cleanly.
- Majola_ZN confirmed correct (winning Tier 7 bid, not a bug).
- **This session, closing the cascade:** Tier 5 was short one seat. Root cause — **NtuanakaTsiki** (`255be657`) was rightfully Tier 5's rank-4 stayer (by points/GD, forfeits counted) but her week-1 status was wrongly `eliminated` instead of `active`, so she never carried into week 2. Backfilled her stayer seat directly (no fee — stayers don't pay a new entry fee) and resynced Tier 5's fixtures.
  - Also checked and ruled out a false alarm along the way: **a2d48754**'s move from Tier 4 to Tier 3 looked like a misplacement but was a legitimate won bid (15 nets). **70c34d31**'s move into Tier 4 is the correct "2nd-best-by-points" backfill for the seat a2d48754 vacated — also legitimate.
- **Result: every tier (1–11) is now at exactly 6, ladder-wide, with every bid winner honored and no matches or payouts disturbed.**

---

## 7. "Asked to join again" complaint — ⏳ Waiting on your answer

Still needs a decision: admin view or member's own page? Not investigated further.

---

## 8. Wall of Fame display check — ✅ Done

New `ladder_champion` achievement merged into the homepage trophy ranking; old in-page Wall of Fame block removed from the League Ladder detail page.

---

## 9. Minor bid edge case — ⏳ Low priority

Not investigated — flagged as likely to resolve on its own.

---

## 10. Relegated players teleporting to the wrong tier — ✅ Fixed

Root cause: the overflow-handling function was running against every league at every week's open, not just the entry league, exiling the newest arrival of any briefly-over-6 league to the ladder's bottom. Fixed (`20260919`), plus a related fixture-regen crash bug (`20260920`). All 4 players misplaced by this bug were manually corrected.

---

## 11. Sunday auto-start/auto-finish not firing — ✅ Fixed

Root cause: an unguarded balance check in fee settlement rolled back the entire Sunday close transaction, including the open-next-week step. Guard now live (`20260916`). A subsequent accidental early manual close was fully reverted (fees refunded, pool credit reversed, premature week 3 deleted, statuses reset). Week 2 will now close naturally via the working cron at Sunday 23:59 UTC.

---

## 12. Redesign build spec (`league-ladder-redesign-build-spec.md`) — ⏳ Not started

Seven phases, in dependency order. Confirmed live vs. spec this session:

- **Phase A — Live tier pricing** (foundation everything else reads from). Confirmed live: `_ladder_match_reward_for_tier` = `4 + round(0.1 * d)`, matching `20260903`'s lowered coefficient. Repo/spec should be double-checked to reflect `0.1`, not the original `0.5` example.
- **Phase B — Affordability fallbacks.** Directly relevant to item 5 above.
- **Phase C — Live open-bid auction**, replacing the sealed-bid model.
- **Phase D — Live (not snapshot) bid eligibility.**
- **Phase E — Mid-week auto-start leagues.** Confirmed live: roster cap is 6 (not 8), fixtures are double round-robin, cutoff is Sunday 23:59 UTC direct (no SAST conversion), and there's no separate "open" cron anymore — `_ladder_close_week_internal` calls the open-week step directly.
- **Phase F — Retroactive global top-up** — ✅ done (`20260877`), confirmed live: `_ladder_retroactive_topup_internal` exists and is wired into the overflow rebalance.
- **Phase G — UI**: surface the live bid leader's name in the bid ticker.

Two addenda confirmed live and working as intended, no action needed:
- **`20260902`** — `ladder_pool` ring-fencing (`_ladder_pool_reward_debit` confirmed live), separating live bid escrow from reward payouts.
- **`20260903`** — Match Reward coefficient lowered to `0.1`, confirmed live.

**Recommended next step:** Phase A, since B–E all build on it.

---

## 13. Full week-1 → week-2 placement audit — ✅ Done

Ran across every tier (1–11): checked that week-1 `promoted` players landed one tier up, `relegated` players landed one tier down, and `active` stayers landed in the same tier, against who's actually there. All confirmed correct except Tier 5 (see item 6) — now fixed. No other mismatches found ladder-wide.

---

## Housekeeping — ✅ Done this session

- **Empty league shells removed.** Tiers 14, 15, 16, 17 in `ladder_leagues` had zero memberships and zero fixtures — leftover clutter from a pre-`20260919` overflow-cascade bug, corrected by hand at the time but leaving the empty rows behind. Confirmed clean (no fixtures referencing them) and deleted.
- **Tier 13 removed (later session).** Fully drained to 0 players in week 2. Unlike the 14–17 shells, this one had real history (3 week-1 memberships, 6 forfeited fixtures — Ben's broken week from item 4) but no fee events, no bids, and no matches actually played. Deleted at the user's request since the league was no longer needed. If any future note still references "Tier 13," re-query live first — the league row no longer exists.
- **Week 2 match legitimacy verified.** Tier 1 (6 matches) and Tier 6 (1 match) show real played results from Aug 31. Confirmed genuine via `ladder_fixture_result_submissions` (distinct submission times, photo proof attached, real reviewer or auto-approve) and matching `ladder_reward_ledger` payouts — not seeded or bulk-inserted data. All other tiers/weeks are correctly at zero (pending, unplayed).

---

## What's actually left

1. **Item 7** — needs your call: admin view or member's own page?
2. **Item 9** — low priority, whenever.
3. **Item 12** — the redesign. Phase A recommended first, since B–E all depend on it.

---

## Gotchas learned (don't repeat these)

- **Double round-robin:** every pairing legitimately gets 2 fixtures (leg 1 home, leg 2 away). Scope any duplicate check by `leg` too.
- **Forfeited fixtures still count as "played."** The standings logic (`case when status in ('played','forfeited') then 1 else 0 end`) means a player who forfeits every match still shows `played > 0` — don't assume no-shows sort to the bottom on that basis alone. Some forfeited fixtures also carry real (non-null) scores if an admin entered a result despite the forfeit status — those count fully in points/GD, not just as a 0-0 no-show.
- **Bid winners always override the normal relegation/backfill path.** Before treating a tier as short and backfilling by points, check `ladder_bids` for a `won` bid targeting that league first.
- **Backfill order, when there's no bid winner:** 2nd-best-by-points from the tier below. Confirm they haven't already legitimately moved elsewhere (e.g. via their own won bid) before assuming they belong in the gap.
- **Don't disturb an already-played, already-paid match** when correcting a placement — redirect the go-forward schedule only, keep history intact.
- **Tier numbers and league IDs are not stable landmarks across sessions** — leagues get consolidated, drained, and recreated. Re-query live for what's actually in a tier now.
- **Identical microsecond timestamps across multiple rows usually mean a batch operation** (a manual fix, an auto-approve sweep), not necessarily fake data — check `ladder_fixture_result_submissions` / `ladder_reward_ledger` for independent corroboration before assuming either way.
