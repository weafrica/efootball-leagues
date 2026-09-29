-- Seed the two single-row tables. Captured verbatim from live migration
-- history (version 20260917061239); it runs after the RLS migration
-- (20260917061233), exactly as it did in production.
insert into cash_ladder_pool (id, balance) values (true, 0);
insert into cash_ladder_cycle (id, current_week, bidding_open, fixtures_locked) values (true, 0, false, true);
