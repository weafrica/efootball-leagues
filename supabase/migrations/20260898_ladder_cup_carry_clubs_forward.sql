-- WEAFRICA SURVIVAL LADDER CUP — carry existing clubs forward into each
-- auto-opened weekly cup, instead of starting empty.
--
-- CONTEXT: 20260895's _ladder_cup_open_new_internal() explicitly chose
-- "no teams are copied over — same as today, every club joins fresh each
-- cup" when it shipped the Sunday 11:59 UTC auto finish-and-restart cycle.
-- In practice that means every club's owner has to notice the new cup and
-- manually rejoin/re-register their club each week, or they simply drop
-- out of the ladder the moment last week's cup finalizes.
--
-- This migration changes that: the clubs (teams) registered in the cup
-- that just finished are automatically registered in the new one too,
-- with the same players attached — no one has to click Join/Rejoin again
-- to keep playing week over week. What DOESN'T change: each club still
-- starts the new week on a completely fresh ladder_cup_entries row (0
-- pts/w/l/gd/streak, a fresh second life, status 'active') via the
-- existing trg_auto_ladder_cup_entry trigger (20260814), which fires
-- unconditionally on any INSERT into teams for a ladder_cup league — so
-- "fresh cup each week" stat-wise is untouched, only the roster itself
-- now carries over automatically instead of needing manual re-entry.
--
-- Only clubs that actually had a real member (a claimed team, team_id not
-- null) carry over — spectator members (team_id is null, someone who
-- joined without a club) are naturally excluded since the copy is scoped
-- per-team. Only the signature-compatible body of
-- _ladder_cup_open_new_internal() changes; step 9's weekly cron entry
-- point and its schedule (20260895) are untouched. Safe to run more than
-- once (create or replace).
create or replace function _ladder_cup_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new_id uuid;
  v_base_name text;
  v_trailing_num integer;
  v_new_name text;
  v_team record;
  v_new_team_id uuid;
begin
  if exists (select 1 from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null) then
    return null; -- a cup is already live — never open a second one
  end if;

  select * into v_prev from leagues where format = 'ladder_cup' order by created_at desc limit 1;
  if not found then
    return null; -- no prior Ladder Cup to clone settings/clubs from — nothing to auto-open yet
  end if;

  v_trailing_num := substring(v_prev.name from '#(\d+)\s*$')::integer;
  if v_trailing_num is not null then
    v_base_name := regexp_replace(v_prev.name, '#\d+\s*$', '');
    v_new_name := trim(v_base_name) || ' #' || (v_trailing_num + 1);
  else
    v_new_name := trim(v_prev.name) || ' #2';
  end if;

  insert into leagues (
    name, created_by, format, entry_closes_at, starts_at, description,
    round_period_hours, created_by_admin, league_type, ladder_cup_cutoff_at
  )
  values (
    v_new_name, v_prev.created_by, 'ladder_cup', null, now(), v_prev.description,
    v_prev.round_period_hours, v_prev.created_by_admin, v_prev.league_type,
    _ladder_cup_next_sunday_1159_utc(now())
  )
  returning id into v_new_id;

  -- Carry every real club from the cup that just finished into the new
  -- one, same name, same owner(s) — this is the "no need to ask them to
  -- rejoin" part. Each insert into teams re-triggers
  -- trg_auto_ladder_cup_entry for its own fresh ladder_cup_entries row,
  -- exactly like a self-join or admin pre-listing would.
  for v_team in select id, name from teams where league_id = v_prev.id loop
    insert into teams (league_id, name)
    values (v_new_id, v_team.name)
    returning id into v_new_team_id;

    insert into members (league_id, team_id, user_id, display_name, phone)
    select v_new_id, v_new_team_id, m.user_id, m.display_name, m.phone
    from members m
    where m.league_id = v_prev.id and m.team_id = v_team.id;
  end loop;

  return v_new_id;
end;
$$;
