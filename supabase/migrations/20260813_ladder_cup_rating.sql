-- WEAFRICA SURVIVAL LADDER CUP — matchmaking rating, decoupled from pts
--
-- ladder_cup_entries.pts (plus w/l/gd/streak/badges) is the league table —
-- it keeps working exactly as it already does: rankLadderCupStandings,
-- the tiebreaker chain, crownChampion at cutoff, all unchanged.
--
-- ladder_rating is a genuinely separate number. It's a standard Elo
-- rating that starts every club at 1000 and moves on every recorded win
-- or loss (played or approved walkover) — see computeEloUpdate in
-- src/formats/ladderCup.js. Its only consumer is getOpponentPool's
-- ±band search (the "who can I challenge" screen): the league table never
-- reads it, and it never feeds standings, badges, or the champion pick.
alter table ladder_cup_entries
  add column if not exists ladder_rating integer not null default 1000;

-- Not part of the tiebreaker chain and not something anyone needs to sort
-- the whole league table by, but the opponent-matching screen re-queries
-- it on every league load, so an index keeps that band search cheap as a
-- league's entry count grows.
create index if not exists idx_ladder_cup_entries_rating
  on ladder_cup_entries(league_id, ladder_rating);
