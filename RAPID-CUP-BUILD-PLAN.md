# Rapid Cup — Full Build Plan

Quick 4-player knockout tournament. Fills fast, auto-starts, auto-finishes, epic and fun.

---

## 1. Lobby & Auto-Start

- Lobby holds 4 slots, live "X/4 joined" counter.
- 1hr countdown from lobby creation.
- Notifications at 15 min, 5 min, 1 min remaining.
- Not filled in 1hr → auto-reset, kicks everyone, notifies "Lobby reset — join again!"
- A fresh lobby auto-opens immediately after any reset.
- 4th player joins → fixtures auto-generate instantly (reuse Knockout bracket logic from League Ladder — see Section 5 for exceptions).
- All 4 players auto-redirected into the tournament page.
- Once full: shows **"Open"** to those 4 players, **"Join"** to everyone else.
- A new lobby auto-generates the moment the previous one fills — never a dead moment.

## 2. Auto-Finish

- League auto-completes 4 hours after fixtures generate, regardless of match state.
- See Section 4d for what happens if the bracket isn't finished by then.

## 3. Entry Fee Engine

- Fee slider: **0–400 Nets**.
- Players set their fee when joining. **Increase-only** — can raise again before their own next match, never mid-match.
- Live display on the tournament page: all 4 players' fees + expected payout, updating live as fees change.
- `max_stake` = the highest fee among the 4 players. Used as the 100% baseline for the bonus-pool proportion (Section 4).

## 4. Payout Calculation

### 4a. Core formula (guaranteed stake-back)

```
base_return     = winner_stake                          ← guaranteed, no fee taken
remaining_pool  = total_pool − winner_stake
bonus_share     = winner_stake ÷ max_stake               ← "highest fee = 100%" rule, applied to the bonus only
bonus           = remaining_pool × bonus_share

organizer_keep  = bonus × 10%
winner_bonus    = bonus × 90%                             (includes the 5% winner-redirect from the 15% headline fee)

winner_net_total = base_return + winner_bonus
leftover         = remaining_pool − bonus                 ← refunded to losers, by stake ratio
```

- The winner's own stake is never taxed or put at risk — only the bonus drawn from the rest of the pool is subject to the organizer fee.
- Leftover (when the winner wasn't the top stake) is refunded to the 3 losers, split proportional to their own stakes.
- All payout math computed **server-side** (RPC), never trusted from the client.

### 4b. Worked example
Stakes: P1=1, P2=397 (max_stake), P3=1, P4=1 → pool=400.

- **P1 wins:** base_return=1, remaining_pool=399, bonus_share=1/397≈0.25%, bonus≈1.0 → organizer_keep≈0.1, winner_bonus≈0.9 → **P1 net ≈ 1.9** (always ≥ their own stake — the earlier "winner loses money" bug is fixed).
- **P2 wins:** base_return=397, remaining_pool=3, bonus_share=100%, bonus=3 → winner_bonus=2.7 → **P2 net = 399.7**.

### 4c. Investor payout & refunds
- Investor's principal (their invested amount) is **guaranteed back** in every outcome — win, loss, or leftover refund.
- **Profit only** (the bonus portion, win case only) splits 80/20: investors get 80% of the invested share of the bonus, player gets 20% (Section 7 has the full formula).
- Straight refunds (leftover / loss case) carry no profit — investor just gets their principal back, no 80/20 split applied to a refund.

### 4d. Unfinished bracket at 4hr auto-finish
Resolved in this order:
1. **Most matches won** → declared winner, takes full payout under 4a.
2. **Still tied** → **most goals scored across all played matches** → declared winner, takes full payout under 4a.
3. **Still tied** (goals equal too) → pool **splits evenly** among the tied players (each treated as guaranteed-stake-back, remaining split evenly as bonus).
4. **No one played a single match** → pool **fully refunded** to everyone — players and investors alike — exactly what they put in, no fees taken, no winner declared.

## 5. Fixtures — Ported from League Ladder

Copy **all** League Ladder fixture features, **except** the SAST/timezone-specific cutoff logic (that logic is specific to the weekly ladder cycle and doesn't apply to a 4hr blitz format). Everything else ports as-is:

- Bracket/round generation (`knockoutRoundFixtures`, `knockoutBracketFixtures`, `knockoutBracketWinners`)
- Bracket display component (`KnockoutFixturesList`)
- Standings/ranking computation logic where applicable to bracket progression
- Legs/rounds structure
- **Excluded:** any SAST wall-clock cutoff/scheduling helper (e.g. `nextSastHourBoundary`, `weekendWindow`-style timing) — Rapid Cup uses its own 1hr lobby timer + 4hr auto-finish timer instead, not day-of-week/timezone cutoffs.

## 6. Results — Full League Ladder Pipeline, New Timers

Direct port of the entire League Ladder result system:

- Score submission with photo proof upload
- Opponent confirm / dispute flow
- Admin approve / reject / correction flow
- Post-approval result correction requests
- Walkover claims
- Cancel/withdraw submission before opponent responds
- Auto-verified screenshot check (where present in the source system)
- Same submission UI/components — ported directly, not rebuilt

**Timers (Rapid Cup-specific):**
- Opponent confirm/dispute window: **2 minutes**
- Admin approve/reject window: **2 minutes**
- No response in either window → auto-accept / auto-approve

## 7. Spectator Investment

- "Invest" button on each player's card (spectators only, not the 4 competing players).
- Investment adds to that player's total stake: `total_stake = own_fee + all_investments`.
- Total stake counts toward `max_stake` and the bonus-share calculation (Section 4).
- Live investor list per player: name, amount invested, expected return.

### Investor split (win case — profit only)
```
self_share     = winner_bonus × (own_fee ÷ total_stake)
invested_share = winner_bonus × (invested_total ÷ total_stake)

investors_get  = invested_share × 80%   (split between multiple investors by their own investment size)
player_gets    = invested_share × 20%   (on top of self_share, and on top of base_return)
```

### Investor refunds (loss / leftover / tied / no-match cases)
- Investor gets their **principal back in full**, proportional to what they put in — no 80/20 skim, since there's no profit to split.

## 8. Prize Collection

- **Winbox** — tap-to-collect after each individual match win (flat/small reward).
- **Cup box** — tap-to-collect after the league win, pays `winner_net_total` (or the self/investor split breakdown if investors are involved). Pack-opening style reveal animation on open.

## 9. History & Archive

- On league finish (or full-refund case), auto-insert into the history/archive (same pattern as `CompletedLeaguesPage`): winner (or "no winner — refunded"), all 4 participants, fees, pool size, date.
- Archived league page links back to the original league (read-only once done).

## 10. Comments

- Direct port of the League Ladder comments component onto the Rapid Cup league page.
- Same posting/delete/timer-armed-delete behavior as the existing system.

## 11. Help Button → WhatsApp

- Reuse existing `WhatsAppLink` / `buildWaLink` helper.
- Prefilled message template includes: league type ("Rapid Cup"), the player's name, and a direct link to that league.
- Opens straight into admin's WhatsApp chat with the message pre-typed.

## 12. Home Integration

- Horizontal banner, positioned under Quick Actions.
- States: `"X/4 joined — timer"` / `"Live now"` / `"Join next lobby"`.
- Tapping the banner joins the current open lobby, or jumps straight into a live bracket the viewer is already part of.

## 13. Epic Extras (polish pass, build last)

- Pack-opening reveal animation on the Cup box.
- "Underdog" tag for the lowest-stake player in a bracket.
- "All-In" badge when a player sets their fee to the 400 Nets max.
- Countdown drumroll sound in the last 10 seconds of the lobby timer.
- Sudden-death Final — no draws allowed.
- Post-match MVP shareable card (auto-generated).
- Hall of Fame leaderboard — all-time top Rapid Cup earners (v2/optional).

---

## Suggested Build Order

1. **Phase 1** — Lobby, countdown, reset, auto-chaining to next lobby (core loop must work first).
2. **Phase 2** — Fee slider + live fee/payout display + `max_stake` logic.
3. **Phase 3** — Payout calculation (guaranteed stake-back formula), server-side RPC.
4. **Phase 4** — Fixtures (ported, minus timezone logic) + 4hr auto-finish + tiebreaker rules.
5. **Phase 5** — Results pipeline (ported) with 2min/2min timers + comments.
6. **Phase 6** — Winbox / Cup box collection UI.
7. **Phase 7** — History archive + Help button (WhatsApp) + Home banner.
8. **Phase 8** — Spectator investment (adds complexity — build once core is stable).
9. **Phase 9** — Epic extras polish pass.

---

## Build Status

- ✅ **Phase 1 — shipped** (`supabase/migrations/20260903090000_rapid_cup_lobby_phase1.sql`, `src/RapidCupBanner.jsx`)
  - Lobby tables, `join_rapid_cup_lobby()` RPC, `expire_rapid_cup_lobbies()` cron RPC
  - Home banner: live count, countdown, 15/5/1 min toasts, join flow, auto-chain to next lobby
  - **Open item:** flipping a full lobby from `filling` → `live` (generating the actual bracket, setting `league_id`) needs the real `leagues`/`fixtures` table column names — not found in a tracked migration. Blocked on that schema before this can be wired end-to-end.
- ⬜ Phase 2 — not started
- ⬜ Phase 3 — not started
- ⬜ Phase 4 — not started
- ⬜ Phase 5 — not started
- ⬜ Phase 6 — not started
- ⬜ Phase 7 — not started
- ⬜ Phase 8 — not started
- ⬜ Phase 9 — not started
