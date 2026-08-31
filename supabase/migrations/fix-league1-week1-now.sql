-- One-off fix: League 1's first-ever joiners were incorrectly scheduled
-- into week 2 (join_ladder_league always does current_week + 1, even
-- when the target week has zero existing members). Moves them back to
-- week 1 — the week that's actually live right now (bidding_open=true,
-- current_week=1) — and regenerates fixtures so the round robin exists
-- for week 1 instead of week 2.

-- 1) Move every active League 1 member from week 2 back to week 1.
update ladder_memberships m
set week_number = 1
from ladder_leagues l
where m.league_id = l.id
  and l.tier = 1
  and m.week_number = 2
  and m.status = 'active';

-- 2) Regenerate the round-robin fixtures for week 1 with the real roster.
--    (Safe to call even if week-2 fixtures already exist from before —
--    _generate_round_robin_fixtures_internal only touches pending
--    fixtures for the week_number it's given, and this call is scoped
--    to week 1.)
select _ladder_sync_fixtures_internal(
  (select id from ladder_leagues where tier = 1),
  1
);

-- 3) Clean up the now-empty week-2 fixture rows this league had
--    (generated back when everyone was still misassigned to week 2).
delete from ladder_fixtures
where league_id = (select id from ladder_leagues where tier = 1)
  and week_number = 2;

-- 4) Verify: everyone should now show week_number = 1.
select p.efootball_username, m.week_number, m.status
from ladder_memberships m
join ladder_leagues l on l.id = m.league_id
left join profiles p on p.user_id = m.user_id
where l.tier = 1
order by m.week_number desc;
