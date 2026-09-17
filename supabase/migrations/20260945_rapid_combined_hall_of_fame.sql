-- Wall of Fame — Rapid Cup/Rapid League champions get their own combined
-- earnings board (Home > Wall of Fame, bottom section), separate from the
-- main trophy-score ranking. Regulars leagues take days/weeks to win;
-- Rapid Cup/League can be won in one sitting, so mixing their winners into
-- the main ranked list drowned out the "real" champions (see
-- computeWallOfFame's isRapidLeagueTitle filter in App.jsx, which now
-- excludes anyone whose only titles are Rapid ones from that list).
--
-- get_rapid_hall_of_fame() — same "sum what was actually claimed, not what
-- was computed/owed" reasoning as get_rapid_cup_hall_of_fame
-- (20260904030158_rapid_cup_hall_of_fame.sql), just unioned across both
-- rapid_cup_collections and rapid_league_collections (added in
-- 20260918000000_rapid_league_single_round_robin.sql, which explicitly
-- left this combined function as a follow-up).
create or replace function get_rapid_hall_of_fame(p_limit integer default 10)
returns table (user_id uuid, display_name text, total_earned bigint)
language sql
stable
as $$
  select
    c.user_id,
    p.efootball_username as display_name,
    sum(c.amount)::bigint as total_earned
  from (
    select user_id, amount from rapid_cup_collections
    union all
    select user_id, amount from rapid_league_collections
  ) c
  left join profiles p on p.user_id = c.user_id
  group by c.user_id, p.efootball_username
  order by total_earned desc
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function get_rapid_hall_of_fame(integer) from public, anon;
grant execute on function get_rapid_hall_of_fame(integer) to authenticated;
