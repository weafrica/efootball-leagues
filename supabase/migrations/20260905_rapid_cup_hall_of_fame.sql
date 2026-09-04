-- Rapid Cup — Phase 9: Hall of Fame leaderboard (Section 13, v2/optional
-- item, built anyway since it's small and self-contained).
--
-- get_rapid_cup_hall_of_fame() — all-time top earners, summed straight
-- from rapid_cup_collections (the ledger of what's actually been credited
-- via Winbox + Cup box — see 20260903210000_rapid_cup_prize_collection.sql
-- and its follow-up), not from rapid_cup_payouts/rapid_cup_payout_recipients.
-- Those two record what was computed/owed, not what was actually claimed;
-- collections is the one table that can't overcount someone who never
-- tapped to collect.
--
-- Read-only, no auth check needed inside — same "public bid ticker" spirit
-- as ladder_pool's own balance being visible to any signed-in user
-- (20260855_ladder_pool.sql). Not SECURITY DEFINER: plain `language sql
-- stable`, runs as the caller, reads only already-public earnings totals,
-- nothing it needs elevated privileges for.
create or replace function get_rapid_cup_hall_of_fame(p_limit integer default 10)
returns table (user_id uuid, display_name text, total_earned bigint)
language sql
stable
as $$
  select
    c.user_id,
    p.efootball_username as display_name,
    sum(c.amount)::bigint as total_earned
  from rapid_cup_collections c
  left join profiles p on p.user_id = c.user_id
  group by c.user_id, p.efootball_username
  order by total_earned desc
  limit greatest(1, least(p_limit, 50));
$$;

revoke all on function get_rapid_cup_hall_of_fame(integer) from public, anon;
grant execute on function get_rapid_cup_hall_of_fame(integer) to authenticated;
