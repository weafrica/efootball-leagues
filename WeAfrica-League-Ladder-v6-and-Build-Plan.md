# WeAfrica League Ladder System — v6

## ⚠️ Superseded facts (read this first)

This doc predates several since-landed migrations and is kept as historical
record, not a live spec — some of its numbers no longer match the running
system:

- **§1 "8 players per league, round robin weekly (7 fixtures per player)"**
  — superseded by **20260876**: roster cap is now **6** (a league splits
  once a 7th player lands), and the schedule is a **double round robin**
  (every pair plays home and away — 10 fixtures per player in a full
  6-player league), not a single leg.
- **§2's Tuesday 12:00 AM start / Sunday 10:00 PM cutoff** — the week now
  starts **Monday** (20260866) and the cutoff is **23:59 UTC** literally,
  not SAST (20260875 attempted the SAST→UTC conversion and got it wrong;
  20260876 corrected it — see that migration's header). The "Monday
  buffer day" described further down no longer applies under the
  Monday-start cycle.
- **§6's 142-hour Tuesday 12AM → Saturday 10PM release window** — the
  window is recalculated for the corrected Monday-start / 23:59 UTC
  cutoff (~143h59m) and now has to spread across double the rounds (10
  release slots for a full 6-player league instead of 7), so the actual
  per-round stagger is different from the worked example below.
- **Checkpoint Safety's "rank 6 clear of rank 7"** — with the 6-player
  cap, no league ever has a rank 7. It's now rank 4 clear of rank 5 (the
  first relegation-zone spot); see `classifyLadderZones` in
  `src/formats/leagueLadder.js`.
- **This whole §2 "Weekly Cycle" section, specifically the idea of a
  scheduled start moment** — superseded by **20260875**, which removed
  the separate open-week cron entirely (`ladder-open-week-tuesday` is
  unscheduled; `_ladder_close_week_internal` now opens the next week
  itself, in the same transaction, right after closing the last one).
  There is no "Tuesday 12:00 AM" or "Monday" start event anywhere in the
  running system anymore, and no "Monday buffer day" — a league becomes
  playable the moment it has 2 active members, whenever that happens, and
  stays open to new joiners (resynced live, per 20260876) right up to the
  one fixed instant left: the Sunday 23:59 UTC cutoff.

`league-ladder-redesign-build-spec.md` carries the fuller, more current
account of what changed and when — check its Addendum section first for
anything cutoff- or roster-size-related.

## ⚠️ Carried-over open items

1. **Roster math — resolved.** The single relegated player who loses the
   buy-back auction doesn't disappear or get eliminated — they simply
   complete their relegation as normal: they land in the league below and
   get auto-charged that league's Entry Fee, exactly like any other
   relegated arrival. That losing player becomes a genuine new arrival in
   the league below, filling what would otherwise be its second,
   unfilled relegation vacancy — so the deficit closes itself out.
   Net result, per the design: each standard league loses 4 and gains 4
   per week — fully balanced. (Re-deriving this independently lands on
   3-out/3-in rather than 4-out/4-in — still balanced either way, so the
   headcount math holds regardless; worth nailing the exact event count
   when Phase 3's resolve job is actually written, since the code needs a
   precise number, not just "it balances.")
   **League 1** already balances on its own (2 out/2 in, no promotion
   outflow to complicate it) and now additionally receives this same
   fall-through mechanic from nowhere above it — i.e. nothing changes for
   League 1 here, it was already resolved.

## 1. Structure

- Infinite tier ladder, League 1 at the top, new leagues auto-created at the
  bottom as the player base grows.
- 8 players per league, round robin weekly (7 fixtures per player per week).
- New players entering the ecosystem always join at the bottom-most league.

## 2. Weekly Cycle

- **Tuesday 12:00 AM** — new week starts, rosters lock, all fixtures
  visible, bidding opens.
- **Tuesday–Sunday** — matches played in any order; early completion
  rewarded.
- **Sunday 10:00 PM** — hard cutoff: matches lock, standings finalize,
  bidding closes, and all fee charges settle together — Entry Fee for
  movers, Table Fee for stayers, both computed and deducted in this same
  "results day" event.
- **Monday** — buffer day: admin processing, dispute window, no active play
  or bidding.
- **Tuesday 12:00 AM** — new cycle begins.
- **Season length:** quarterly (~13 weekly cycles), matching the existing
  quarterly leaderboard reset.

## 3. Promotion & Relegation

**Standard leagues (all except League 1):**
- Rank 1 auto-promotes, Entry Fee for the new league charged automatically —
  no bid, nothing to refund.
- Bottom 2 relegate, and auto-pay the lower league's Entry Fee on arrival.
- The single extra/auction spot opened by relegation is won via bidding
  among the 7 non-promoted players from the league below **plus** the
  2 just-relegated players from this league — 9 candidates for 1 spot
  (confirmed: only 1 spot is awarded; see open item #1 — the second
  relegated player from that pool goes without a seat that week).

**League 1 (top league) — now aligned with standard leagues:**
- Full round robin still played weekly.
- Bottom 2 relegate, same as every other league (previously only 1 —
  that mismatch meant League 1 gained 2 arrivals but lost only 1 per
  week, a growing roster **surplus** rather than the deficit standard
  leagues have; relegating 2 fixes it to 2-out/2-in, matching everyone
  else).
- The single extra/auction spot is won the same way as standard leagues:
  bidding among the 7 non-promoted players from League 2 **plus** the 2
  just-relegated League 1 players — the special no-bid rule is removed,
  so League 1's own relegated players now get the same buy-back shot
  everyone else's do.
- The only thing still special about League 1: **no promotion event** —
  there's nowhere higher to go, so it never loses a player upward, only
  to relegation.

- **Tie-break:** highest points within that league's round robin wins.

## 4. Bidding System

- Eligible pool per league, including League 1: the 7 non-promoted
  players from the league below, plus the 2 just-relegated players from
  *this* league getting one shot to buy back in. (League 1 previously had
  a special no-bid exception here — removed; it now follows the same
  rule as every other league.)
- Bid only for the league directly above your own — no tier-skipping.
- Bids in Nets, shown live on a public bid ticker.
- Winning bid must be at or above that league's Entry Fee (the bid floor).
- Losing bidders refunded in full at the Sunday 10PM cutoff.
- Auto-promoted players never bid — nothing to refund there by construction.
- Tie-break: highest points in current league wins; no automatic protection
  for a relegated player.

## 5. Fees & Match Rewards

Currency: **Nets only** — no real-money option for any fee.

**Nets economy model (confirmed):** Nets are drawn from and returned to a
shared pool, not minted fresh per transaction — Match Rewards, Table Fee,
Entry Fee, and commission all flow through the same pool, making the
ladder a self-sustained economy rather than one that inflates Nets supply
over time.

Two distinct fees, and every player pays exactly one of them each week,
never both, never neither:

- **Entry Fee** — charged only on a league *transition*: auto-promotion,
  winning an auction bid, or being relegated into a new league. Still
  doubles as that league's bid floor. **League 8 (the bottom league) is
  free to enter — its Entry Fee is 0N**, added in Phase 6.
- **Table Fee** — charged to every player who stayed in the same league
  they were already in, calculated as **20% of that player's total Nets
  earned that week** (match rewards + early completion bonuses + streak
  bonuses + placement bonus, combined) — pay-as-you-earn, not a flat number.
  - Scales naturally by tier without a separate rate per league.
  - A player who earns nothing that week (didn't play) owes nothing — Decay
    Penalty already handles the inactivity case separately.
  - **Worked example (20%):**
    - League 1 player, ~175N full week → Table Fee ≈ **35N**, vs. an 80N
      Entry Fee for a mover — staying is meaningfully cheaper, as intended.
    - League 8 player, ~28N full week → Table Fee ≈ **5–6N**, vs. a free
      (0N) Entry Fee to move into League 8 — the only tier where moving is
      now cheaper than staying, a deliberate exception (Phase 6): the
      bottom league is meant to be a costless landing spot for anyone
      arriving there, not one more toll on the way in.
  - 20% restores the intended gap at both ends of the ladder (unlike 40%,
    which flipped the incentive at League 8 — see build-plan history if
    that number comes back up later).

| League | Entry Fee (movers) | Match Reward | Early Bonus |
|---|---|---|---|
| 8 (bottom) | Free (0N) | 4N | 1N |
| 7 | 18N | 6N | 1–2N |
| 6 | 29N | 8N | 2N |
| 5 | 36N | 10N | 2–3N |
| 4 | 48N | 13N | 3N |
| 3 | 58N | 16N | 4N |
| 2 | 67N | 20N | 5N |
| 1 (top) | 80N | 25N | 6N |

- Winning Bid Commission: WeAfrica takes a % cut (e.g. 10%) of each winning
  bid. League 8's bid floor is 0N per the free-entry change above — any
  positive bid clears it (bids must still be > 0, per §4).
- Match Fixture Fee (optional): small fee per match played.

## 6. Fixture Countdown System

- Each fixture carries its own 24-hour countdown to be played, staggered
  **evenly across the week** — resolved: release 1 fixture every ~19h40m
  (118 available release-hours ÷ 6 gaps between 7 fixtures), starting
  Tuesday 12:00 AM and ending Saturday 10:00 PM, so every fixture gets a
  full 24-hour window before the Sunday 10:00 PM hard cutoff:
  Tue 12:00 AM, Tue 7:40 PM, Wed 3:20 PM, Thu 11:00 AM, Fri 6:40 AM,
  Sat 2:20 AM, Sat 10:00 PM.
- All fixtures visible from Tuesday 12AM regardless of countdown status.
- **Missed fixture rule:** if a fixture's countdown expires unplayed, it's
  an automatic double-forfeit — both players get a 4-0 loss recorded,
  neither receives the match reward.

## 7. Excitement & Retention Mechanics

- Danger Zone, Live Bid Ticker, Placement Bonus, Transfer Window/Reroll,
  Streak Bonuses, & Wall of Fame — names carried over from v3; still no
  concrete definitions for these beyond the name itself (unlike the three
  below, which are now defined).
- **Second Life does not apply to the League Ladder.** That mechanic is
  specific to `ladderCup.js` (a 24h buy-back offer after a loss) and was
  wrongly assumed to carry over — confirmed it does not. Elimination in
  the League Ladder happens only via the roster mechanics already
  defined (relegation, losing the buy-back auction, Decay Penalty below)
  — there's no separate revival offer.
- **Decay Penalty (confirmed):** a player who doesn't play a single match
  that week is removed from the league and charged a 10% fee on their
  **total (all-time) Nets earned from the ladder** — not just that
  week's earnings, since a fully inactive week earns 0N and 10% of 0
  would be meaningless. Because it's percentage-based, it already scales
  naturally by tier exactly like Table Fee does — no separate per-tier
  rate needed, so the "should this scale at higher tiers" question is
  answered by the definition itself.
- **Elite Safety Zone (confirmed trigger):** a player qualifies when
  they're rank 1 in their league and leading 2nd place by 6+ points.
- **Checkpoint Safety (confirmed trigger):** a player qualifies when
  they're 6 points clear of the relegation zone (bottom 2).
- **Elite Safety Zone / Checkpoint Safety effect (confirmed): badge
  only, no real protection.** Qualifying doesn't block relegation or
  grant immunity — a leader who loses their 6-point cushion the
  following round simply stops showing the badge, same as any other
  standings change. Landed as `classifyLadderZones` (leagueLadder.js,
  pure/live-standings) — see that function's own header. This closes
  the "badge vs. real protection" question §8 raised; no SQL/economy
  changes needed since nothing about relegation or fees reads this
  status.
- **Ladder King crowning (confirmed):** whoever finishes rank 1 in
  League 1 that week is the Ladder King. If League 1's round robin ends
  in a tie for first, both tied players are crowned Ladder Kings for
  that week — no sustained-weeks requirement, it's decided week by week.

## 8. Open Items Still to Decide

- ~~What do Elite Safety Zone and Checkpoint Safety actually grant?~~
  **Resolved: badge only, no real protection** — see §7. Still worth a
  playtest once real weeks run to confirm badge-only doesn't dilute
  Danger Zone's tension (both statuses can be live in the same league
  at once, even though no single player can hold both).
- ~~Danger Zone, Live Bid Ticker, Placement Bonus, Transfer Window/
  Reroll, Streak Bonuses, Wall of Fame~~ **Resolved** — Danger Zone
  (bottom 2, badge only, same as above), Live Bid Ticker (UI added on
  top of the already-built Phase 5 backend), Streak Bonuses (+10% match
  reward on a 2nd+ consecutive win), and Wall of Fame (League 1's rank-1
  at Sunday 10PM) are all built — see 20260865_ladder_streaks_wall_of_fame.sql
  and leagueLadder.js/economy.js. Placement Bonus and Transfer
  Window/Reroll are confirmed DROPPED, not built.

The remaining v5/v6 open items (fixture countdown stagger direction,
Nets pool model, Ladder King threshold) are now decided — see §5–7.

Phase 7 is now fully closed except for its own last checklist item
(playtest zones+Danger Zone together once real weeks run — testing, not
code). Phase 9 (load test & rollout) has been skipped by decision, and
League 8 has been seeded in production — see those sections for
details.

---

# Full Build Plan

This is scoped against your actual repo: `formats/ladderCup.js` is the
closest existing analogue (a full standings/lifecycle module), `economy.js`
already has a `league` match type (fixed win/draw/loss, double round
robin) that this system will largely replace/extend, and `nets.js` is the
only file allowed to touch `nets_wallets` / `nets_transactions` via
`nets_credit`/`nets_debit`. Follow that separation throughout — don't add
new direct wallet writes.

Build in this order. Each phase should be shippable and testable on its
own — with fake/manual data if needed — before the next phase depends on
it. Don't start a phase's UI work until its data layer is solid.

---

### Phase 0 — Remaining open decisions (no code)

Everything that used to block schema decisions is now settled — Nets
minting model (shared pool), fixture countdown schedule, Ladder King
threshold, and Decay Penalty (defined, and its tier-scaling question is
answered by its own percentage-based design) are all resolved (see
§5–7). Nothing left to lock down before starting Phase 1, except the
deferred items below, which don't need an answer until Phase 7:

- [ ] What Elite Safety Zone and Checkpoint Safety actually grant once
      triggered (badge, immunity, bonus?) — triggers are defined, effects
      aren't.
- [ ] Definitions for Danger Zone, Live Bid Ticker, Placement Bonus,
      Transfer Window/Reroll, Streak Bonuses, Wall of Fame — still just
      names carried over from v3, no mechanics specified yet.

---

### Phase 1 — Data model

Tables (one migration per table, numbered after your latest —
`20260850_ladder_purge_auto_schedule.sql` — following the existing
`supabase/migrations/2026NNNN_description.sql` convention):

1. **`ladder_leagues`**
   `id, tier (int, unique, 1 = top), status (active/archived), created_at`
2. **`ladder_memberships`**
   `id, user_id, league_id, week_number, status (active/promoted/
   relegated/auction_won/eliminated), joined_at`
   — one row per player per league per week; this is your source of
   truth for "who's where."
3. **`ladder_fixtures`**
   `id, league_id, week_number, home_user_id, away_user_id, countdown_
   expires_at, status (pending/played/forfeited), home_score, away_score,
   played_at`
4. **`ladder_bids`**
   `id, bidder_user_id, target_league_id, week_number, amount, status
   (pending/won/refunded), placed_at`
5. **`ladder_wallet_events`** (optional if `nets_transactions` already
   carries enough metadata) — only add this if you need ladder-specific
   reporting `nets_transactions`' generic `reason`/`ref` fields can't
   cleanly express.
6. **`ladder_pool`** — since Nets are confirmed to be drawn from and
   returned to a shared pool rather than minted fresh, this table needs a
   running balance: every Table Fee, Entry Fee, and commission payment
   credits the pool; every Match Reward and refund debits it. Add a
   simple `balance` + `ladder_pool_transactions` audit trail from day
   one — retrofitting a closed-loop economy after the fact is much
   harder than building it in from the start.

Steps:
- [ ] Write and run migrations 1–4 above in a dev/staging Supabase
      project first, not production.
- [ ] Add RLS policies mirroring your existing pattern (one UPDATE
      policy per table, scoped to the row owner or an admin via the
      `admins` table) — same cleanup you already did for comments/
      fixtures.
- [ ] Seed `ladder_leagues` with just League 8 (tier = highest number,
      bottom of ladder) and manually insert 8 test users into
      `ladder_memberships` for week 1. Don't build auto-creation of new
      bottom leagues yet — that's Phase 3.

---

### Phase 2 — Core weekly cycle (no fees, no promotion, no bidding)

Goal: fixtures generate, matches get played, standings compute correctly.
Nothing moves between leagues and no Nets change hands yet.

- [ ] Create `src/formats/leagueLadder.js`, mirroring `ladderCup.js`'s
      shape (pure functions, no Supabase calls inside the logic
      functions themselves):
  - `generateRoundRobinFixtures(leagueId, weekNumber, playerIds)` — 7
    fixtures per player, no double-booking.
  - `computeStandings(fixtures)` — points table with the highest-points
    tie-break.
  - `isWeekComplete(fixtures)` — used later to gate the resolve job.
- [ ] Write unit tests for these three functions against fixed 8-player
      inputs before touching the database — round-robin generation bugs
      are much cheaper to catch here than in production.
- [ ] Build the weekly-cycle scheduler as a Supabase scheduled function
      (same cron mechanism as `20260850_ladder_purge_auto_schedule.sql`):
      Tuesday 12AM → generate fixtures + open bidding flag; Sunday 10PM →
      lock fixtures + close bidding flag (bidding/resolve logic itself
      comes in later phases — for now this job just flips status flags).
- [ ] Build minimal UI: a league standings table and fixture list on
      `LeagueDetail.jsx` (or a new `LadderDetail.jsx` if the shape
      diverges too much from existing leagues) — read-only standings,
      manual match-result entry reusing your existing result-submission
      flow.
- [ ] Manually run 2–3 fake weeks end-to-end with the seeded 8 test
      users and confirm standings and tie-breaks come out right before
      moving on.

---

### Phase 3 — Promotion & relegation engine

- [ ] Write `resolveLadderWeek(leagueId, weekNumber)` in
      `leagueLadder.js`: given final standings, returns
      `{ promoted: [userId], relegated: [userId, userId], stayed:
      [...] }` — pure function, easy to unit test against known
      standings.
  - Every league relegates 2, including League 1.
  - `promoted.length === 1` for every league except League 1, where it's
    `0` (no promotion event — nowhere higher to go).
- [ ] Write the actual "resolve week" Supabase function that runs at the
      Sunday 10PM cutoff: calls `resolveLadderWeek`, writes new
      `ladder_memberships` rows for next week (promoted → tier - 1,
      relegated → tier + 1, everyone else stays), and marks the
      relegated players' auction eligibility (see Phase 5).
- [ ] Auto-create a new bottom league: when the current bottom league's
      incoming class (existing stayers + arrivals) would exceed 8, split
      into a new `ladder_leagues` row and rebalance.
- [ ] Leave the single vacated auction slot empty for now (no bidding
      yet) — this phase only tests promotion/relegation counts in
      isolation, so a league will look like it's shrinking until Phase 5
      adds the fall-through-to-the-league-below mechanic that actually
      closes the gap. Don't mistake that for a bug at this stage.
- [ ] Test edge cases now, cheaply: what happens at League 1 (no
      promotion), what happens if a league has fewer than 8 active
      players going into resolve.

---

### Phase 4 — Fees (Entry Fee / Table Fee)

- [ ] Add to `economy.js` (pure functions, no Supabase, matching the
      file's existing style):
  - `LADDER_ENTRY_FEES` — the per-tier table from §5.
  - `computeTableFee(weeklyEarnings)` → `0.20 * weeklyEarnings`.
  - `computeLadderWeekFee(player, transitioned, weeklyEarnings, league)`
    → returns the Entry Fee if `transitioned`, else the Table Fee.
- [ ] Unit test against the worked examples in §5 (League 1 ≈35N, League
      8 ≈5–6N) so a future rate change is caught by a failing test, not
      by someone re-deriving the math by hand.
- [ ] Wire settlement into the same Sunday 10PM resolve job from Phase 3
      — for every player in that week's final memberships, compute their
      fee and call `nets_debit`/`nets_credit` via `nets.js`. Never charge
      per-match; Table Fee needs the week's total first.
- [ ] Add a `ladder_fee_events` row (or reuse `nets_transactions`'
      `reason`/`ref` fields) so every charge is traceable back to which
      week and which fee type produced it — needed for the Phase 8
      dashboard and for resolving player disputes.

---

### Phase 5 — Auction / bidding system

- [ ] `placeLadderBid(bidderId, targetLeagueId, weekNumber, amount)`:
      validate bidder eligibility (7 non-promoted from below, plus the 2
      relegated from the target league itself — this rule now applies
      uniformly, including League 1), validate
      `amount >= targetLeague.entryFee`, insert into `ladder_bids`.
      Reject invalid bids server-side, not just in the UI.
- [ ] Live bid ticker: Supabase Realtime channel on `ladder_bids` filtered
      by `target_league_id`, same subscription pattern you'd use
      elsewhere in the app for live updates.
- [ ] Settlement at Sunday 10PM (same resolve job): pick the single
      highest bid per league as the winner, mark `status = won`, charge
      that league's Entry Fee via `nets_debit`; refund every other bidder
      in full via `nets_credit`, `status = refunded`.
- [ ] Implement the fall-through mechanic: the relegated player who loses
      the buy-back auction isn't left in limbo — write their
      `ladder_memberships` row for next week as a normal arrival in the
      league below, and charge that league's Entry Fee via `nets_debit`
      same as any other relegated arrival. This is what actually closes
      the roster gap from Phase 3 — confirm the numbers balance once
      this lands, not before.
- [ ] Test: a relegated player who also wins their own league's buy-back
      bid, a league with zero bids (spot stays vacant — decide what that
      means for next week's roster count), a tie between two equal bids
      (apply the highest-points tie-break from §4).

---

### Phase 6 — Fixture countdown & forfeit automation

- [x] Add the 24h countdown field usage: implement the confirmed
      ~19h40m stagger from §6 (Tue 12AM through Sat 10PM releases),
      computed at fixture-generation time in Phase 2's
      `generateRoundRobinFixtures`.
- [x] Scheduled sweep job (hourly is probably enough resolution) that
      finds fixtures where `countdown_expires_at < now()` and
      `status = pending`, marks both sides as a 4-0 double-forfeit, and
      skips the match reward — mirror whatever forfeit/walkover pattern
      already exists in your ladder cup migrations rather than inventing
      a new one.
- [x] Surface forfeits clearly in the UI (distinct from a played 4-0) so
      players and admins can tell the difference at a glance.
- [x] League 8 (bottom league) made free to enter — Entry Fee 0N, in
      `economy.js` and mirrored in `_ladder_entry_fee_for_tier`. Rode
      along with this phase since it touches the same fee/settlement
      code paths; see §5 for the updated table and the note on why
      `_ladder_settle_week_fees_internal` and `_ladder_fall_through_internal`
      both needed a zero-fee guard to not hard-fail on it.

---

### Phase 7 — Excitement & retention mechanics

- [x] Build Decay Penalty fresh (it's now fully defined, not a port):
      at the Sunday 10PM resolve job, any player with zero matches
      played that week gets removed from `ladder_memberships` and
      charged 10% of their **all-time cumulative** Nets earned in the
      ladder (not that week's — a fully inactive week earns 0). Landed
      as `computeDecayPenalty` (economy.js, pure/unit-tested) +
      `_ladder_apply_decay_penalty_internal` (SQL, wired into
      `_ladder_close_week_internal` last, after fall-through) in
      `20260863_ladder_decay_penalty.sql`. SCOPE NOTE: restricted to
      players whose week resolved as a stayer (`status = 'active'`) —
      see that migration's own header for why applying it to a
      promoted/relegated/fell-through player as well is left for a
      later migration, once that interaction is actually specified.
- [x] Do NOT port Second Life — confirmed it doesn't apply to the League
      Ladder. Elimination here only ever happens via relegation, a lost
      buy-back auction, or Decay Penalty. Nothing to build here — the
      absence of a Second Life migration IS this item, done.
- [x] Elite Safety Zone / Checkpoint Safety: confirmed badge-only, no
      real protection — a leader who loses their 6+ point cushion the
      following round just stops showing the badge. Landed as
      `classifyLadderZones` (leagueLadder.js), rendered in
      LeagueLadderDetail.jsx. Nothing reads this status for
      relegation/fees, so no SQL was needed.
- [x] Danger Zone (bottom 2, same badge-only treatment), Live Bid
      Ticker (UI on top of the already-built Phase 5 backend), Streak
      Bonuses (+10% of the tier's match reward from the 2nd consecutive
      win onward), and Wall of Fame (League 1's rank-1 player at Sunday
      10PM) — all built in `20260865_ladder_streaks_wall_of_fame.sql` +
      leagueLadder.js/economy.js/LeagueLadderDetail.jsx. Placement
      Bonus and Transfer Window/Reroll: confirmed DROPPED, not built —
      see economy.js's own note.
- [ ] Once Elite Safety Zone and Checkpoint Safety are fully specified,
      playtest with both active together and check whether Danger Zone
      still feels meaningful — the original three-way stacking concern
      is now a two-way one since Second Life is confirmed out of scope,
      but the same risk (safety nets diluting the threat of relegation)
      still applies to these two.
      it's fine.

---

### Phase 8 — Admin tooling & observability

- [x] Admin panel RPCs for the Monday dispute window: override a fixture
      result (`admin_override_ladder_fixture_result`, works on a fixture
      in any status, unlike the participant-facing
      `submit_ladder_fixture_result`), manually re-trigger a week's
      resolve job (`admin_retrigger_ladder_resolve`), cancel/adjust a bid
      (`admin_cancel_ladder_bid`, refunds escrow in full) — all in
      `20260864_ladder_admin_tools.sql`, all gated on the existing
      `admins` table check pattern. **Not included:** the actual admin
      panel UI (buttons/rows wired to these RPCs) — these are the
      callable functions a panel would sit on top of, not the panel
      itself.
- [x] Confirmed: every ladder Nets movement (match reward, entry fee,
      table fee, bid escrow/refund, decay penalty, admin
      overrides/cancellations above) already goes through
      `_nets_credit_internal`/`_nets_debit_internal`, which write to
      `nets_transactions` with `reason`/`ref_type`/`ref_id` populated —
      no parallel logging table needed, matching this item's own
      "unless turned out to be necessary" bar.
- [x] Build the roster-balance dashboard: `ladder_roster_balance` view
      in `20260864_ladder_admin_tools.sql` — week-over-week roster count
      and net change per league. With the fall-through mechanic from
      Phase 5 in place, every league should now settle at net zero —
      query this view against production to confirm that once real
      weekly cycles are running, rather than assuming the math holds.

---

### Phase 9 — Load test & rollout — **SKIPPED (by decision)**

Deliberately not started, and now skipped rather than pursued. This
phase was entirely about testing against real/synthetic play before
rollout (code-only, no testing/seeding was ever in scope for this
pass). The items below are left here for reference only — none are
planned:

- [ ] ~~Simulate a full 13-week season against synthetic players/results
      before touching real users — specifically exercise: a league
      dropping below 8 active players, a league with zero bids, and a
      relegated player winning their own buy-back bid (including at
      League 1, which now follows the same rules as every other league).~~
- [ ] ~~Roll out to a single bottom-tier league first (either League 8 or
      a fresh standalone tier) rather than switching the whole existing
      player base over at once — this isolates a resolve-job bug to one
      league instead of cascading through the ladder.~~
- [ ] ~~Only after a few clean weekly cycles on that pilot league, migrate
      the rest of the player base in and retire whatever the old league
      format (`economy.js`'s current `league` match type) was serving.~~

**Live as of 20260866:** League 8 is seeded in production
(`20260866_ladder_go_live_seed_league_8.sql`) and the ladder is open
for real users to join — none of the three items above were done
first. The known-untested paths they would have caught (a league
dropping below 8 active players, a zero-bid week, a relegated player
winning their own buy-back bid) are now live risks against real Nets
balances rather than pre-launch checks, and the whole existing player
base is exposed at once rather than a contained pilot league. Watch
the first Tuesday/Sunday cron cycles and `ladder_roster_balance`
(Phase 8) closely.

