-- WEAFRICA SURVIVAL LADDER CUP — rebirth (rejoin after full elimination)
--
-- Until now "eliminated" (second life already used, or a first offer
-- declined/expired) was a dead end: the row stays in ladder_cup_entries
-- forever, which is exactly why the club keeps showing on the standings
-- table for the record — getOpponentPool (formats/ladderCup.js) only ever
-- considers status = 'active', so an eliminated club was already invisible
-- to matchmaking on its own — but there was no way back onto the ladder.
--
-- Rebirth adds that path: a fully eliminated club can choose to rejoin.
-- Its finished life (pts/w/l/gd/badges/rating) is archived into a new
-- `past_lives` jsonb array — kept purely for display (club history /
-- legacy stats on the standings table and club profile), never summed
-- back into the live pts/w/l/gd the standings actually rank on — and the
-- row's live stats reset to a brand-new day-one run: 0 pts/w/l/gd/streak,
-- a fresh second life, ladder_rating back to the starting value, status
-- back to 'active'.
alter table ladder_cup_entries
  add column if not exists rebirth_count integer not null default 0,
  add column if not exists past_lives jsonb not null default '[]'::jsonb,
  add column if not exists reborn_at timestamptz;

-- RLS-safe rejoin, same SECURITY DEFINER pattern as every other
-- ladder_cup_entries write (ensure_ladder_cup_entry, apply_ladder_cup_entry_result):
-- plain client UPDATEs are blocked by RLS, so this needs the same
-- treatment. Self-serve only — no admin path, same as accepting/declining
-- a second-life offer (see 20260819's apply_ladder_cup_entry_result vs this
-- one: reviving your own club is a personal choice, not something an admin
-- does on your behalf). p_past_life is the finished-life snapshot the
-- client's reborn() (formats/ladderCup.js) already built; this function
-- trusts its numbers the same way apply_ladder_cup_entry_result trusts a
-- client-built entry patch — what it DOES enforce server-side is the
-- invariant that actually matters: the entry really is eliminated, and the
-- cup hasn't already finalized/passed its cutoff.
create or replace function rebirth_ladder_cup_entry(
  p_entry_id uuid,
  p_league_id uuid,
  p_team_id uuid,
  p_past_life jsonb
)
returns ladder_cup_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry ladder_cup_entries;
  v_status text;
  v_cutoff timestamptz;
  v_finalized timestamptz;
begin
  -- Scalar-only INTO here on purpose: a whole-row record (ladder_cup_entries)
  -- can't share an INTO list with plain scalar targets ("record variable
  -- cannot be part of multiple-item INTO list") — v_entry only gets filled
  -- later, off the UPDATE ... RETURNING below, once we know this call is
  -- actually going to change something.
  select e.status, l.ladder_cup_cutoff_at, l.ladder_cup_finalized_at
    into v_status, v_cutoff, v_finalized
  from ladder_cup_entries e
  join leagues l on l.id = e.league_id
  where e.id = p_entry_id and e.league_id = p_league_id and e.team_id = p_team_id;

  if not found then
    raise exception 'Ladder cup entry % not found in league %', p_entry_id, p_league_id;
  end if;

  if v_status <> 'eliminated' then
    raise exception 'Only a fully eliminated club can be reborn.';
  end if;

  if v_finalized is not null or (v_cutoff is not null and v_cutoff <= now()) then
    raise exception 'The Ladder Cup cutoff has passed — rebirth is closed.';
  end if;

  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id = p_team_id
  ) then
    raise exception 'Not authorized to revive this club.';
  end if;

  update ladder_cup_entries set
    pts = 0, w = 0, l = 0, gd = 0, streak = 0,
    status = 'active',
    second_life_used = false,
    second_life_offered_at = null,
    second_life_expires_at = null,
    toughest_opponent_beaten_pts = 0,
    ladder_rating = 1000,
    badge_heater_tier = 0,
    badge_giant_slayer = 0,
    badge_second_life = false,
    badge_walkover = 0,
    badge_bounty_hunter = 0,
    rebirth_count = rebirth_count + 1,
    past_lives = past_lives || jsonb_build_array(p_past_life),
    reborn_at = now(),
    updated_at = now()
  where id = p_entry_id
  returning * into v_entry;

  return v_entry;
end;
$$;

grant execute on function rebirth_ladder_cup_entry(uuid, uuid, uuid, jsonb) to authenticated;
