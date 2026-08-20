-- Ladder Cup — move standings computation server-side; add ladder_battle
-- Nets reward crediting on top of it.
--
-- ROOT CAUSE (two separate holes, found while wiring Nets rewards to this
-- format):
--
-- 1. apply_ladder_cup_entry_result (20260819) writes whatever pts/w/l/gd/
--    streak/status/ladder_rating/badge_* it's given — it only checks that
--    the caller belongs to ONE of the two clubs on the match, not that
--    p_entry_id belongs to THEIR club. Every one of those fields is
--    computed in App.jsx (recordLadderCupWin, in src/formats/ladderCup.js)
--    and handed to the RPC as plain parameters. A signed-in member of
--    either club can call this RPC directly with any numbers they like.
--
-- 2. submit_ladder_cup_match_result (20260818) takes p_winner_team_id and
--    p_decided_by as caller-supplied values and only checks that
--    p_winner_team_id is one of the two clubs in the match — it never
--    checks that the claimed winner actually matches the submitted
--    scoreline. A reporter could submit "we lost 0-5" and still claim
--    p_winner_team_id = themselves.
--
-- Both matter for Nets: ladder_battle's win reward has two tiers
-- (beatHigherRank) driven by rank, which is driven by pts — so #1 lets a
-- club manufacture the upset tier for a future real win, and #2 lets a
-- club just declare a win that didn't happen. Fixing only the Nets
-- crediting RPC on top of these would still be exploitable one level
-- down.
--
-- FIX:
--  - submit_ladder_cup_match_result now derives winner/decided_by itself
--    from the submitted goals (regulation -> extra time -> penalties,
--    same order/logic as resolveMatchWinner in ladderCup.js) instead of
--    trusting the client's claim. p_winner_team_id/p_decided_by stay in
--    the signature (client still sends them, CREATE OR REPLACE needs the
--    same signature) but are no longer what gets stored.
--  - _apply_ladder_cup_match_win(p_match_id) is a new internal-only
--    function that ports recordLadderCupWin/applyLoss (pts, gd, streak,
--    ladder_rating via computeEloUpdate, toughest_opponent_beaten_pts,
--    badges, second-life transition) to SQL, computing standings and the
--    win/loss update entirely from server-held state at confirm time.
--    Guarded by ladder_cup_matches.finalized_at IS NULL, checked under
--    the same row lock the update happens in — so double-confirming a
--    match (race or replay) is a no-op, the same idempotency shape
--    fixtures.played already gives record_fixture_result.
--  - confirm_ladder_cup_match_result now delegates to that function
--    instead of just flipping result_status/finalized_at — its own
--    authorization (self-serve confirm or league creator/admin) is
--    unchanged.
--  - _credit_ladder_battle_match_reward, same shape as
--    _credit_league_fixture_reward (20260832): reward amounts port
--    economy.js's ladder_battle branch exactly (winHigher 3+1, winLower
--    1+1, loss 0+1). Walkovers always pay the winLower tier — same as
--    recordLadderCupWin, which never runs the upset check for a
--    walkover. Called once, inside _apply_ladder_cup_match_win, under
--    the same finalized_at guard — so it can't double-pay any more than
--    the standings update can double-apply.
--
-- SCOPE NOTE — what this migration does NOT fix: apply_ladder_cup_entry_
-- result is still reachable and still trusts its caller for the OTHER
-- writes that go through it — accepting/declining a second-life offer,
-- and rebirth. Those don't feed beatHigherRank (they don't touch w/l on
-- an opponent's entry, only the caller's own status/pts in ways that
-- don't grant an upset bonus to a future match) so they're out of scope
-- for what was blocking Nets specifically, but the same
-- caller-just-needs-to-be-on-either-club, not-necessarily-their-own-entry
-- gap is still real there. Flagging as follow-up, not silently claiming
-- it's closed.
--
-- Safe to run more than once, EXCEPT: any ladder_cup_matches row that
-- was finalized before this migration ran has standings already applied
-- by the old client-trusted path — this does not retroactively recheck
-- or correct historical results, only closes the hole for confirms from
-- here on.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. submit_ladder_cup_match_result — derive winner/decided_by server-side
-- ─────────────────────────────────────────────────────────────────────────
create or replace function submit_ladder_cup_match_result(
  p_match_id uuid,
  p_team_id uuid,
  p_home_goals integer,
  p_away_goals integer,
  p_extra_time_home_goals integer,
  p_extra_time_away_goals integer,
  p_pens_home integer,
  p_pens_away integer,
  p_decided_by text,
  p_winner_team_id uuid,
  p_proof_url text
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
  -- (ladderCup.js) uses: regulation, then extra time, then penalties.
  -- p_winner_team_id/p_decided_by are accepted but no longer trusted.
  if p_home_goals <> p_away_goals then
    v_winner_team_id := case when p_home_goals > p_away_goals then v_match.home_team_id else v_match.away_team_id end;
    v_decided_by := 'regulation';
  elsif v_et_home <> v_et_away then
    v_winner_team_id := case when v_et_home > v_et_away then v_match.home_team_id else v_match.away_team_id end;
    v_decided_by := 'extra_time';
  else
    if p_pens_home is null or p_pens_away is null then
      raise exception 'Match finished level — add an extra time or penalty shootout score';
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

grant execute on function submit_ladder_cup_match_result(
  uuid, uuid, integer, integer, integer, integer, integer, integer, text, uuid, text
) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. _credit_ladder_battle_match_reward — internal only, mirrors
--    _credit_league_fixture_reward's shape (20260832).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _credit_ladder_battle_match_reward(
  p_league_id uuid, p_match_id uuid,
  p_winner_team_id uuid, p_loser_team_id uuid, p_beat_higher_rank boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_winner_reward bigint := (case when p_beat_higher_rank then 3 else 1 end) + 1;
  v_loser_reward bigint := 0 + 1;
  v_member record;
begin
  for v_member in select user_id from members where league_id = p_league_id and team_id = p_winner_team_id loop
    perform _nets_credit_internal(v_member.user_id, v_winner_reward, 'ladder_battle_reward', null, 'ladder_cup_match', p_match_id::text, p_winner_team_id);
  end loop;

  for v_member in select user_id from members where league_id = p_league_id and team_id = p_loser_team_id loop
    perform _nets_credit_internal(v_member.user_id, v_loser_reward, 'ladder_battle_reward', null, 'ladder_cup_match', p_match_id::text, p_loser_team_id);
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. _apply_ladder_cup_match_win — the authoritative recompute+apply,
--    internal only. Ports recordLadderCupWin/applyLoss/computeEloUpdate
--    (ladderCup.js) to SQL.
-- ─────────────────────────────────────────────────────────────────────────
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
    select count(*) as leader_count, min(team_id) as sole_team_id from ranked where rank_position = 1
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

-- ─────────────────────────────────────────────────────────────────────────
-- 4. confirm_ladder_cup_match_result — delegate to the authoritative
--    function instead of a bare result_status/finalized_at update.
--    Authorization unchanged from 20260820.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function confirm_ladder_cup_match_result(
  p_match_id uuid,
  p_league_id uuid,
  p_team_a_id uuid,
  p_team_b_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from ladder_cup_matches m where m.id = p_match_id and m.league_id = p_league_id
  ) then
    raise exception 'Ladder cup match % not found in league %', p_match_id, p_league_id;
  end if;

  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id in (p_team_a_id, p_team_b_id)
  ) and not exists (
    select 1 from leagues l where l.id = p_league_id and l.created_by = auth.uid()
  ) then
    raise exception 'Not authorized to resolve this ladder cup match';
  end if;

  perform _apply_ladder_cup_match_win(p_match_id);
end;
$$;

grant execute on function confirm_ladder_cup_match_result(uuid, uuid, uuid, uuid) to authenticated;
