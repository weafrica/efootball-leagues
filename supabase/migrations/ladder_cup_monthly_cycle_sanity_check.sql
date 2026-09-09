-- Ladder Cup monthly-cycle sanity check.
--
-- Run this in the Supabase SQL editor:
--   - before shipping any migration that touches
--     _ladder_cup_open_new_internal (to confirm you're not about to
--     silently drop naming or carry-forward again, the way
--     20260901/20260902 did to 20260898/20260899's work), and
--   - after any monthly cron tick fires (last day of the month, 23:59
--     UTC), to confirm the new cup came out named and populated
--     correctly.
--
-- name_ok       — the live cup's name matches the month it's actually
--                  running in (starts_at + 1 day), not the month it was
--                  created on the last instant of.
-- carryover_ok  — the new cup's team count is at least the previous cup's
--                  team count (every real club carried forward, nothing
--                  silently reset to an empty roster).
--
-- Both should read `true`. If either is `false`, something regressed —
-- check pg_get_functiondef('_ladder_cup_open_new_internal'::regproc)
-- against what's actually supposed to be live before assuming which one
-- is wrong.

with current_cup as (
  select id, name, starts_at
  from leagues
  where format = 'ladder_cup' and ladder_cup_finalized_at is null
  order by created_at desc limit 1
),
prev_cup as (
  select id from leagues
  where format = 'ladder_cup' and id <> (select id from current_cup)
  order by created_at desc limit 1
)
select
  c.name as current_cup_name,
  to_char(coalesce(c.starts_at, now()) + interval '1 day', 'FMMonth') || ' Survivor Cup' as expected_name,
  (c.name = to_char(coalesce(c.starts_at, now()) + interval '1 day', 'FMMonth') || ' Survivor Cup') as name_ok,
  (select count(*) from teams where league_id = p.id) as prev_cup_team_count,
  (select count(*) from teams where league_id = c.id) as current_cup_team_count,
  (select count(*) from teams where league_id = c.id) >= (select count(*) from teams where league_id = p.id) as carryover_ok
from current_cup c, prev_cup p;
