-- League Ladder — fix: unique pairing constraint blocks the second leg of
-- the double round-robin, breaking every join past the first player.
--
-- ROOT CAUSE: idx_ladder_fixtures_unique_pairing (20260858) is
-- order-invariant by design — least(home,away), greatest(home,away) — so
-- it can't tell leg 1 (A home vs B away) apart from leg 2 (B home vs A
-- away) for the same league/week. That was fine when it was written,
-- because fixture generation only ever produced a single leg back then.
--
-- 20260876 introduced the double round-robin: every pair legitimately
-- gets TWO fixtures in the same week, home/away reversed. The moment
-- _generate_round_robin_fixtures_internal inserts that second, reversed
-- fixture, this index sees it as a duplicate of the first and rejects
-- it — rolling back the whole join_ladder_league() transaction. In
-- practice this means the 2nd player to join a league (the point at
-- which fixture generation first has >=2 players to schedule) always
-- fails with "duplicate key value violates unique constraint
-- idx_ladder_fixtures_unique_pairing", and their membership insert is
-- rolled back with it, so they never actually end up on the ladder.
--
-- FIX: scope the uniqueness to (league_id, week_number, leg) instead of
-- just (league_id, week_number). Within a single leg the constraint
-- still catches a genuine duplicate/reversed-duplicate pairing bug
-- (its original purpose, from 20260858) — it just no longer conflates
-- leg 1 and leg 2, which are supposed to contain the same pairing in
-- opposite directions.
--
-- Safe to run more than once.

drop index if exists idx_ladder_fixtures_unique_pairing;

create unique index if not exists idx_ladder_fixtures_unique_pairing
  on ladder_fixtures (
    league_id,
    week_number,
    leg,
    least(home_user_id, away_user_id),
    greatest(home_user_id, away_user_id)
  );
