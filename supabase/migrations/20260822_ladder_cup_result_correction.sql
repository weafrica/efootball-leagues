-- WEAFRICA SURVIVAL LADDER CUP — correcting an already-confirmed result
--
-- BACKGROUND: editing a result comment has always had two paths —
-- comment.fixture_id (regular league fixtures) gets real score inputs
-- wired to editResultForFixture, which rewrites the fixture row and
-- reruns knockout elimination. comment.ladder_cup_match_id (Ladder Cup)
-- had no equivalent: saveEdit only ever checked `linkedFixture`, so every
-- Ladder Cup result comment silently fell into the plain text-only
-- onEdit path (UPDATE comments SET body = ...) — it never touched
-- ladder_cup_matches or ladder_cup_entries, regardless of how old the
-- comment was.
--
-- Unlike a fixture, Ladder Cup scoring can't be fixed with a plain
-- "overwrite the score, patch two rows" edit: pts/gd/streak/status
-- (active/second-life/eliminated), badges, and ladder_rating are all
-- PATH-DEPENDENT — streak and badges depend on the order matches
-- happened in, Elo depends on both clubs' ratings at the moment of each
-- result. There's no "undo" for any of that once a match is confirmed.
--
-- FIX: a recompute, not a patch. correct_ladder_cup_match_result rewrites
-- just the one match's raw scoreline (narrow, audited). App.jsx's
-- recomputeLadderCupLeague then replays EVERY finalized match/approved
-- walkover for the league, in the order they actually finalized, through
-- the same pure engine (formats/ladderCup.js) every live result already
-- goes through — with the corrected score swapped in — and rebuilds every
-- club's entry from scratch. bulk_apply_ladder_cup_entries writes that
-- rebuilt table back in one round trip.

create table if not exists ladder_cup_match_corrections (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  match_id uuid not null references ladder_cup_matches(id) on delete cascade,
  corrected_by uuid references auth.users(id),
  previous_home_goals integer,
  previous_away_goals integer,
  previous_extra_time_home_goals integer,
  previous_extra_time_away_goals integer,
  previous_penalties_home integer,
  previous_penalties_away integer,
  previous_decided_by text,
  previous_winner_team_id uuid,
  new_home_goals integer not null,
  new_away_goals integer not null,
  new_extra_time_home_goals integer,
  new_extra_time_away_goals integer,
  new_penalties_home integer,
  new_penalties_away integer,
  new_decided_by text not null,
  new_winner_team_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_cup_match_corrections_league
  on ladder_cup_match_corrections(league_id);

-- Narrow, admin-only rewrite of one already-finalized match's raw
-- scoreline. Deliberately does NOT touch ladder_cup_entries — that's
-- bulk_apply_ladder_cup_entries below, called separately once App.jsx has
-- replayed the whole league with this corrected score in place. Logs the
-- before/after into ladder_cup_match_corrections since this can move
-- points/streaks/elimination status for every match that happened after
-- it — worth an audit trail. Only ever callable on a match that's
-- actually been confirmed (finalized_at set); a still-pending report
-- should be disputed/re-logged instead, not "corrected".
create or replace function correct_ladder_cup_match_result(
  p_match_id uuid,
  p_league_id uuid,
  p_home_goals integer,
  p_away_goals integer,
  p_extra_time_home_goals integer,
  p_extra_time_away_goals integer,
  p_penalties_home integer,
  p_penalties_away integer,
  p_decided_by text,
  p_winner_team_id uuid
)
returns ladder_cup_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match ladder_cup_matches;
begin
  select * into v_match from ladder_cup_matches where id = p_match_id and league_id = p_league_id;
  if not found then
    raise exception 'Ladder cup match % not found in league %', p_match_id, p_league_id;
  end if;

  if v_match.finalized_at is null then
    raise exception 'This match has not been confirmed yet — dispute or re-log it instead of correcting it.';
  end if;

  if not exists (
    select 1 from leagues l where l.id = p_league_id and l.created_by = auth.uid()
  ) then
    raise exception 'Only the league admin can correct a confirmed Ladder Cup result';
  end if;

  insert into ladder_cup_match_corrections (
    league_id, match_id, corrected_by,
    previous_home_goals, previous_away_goals, previous_extra_time_home_goals, previous_extra_time_away_goals,
    previous_penalties_home, previous_penalties_away, previous_decided_by, previous_winner_team_id,
    new_home_goals, new_away_goals, new_extra_time_home_goals, new_extra_time_away_goals,
    new_penalties_home, new_penalties_away, new_decided_by, new_winner_team_id
  ) values (
    p_league_id, p_match_id, auth.uid(),
    v_match.home_goals, v_match.away_goals, v_match.extra_time_home_goals, v_match.extra_time_away_goals,
    v_match.penalties_home, v_match.penalties_away, v_match.decided_by, v_match.winner_team_id,
    p_home_goals, p_away_goals, p_extra_time_home_goals, p_extra_time_away_goals,
    p_penalties_home, p_penalties_away, p_decided_by, p_winner_team_id
  );

  update ladder_cup_matches set
    home_goals = p_home_goals, away_goals = p_away_goals,
    extra_time_home_goals = p_extra_time_home_goals, extra_time_away_goals = p_extra_time_away_goals,
    penalties_home = p_penalties_home, penalties_away = p_penalties_away,
    decided_by = p_decided_by, winner_team_id = p_winner_team_id
  where id = p_match_id
  returning * into v_match;

  return v_match;
end;
$$;

grant execute on function correct_ladder_cup_match_result(
  uuid, uuid, integer, integer, integer, integer, integer, integer, text, uuid
) to authenticated;

-- Bulk rewrite of every ladder_cup_entries row for a league in one round
-- trip — what the client-side recompute (replay every finalized match and
-- approved walkover chronologically through formats/ladderCup.js with the
-- corrected score in place, see App.jsx's recomputeLadderCupLeague)
-- writes back once it's rebuilt every club's standing from scratch.
-- Admin-only: unlike apply_ladder_cup_entry_result (one entry at a time,
-- either participant can call it for their own confirm/second-life step),
-- this can move every club's points/streak/status/badges/rating at once
-- and is only ever invoked from the correction flow.
--
-- p_entries is a jsonb array of objects shaped like
-- ladderCupRowPatchFromEntry's output (App.jsx) plus an entry_id:
-- { entry_id, pts, w, l, gd, streak, status, second_life_used,
--   second_life_offered_at, second_life_expires_at,
--   toughest_opponent_beaten_pts, ladder_rating, badge_heater_tier,
--   badge_giant_slayer, badge_second_life, badge_walkover, badge_bounty_hunter }
create or replace function bulk_apply_ladder_cup_entries(
  p_league_id uuid,
  p_entries jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry jsonb;
begin
  if not exists (
    select 1 from leagues l where l.id = p_league_id and l.created_by = auth.uid()
  ) then
    raise exception 'Only the league admin can recompute Ladder Cup standings';
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries)
  loop
    update ladder_cup_entries set
      pts = (v_entry->>'pts')::integer,
      w = (v_entry->>'w')::integer,
      l = (v_entry->>'l')::integer,
      gd = (v_entry->>'gd')::integer,
      streak = (v_entry->>'streak')::integer,
      status = v_entry->>'status',
      second_life_used = (v_entry->>'second_life_used')::boolean,
      second_life_offered_at = nullif(v_entry->>'second_life_offered_at', '')::timestamptz,
      second_life_expires_at = nullif(v_entry->>'second_life_expires_at', '')::timestamptz,
      toughest_opponent_beaten_pts = (v_entry->>'toughest_opponent_beaten_pts')::integer,
      ladder_rating = (v_entry->>'ladder_rating')::integer,
      badge_heater_tier = (v_entry->>'badge_heater_tier')::smallint,
      badge_giant_slayer = (v_entry->>'badge_giant_slayer')::integer,
      badge_second_life = (v_entry->>'badge_second_life')::boolean,
      badge_walkover = (v_entry->>'badge_walkover')::integer,
      badge_bounty_hunter = (v_entry->>'badge_bounty_hunter')::integer,
      updated_at = now()
    where id = (v_entry->>'entry_id')::uuid and league_id = p_league_id;
  end loop;
end;
$$;

grant execute on function bulk_apply_ladder_cup_entries(uuid, jsonb) to authenticated;
