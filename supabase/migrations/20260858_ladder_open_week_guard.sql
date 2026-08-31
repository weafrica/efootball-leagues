-- League Ladder — fix: guard against opening a week twice.
--
-- _ladder_open_week_internal had no check for "is a week already open right
-- now" — calling it a second time (by hand while testing, or a real race
-- against the cron job) would silently advance current_week again and
-- generate a whole extra week on top of the one still in progress. Two
-- fixes, layered:
--
--   1. An explicit guard + row lock at the top of the function: refuses
--      to open a new week while bidding_open is still true (meaning the
--      current week hasn't been closed yet), and locks the ladder_cycle
--      row for the duration so two concurrent callers can't both read
--      bidding_open=false and both proceed.
--   2. A unique constraint on ladder_fixtures as a backstop — even if
--      something else someday calls the fixture generator directly with a
--      bad week number, the database itself refuses a duplicate pairing
--      for the same league/week rather than silently accepting it.
--
-- Safe to run more than once.

-- Order-invariant: catches a duplicate pairing regardless of which side
-- ended up home vs away (a straight (league,week,home,away) unique
-- constraint would miss a reversed-duplicate bug, since the two rows
-- would differ in those columns while still representing the same
-- impossible "these two played twice" scheduling error).
create unique index if not exists idx_ladder_fixtures_unique_pairing
  on ladder_fixtures (league_id, week_number, least(home_user_id, away_user_id), greatest(home_user_id, away_user_id));

create or replace function _ladder_open_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev_week integer;
  v_new_week integer;
  v_bidding_open boolean;
  v_league record;
  v_player_ids uuid[];
begin
  -- Lock the singleton row for the rest of this transaction — a second
  -- concurrent call blocks here until the first one commits, rather than
  -- both reading the same "not open yet" state and both proceeding.
  select current_week, bidding_open into v_prev_week, v_bidding_open
  from ladder_cycle where id = true for update;

  if v_bidding_open then
    raise exception '_ladder_open_week_internal: week % is still open — close it before opening a new one', v_prev_week;
  end if;

  v_new_week := v_prev_week + 1;

  for v_league in select id from ladder_leagues where status = 'active' loop
    if v_prev_week > 0 then
      insert into ladder_memberships (user_id, league_id, week_number, status)
      select user_id, v_league.id, v_new_week, 'active'
      from ladder_memberships
      where league_id = v_league.id and week_number = v_prev_week and status = 'active';
    end if;

    select array_agg(user_id) into v_player_ids
    from ladder_memberships
    where league_id = v_league.id and week_number = v_new_week and status = 'active';

    if array_length(v_player_ids, 1) >= 2 then
      perform _generate_round_robin_fixtures_internal(v_league.id, v_new_week, v_player_ids);
    end if;
  end loop;

  update ladder_cycle
  set current_week = v_new_week, bidding_open = true, fixtures_locked = false, updated_at = now()
  where id = true;
end;
$$;
