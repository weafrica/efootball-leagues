-- ladder_league_comments.photo_url
-- Live production already has this column (it was added by hand, outside
-- migration history), and cash_ladder_league_comments inherits it because
-- that table is created with LIKE ladder_league_comments. Adding it here
-- (idempotently) makes a from-scratch replay match production.
alter table ladder_league_comments add column if not exists photo_url text;
