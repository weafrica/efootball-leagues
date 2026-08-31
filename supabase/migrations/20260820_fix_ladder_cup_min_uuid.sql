-- Fix: _apply_ladder_cup_match_win called min(team_id) where team_id is
-- uuid. Postgres has no MIN aggregate for uuid, causing:
--   function min(uuid) does not exist
-- Only the leader_count = 1 check needs a single arbitrary team_id from
-- that one row, so array_agg(...)[1] replaces min(...) with identical
-- behaviour when there's exactly one leader.

CREATE OR REPLACE FUNCTION public._apply_ladder_cup_match_win(p_match_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_match ladder_cup_matches%rowtype;
  v_winner_id uuid;
  v_loser_id uuid;
  v_winner_goals integer;
  v_loser_goals integer;
  v_winner ladder_cup_entries%rowtype;
  v_loser ladder_cup_entries%rowtype;
  v_winner_rank integer;
  v_loser_rank integer;
  v_sole_leader_id uuid;
  v_beat_higher_rank boolean;
  v_is_bounty_target boolean;
  v_streak_after integer;
  v_base integer := 3; -- BASE_WIN_POINTS
  v_upset integer;
  v_heater integer;
  v_bounty integer;
  v_gained integer;
  v_gd_delta integer;
  v_expected_winner double precision;
  v_elo_delta integer;
  v_winner_rating integer;
  v_loser_rating integer;
begin
  select * into v_match from ladder_cup_matches where id = p_match_id for update;
  if not found then
    raise exception 'Ladder cup match % not found', p_match_id;
  end if;
  -- Idempotency: the same guard shape as record_fixture_result's
  -- p_was_already_played, but derived from the row's own state rather
  -- than a caller-supplied flag, so it can't be lied to either.
  if v_match.finalized_at is not null then
    return;
  end if;
  if v_match.winner_team_id is null or v_match.home_goals is null or v_match.away_goals is null then
    raise exception 'Match % has no reported result to apply', p_match_id;
  end if;

  v_winner_id := v_match.winner_team_id;
  v_loser_id := case when v_winner_id = v_match.home_team_id then v_match.away_team_id else v_match.home_team_id end;
  v_winner_goals := case when v_winner_id = v_match.home_team_id then v_match.home_goals else v_match.away_goals end;
  v_loser_goals := case when v_winner_id = v_match.home_team_id then v_match.away_goals else v_match.home_goals end;

  select * into v_winner from ladder_cup_entries where league_id = v_match.league_id and team_id = v_winner_id for update;
  select * into v_loser from ladder_cup_entries where league_id = v_match.league_id and team_id = v_loser_id for update;
  if v_winner.id is null or v_loser.id is null then
    raise exception 'Missing ladder cup entry for one of the two clubs in match %', p_match_id;
  end if;

  -- Standings before this match — 1224 ranking: pts desc, gd desc,
  -- toughest_opponent_beaten_pts desc (same chain as rankLadderCupStandings).
  -- Needs: rank position of the winner/loser, and whether the loser sits
  -- ALONE at rank 1 (a tie for #1 doesn't count as a bounty target) — all
  -- from one pass over the league's entries.
  with ranked as (
    select team_id,
      rank() over (order by pts desc, gd desc, toughest_opponent_beaten_pts desc) as rank_position
    from ladder_cup_entries
    where league_id = v_match.league_id
  ),
  leaders as (
    select count(*) as leader_count, (array_agg(team_id))[1] as sole_team_id from ranked where rank_position = 1
  )
  select
    (select rank_position from ranked where team_id = v_winner_id),
    (select rank_position from ranked where team_id = v_loser_id),
    (select case when leader_count = 1 then sole_team_id else null end from leaders)
  into v_winner_rank, v_loser_rank, v_sole_leader_id;

  v_beat_higher_rank := (not v_match.is_walkover) and v_loser_rank < v_winner_rank;
  v_is_bounty_target := (not v_match.is_walkover) and v_sole_leader_id = v_loser_id;
  v_streak_after := v_winner.streak + 1;

  if v_match.is_walkover then
    v_upset := 0; v_heater := 0; v_bounty := 0;
    v_gained := v_base;
  else
    v_upset := case when v_beat_higher_rank then 1 else 0 end; -- UPSET_BONUS
    v_heater := case when v_streak_after >= 3 then 1 else 0 end; -- HEATER_STREAK_START/HEATER_BONUS
    v_bounty := case when v_is_bounty_target then 2 else 0 end; -- BOUNTY_BONUS
    v_gained := v_base + v_upset + v_heater + v_bounty;
  end if;

  -- gd: regulation always counts, penalties never do, extra time is
  -- gated by COUNT_EXTRA_TIME_IN_GD which is currently false in
  -- ladderCup.js — mirrored here as always-off. Walkovers are 0-0.
  v_gd_delta := coalesce(v_winner_goals, 0) - coalesce(v_loser_goals, 0);

  -- Elo (computeEloUpdate): standard expected-score update, K=32.
  v_expected_winner := 1.0 / (1.0 + power(10.0, (v_loser.ladder_rating - v_winner.ladder_rating) / 400.0));
  -- round(double precision) isn't a direct overload in Postgres — cast
  -- through numeric, same as everywhere else this pattern is needed.
  v_elo_delta := round((32 * (1 - v_expected_winner))::numeric)::integer;
  v_winner_rating := v_winner.ladder_rating + v_elo_delta;
  v_loser_rating := v_loser.ladder_rating - v_elo_delta;

  update ladder_cup_entries set
    pts = pts + v_gained,
    w = w + 1,
    gd = gd + v_gd_delta,
    streak = v_streak_after,
    ladder_rating = v_winner_rating,
    toughest_opponent_beaten_pts = greatest(toughest_opponent_beaten_pts, v_loser.pts),
    badge_heater_tier = badge_heater_tier + v_heater,
    badge_giant_slayer = badge_giant_slayer + v_upset,
    badge_bounty_hunter = badge_bounty_hunter + v_bounty,
    badge_walkover = badge_walkover + (case when v_match.is_walkover then 1 else 0 end),
    updated_at = now()
  where id = v_winner.id;

  -- applyLoss: streak resets; second life consumed -> eliminated, else
  -- into the 24h pending_second_life window.
  if v_loser.second_life_used then
    update ladder_cup_entries set
      l = l + 1, streak = 0, gd = gd - v_gd_delta, ladder_rating = v_loser_rating,
      status = 'eliminated', second_life_offered_at = null, second_life_expires_at = null,
      updated_at = now()
    where id = v_loser.id;
  else
    update ladder_cup_entries set
      l = l + 1, streak = 0, gd = gd - v_gd_delta, ladder_rating = v_loser_rating,
      status = 'pending_second_life',
      second_life_offered_at = now(),
      second_life_expires_at = now() + interval '24 hours', -- SECOND_LIFE_WINDOW_HOURS
      updated_at = now()
    where id = v_loser.id;
  end if;

  update ladder_cup_matches set
    result_status = 'confirmed',
    result_confirmed_at = now(),
    finalized_at = now()
  where id = p_match_id;

  perform _credit_ladder_battle_match_reward(v_match.league_id, p_match_id, v_winner_id, v_loser_id, v_beat_higher_rank);
end;
$function$;
