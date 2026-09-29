-- Re-add foreign keys among the new cash_ladder_* tables (LIKE ...
-- INCLUDING ALL does not copy FK constraints). Anything that pointed at
-- a shared table (auth.users) keeps pointing at that same shared table;
-- anything that pointed at another ladder_* table now points at its
-- cash_ladder_* sibling, so this really is its own, separate ladder.
--
-- Captured verbatim from live migration history (version 20260917061204).

ALTER TABLE cash_ladder_memberships
  ADD CONSTRAINT cash_ladder_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  ADD CONSTRAINT cash_ladder_memberships_league_id_fkey FOREIGN KEY (league_id) REFERENCES cash_ladder_leagues(id);

ALTER TABLE cash_ladder_league_comments
  ADD CONSTRAINT cash_ladder_league_comments_league_id_fkey FOREIGN KEY (league_id) REFERENCES cash_ladder_leagues(id),
  ADD CONSTRAINT cash_ladder_league_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  ADD CONSTRAINT cash_ladder_league_comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES cash_ladder_league_comments(id);

ALTER TABLE cash_ladder_league_comment_likes
  ADD CONSTRAINT cash_ladder_league_comment_likes_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES cash_ladder_league_comments(id),
  ADD CONSTRAINT cash_ladder_league_comment_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

ALTER TABLE cash_ladder_reward_ledger
  ADD CONSTRAINT cash_ladder_reward_ledger_league_id_fkey FOREIGN KEY (league_id) REFERENCES cash_ladder_leagues(id),
  ADD CONSTRAINT cash_ladder_reward_ledger_fixture_id_fkey FOREIGN KEY (fixture_id) REFERENCES cash_ladder_fixtures(id);

ALTER TABLE cash_ladder_wall_of_fame
  ADD CONSTRAINT cash_ladder_wall_of_fame_league_id_fkey FOREIGN KEY (league_id) REFERENCES cash_ladder_leagues(id);

ALTER TABLE cash_ladder_fee_events
  ADD CONSTRAINT cash_ladder_fee_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  ADD CONSTRAINT cash_ladder_fee_events_league_id_fkey FOREIGN KEY (league_id) REFERENCES cash_ladder_leagues(id);

ALTER TABLE cash_ladder_bids
  ADD CONSTRAINT cash_ladder_bids_target_league_id_fkey FOREIGN KEY (target_league_id) REFERENCES cash_ladder_leagues(id),
  ADD CONSTRAINT cash_ladder_bids_bidder_user_id_fkey FOREIGN KEY (bidder_user_id) REFERENCES auth.users(id);

ALTER TABLE cash_ladder_fixtures
  ADD CONSTRAINT cash_ladder_fixtures_league_id_fkey FOREIGN KEY (league_id) REFERENCES cash_ladder_leagues(id),
  ADD CONSTRAINT cash_ladder_fixtures_home_user_id_fkey FOREIGN KEY (home_user_id) REFERENCES auth.users(id),
  ADD CONSTRAINT cash_ladder_fixtures_away_user_id_fkey FOREIGN KEY (away_user_id) REFERENCES auth.users(id);

ALTER TABLE cash_ladder_fixture_result_submissions
  ADD CONSTRAINT cash_ladder_fixture_result_submissions_fixture_id_fkey FOREIGN KEY (fixture_id) REFERENCES cash_ladder_fixtures(id),
  ADD CONSTRAINT cash_ladder_fixture_result_submissions_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES auth.users(id),
  ADD CONSTRAINT cash_ladder_fixture_result_submissions_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);

ALTER TABLE cash_ladder_fixture_corrections
  ADD CONSTRAINT cash_ladder_fixture_corrections_fixture_id_fkey FOREIGN KEY (fixture_id) REFERENCES cash_ladder_fixtures(id),
  ADD CONSTRAINT cash_ladder_fixture_corrections_corrected_by_fkey FOREIGN KEY (corrected_by) REFERENCES auth.users(id);

ALTER TABLE cash_ladder_fixture_cancellations
  ADD CONSTRAINT cash_ladder_fixture_cancellations_fixture_id_fkey FOREIGN KEY (fixture_id) REFERENCES cash_ladder_fixtures(id),
  ADD CONSTRAINT cash_ladder_fixture_cancellations_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES auth.users(id);

ALTER TABLE cash_ladder_pool_transactions
  ADD CONSTRAINT cash_ladder_pool_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);

ALTER TABLE cash_ladder_reward_payout_queue
  ADD CONSTRAINT cash_ladder_reward_payout_queue_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
