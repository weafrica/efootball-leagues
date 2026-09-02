-- WEAFRICA SURVIVAL LADDER CUP — "opponents only face each other once"
--
-- The client-side rule (getOpponentPool, formats/ladderCup.js) now excludes
-- any club with a FINALIZED ladder_cup_matches row against the viewer, so
-- a rematch pairing no longer shows up in the Challenge board or the
-- read-only Find Opponent lookup. But that's only what's SHOWN — nothing
-- stopped a caller who already knows the opponent's team_id from invoking
-- initiate_ladder_cup_match(p_league_id, p_team_id, p_opponent_team_id)
-- directly with a pairing that's already been decided. This closes that
-- gap server-side, the same way the existing open-match dedupe check just
-- above it already guards against a double-challenge.
--
-- "Already faced" means a finalized match exists between the two clubs in
-- THIS league — finalized_at is set by _apply_ladder_cup_match_win
-- (20260833) for both played results and, since 20260837, approved
-- walkover claims (approve_ladder_cup_walkover_claim inserts a real
-- ladder_cup_matches row and routes it through the same function) — so
-- one finalized_at check catches both ways two clubs can have already met.
-- A still-open (finalized_at is null) match is unaffected here; that's
-- what the existing check right above already handles.
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

  -- "Opponents only face each other once" — reject if these two clubs
  -- already have a finalized (played or walkover) match between them in
  -- this league. This is the server-side twin of the getOpponentPool
  -- exclusion; the UI shouldn't be able to offer this pairing at all, but
  -- a caller invoking the RPC directly could otherwise still slip past it.
  if exists (
    select 1 from ladder_cup_matches m
    where m.league_id = p_league_id and m.finalized_at is not null
      and ((m.home_team_id = p_team_id and m.away_team_id = p_opponent_team_id)
        or (m.home_team_id = p_opponent_team_id and m.away_team_id = p_team_id))
  ) then
    raise exception 'These clubs have already faced each other in this Ladder Cup';
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

-- A walkover claim is just the other way two clubs "face" each other in
-- this Ladder Cup (see 20260837 — it produces a real, finalized
-- ladder_cup_matches row same as a played match), so the once-only rule
-- has to hold here too, at both ends of the claim flow:
--
--   1. claim_ladder_cup_walkover: don't let a claim even be FILED against
--      a club that's already been finalized-faced — otherwise a pending
--      claim could sit around for a pairing that was never going to be
--      approvable anyway.
--   2. approve_ladder_cup_walkover_claim: the actual enforcement point,
--      since it's the one that inserts the match row — a same-cutoff race
--      (a played match against that same opponent finalizing between claim
--      and approval) could otherwise still let a duplicate finalized match
--      through even if the claim-time check above passed.
create or replace function claim_ladder_cup_walkover(
  p_league_id uuid,
  p_claimant_team_id uuid,
  p_target_team_id uuid,
  p_claimed_at timestamptz,
  p_proof_url text
)
returns table (id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id uuid;
begin
  if p_claimant_team_id is null or p_target_team_id is null then
    raise exception 'Both clubs are required';
  end if;
  if p_claimant_team_id = p_target_team_id then
    raise exception 'A club cannot claim a walkover against itself';
  end if;
  if p_proof_url is null or length(trim(p_proof_url)) = 0 then
    raise exception 'Photo proof is required to claim a walkover';
  end if;

  -- Caller must actually control p_claimant_team_id (same ownership check
  -- initiate_ladder_cup_match relies on).
  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id = p_claimant_team_id
  ) then
    raise exception 'Not authorized to act for this club';
  end if;

  -- Both clubs must genuinely be ladder_cup clubs in this exact league —
  -- same shape of check the entry/match RPCs already do.
  if not exists (
    select 1 from teams t join leagues l on l.id = t.league_id
    where t.id = p_claimant_team_id and t.league_id = p_league_id and l.format = 'ladder_cup'
  ) then
    raise exception 'Club % is not a ladder_cup club in league %', p_claimant_team_id, p_league_id;
  end if;
  if not exists (
    select 1 from teams t join leagues l on l.id = t.league_id
    where t.id = p_target_team_id and t.league_id = p_league_id and l.format = 'ladder_cup'
  ) then
    raise exception 'Club % is not a ladder_cup club in league %', p_target_team_id, p_league_id;
  end if;

  if exists (
    select 1 from leagues l
    where l.id = p_league_id and l.ladder_cup_cutoff_at is not null and l.ladder_cup_cutoff_at <= now()
  ) then
    raise exception 'The Ladder Cup cutoff has passed — no new walkover claims';
  end if;

  -- "Opponents only face each other once" — same finalized-match check
  -- initiate_ladder_cup_match now does.
  if exists (
    select 1 from ladder_cup_matches m
    where m.league_id = p_league_id and m.finalized_at is not null
      and ((m.home_team_id = p_claimant_team_id and m.away_team_id = p_target_team_id)
        or (m.home_team_id = p_target_team_id and m.away_team_id = p_claimant_team_id))
  ) then
    raise exception 'These clubs have already faced each other in this Ladder Cup';
  end if;

  insert into ladder_cup_walkover_claims
    (league_id, claimant_team_id, target_team_id, claimed_at, status, proof_url)
  values
    (p_league_id, p_claimant_team_id, p_target_team_id, p_claimed_at, 'pending_review', p_proof_url)
  returning ladder_cup_walkover_claims.id into v_claim_id;

  return query select v_claim_id;
end;
$$;

grant execute on function claim_ladder_cup_walkover(uuid, uuid, uuid, timestamptz, text) to authenticated;

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

  -- Re-checked here (not just at claim time) — this is the function that
  -- actually inserts the finalized match row, so it's the last line of
  -- defense against a duplicate finalized pairing slipping through a race
  -- with some other match against the same opponent finalizing in between.
  if exists (
    select 1 from ladder_cup_matches m
    where m.league_id = v_claim.league_id and m.finalized_at is not null
      and ((m.home_team_id = v_claim.claimant_team_id and m.away_team_id = v_claim.target_team_id)
        or (m.home_team_id = v_claim.target_team_id and m.away_team_id = v_claim.claimant_team_id))
  ) then
    raise exception 'These clubs have already faced each other in this Ladder Cup';
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
