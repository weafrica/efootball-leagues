-- Fixes a repeat of the same bug already fixed once for Rapid Cup
-- (see 20260903190000_rapid_cup_secure_grants.sql): Postgres grants
-- EXECUTE to PUBLIC on new functions by default unless revoked. The
-- spectator-investment migration (20260904) created two new functions
-- and never revoked that default grant.
--
-- _rapid_cup_split_recipient_internal is SECURITY DEFINER and inserts
-- arbitrary-amount payout_recipients rows for a caller-supplied
-- user_id/amount with no auth check inside it — it was never meant to
-- be reachable directly, only via finalize_rapid_cup_payout /
-- _rapid_cup_finish_lobby_internal, both of which are already locked
-- down. Left open, any signed-in (or anonymous) user could call it
-- directly and mint themselves Nets via collect_rapid_cup_cupbox.
--
-- _rapid_cup_player_stakes_internal is read-only and not SECURITY
-- DEFINER, so the exposure there is just leaking stake data, not a
-- wallet exploit — still tightened for consistency with every other
-- _internal function in this project.
revoke all on function _rapid_cup_split_recipient_internal(uuid, uuid, uuid, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function _rapid_cup_player_stakes_internal(uuid) from public, anon, authenticated;
