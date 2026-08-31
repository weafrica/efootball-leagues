-- Nets — route Ladder Cup walkover claim approval through
-- _apply_ladder_cup_match_win, closing the "walkover wins pay 0 Nets"
-- gap and the client-trusted-numbers gap it shares with the standings
-- bug 20260833 already fixed for played matches.
--
-- CONFIRMED (App.jsx, approveLadderCupWalkoverClaim): approving a
-- walkover claim today never creates a ladder_cup_matches row at all.
-- It runs recordLadderCupWin(isWalkover: true) in the BROWSER, then
-- pushes the resulting pts/w/l/gd/streak/rating/badges straight to
-- apply_ladder_cup_entry_result (20260821) — the same client-trusted
-- path 20260833's scope note flagged as still-open for entry writes
-- other than match wins. Two consequences:
--   1. No Nets — nothing on this path has ever called nets_credit or
--      _nets_credit_internal.
--   2. The exact same "any club member can hand-craft the numbers"
--      exposure 20260833 closed for played/decider matches is still
--      wide open for every walkover, including the beatHigherRank-
--      adjacent fields (toughest_opponent_beaten_pts, ladder_rating).
--
-- FIX: a walkover claim is really just a match with a 0-0 (by
-- convention) scoreline and a known winner — so give it a real
-- ladder_cup_matches row and run it through the exact same authoritative
-- path 20260833 built: _apply_ladder_cup_match_win. That function
-- already special-cases is_walkover (skips upset/bounty/streak bonuses,
-- pays base-only pts, bumps badge_walkover, and — per
-- _credit_ladder_battle_match_reward — always pays the winLower Nets
-- tier for a walkover) — it just never had a caller that set
-- is_walkover = true before now.
--
-- decided_by's check constraint only allowed regulation/extra_time/
-- penalties (walkovers never went through ladder_cup_matches at all
-- until now, so nothing needed 'walkover' as a value before) — widened
-- here to include it.
--
-- approve_ladder_cup_walkover_claim(p_claim_id) is the new single entry
-- point: locks the claim row, checks it's still pending_review (so a
-- claim can't be approved twice — same idempotency the finalized_at
-- guard gives matches, just at the claim-row level since a claim can
-- only ever produce one match), checks the same cutoff rule
-- claim_ladder_cup_walkover already enforces at claim time, requires
-- admin or league-creator (canManageLeague's own two checks, matching
-- what the client already gates this button on), inserts the match row,
-- delegates to _apply_ladder_cup_match_win, then marks the claim
-- approved. App.jsx's approveLadderCupWalkoverClaim needs to call this
-- RPC instead of computing/pushing the result itself — see the
-- accompanying App.jsx change.
--
-- reject_ladder_cup_walkover_claim(p_claim_id) is pulled in alongside
-- it — same status/authorization checks, no side effects beyond the
-- claim row, replacing the current bare .update() from the client so
-- both actions go through a consistent, race-safe path rather than one
-- guarded server-side and one not.
--
-- Safe to run more than once, EXCEPT: claims already approved before
-- this migration ran were paid out (if at all) through the old
-- client-trusted path and are not retroactively corrected or re-paid —
-- same carve-out 20260833 stated for pre-existing finalized matches.

alter table ladder_cup_matches drop constraint if exists ladder_cup_matches_decided_by_check;
alter table ladder_cup_matches add constraint ladder_cup_matches_decided_by_check
  check (decided_by in ('regulation', 'extra_time', 'penalties', 'walkover'));

create or replace function approve_ladder_cup_walkover_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim ladder_cup_walkover_claims%rowtype;
  v_match_id uuid;
begin
  select * into v_claim from ladder_cup_walkover_claims where id = p_claim_id for update;
  if not found then
    raise exception 'Walkover claim % not found', p_claim_id;
  end if;
  if v_claim.status <> 'pending_review' then
    raise exception 'This claim has already been reviewed';
  end if;

  if not exists (select 1 from admins a where a.user_id = auth.uid())
     and not exists (select 1 from leagues l where l.id = v_claim.league_id and l.created_by = auth.uid()) then
    raise exception 'Not authorized to approve this walkover claim';
  end if;

  if exists (
    select 1 from leagues l
    where l.id = v_claim.league_id and l.ladder_cup_cutoff_at is not null and l.ladder_cup_cutoff_at <= now()
  ) then
    raise exception 'The Ladder Cup cutoff has passed — this claim can no longer be approved';
  end if;

  insert into ladder_cup_matches
    (league_id, home_team_id, away_team_id, home_goals, away_goals,
     decided_by, is_walkover, winner_team_id, proof_url)
  values
    (v_claim.league_id, v_claim.claimant_team_id, v_claim.target_team_id, 0, 0,
     'walkover', true, v_claim.claimant_team_id, v_claim.proof_url)
  returning id into v_match_id;

  perform _apply_ladder_cup_match_win(v_match_id);

  update ladder_cup_walkover_claims set
    status = 'approved', approved_at = now(), reviewed_by = auth.uid()
  where id = p_claim_id;
end;
$$;

grant execute on function approve_ladder_cup_walkover_claim(uuid) to authenticated;

create or replace function reject_ladder_cup_walkover_claim(p_claim_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim ladder_cup_walkover_claims%rowtype;
begin
  select * into v_claim from ladder_cup_walkover_claims where id = p_claim_id for update;
  if not found then
    raise exception 'Walkover claim % not found', p_claim_id;
  end if;
  if v_claim.status <> 'pending_review' then
    raise exception 'This claim has already been reviewed';
  end if;

  if not exists (select 1 from admins a where a.user_id = auth.uid())
     and not exists (select 1 from leagues l where l.id = v_claim.league_id and l.created_by = auth.uid()) then
    raise exception 'Not authorized to reject this walkover claim';
  end if;

  update ladder_cup_walkover_claims set
    status = 'rejected', reviewed_by = auth.uid()
  where id = p_claim_id;
end;
$$;

grant execute on function reject_ladder_cup_walkover_claim(uuid) to authenticated;
