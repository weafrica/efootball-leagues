# Migration version-collision fixes — 2026-09-09

## Root cause

The Supabase CLI extracts a migration's tracking "version" from the leading
digit run before the **first underscore** in its filename
(`^([0-9]+)_(.*)\.sql$`, `apps/cli-go/pkg/migration/file.go`), and inserts
one row per applied file into `supabase_migrations.schema_migrations` keyed
on that version. Execution order is separately just the plain lexicographic
sort of filenames (`fs.ReadDir`, used as-is in `ListLocalMigrations`).

Two files sharing the same plain 8-digit date prefix (e.g. `20260811_a.sql`
and `20260811_b.sql`) both extract to the same version, so the second file's
insert hits `duplicate key value violates unique constraint
"schema_migrations_pkey"` — exactly the `db-tests` CI failure. This existed
in **14 date groups** (19 files, one group of 6), independent of any content
bug, and had never been exercised because production's tracked history only
starts at `20260831103224`.

**Verified against the actual CLI source** (`supabase/cli`, fetched
2026-09-09), not assumed: a filename that extends the *same* leading date
with more digits before its underscore always sorts **before** the plain
dated file (digit `0`-`9` < `_` in ASCII) — the extension trick only works
for reordering *within* a day, never for "run after the plain file of this
same day." Where a file needed to run after same-day content, it was moved
to the **next day's** slot instead.

## Renames (13 no-dependency groups + 1 real-dependency group)

| Old name | New name | Why |
|---|---|---|
| `20260811_ladder_cup_start.sql` | `20260811000001_...` | No dependency on `ladder_cup.sql`; version-only fix. |
| `20260811_ladder_cup_second_life_offers_baseline.sql` | `20260812000001_...` | References `ladder_cup_entries`/`ladder_cup_matches`, created by `20260811_ladder_cup.sql` — must run after it, so pushed to the next day rather than extended same-day. |
| `20260814_user_activity_log.sql` | `20260814000001_...` | No dependency; version-only fix. |
| `20260815_ladder_cup_match_rpc.sql` | `20260815000001_...` | No dependency; version-only fix. |
| `20260820_ladder_cup_match_admin_rpc.sql` | `20260820000001_...` | No dependency; version-only fix. |
| `20260823_transfer_market.sql` | `20260823000001_...` | No dependency; version-only fix. |
| `20260866_ladder_week_monday_start.sql` | `20260866000001_...` | No dependency; version-only fix. |
| `20260900_ladder_league_join_week_guard_fix.sql` | `20260900000001_...` | No dependency; version-only fix. |
| `20260901_ladder_origin_league_resync_after_split.sql` | `20260901000001_...` | No dependency; version-only fix. |
| `20260902_ladder_pool_ring_fence_escrow.sql` | `20260902000001_...` | No dependency; version-only fix. |
| `20260904_ladder_correct_forfeited_fixture.sql` | `20260904000001_...` | No dependency; version-only fix. |
| `20260904_ladder_cup_opponent_slot_purchase.sql` | `20260904000002_...` | No dependency; version-only fix. |
| `20260904_rapid_cup_spectator_investment.sql` | `20260904000003_...` | Creates `_rapid_cup_split_recipient_internal` / `_rapid_cup_player_stakes_internal`. |
| `20260904_rapid_cup_investment_secure_grants.sql` | `20260904000004_...` | Revokes on the two functions above — **must run after** `rapid_cup_spectator_investment`. Previously it sorted *before* it ("investment" < "spectator") and would have failed on missing functions even without the PK bug. |
| `20260905_rapid_cup_hall_of_fame.sql` | `20260905000001_...` | No dependency; version-only fix. |
| `20260906_rapid_cup_push_subscriptions.sql` | `20260906000001_...` | No dependency; version-only fix. |
| `20260908_ladder_fix_silent_seat_conflict_self_heal.sql` | `20260908000001_...` | No dependency; version-only fix. |
| `20260821_ladder_cup_second_life_history.sql` | `20260934_ladder_cup_second_life_history.sql` | Content is a one-off `DELETE FROM ladder_leagues WHERE id IN (...)` cleaning up leftover tier shells, per its own comment "clutter from a **pre-20260919** overflow-cascade bug." `ladder_leagues` isn't created until `20260851_ladder_leagues.sql`, and the fix it depends on lands at `20260920`+. Moved to the end of the current sequence (after `20260933`, the last existing file) so it runs after everything it references. The delete is idempotent by hardcoded UUID (no-op if already removed), so this reorder is safe — but **please confirm those 4 tier rows are still the ones you want removed** before this runs for real; I did not verify that against live data. |
| `20260904_lock_down_all_open_internal_functions.sql` | `20260925000001_lock_down_all_open_internal_functions.sql` | Revokes on 39 functions; one of them, `_credit_ladder_battle_draw_reward`, isn't created until `20260924_ladder_cup_draws.sql` — 20 versions after the file's original date. Moved to run immediately after `20260924`. **This alone does not make the file safe to run — see Known blocking issue below.** |

`20260821_ladder_cup_walkover_claim_direct.sql` was left at its original
version — its former collision partner (`_second_life_history.sql`) moved
elsewhere, so the pair no longer collides and this file has no dependency
issue of its own.

## Verified fix

Simulated the CLI's own version-extraction regex and insert order against
all 172 conforming migration filenames in a real local Postgres
`schema_migrations` table: **0 primary-key collisions**, in filename order,
matching how `db start`/`db reset` actually apply migrations.

## Known blocking issue — needs your call, not fixed here

`20260925000001_lock_down_all_open_internal_functions.sql` (formerly
`20260904_lock_down_all_open_internal_functions.sql`) contains:

```sql
revoke all on function _ladder_settle_queued_reward_payouts_internal() from public, anon, authenticated;
```

**`_ladder_settle_queued_reward_payouts_internal` is not created anywhere
in the migration history** — I searched every `.sql` file in
`supabase/migrations/`; this revoke is the only place the name appears.
Moving the file's date doesn't fix this — it will fail with `function
_ladder_settle_queued_reward_payouts_internal() does not exist` wherever it
runs. I didn't find an obviously-intended target (closest names are
`_ladder_settle_bids_internal` and `_ladder_settle_week_fees_internal`,
already revoked elsewhere in the same file, so it's not simply a duplicate).
I didn't want to guess and silently drop or "correct" this line, since I
can't tell whether it's a typo for a real function, a leftover reference to
something renamed/dropped elsewhere, or the security intent was never
finished. Let me know which it is and I'll fix it in a follow-up.

## Other pre-existing issues noticed but out of scope for this fix

Found while reading migrations for the checks above — not touched:

- `20260901052706_fix_ntuanaka_tsiki_tier5_stayer_placement.sql` references
  specific hardcoded user IDs — worth a second look before it's ever applied
  to production.
- `20260903230000_rapid_cup_themes.sql`, `20260883_admin_select_challenges.sql`
  had issues flagged in earlier notes (a `setval` sequencing concern and a
  duplicate policy respectively) that I have not independently re-verified.

None of these were touched by the renames above.
