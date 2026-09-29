-- Cash League Ladder — structural duplicate of every ladder_* table
-- (the weekly-cycle League Ladder, NOT ladder_cup_*), renamed cash_ladder_*.
-- LIKE ... INCLUDING ALL copies columns, defaults, not-null, CHECK
-- constraints, indexes and identity — everything except foreign keys,
-- which are re-added below, and RLS policies, which are copied in the
-- next migration.
--
-- Captured verbatim from live migration history (version 20260917061134).
-- It was applied to production but never committed to git, which made
-- 20260917061233_cash_ladder_tables_rls.sql fail on a fresh database with
-- "relation cash_ladder_bids does not exist".
--
-- Requires ladder_league_comments / ladder_league_comment_likes to exist
-- already: 20260903005300_ladder_league_comments.sql (renamed from
-- 20260925_ladder_league_comments.sql so it runs before this file).

CREATE TABLE cash_ladder_leagues (LIKE ladder_leagues INCLUDING ALL);
CREATE TABLE cash_ladder_memberships (LIKE ladder_memberships INCLUDING ALL);
CREATE TABLE cash_ladder_fixtures (LIKE ladder_fixtures INCLUDING ALL);
CREATE TABLE cash_ladder_bids (LIKE ladder_bids INCLUDING ALL);
CREATE TABLE cash_ladder_pool (LIKE ladder_pool INCLUDING ALL);
CREATE TABLE cash_ladder_pool_transactions (LIKE ladder_pool_transactions INCLUDING ALL);
CREATE TABLE cash_ladder_cycle (LIKE ladder_cycle INCLUDING ALL);
CREATE TABLE cash_ladder_fee_events (LIKE ladder_fee_events INCLUDING ALL);
CREATE TABLE cash_ladder_wall_of_fame (LIKE ladder_wall_of_fame INCLUDING ALL);
CREATE TABLE cash_ladder_reward_ledger (LIKE ladder_reward_ledger INCLUDING ALL);
CREATE TABLE cash_ladder_fixture_result_submissions (LIKE ladder_fixture_result_submissions INCLUDING ALL);
CREATE TABLE cash_ladder_fixture_corrections (LIKE ladder_fixture_corrections INCLUDING ALL);
CREATE TABLE cash_ladder_reward_payout_queue (LIKE ladder_reward_payout_queue INCLUDING ALL);
CREATE TABLE cash_ladder_fixture_cancellations (LIKE ladder_fixture_cancellations INCLUDING ALL);
CREATE TABLE cash_ladder_league_comments (LIKE ladder_league_comments INCLUDING ALL);
CREATE TABLE cash_ladder_league_comment_likes (LIKE ladder_league_comment_likes INCLUDING ALL);
CREATE TABLE cash_ladder_fixture_notify_sent (LIKE ladder_fixture_notify_sent INCLUDING ALL);

-- Real-money additions to the fee/payout layer (see next migrations for
-- the functions that use these): entry/table fees are settled by a
-- payment record instead of an instant nets_wallets debit, and rewards
-- are queued for a manual cash payout instead of an instant credit.
ALTER TABLE cash_ladder_fee_events
  ADD COLUMN checkout_method text CHECK (checkout_method IN ('manual_proof', 'gateway', 'whatsapp')),
  ADD COLUMN payment_status text NOT NULL DEFAULT 'pending_review' CHECK (payment_status IN ('pending_review', 'paid', 'rejected', 'whatsapp_sent')),
  ADD COLUMN payment_proof_path text,
  ADD COLUMN gateway_reference text,
  ADD COLUMN admin_reviewed_by uuid REFERENCES auth.users(id),
  ADD COLUMN admin_reviewed_at timestamptz;

ALTER TABLE cash_ladder_reward_payout_queue
  ADD COLUMN payout_method text CHECK (payout_method IN ('bank_transfer', 'whatsapp_arranged')),
  ADD COLUMN payout_reference text,
  ADD COLUMN paid_by uuid REFERENCES auth.users(id);

COMMENT ON TABLE cash_ladder_leagues IS 'Cash-prize League Ladder — structural duplicate of ladder_leagues, real-money entry/payout instead of Nets.';
