# Continue-from-here notes
_Rewritten 2026-09-07, after the session that reconciled tier 18's two
paid-but-blank fixtures, fixed the leg-scoping bug, and wrote three
previously-live-only changes back to the repo as migrations 20260931–20260933.
Independently verified against live `pg_get_functiondef` this session — not
just carried forward from the prior doc._

## Project facts
- Repo: `efootball-leagues-repo` (weafrica.co.za)
- Live Supabase project: `weafrica Leagues`, project ref `jobgzxljuczzqljwavyq`
- No CI/CD — migrations are applied manually. **Always check live vs. repo
  before trusting a file, including this one.** `pg_get_functiondef` on the
  live project is the source of truth, not any doc.

## What's actually left
1. **Tier 18 "reset" — actually solved, and it needs a human decision, not
   a fix.** Not a bug. Admin account "WeAfrica" called
   `cancel_ladder_fixture_result` on both fixtures at 2026-09-07 05:22–05:24
   UTC (logged in `ladder_fixture_cancellations`, `cancelled_by` resolves to
   an admin). That function is documented to intentionally leave already-paid
   rewards untouched when cancelling a result — so the "corruption" was a
   deliberate admin cancellation, working exactly as designed.
   **The problem: an earlier session (06:04–06:38 UTC the same morning,
   before this note) didn't know that, treated it as an anomaly, and
   manually re-marked both fixtures `played`/3-3 again — silently reversing
   the admin's cancellation.** Nobody has asked WeAfrica why those two
   results were cancelled. Find out before deciding whether to leave the
   reinstated 3-3 results in place or cancel them again.
2. **Safety-net backfill (migration `20260932`) — not actually
   inconsistent, that was my own mistake last time.** Re-verified live: the
   guaranteed promotion still has its affordability check, same as the
   extra safety-net promotions — no asymmetry. What IS worth a sign-off:
   the extra promotions can now pull a player up from a source league that
   isn't the one directly below the shortfall, which is new territory
   nobody explicitly approved.

## Verified live and matching the repo as of this session
- `_ladder_fall_through_internal` — no affordability check, no entry fee
  either direction on relegation fall-through (migration `20260931`).
- `_ladder_resolve_promotion_relegation_internal` — promotion's
  affordability check is UNCHANGED from `20260870`/repo (only relegation
  had it removed); safety-net backfill block present, also
  affordability-gated (migration `20260932`).
- `_generate_round_robin_fixtures_internal` — duplicate-pairing check
  scoped by `leg` (migration `20260933`). Sits on the real weekly cron
  path (`ladder-close-week-sunday` → `_ladder_close_week_internal` →
  `_ladder_open_week_internal` → `_ladder_sync_fixtures_internal` → this
  function) — protects the natural Sunday cutover, not just manual repairs.
- Every league (tiers 1–19) has a schedule with matched leg1/leg2 counts
  for week 3 — no other tier besides the already-fixed 17 and 18 had the
  leg1-only gap.
- Tier counts at week 3 (verified live, will drift as the week plays out):
  tiers 1, 3, 4, 7–12, 14, 16, 18, 19 at 6 (or 7 for 18, one over the usual
  cap — deliberate, see below); tiers 2, 5, 6, 13 short-handed, which
  reflects normal week-to-week churn, not a bug.
- Tier 18 sits at 7 (one over the usual 6 cap) — intentionally not pushed
  down further, since that cascade would land on the same reward-ledger
  tangle described in item 1 above. Revisit once item 1 is actually
  resolved, not before.

## Gotchas learned across these sessions (don't repeat these)
- This is a **double round-robin**: every pairing legitimately gets 2
  fixtures (leg 1 home, leg 2 away). Scope any duplicate check by `leg`
  too, or you'll drown in false positives across every league.
- Tier numbers and league IDs are not stable landmarks across sessions —
  leagues get consolidated, drained, and recreated. Re-query live for
  what's actually in a tier now; don't assume an older status doc's tier
  layout still holds.
- **Docs drift from live fast, in both directions**, and now provably by
  more than "a migration wasn't written down" — this session found a
  whole undocumented backfill code block live that no doc, migration, or
  prior session summary mentioned at all. Treat any doc (including this
  one) as a starting hypothesis, not a source of truth. `pg_get_functiondef`
  / a live query is the only source of truth.
- `Supabase:apply_migration` records a migration in the *live project's*
  own migration history — it does **not** write anything back to this repo
  folder. Any live change made that way needs a matching `.sql` file
  committed here in the same session, or it becomes exactly this kind of
  drift again.
- When adding new bidding logic, remember all four wallet/pool helper
  functions (`_nets_debit_internal`, `_nets_credit_internal`,
  `_ladder_pool_credit`, `_ladder_pool_debit`) reject non-positive amounts
  outright — any code path that might legitimately involve a `0` amount
  needs to skip those calls explicitly.
- For live-DB sanity checks without touching real data: `set local
  request.jwt.claim.sub = '<uuid>'` inside a query lets you exercise
  `auth.uid()`-gated functions as a specific user; wrap the actual test in
  a small plpgsql probe that catches exceptions and returns `sqlerrm`.
