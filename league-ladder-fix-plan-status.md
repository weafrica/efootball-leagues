# League Ladder — Fix Plan Status (detailed)

_Matchday / efootball-leagues-repo — weafrica.co.za_
_Updated 2026-09-07. Items 1–13 and Housekeeping are carried forward from the
prior doc (that doc claimed "nothing left" — it was wrong; see 14–16 below,
found this session by diffing live `pg_get_functiondef` against the repo,
not by trusting the prior doc's claim)._

---

## 1–13, Housekeeping — see git history for full detail

Prior status: audit vs. live, auction-winner labeling, history cleanup,
week-1 reclosing, affordability fix (superseded — see 14), roster cap
recheck, "asked to join again," Wall of Fame, zero-amount bid fix,
relegation teleport fix, Sunday auto-close fix, redesign build spec
(7 phases), week1→week2 placement audit, and empty-shell/tier-13 cleanup.
All previously marked done; nothing in this session contradicted any of
those specific items — the contradiction was the doc's closing claim that
*nothing else* was outstanding.

---

## 14. Entry-fee affordability rule removed from relegation — ✅ Done, live, now in repo

**Decision this session:** relegated players finish bottom of their
league — there's no match-reward money to draw an Entry Fee from — so the
affordability check added in item 5 / `20260870` was reworked to remove
the fee entirely rather than just skip unaffordable players.

- `_ladder_fall_through_internal`: no balance check, no fee, unconditional
  move to the tier below. Migration `20260931`.
- `_ladder_resolve_promotion_relegation_internal`: the single guaranteed
  promotion per league is no longer affordability-gated either. Migration
  `20260932`.
- Historical repair: 16 players who'd gotten stuck in their pre-relegation
  league under the old affordability rule were moved into their correct
  tier-below league for week 3, with fixtures regenerated to include them.
  Confirmed nothing had been played yet anywhere at the time, so this was
  safe.

**Open question, not yet decided:** `20260932`'s safety-net backfill block
(see item 15) still runs its *own* affordability check on the extra
promotions it grants — inconsistent with the guaranteed-promotion path
right above it in the same function. Needs an explicit decision on
whether that's intentional.

---

## 15. Undocumented safety-net backfill — found live, not deployed by this session, now in repo

Not something this session added — found already running live in
`_ladder_resolve_promotion_relegation_internal`, with no matching doc,
migration comment, or session note anywhere. Backfills a destination
tier's shortfall (beyond its one guaranteed promotion) from the *source*
league's own next-best non-relegated finishers, capped by how many extra
seats the destination actually needs after accounting for pending paid
bids. Exists almost entirely to cover tier 1's structural one-seat-per-week
loss (tier 1 has no tier above it to relegate players in from). Written up
and captured verbatim in migration `20260932` so it stops being
invisible — see that file's header for the full mechanism.

**Status: documented, not evaluated.** Nobody has confirmed the
affordability-check asymmetry against the rest of item 14 is intentional.

---

## 16. Tier 17/18 leg-2 gap and tier 18 payout reconciliation — ✅ Done

**Root cause:** `_generate_round_robin_fixtures_internal`'s duplicate-pairing
check didn't scope by `leg`. A league whose week-3 schedule was generated
across two separate calls (leg 1, then later leg 2) had the second call
silently no-op on every leg-2 insert because it saw leg 1's row as a
"duplicate." Leagues generated in one uninterrupted call were unaffected.
Found by checking leg1/leg2 fixture counts ladder-wide: tier 17 was 15/0,
tier 18 was 20/2.

- **Function fixed live and in repo:** duplicate check now also matches on
  `leg`. Migration `20260933`. Sits on the real weekly cron path, so this
  protects the natural Sunday cutover going forward, not just this
  session's manual repairs.
- **Tier 17:** backfilled the missing leg 2 (mirrored each leg-1 fixture,
  home/away swapped, onto the same 5 round-times tier 1 used). Verified
  clean 15/15.
- **Tier 18:** two fixtures (`c600b38e`, `edf9bf76`) had been played and
  paid out (reward-ledger rows exist) but showed as blank/pending —
  unrelated to the leg-scoping bug, and confirmed NOT caused by the normal
  fixture-regen path (`_generate_round_robin_fixtures_internal` explicitly
  refuses to delete any `pending` fixture that has a `ladder_reward_ledger`
  row against it). Fixed both rows to `status = 'played'`, `3-3`,
  `played_at = 2026-09-06 22:15:00`, matching each fixture's own approved
  result submission. No reward re-credited — confirmed the update doesn't
  re-trigger `_credit_ladder_match_reward_internal`, and `ladder_reward_ledger`
  still shows exactly the original 4 rows. Ran the now-fixed generator for
  tier 18's 7 members: correctly skipped the 3 real matches and filled in
  the rest. Tier 18 is now a clean 42/42 (21 per leg, 7 players).
- **Still unknown:** what actually reset those two fixtures from
  played/paid back to blank after the fact. Looks like a manual `UPDATE`
  outside the guarded regen path — see `CONTINUE-FROM-HERE.md` item 1.
- Confirmed ladder-wide, post-fix: no other tier besides 17 and 18 had the
  leg1-only gap.

---

## What's actually left

See `CONTINUE-FROM-HERE.md` — two open items: the tier-18 reset mechanism
(unknown root cause, likely unrecoverable via logs now), and the
safety-net backfill's affordability-check asymmetry (needs a decision,
not a fix).

---

## Gotchas learned (don't repeat these)

- **Double round-robin:** every pairing legitimately gets 2 fixtures (leg
  1 home, leg 2 away). Scope any duplicate check by `leg` too.
- **Forfeited fixtures still count as "played."** Don't assume no-shows
  sort to the bottom on that basis alone. Some forfeited fixtures carry
  real (non-null) scores if an admin entered a result despite the forfeit
  status.
- **Bid winners always override the normal relegation/backfill path.**
  Check `ladder_bids` for a `won` bid targeting a league before treating
  it as short and backfilling by points.
- **Don't disturb an already-played, already-paid match** when correcting
  a placement — redirect the go-forward schedule only, keep history intact.
- **Tier numbers and league IDs are not stable landmarks across
  sessions.** Re-query live for what's actually in a tier now.
- **A migration applied live via `Supabase:apply_migration` does not
  exist in this repo until someone writes the matching `.sql` file.**
  This session found three separate live changes (two known, one
  completely undocumented) that had drifted this way. Write the file in
  the same session as the live change, every time.
- **A status doc's "nothing left" claim is not evidence.** This exact doc
  said that at the top of this session and was wrong on two counts.
  `pg_get_functiondef` / a live query is the only source of truth.
