-- League Ladder — cleanup: drop the dead bid points tie-break helpers.
--
-- _ladder_bidder_points_internal / _ladder_player_points_internal
-- (20260861) fed _ladder_settle_bids_internal's old sealed-bid tie-break
-- (amount, then points, then placed_at). Phase C's live open-bid auction
-- redesign (20260871) replaced that: at most one 'pending' bid per
-- league/week ever exists now (every dethroned bid is refunded live), so
-- _ladder_settle_bids_internal just seats whoever is still 'pending' —
-- no ranking, no tie-break, no caller left for either function. 20260871's
-- own header already flagged this ("have no caller left in the SQL after
-- this migration... not deleted here since deleting them is a cleanup
-- decision, not part of this phase's ask").
--
-- leagueLadder.js's matching pure JS function, resolveLadderBids, and its
-- five unit tests are removed in the same change that adds this migration
-- — see that file's Phase 5 header for the full explanation.
--
-- Safe to run more than once (drop ... if exists).

drop function if exists _ladder_bidder_points_internal(uuid, uuid, integer);
drop function if exists _ladder_player_points_internal(uuid, uuid, integer);
