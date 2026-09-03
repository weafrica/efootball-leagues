-- Every "not granted to authenticated" comment in the Rapid Cup migrations
-- (Phase 3 and Phase 4) was aspirational, not enforced: Postgres grants
-- EXECUTE to PUBLIC on every new function by default unless it's
-- explicitly revoked, and none of these migrations ever did that revoke.
-- This project already hit this exact bug once before, for the nets
-- wallet functions (see 20260843_secure_grants_and_nets_purchases.sql) —
-- it just wasn't caught for Rapid Cup, which shipped after that fix.
--
-- Worst case before this migration: any signed-in user (and even an
-- anonymous one) could call finalize_rapid_cup_payout(lobby_id, their_own
-- user_id) directly via RPC and pay themselves the pool, or call
-- compute_rapid_cup_payout with any numbers to see internals — no auth
-- check inside either function stopped them, because the client was never
-- supposed to be able to reach them at all.
revoke all on function _rapid_cup_advance_bracket_internal(uuid) from public, anon, authenticated;
revoke all on function _rapid_cup_finish_lobby_internal(uuid) from public, anon, authenticated;
revoke all on function _rapid_cup_sweep_internal() from public, anon, authenticated;
revoke all on function finalize_rapid_cup_payout(uuid, uuid) from public, anon, authenticated;
revoke all on function compute_rapid_cup_payout(numeric, numeric, numeric) from public, anon, authenticated;
