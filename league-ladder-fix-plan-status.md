# League Ladder — Fix Plan Status (detailed)

_Matchday / efootball-leagues-repo — weafrica.co.za_

---

## 1. Audit core system vs. live — ✅ Done

Compared what the migration files in the repo claim is deployed against what's actually running on the live Supabase project (`weafrica Leagues`, project ref `jobgzxljuczzqljwavyq`). This surfaced the recurring pattern behind most of the bugs below: there's no CI/CD pipeline and no `supabase/config.toml` in this repo, so migrations are applied manually and sometimes never actually make it to production even though the file exists in the repo. Several of the items below trace back to exactly this — a fix committed as a `.sql` file that was never run against the live database.

---

## 2. Fix auction-winner labeling bug — ✅ Done

Deployed live. Unblocked a real player who was stuck due to the mislabeling. (Migration: `20260918_ladder_auction_winner_active_label_fix.sql`.)

---

## 3. League-by-league history cleanup — 🔄 In progress

- **League 2:** ✅ Done. 30 leftover/duplicate games from a mislabeled batch were identified and removed. The ledger records logging the reward payout for 3 of those games were removed too (balances themselves were left untouched — the reward money stays with the players, only the duplicate log entries were deleted). League 2 now shows only genuine history: 30 real week-1 games, plus the real week-2 fixtures in progress across its 5 active players.
- **Leagues 3, 4, 5, 8 (tiers 3, 4, 5, 8):** ✅ Done, and clean. Checked each for duplicate fixtures, fixtures involving players not actually rostered that week, and duplicate reward-ledger payouts on the same match — found none of any of those in any of the four. Rosters also reconcile exactly to 6 for both week 1 and week 2 in all four. Unlike League 2, there was nothing to remove here.
- **Tiers 1, 10, 11, 12, 14 (and likely deeper):** ⏳ Not started, new since item 10 below. These sit below the 6-per-league rule (5, 3, 3, 2, 3 players respectively) — mostly players already marked `eliminated` from before this cleanup effort started, not caused by the overflow bug fixed in item 10. Needs the same per-league audit as League 2 got.

---

## 4. Re-run proper closing for each league's real first week — ✅ Done

Audited every league's week-1 close against the current live data. **Tiers 1–12:** already properly closed — each shows the expected 1-promoted/2-relegated pattern, sitting correctly in week 2, League 1's champion recorded in Wall of Fame. No action needed.

**Tier 13 was broken.** All 6 of its week-1 fixtures were forfeited — nobody ever played, a leftover from the original mislabeled-batch problem (same root cause as the "27 stuck games" from before item 1). Of its 3 real players, 2 (changara05, Fabio's) landed correctly in Tier 14 for week 2 via the normal relegation path. The third, Ben, did not: he was never promoted or relegated (stayed a "stayer"), and the weekly close's inactivity-decay step then marked him `eliminated` for having played 0 matches that week — decay has no fallback, unlike fall-through, so this left him with no week-2 membership anywhere.

**This is a gap the `league-ladder-redesign-build-spec.md` doesn't cover.** Its Phase B (step 7) flags fall-through's lack of a graceful affordability fallback, but says nothing about decay — which had the same "no graceful fallback" problem in a worse form: fall-through at least re-seats the player back in their own league on failure; decay just flips them to `eliminated` and stops.

**Decision: remove the decay step entirely** rather than patch it (admin call, not from the redesign spec). Deployed live and committed as `20260921_ladder_remove_decay_penalty_step.sql` — `_ladder_close_week_internal` no longer calls `_ladder_apply_decay_penalty_internal`. The function itself is left in place, unused, in case it's revisited later with a proper fallback instead of removal.

**Ben, resolved:** reverted to `active` for week 1, seated `active` in Tier 13 for week 2 — the same treatment any normal stayer gets. No money was involved (his decay penalty would have been 0 — no lifetime match-reward earnings to base it on). He's currently alone in Tier 13 for week 2 (his 2 former leaguemates are in Tier 14 now), so no fixtures were generated — he has no one to play until the league gets more players or he's moved somewhere with people.

---

## 5. Deploy the promotion/relegation fix — ✅ Decided, ⏳ not yet live

**Decision: skip unaffordable players.** Promotion walks the standings in rank order and promotes the first player who can afford the destination league's entry fee. If rank 1 can't afford it, they stay put and get skipped over — someone else gets promoted instead. If nobody in the league can afford it, promotion is left empty for that league that week.

- Relegation stays "bottom 2" either way — it's just bottom 2 of whoever's left *after* the promoted player is pulled out. If a lower-ranked player gets promoted instead of rank 1, rank 1 simply stays a stayer; nobody extra gets relegated because of this rule. Skipping doesn't add a relegation, it just picks a different promotion.

**Checked live vs. repo — they don't match:**
- Repo migration `20260916` has the correct skip-unaffordable logic.
- What's actually running live right now is "always rank 1, balance irrelevant" — and there is **no migration file anywhere for that live version.** It was changed straight on the database, never committed.

**Next step:** write and run a new migration that puts `20260916`'s skip-unaffordable version back live, so the database and the repo agree again. Do this before leagues 3–5/8 get cleaned up (item 3/4) and promotion starts actually moving real players.

---

## 6. Recheck roster cap (max 6) — 🔄 In progress

Confirmed in the repo (`20260876_ladder_double_round_robin_groups_of_6_and_utc_cutoff.sql`) that the cap is meant to be 6 (a league splits once a 7th player lands), down from the earlier cap of 8.

Re-verified against what's actually enforced live — see item 10: the cap itself was fine, but the mechanism handling a league that briefly exceeds 6 was badly broken and has now been fixed. Still open: tiers 1, 10, 11, 12, 14 currently sit *under* 6 (pre-existing data debt, see item 3).

---

## 7. "Asked to join again" complaint — ⏳ Waiting on your answer

Still needs a decision: should this be checked from the **admin view** or the **member's own page**? Not investigated further yet pending that answer.

---

## 8. Wall of Fame display check — ✅ Done

- Added a new `ladder_champion` achievement/badge: earned by finishing #1 in League 1 at the Sunday 23:59 UTC cutoff (sourced from `ladder_wall_of_fame`, tier 1 only).
- This badge merges into the same trophy/badge ranking as regular league wins (`league_champion`) — a League 1 ladder win now shows up as a title on the homepage Wall of Fame, ranked by the same weighted trophy score.
- Removed the separate, smaller "Wall of Fame" section that used to live inside the League Ladder detail page (League 1 only, last 5 weeks) — that data now surfaces exclusively via the homepage.
- Files changed: `src/App.jsx` (new achievement, `loadLadderChampions`, `computeLadderTitlesByUserId`, merged into `computeWallOfFame`), `src/LeagueLadderDetail.jsx` (removed the old in-page block and its query).

---

## 9. Minor bid edge case — ⏳ Low priority

Not investigated — flagged as likely to resolve on its own.

---

## 10. Relegated players teleporting to the wrong tier — ✅ Fixed (new item, found this session)

**Symptom:** relegated players weren't showing up one tier below where they were relegated from. Some landed 10+ tiers away in a near-empty league at the bottom of the whole ladder. Several leagues also sat under 6 players as a result, with the missing player usually turning up in one of those far-away almost-empty leagues.

**Root cause, confirmed via live query:** the overflow-handling function (meant only for brand-new joiners piling up past 6 in the entry-level league) was also running against *every* league at every week's open, not just the entry league. Whenever a mid-ladder league briefly had 7 players — completely normal, e.g. it just received 2 relegated arrivals and 1 promoted arrival in the same moment — it exiled the newest arrival to a brand-new league at the very bottom of the entire ladder instead of just holding the league at 6.

**Fix:**
- Rewrote the overflow function so an overflowing league only ever pushes its extra player one tier further down (creating that tier if it doesn't exist), never to the ladder's bottom. For the entry league this is unchanged — it IS the bottom tier already. Migration: `20260919_ladder_overflow_push_one_tier_not_bottom.sql`.
- Along the way, found and fixed a second bug this exposed: the fixture-schedule rebuild (which runs whenever a league's roster changes mid-week) compared "already played" pairings in a fixed home/away order, but the round-robin rotation can flip which side is home/away once the roster changes — so it could try to re-insert an already-played match with sides swapped and crash against the database's own duplicate-pairing rule. Migration: `20260920_ladder_fixture_regen_order_independent_played_check.sql`.
- Manually corrected the 4 players already misplaced in week 2 (moved to their correct one-tier-below destination), then re-ran the fixed rebalance for week 2. Every league is now at exactly 6 or below the historical debt in item 3 — no league is over 6.
- **Follow-up check (all leagues, not just 3/4/5/8):** re-ran the same duplicate-fixture / orphaned-fixture / duplicate-payout checks from item 3 across every league. Found one leftover — 6 stray pending fixtures in tier 14 for one of the 4 manually-moved players, left behind because the manual move only updated their membership row, not their fixtures. Deleted those and resynced tier 14's schedule. No duplicate reward payouts anywhere, and no other leftover fixtures anywhere.

---

## 11. Sunday auto-start/auto-finish not firing — ✅ Fixed

**Symptom:** the ladder didn't auto-close week 2 or auto-open the next week at the Sunday 23:59 UTC cutoff.

**Root cause, confirmed via `cron.job_run_details` on the live database:** the Sunday close job (`ladder-close-week-sunday`) failed with `insufficient balance for user ... (have 7, need 10)` — a player couldn't cover their weekly fee, and because the whole close routine runs in one transaction (promotion/relegation → Wall of Fame → fee settlement → bid settlement → fall-through → decay penalty → open next week), that one failure rolled back everything, including the open-next-week step.

The underlying bug (fee settlement having no balance guard) had already been fixed in the repo's `20260916` migration, and that fix **was** live in the database by the time we checked — but too late, since it landed after Sunday's failed run already happened. The `cron.job` listing also confirmed no stray leftover cron job was interfering — that part of the earlier `20260917` fix was clean.

**Action taken:** manually ran the close routine to catch the week up now that the guard is in place.

**Complication — this manual run was itself a mistake, and was rolled back:** week 2 had only just opened that same morning (08:11 UTC), so closing it again a few hours later was wrong — it charged real entry/table fees to real players, generated a premature week 3, and advanced `current_week` to 3. This was fully reverted:
- Refunded every fee/decay-penalty debit from that erroneous run, per-user, back to their wallets.
- Reversed the matching pool credit.
- Deleted the erroneous ledger rows (`ladder_fee_events`, `nets_transactions`, `ladder_pool_transactions`, `ladder_wall_of_fame` entries) created by that run.
- Deleted the premature week 3 fixtures and memberships.
- Reverted week 2 membership statuses (`promoted`/`relegated`/`eliminated`) back to `active`.
- Reset `ladder_cycle` back to `current_week = 2`, `bidding_open = true`, `fixtures_locked = false`.

**Net result:** week 2 is now genuinely mid-week again, exactly as it should be. It will close naturally on its own this Sunday at 23:59 UTC via the now-working cron job — no further manual action needed for this week.

---

## 12. Redesign build spec (`league-ladder-redesign-build-spec.md`) — ⏳ Not started

New item, from the document you uploaded. Supersedes parts of the original build plan. Seven phases, in dependency order:

- **Phase A — Live tier pricing** (foundation everything else reads from). Replace the stale, un-renumbered hardcoded reward/fee tables with formulas driven off `_ladder_current_max_tier_internal()`. Note: `20260903` already lowered the Match Reward coefficient from `0.5` to `0.1` per match — confirm Phase A's implementation reflects that current rate, not the spec's original `0.5` example.
- **Phase B — Affordability fallbacks.** Directly relevant to item 5 above — see the conflict flagged there.
- **Phase C — Live open-bid auction**, replacing the sealed-bid model: new bids must beat the current leader, immediate refund-on-outbid, simplified Sunday settlement.
- **Phase D — Live (not snapshot) bid eligibility**, including re-checking eligibility whenever a fixture result lands.
- **Phase E — Mid-week auto-start leagues.** Move the overflow/split check into `join_ladder_league()` itself instead of waiting for a weekly cron — ties in with the fact that (per the spec's own addendum) there's no separate "open" cron left at all anymore; `_ladder_close_week_internal` calls the open-week step directly.
- **Phase F — Retroactive global top-up** — ✅ already done per the spec (`20260877`), confirmed present in the migrations folder.
- **Phase G — UI**: surface the live bid leader's name in the bid ticker.

Two addenda in the doc are already reflected live and don't need action: the `20260902` pool ring-fencing (separating live bid escrow from reward payouts) and `20260903`'s reward-growth-rate change — both migrations exist in the repo and are worth a quick live-vs-file drift check given the pattern in item 1, but aren't flagged as broken.

**Recommended next step:** Phase A, since B–E all build on it.
