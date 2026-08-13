-- WEAFRICA SURVIVAL LADDER CUP — RLS-safe entry updates after a result
--
-- ROOT CAUSE: ladder_cup_entries already blocks a plain client INSERT for
-- regular users (see 20260812_ladder_cup_entry_rpc.sql's comment — "new row
-- violates row-level security policy for table ladder_cup_entries"), which
-- is exactly why ensure_ladder_cup_entry exists. The three places that
-- later WRITE to that same table — applyLadderCupMatchResult,
-- approveLadderCupWalkoverClaim, and respondLadderCupSecondLife (all in
-- App.jsx) — were never given the equivalent treatment; they still do a
-- plain supabase.from("ladder_cup_entries").update(...) straight from the
-- client. Under the same RLS that blocks the insert, these updates fail
-- silently from the user's point of view: the .update() call resolves with
-- an error, App.jsx already catches that (winnerErr/loserErr) and shows a
-- "couldn't be fully updated — check permissions" toast, but the row's
-- pts/w/l/gd/status never change. That's what's behind "confirmed results
-- don't show on the table" and "the eliminated club isn't marked out" —
-- the match itself finalizes fine (ladder_cup_matches has its own,
-- separate update path that a participant IS allowed to hit directly), but
-- the standings row backing the table and the status badge never updates.
--
-- Fix: give entry updates the same SECURITY DEFINER treatment
-- ensure_ladder_cup_entry already gets for inserts. Authorization mirrors
-- what the client already checked before calling in: either caller is a
-- member of one of the two clubs the result concerns (self-serve confirm/
-- dispute/second-life), or caller created the league (admin approve/
-- reject paths — same check App.jsx's canManageLeague already uses via
-- leagues.created_by). Swap in your real admin check here if you track
-- platform admins separately from league creators.
create or replace function apply_ladder_cup_entry_result(
  p_entry_id uuid,
  p_league_id uuid,
  p_team_a_id uuid,
  p_team_b_id uuid,
  p_pts integer,
  p_w integer,
  p_l integer,
  p_gd integer,
  p_streak integer,
  p_status text,
  p_second_life_used boolean,
  p_second_life_offered_at timestamptz,
  p_second_life_expires_at timestamptz,
  p_toughest_opponent_beaten_pts integer,
  p_ladder_rating integer,
  p_badge_heater_tier smallint,
  p_badge_giant_slayer integer,
  p_badge_second_life boolean,
  p_badge_walkover integer,
  p_badge_bounty_hunter integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from ladder_cup_entries e where e.id = p_entry_id and e.league_id = p_league_id
  ) then
    raise exception 'Ladder cup entry % not found in league %', p_entry_id, p_league_id;
  end if;

  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id in (p_team_a_id, p_team_b_id)
  ) and not exists (
    select 1 from leagues l where l.id = p_league_id and l.created_by = auth.uid()
  ) then
    raise exception 'Not authorized to update this ladder cup entry';
  end if;

  update ladder_cup_entries set
    pts = p_pts, w = p_w, l = p_l, gd = p_gd, streak = p_streak, status = p_status,
    second_life_used = p_second_life_used,
    second_life_offered_at = p_second_life_offered_at,
    second_life_expires_at = p_second_life_expires_at,
    toughest_opponent_beaten_pts = p_toughest_opponent_beaten_pts,
    ladder_rating = p_ladder_rating,
    badge_heater_tier = p_badge_heater_tier,
    badge_giant_slayer = p_badge_giant_slayer,
    badge_second_life = p_badge_second_life,
    badge_walkover = p_badge_walkover,
    badge_bounty_hunter = p_badge_bounty_hunter,
    updated_at = now()
  where id = p_entry_id;
end;
$$;

grant execute on function apply_ladder_cup_entry_result(
  uuid, uuid, uuid, uuid, integer, integer, integer, integer, integer, text,
  boolean, timestamptz, timestamptz, integer, integer, smallint, integer, boolean, integer, integer
) to authenticated;
