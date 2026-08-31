-- WEAFRICA SURVIVAL LADDER CUP — carry each club's WhatsApp number forward
-- too, not just its name.
--
-- CONTEXT: 20260898_ladder_cup_carry_clubs_forward gave every new weekly
-- cup the previous cup's clubs automatically, so owners don't have to
-- rejoin each week. But it only copied `teams.name` into the new team
-- row:
--
--   insert into teams (league_id, name) values (v_new_id, v_team.name)
--
-- The WhatsApp "call opponent" icon (WhatsAppCallLink / opponent.phone
-- throughout LeagueDetail.jsx and LadderCupOpponentRow) reads
-- `teams.phone` specifically — a club-level number set via
-- onUpdateTeamPhone / `update teams set phone = ...` — which is a
-- separate column from `members.phone` (the per-person number). Because
-- the carry-forward insert never set it, every club's phone silently
-- reset to null on the new team row each week, so no club had a
-- WhatsApp icon on its opponents in a freshly auto-opened cup — even
-- though the same clubs had numbers on file the week before. The same
-- gap was in the one-off fix-ladder-cup-bring-back-prior-clubs-now.sql
-- backfill.
--
-- This migration (1) fixes _ladder_cup_open_new_internal() so every
-- future weekly cup carries teams.phone forward alongside the name, and
-- (2) backfills the currently-live cup's already-carried-over clubs from
-- whichever prior ladder_cup league they most recently had a number on,
-- so the fix applies retroactively without waiting for next week's cup.
-- Safe to run more than once.

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
  -- one — same name AND same WhatsApp number this time, same owner(s).
  -- Each insert into teams re-triggers trg_auto_ladder_cup_entry for its
  -- own fresh ladder_cup_entries row, exactly like a self-join or admin
  -- pre-listing would.
  for v_team in select id, name, phone from teams where league_id = v_prev.id loop
    insert into teams (league_id, name, phone)
    values (v_new_id, v_team.name, v_team.phone)
    returning id into v_new_team_id;

    insert into members (league_id, team_id, user_id, display_name, phone)
    select v_new_id, v_new_team_id, m.user_id, m.display_name, m.phone
    from members m
    where m.league_id = v_prev.id and m.team_id = v_team.id;
  end loop;

  return v_new_id;
end;
$$;

-- One-off backfill: fix teams.phone on the currently-live cup for clubs
-- that were already carried over (by 20260898 or the earlier manual
-- fix-ladder-cup-bring-back-prior-clubs-now.sql) without a number. Walks
-- backwards through every OTHER ladder_cup league, most recent first, and
-- fills in the first phone number found for each same-named club — so a
-- club that skipped a week or two still gets its last known number.
do $$
declare
  v_current uuid;
  v_row record;
begin
  select id into v_current
  from leagues
  where format = 'ladder_cup' and ladder_cup_finalized_at is null
  order by created_at desc
  limit 1;

  if v_current is null then
    raise notice 'No live Ladder Cup found — nothing to backfill.';
    return;
  end if;

  for v_row in
    select t.id as team_id, t.name as team_name
    from teams t
    where t.league_id = v_current and (t.phone is null or t.phone = '')
  loop
    update teams
    set phone = prior.phone
    from (
      select pt.phone
      from teams pt
      join leagues pl on pl.id = pt.league_id
      where pl.format = 'ladder_cup'
        and pt.league_id <> v_current
        and lower(pt.name) = lower(v_row.team_name)
        and pt.phone is not null and pt.phone <> ''
      order by pl.created_at desc
      limit 1
    ) as prior
    where teams.id = v_row.team_id;
  end loop;
end $$;

-- Verify: every club on the live cup's ladder with its phone status.
select t.name, t.phone
from teams t
where t.league_id = (
  select id from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null
  order by created_at desc limit 1
)
order by t.name;
