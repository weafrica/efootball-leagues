-- STEP 16: Survivor Ladder Cup draws.
--
-- Until now every Ladder Cup match had to resolve to a winner — a level
-- regulation scoreline forced extra time, then penalties if still level.
-- This adds a genuine draw outcome: both clubs get DRAW_POINTS (2) pts and
-- DRAW_NETS_REWARD (3) Nets each, nobody loses a life, nobody is
-- eliminated, and a win streak resets (a draw isn't a win) same as a loss
-- already does.
--
-- Touches, in order: the `d` (draws) column, the decided_by check
-- constraint, the RPC that accepts a reported result, the function that
-- actually applies it and pays out, a new Nets-payout helper for the draw
-- case, and the admin recompute's bulk-write RPC.

alter table ladder_cup_entries add column if not exists d integer not null default 0;

alter table ladder_cup_matches drop constraint if exists ladder_cup_matches_decided_by_check;
alter table ladder_cup_matches add constraint ladder_cup_matches_decided_by_check
  check (decided_by = any (array['regulation', 'extra_time', 'penalties', 'walkover', 'draw']));

-- Accepts a reported result. p_is_draw is new: true logs a level
-- scoreline as a draw instead of requiring it to be resolved by extra
-- time/penalties. p_winner_team_id/p_decided_by remain accepted-but-not-
-- trusted, same as before this migration — the server derives the real
-- outcome itself.
create or replace function submit_ladder_cup_match_result(
  p_match_id uuid, p_team_id uuid, p_home_goals integer, p_away_goals integer,
  p_extra_time_home_goals integer, p_extra_time_away_goals integer,
  p_pens_home integer, p_pens_away integer,
  p_decided_by text, p_winner_team_id uuid, p_proof_url text,
  p_is_draw boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match ladder_cup_matches%rowtype;
  v_et_home integer := coalesce(p_extra_time_home_goals, 0);
  v_et_away integer := coalesce(p_extra_time_away_goals, 0);
  v_winner_team_id uuid;
  v_decided_by text;
begin
  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id = p_team_id
  ) then
    raise exception 'Not authorized to act for this club';
  end if;

  select * into v_match from ladder_cup_matches where id = p_match_id for update;
  if not found then
    raise exception 'Match not found';
  end if;
  if v_match.home_team_id <> p_team_id and v_match.away_team_id <> p_team_id then
    raise exception 'Club % is not part of this match', p_team_id;
  end if;
  if v_match.finalized_at is not null then
    raise exception 'This match is already finalized';
  end if;
  if v_match.result_status is not null then
    raise exception 'A result has already been reported for this match';
  end if;
  if p_home_goals is null or p_away_goals is null then
    raise exception 'A score is required';
  end if;

  -- Server-derived winner/decided_by — same order resolveMatchWinner
  -- (ladderCup.js) uses: draw (if requested), then regulation, then extra
  -- time, then penalties.
  if p_is_draw then
    if p_home_goals <> p_away_goals then
      raise exception 'Scores aren''t level — this can''t be logged as a draw';
    end if;
    v_winner_team_id := null;
    v_decided_by := 'draw';
  elsif p_home_goals <> p_away_goals then
    v_winner_team_id := case when p_home_goals > p_away_goals then v_match.home_team_id else v_match.away_team_id end;
    v_decided_by := 'regulation';
  elsif v_et_home <> v_et_away then
    v_winner_team_id := case when v_et_home > v_et_away then v_match.home_team_id else v_match.away_team_id end;
    v_decided_by := 'extra_time';
  else
    if p_pens_home is null or p_pens_away is null then
      raise exception 'Match finished level — add an extra time or penalty shootout score, or log it as a draw';
    end if;
    if p_pens_home = p_pens_away then
      raise exception 'Penalties can''t be level too — someone has to win';
    end if;
    v_winner_team_id := case when p_pens_home > p_pens_away then v_match.home_team_id else v_match.away_team_id end;
    v_decided_by := 'penalties';
  end if;

  update ladder_cup_matches set
    home_goals = p_home_goals,
    away_goals = p_away_goals,
    extra_time_home_goals = p_extra_time_home_goals,
    extra_time_away_goals = p_extra_time_away_goals,
    penalties_home = p_pens_home,
    penalties_away = p_pens_away,
    decided_by = v_decided_by,
    is_walkover = false,
    winner_team_id = v_winner_team_id,
    proof_url = p_proof_url,
    result_status = 'pending',
    result_reported_by = auth.uid(),
    result_reported_by_team_id = p_team_id,
    result_reported_at = now()
  where id = p_match_id;
end;
$$;

grant execute on function submit_ladder_cup_match_result(uuid, uuid, integer, integer, integer, integer, integer, integer, text, uuid, text, boolean) to authenticated;

-- Applies a confirmed result. Adds a draw branch up front — decided_by =
-- 'draw' has no winner_team_id, so the existing win/loss logic below (all
-- of which reads v_match.winner_team_id) can't run on it and never runs
-- on it; the draw path returns before reaching that code.
create or replace function _apply_ladder_cup_match_win(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
  v_draw_home ladder_cup_entries%rowtype; -- draw branch: home-side entry
  v_draw_away ladder_cup_entries%rowtype; -- draw branch: away-side entry
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

  -- STEP 16 (draws): no winner_team_id, no elimination — flat DRAW_POINTS
  -- and DRAW_NETS_REWARD each, win streak resets same as a loss would,
  -- nothing else on either entry moves.
  if v_match.decided_by = 'draw' then
    if v_match.home_goals is null or v_match.away_goals is null then
      raise exception 'Match % has no reported result to apply', p_match_id;
    end if;

    select * into v_draw_home from ladder_cup_entries where league_id = v_match.league_id and team_id = v_match.home_team_id for update;
    select * into v_draw_away from ladder_cup_entries where league_id = v_match.league_id and team_id = v_match.away_team_id for update;
    if v_draw_home.id is null or v_draw_away.id is null then
      raise exception 'Missing ladder cup entry for one of the two clubs in match %', p_match_id;
    end if;

    update ladder_cup_entries set
      pts = pts + 2, -- DRAW_POINTS
      d = d + 1,
      streak = 0,
      updated_at = now()
    where id in (v_draw_home.id, v_draw_away.id);

    update ladder_cup_matches set
      result_status = 'confirmed',
      result_confirmed_at = now(),
      finalized_at = now()
    where id = p_match_id;

    perform _credit_ladder_battle_draw_reward(v_match.league_id, p_match_id, v_match.home_team_id, v_match.away_team_id);
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
$$;

-- Draw-only Nets payout — DRAW_NETS_REWARD (3) to every member of BOTH
-- clubs, unlike _credit_ladder_battle_match_reward's asymmetric
-- winner-only payout. Same shape otherwise (one loop per club, one
-- ledger entry per member, attributed to their own team_id).
create or replace function _credit_ladder_battle_draw_reward(p_league_id uuid, p_match_id uuid, p_team_a_id uuid, p_team_b_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draw_reward bigint := 3; -- DRAW_NETS_REWARD
  v_member record;
begin
  for v_member in select user_id from members where league_id = p_league_id and team_id = p_team_a_id loop
    perform _nets_credit_internal(v_member.user_id, v_draw_reward, 'ladder_battle_reward', null, 'ladder_cup_match', p_match_id::text, p_team_a_id);
  end loop;
  for v_member in select user_id from members where league_id = p_league_id and team_id = p_team_b_id loop
    perform _nets_credit_internal(v_member.user_id, v_draw_reward, 'ladder_battle_reward', null, 'ladder_cup_match', p_match_id::text, p_team_b_id);
  end loop;
end;
$$;

-- Admin recompute's bulk write (see recomputeLadderCupLeague /
-- computeLadderCupRecompute in App.jsx) now needs to write `d` back too —
-- coalesce onto the row's current value so a payload from a not-yet-
-- updated client (missing the key entirely) doesn't null it out.
create or replace function bulk_apply_ladder_cup_entries(p_league_id uuid, p_entries jsonb)
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
      d = coalesce((v_entry->>'d')::integer, d),
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
