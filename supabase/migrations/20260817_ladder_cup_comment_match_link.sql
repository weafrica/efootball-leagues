-- WEAFRICA SURVIVAL LADDER CUP — link result comments back to their match
--
-- Every other format's auto-posted scoreline comment carries a fixture_id,
-- which is what CommentRow (LeagueDetail.jsx) uses to look up both clubs
-- and show the admin "message home/away club about this result" WhatsApp
-- icons on the Results tab. Ladder Cup results don't run through the
-- fixtures table at all (see ladder_cup_matches, 20260811_ladder_cup.sql),
-- so those comments have always posted with fixture_id: null — which is
-- exactly why that icon pair never showed up for a Ladder Cup result, even
-- though the "message the league admin about this result" icon (which only
-- needs league.creator_phone, not a linked fixture) worked fine.
--
-- This gives Ladder Cup result comments the equivalent link: a nullable FK
-- to ladder_cup_matches, populated only by recordLadderCupMatchResult
-- (App.jsx) when it posts the scoreline comment. Every other comment type
-- (chat, walkover-claim posts, every other format's fixture-linked results)
-- keeps this column null, same as they've always left fixture_id null for
-- comments that don't apply to them.
alter table comments
  add column if not exists ladder_cup_match_id uuid references ladder_cup_matches(id) on delete set null;

create index if not exists idx_comments_ladder_cup_match on comments(ladder_cup_match_id);
