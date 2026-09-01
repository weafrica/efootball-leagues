# League Ladder — Auto-Start / Live-Pricing / Live-Bidding Redesign
### Build spec — supersedes the relevant parts of §5 and Phase 3–6 of the original build plan

Build in this order — each phase is testable on its own before the next depends on it.

---

## Phase A — Live tier pricing (foundation; everything else reads from this)

1. Add `_ladder_current_max_tier_internal()` — single source of truth for "current max active tier." Every pricing function below calls this instead of re-querying independently, so there's one place to fix if the query ever needs to change.
2. Rewrite `_ladder_match_reward_for_tier(tier)` — currently `immutable` SQL with a hardcoded, un-renumbered 8-row table (still assumes tier 1 = 25N, tier 8 = 4N — stale since the renumbering). Replace with a `stable` function:
   - `d = current_max_active_tier - tier`
   - `MatchReward(d) = 4 + round(0.5 * d)`
3. Rewrite `_ladder_entry_fee_for_tier(tier)` the same way:
   - `EntryFee(d) = 0` if `d = 0`, else `round(2 * MatchReward(d))`
4. Add `_ladder_early_bonus_for_tier(tier)`:
   - `EarlyBonus(d) = round(0.25 * MatchReward(d))`
5. Update `economy.js`'s `LADDER_TIER_TABLE` / `ladderTierRow()` to mirror the same formulas (hand-sync convention, same as every other JS/SQL pair in this codebase — flag clearly in comments on both sides).
6. Unit test: confirm `d=0` always resolves to `0 / 4N / 1N` regardless of how large the ladder has grown, and that consecutive `d` values never jump more than 1N in match reward.

---

## Phase B — Affordability fallbacks

7. **Relegation / fall-through** (`_ladder_fall_through_internal`): check balance against `_ladder_entry_fee_for_tier` *before* calling `_nets_debit_internal`. If short, skip the transition entirely — player stays a stayer in their current league. (Today this path raises an exception instead of failing gracefully — fix regardless of the rest of this spec.)
8. **Promotion** (`_ladder_resolve_promotion_relegation_internal`): restructure selection — walk the standings array in rank order, stop at the first player whose balance covers the *destination* league's entry fee, promote them. Only null out promotion for that league if nobody in the array can afford it. This moves the affordability check *before* seating (today it's seated first, charged 3 steps later in `_ladder_settle_week_fees_internal` — too late to redirect promotion to someone else).

---

## Phase C — Live open-bid auction (replaces today's sealed-bid model)

9. `place_ladder_bid`: a new bid must beat the *current leading bid* for that target league, not just clear the tier floor. The floor only applies when there's no existing leader yet.
10. On a new leading bid: immediately credit-refund the previous leader and flip their row to `refunded`, in the same transaction. Lock the league's current-leader row with `for update` first (same pattern the existing self-raise case already uses) so two near-simultaneous bids can't both believe they're leading.
11. `_ladder_settle_bids_internal` simplifies: by Sunday there's at most one `pending` bid per league (everyone else was refunded live throughout the week) — just seat that bidder, no comparison needed.

---

## Phase D — Bid eligibility (live, not snapshot-based)

12. Replace `_ladder_bid_eligible_pool_internal`'s end-of-week-snapshot read with a **live standings query** — needed because eligibility can no longer be determined once at Sunday; it has to be checked at whatever moment a bid is placed, mid-week.
13. Exclude the live rank-1 of the league below from the eligible pool (they're on track for free auto-promotion — no need to bid).
14. Restrict the 2 players currently sitting in relegation position (bottom of standings) to bidding *only* on their own current league (buy-back) — confirm this holds under the new live check, not just the old end-of-week one.
15. ✅ done (`ladder_live_bid_reeligibility_on_fixture_result`). **Live re-eligibility check, tied to fixture results:** whenever a fixture result is recorded, re-check whether the affected league's current bid leader has newly become rank 1. If so: void their bid, refund immediately (reuses Phase C's refund path), promote the 2nd-highest pending bid (if any) to leader automatically.
    - Built as `_ladder_recheck_bid_leader_eligibility_internal(league_id, week_number)` plus an `after insert or update` trigger on `ladder_fixtures` that fires when a fixture's status becomes `played`/`forfeited` or an already-recorded result's score is corrected.
    - "Promote the 2nd-highest pending bid" turned out to be a no-op under the live model: Phase C's beat-the-leader auction refunds a dethroned bidder immediately at bid time, so there's never a second `pending` bid sitting behind a league's leader to promote. If that invariant is ever relaxed, the next `place_ladder_bid` call or Sunday's `_ladder_settle_bids_internal` will naturally pick up the next-highest pending bid — nothing here needs to do that itself.
    - No JS mirror, by the same logic as Phase F's retroactive top-up: this is backend orchestration tied to a live trigger, not a pure pricing function.

---

## Phase E — Mid-week auto-start leagues

16. Move the overflow check out of the weekly-only `_ladder_open_week_internal` cron and into `join_ladder_league()` itself: after inserting a new membership, count the league's active roster; at 6 (moved from 8 by 20260876 — see addendum below), call `_rebalance_ladder_overflow_internal` immediately.
17. New fixture-stagger calculation for a league born mid-week: replace the fixed 142-hour week-start constant with "hours remaining until this Sunday 23:59 UTC" (corrected from "10PM SAST" by 20260876 — see addendum below), passed into `_generate_round_robin_fixtures_internal`.
18. Generate the new league's fixtures immediately at birth (call the round-robin generator right after the split), rather than waiting for the next scheduled open-week job.
19. Confirm resolution timing is unaffected: however/whenever a league is born, its fixtures still only resolve promotion/relegation/fees at the standing Sunday cutoff close — no separate mid-week resolution.

---

## Phase F — Retroactive global top-up ✅ done (20260877)

20. ✅ Rewards ledger added — `ladder_reward_ledger`, one row per (fixture, participant), recording tier + max-tier-at-credit + `d` + amount paid. Written by `_credit_ladder_match_reward_internal` alongside its existing `_nets_credit_internal` calls. Scoped to the flat Match Reward specifically (Early Bonus / Streak Bonus aren't ledgered here — see the migration's header).
21. ✅ `_ladder_retroactive_topup_internal(week_number)` built: walks that week's ledger rows for still-active leagues, recomputes each row's tier at the current max active tier, and — only where `d` actually grew since last paid — credits the delta and updates the ledger row to the new baseline. Floors at 0, no clawback branch (matches the formula's "d only grows mid-week" invariant).
22. ✅ Wired into `_rebalance_ladder_overflow_internal`, called once after its loop (not per-split). Per its own header note: by 20260876 the auto-start redesign had already collapsed "the weekly trigger" and "the mid-week trigger" this step originally called out into the single `join_ladder_league()` → `_rebalance_ladder_overflow_internal` path — there's only one call site left to wire, not two, and this covers it.
23. ✅ Global by construction: the top-up loop is keyed on `week_number` and `ladder_leagues.status = 'active'` only, not the league that split — every active league's ledger rows for the week get checked.
24. JS mirror: `economy.js`'s `computeLadderRetroactiveTopup(tier, newMaxActiveTier, previouslyPaid)`, pure, unit-tested in `scripts/test-ladder-fees.mjs`. The SQL side is the one that actually walks the ledger and credits players (not a pure function, so no full JS reimplementation of the loop) — the JS mirror covers the per-row pricing delta only, same split as every other pure/orchestration pair in this codebase.

---

## Phase G — UI

24. Extend `getLadderBids` / `watchLadderBidTicker` (or add a lightweight companion query) to surface the current leader's display name per league — join to the bidder's profile, expose `currentLeader: { name, amount }` alongside the existing full bid list.
25. Surface the live leader name wherever the bid ticker is rendered in the app.

---

## Notes carried over from earlier discussion, still true here

- The Phase 3 promotion-direction question (`tier - 1`) is **not** backwards — confirmed correct given `join_ladder_league` seats new joiners at the highest tier and promotion converges toward League 1.
- `_ladder_match_reward_for_tier` / `_ladder_entry_fee_for_tier`'s current hardcoded values are already wrong today (pre-renumbering table), independent of this redesign — Phase A fixes this as a side effect.
- ~~Cutoff timing (Sunday 10PM SAST close, Monday 00:00 SAST open) is unchanged by any of the above.~~ **No longer true — see addendum below.**

---

## Addendum — 20260875 / 20260876 (post-dates Phases A–G above)

Two further migrations landed after this spec was written, changing exactly the thing the last bullet above said wouldn't change:

- **20260875** moved the weekly cycle from Tuesday-start to Monday-start and attempted to correct the cutoff to "11:59pm Sunday," but read that as SAST and converted it to 21:59 UTC — that conversion was itself wrong.
- **20260876** corrected it again: the actual ask was 11:59pm Sunday **UTC**, i.e. **23:59 UTC directly, no SAST conversion at all.** The cron (`ladder-close-week-sunday`) now fires literally at `59 23 * * 0`. Every place in this spec and the original build plan that says "Sunday 10PM SAST" (or, per 20260875's now-superseded fix, "21:59 UTC") should be read as **Sunday 23:59 UTC**.
- **20260876** also changed the roster cap referenced in step 16 from 8 to **6** (a league now splits the moment a 7th player lands), and moved `_generate_round_robin_fixtures_internal` from a single-leg round robin to a **double round robin** (every pair plays home and away). See that migration's own header for the full rationale, and `src/formats/leagueLadder.js` for the JS-side mirror (`LADDER_ROSTER_SIZE`, `generateRoundRobinFixtures`) kept in sync with it.
- 20260876 also replaced the old "already fixtured → do nothing" guard with a resync-on-every-join model: `_ladder_sync_fixtures_internal` (renamed from `_ladder_maybe_autostart_fixtures_internal`) now runs on every roster change and rebuilds the pending schedule around whatever's already been played, rather than generating fixtures once and leaving late joiners unscheduled.
- **There is no scheduled "start" anymore, and there hasn't been since 20260875.** That migration unscheduled `ladder-open-week-tuesday` outright — `_ladder_close_week_internal` now calls `_ladder_open_week_internal` itself, in the same transaction, right after flipping `bidding_open` to false. The only cron job left anywhere in the League Ladder system is `ladder-close-week-sunday`, firing once a week at the corrected Sunday 23:59 UTC. Combined with resync-on-every-join above, that means players can join and start playing at any time — there's no "wait for the week to open" moment to wait out. The Sunday 23:59 UTC cutoff is the only fixed instant left in the whole system.

---

## Addendum — 20260902 (ladder_pool ring-fenced escrow from reward payouts)

Root cause (found via an admin-can't-approve-results report on a league created the day before): `ladder_pool` (20260855) is a single global singleton balance shared between two unrelated kinds of money — live bid escrow (must always be refundable on demand) and Match Reward / Early Bonus / Streak Bonus / retroactive top-up payouts (permanently paid out). Because both draw the same `balance`, an unrelated fixture approval or bonus on *any* league could debit the pool below what a completely different league's pending bid needed to stay refundable — surfacing as either "admin can't approve a result" or "raising my bid fails," depending on which side hit the shortfall first.

- **20260902** adds `_ladder_pool_reward_debit`, a guarded wrapper used by every reward-reason debit (`ladder_match_reward`, `ladder_early_bonus`, `ladder_streak_bonus`, `ladder_match_reward_topup`) in `_credit_ladder_match_reward_internal` and `_ladder_retroactive_topup_internal`. It refuses to let the pool balance drop below the sum of every currently-`'pending'` `ladder_bids.amount` — i.e. live escrow that must remain refundable — failing with a clear "pool needs topping up" error instead of silently endangering a bid refund elsewhere.
- Escrow refunds themselves (`ladder_bid_raise_refund` / `ladder_bid_refund` / `ladder_bid_admin_cancel_refund`, in `place_ladder_bid` / `admin_cancel_ladder_bid`) are **unguarded by design** — they only ever return money whose matching `ladder_entry_fee` credit already sits in the balance, so blocking them would defeat the entire point of ring-fencing.
- The migration also runs a one-off correction crediting the pool up to its live escrow reserve at deploy time, since the pool was very likely already short given the reported symptom.
- **Known limitation, discussed but intentionally not built yet:** a blocked reward payout currently still fails the admin action outright rather than queuing for later settlement. A `ladder_reward_payout_queue` + settlement-sweep design was sketched (catch a dedicated `LDR01` SQLSTATE, queue the payout, retry on a schedule or via an admin button) but not implemented — revisit if the "pool needs topping up" error is hit in practice.
- **Underlying economics, not fully resolved by this migration:** Table Fee (`_ladder_settle_week_fees_internal`, still live, 20% of a stayer's weekly earnings credited to the pool every Sunday close) is the main funding stream for reward payouts, but it settles weekly while rewards pay out immediately — a timing lag that gets worse the more leagues spin up mid-week. League 8's free entry and Phase F's retroactive top-up are both one-directional drains on the pool by design. This migration makes the resulting shortfall fail safely; it does not close the gap itself.

---

## Addendum — 20260903 (Match Reward growth rate lowered)

Confirmed decision: Nets will eventually convert to real prizes and marketplace items (not yet built). Given that, the d-based formula's *unbounded, ever-growing* Match Reward was flagged as a genuine long-run risk at large scale — `d = current_max_active_tier - tier` has no ceiling, and `max_tier` grows every time the ladder overflows a new tier, which happens faster the more active players there are. A capped or sub-linear (sqrt/log) curve was proposed as a way to get genuine long-run stability; **explicitly declined** — the formula's linear, uncapped shape is being kept on purpose, on the reasoning that it was designed to solve a specific problem and shouldn't change now.

- **20260903** lowers only the coefficient: `MatchReward(d) = 4 + round(0.1 * d)`, was `0.5`. Formula shape (linear in `d`, uncapped) is unchanged.
- `_ladder_entry_fee_for_tier`, `_ladder_early_bonus_for_tier`, and `_ladder_streak_bonus_for_tier` all call `_ladder_match_reward_for_tier` internally rather than duplicating the formula, so they inherit the slower rate automatically — no other SQL changed.
- JS mirror (`src/economy.js`'s `ladderTierRow()`) and its unit tests (`scripts/test-ladder-fees.mjs`) updated to match; full suite passing (21/21).
- **Still true, flagged and accepted knowingly:** this is 5x slower to reach any given reward value than the 0.5 rate, not bounded. If total active-player count (and therefore ladder depth) grows enough — plausible at large marketing scale — this will still eventually produce large per-match rewards against real prize inventory. Worth watching `max(tier)` in `ladder_leagues` over time as a leading indicator.
- **Rollout note:** existing leagues will see Match Reward (and Entry Fee, at 2x) drop compared to what the old 0.5 rate paid at the same depth, the moment this deploys — a live decrease for players already at a given standing, not just a slower future increase.
