-- WEAFRICA SURVIVAL LADDER CUP — RLS-safe match creation
--
-- Same wall ensure_ladder_cup_entry (20260812) was built for: regular
-- authenticated clients can't INSERT into ladder_cup_matches directly —
-- RLS rejects it with "new row violates row-level security policy for
-- table ladder_cup_matches", which is exactly the error initiateLadderCupMatch
-- (App.jsx) surfaces as "Couldn't set up the match: ..." the moment someone
-- taps Challenge. This gives match creation the same treatment: a SECURITY
-- DEFINER function that runs with elevated privilege (bypassing RLS
-- internally) but re-validates everything the client already checked
-- before it does — the caller really controls p_team_id, both clubs really
-- belong to this ladder_cup league, the cutoff hasn't passed, and there
-- isn't already an open match between the two — so a caller can't use it
-- to plant a match for an arbitrary pairing or league.
--
-- Home/away assignment moves server-side too (mirrors assignHomeTeam's
-- ~50/50 split in formats/ladderCup.js) so the row that actually gets
-- written and the row the caller learns about can never disagree — with
-- the old client-computed-then-inserted flow, a mid-air race between two
-- callers challenging the same pair could otherwise leave one side's UI
-- reporting an assignment that isn't what actually got inserted.
create or replace function initiate_ladder_cup_match(p_league_id uuid, p_team_id uuid, p_opponent_team_id uuid)
returns table (id uuid, home_team_id uuid, away_team_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_home_id uuid;
  v_away_id uuid;
  v_match_id uuid;
begin
  if p_team_id is null or p_opponent_team_id is null then
    raise exception 'Both clubs are required';
  end if;
  if p_team_id = p_opponent_team_id then
    raise exception 'A club cannot challenge itself';
  end if;

  -- Caller must actually control p_team_id (same ownership check every
  -- other member-gated action in this app relies on).
  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id = p_team_id
  ) then
    raise exception 'Not authorized to act for this club';
  end if;

  -- Both clubs must genuinely be ladder_cup clubs in this exact league —
  -- same shape of check ensure_ladder_cup_entry already does for entries.
  if not exists (
    select 1 from teams t join leagues l on l.id = t.league_id
    where t.id = p_team_id and t.league_id = p_league_id and l.format = 'ladder_cup'
  ) then
    raise exception 'Club % is not a ladder_cup club in league %', p_team_id, p_league_id;
  end if;
  if not exists (
    select 1 from teams t join leagues l on l.id = t.league_id
    where t.id = p_opponent_team_id and t.league_id = p_league_id and l.format = 'ladder_cup'
  ) then
    raise exception 'Club % is not a ladder_cup club in league %', p_opponent_team_id, p_league_id;
  end if;

  if exists (
    select 1 from leagues l
    where l.id = p_league_id and l.ladder_cup_cutoff_at is not null and l.ladder_cup_cutoff_at <= now()
  ) then
    raise exception 'The Ladder Cup cutoff has passed — no new matches';
  end if;

  -- Belt-and-suspenders against a double-tap / two callers challenging the
  -- same pair at once — same dedupe ladderCupPendingMatchWith already does
  -- client-side, re-checked here so the race can't slip past it.
  if exists (
    select 1 from ladder_cup_matches m
    where m.league_id = p_league_id and m.finalized_at is null
      and ((m.home_team_id = p_team_id and m.away_team_id = p_opponent_team_id)
        or (m.home_team_id = p_opponent_team_id and m.away_team_id = p_team_id))
  ) then
    raise exception 'A match with this club is already set up';
  end if;

  if random() < 0.5 then
    v_home_id := p_team_id; v_away_id := p_opponent_team_id;
  else
    v_home_id := p_opponent_team_id; v_away_id := p_team_id;
  end if;

  insert into ladder_cup_matches (league_id, home_team_id, away_team_id)
  values (p_league_id, v_home_id, v_away_id)
  returning ladder_cup_matches.id into v_match_id;

  return query select v_match_id, v_home_id, v_away_id;
end;
$$;

-- Any signed-in user can call this — identical permissiveness to
-- ensure_ladder_cup_entry: the function's own checks above (not caller
-- identity) are what keep it from being misused.
grant execute on function initiate_ladder_cup_match(uuid, uuid, uuid) to authenticated;
