-- WEAFRICA SURVIVAL LADDER CUP — RLS-safe match confirm/clear
--
-- ROOT CAUSE: 20260818_ladder_cup_result_pipeline.sql's own comment says
-- "confirm/dispute/admin-approve/admin-reject all done with a normal
-- client .update() (no RPC needed for those)". That held for the
-- confirm/dispute half — the acting user IS a member of one of the two
-- clubs on the match, same as the report step. It did NOT hold for the
-- admin-approve/admin-reject half: a match only reaches the admin queue
-- (ladderCupResultEscalationReason) once the confirmation window has
-- timed out or the dispute cap's been hit, and the admin resolving it is
-- routinely not a member of either club — so whatever RLS policy lets a
-- participant update their own match row doesn't cover the admin. The
-- update silently fails, applyLadderCupMatchResult/clearLadderCupMatchResult
-- return before result_status ever changes, and the match — still
-- "pending" — never leaves the review queue no matter how many times
-- Approve/Reject is clicked.
--
-- Fix: give both writes the same SECURITY DEFINER treatment
-- ensure_ladder_cup_entry / apply_ladder_cup_entry_result already use.
-- Authorization accepts either side (self-serve confirm/dispute keeps
-- working exactly as before) OR the league creator (the admin path —
-- same convention as apply_ladder_cup_entry_result's migration; swap in
-- your real platform-admin check here too if you track one separately).
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

  update ladder_cup_matches set
    result_status = 'confirmed',
    result_confirmed_at = now(),
    finalized_at = now()
  where id = p_match_id;
end;
$$;

grant execute on function confirm_ladder_cup_match_result(uuid, uuid, uuid, uuid) to authenticated;

-- Same authorization, for the dispute/admin-reject side: wipes a reported
-- result back to scratch and bumps result_dispute_count, same shape
-- clearLadderCupMatchResult (App.jsx) already builds client-side — this
-- just gives it somewhere it's actually allowed to write.
create or replace function clear_ladder_cup_match_result(
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

  update ladder_cup_matches set
    home_goals = null, away_goals = null, extra_time_home_goals = null, extra_time_away_goals = null,
    penalties_home = null, penalties_away = null, decided_by = null, winner_team_id = null, proof_url = null,
    result_status = null, result_reported_by = null, result_reported_by_team_id = null, result_reported_at = null,
    result_dispute_count = coalesce(result_dispute_count, 0) + 1
  where id = p_match_id;
end;
$$;

grant execute on function clear_ladder_cup_match_result(uuid, uuid, uuid, uuid) to authenticated;
