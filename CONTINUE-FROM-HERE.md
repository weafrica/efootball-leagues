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
1. **Tier 18 reset mechanism, unsolved.** Two fixtures (`c600b38e`,
   `edf9bf76`) were found reset from paid/played back to blank pending
   sometime Sept 6 ~22:15–23:59, despite `_generate_round_robin_fixtures_internal`
   explicitly guarding against touching any fixture with a
   `ladder_reward_ledger` row. Symptom fixed (both now correctly show
   `played`, 3-3, matching their original approved submissions; no
   double-payment — `ladder_reward_ledger` still has exactly the original
   4 rows). Root cause of the reset itself is still unknown; looks like a
   manual `UPDATE` outside the normal fixture-regen path. `query_logs` only
   covers a rolling 24h window and that window has now passed — Postgres
   logs for that moment are likely gone, but worth a targeted check if this
   recurs.
2. **The safety-net backfill block in `_ladder_resolve_promotion_relegation_internal`
   needs a design decision, not just documentation.** It's real, it's
   live, and it's now captured in migration `20260932` — but nobody has
   confirmed on purpose that it's inconsistent by design: the single
   guaranteed promotion per league has NO affordability check anymore,
   but the *extra* safety-net promotions (covering tier 1's structural
   one-seat-per-week loss) are still affordability-gated. Worth asking
   whether that's intentional or itself needs the same treatment as the
   fee-removal decision already covered.

## Verified live and matching the repo as of this session
- `_ladder_fall_through_internal` — no affordability check, no entry fee
  either direction on relegation fall-through (migration `20260931`).
- `_ladder_resolve_promotion_relegation_internal` — no affordability check
  on the single guaranteed promotion; safety-net backfill block present
  (migration `20260932`).
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
