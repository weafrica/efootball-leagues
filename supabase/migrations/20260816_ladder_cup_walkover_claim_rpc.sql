-- WEAFRICA SURVIVAL LADDER CUP — RLS-safe walkover claim creation
--
-- Same wall ensure_ladder_cup_entry (20260812) and initiate_ladder_cup_match
-- (20260815) were built for: regular authenticated clients can't INSERT into
-- ladder_cup_walkover_claims directly — RLS rejects it with "new row
-- violates row-level security policy for table ladder_cup_walkover_claims",
-- which is exactly the error messageLadderCupWalkoverOpponent (App.jsx)
-- surfaces as "Couldn't start the claim: ..." the moment someone taps
-- "Message opponent". This is the one raw insert against this table that
-- never got the SECURITY DEFINER treatment its siblings did — this
-- migration closes that gap the same way.
--
-- Re-validates everything the client already checked before it does — the
-- caller really controls p_claimant_team_id, both clubs really belong to
-- this ladder_cup league, and the cutoff hasn't passed — so a caller can't
-- use it to plant a claim for an arbitrary team/league pair.
--
-- The table's own partial unique index (uq_ladder_cup_claim_per_target, on
-- (claimant_team_id, target_team_id) where status in ('messaged',
-- 'pending_review')) still does the "one open claim per target" enforcement
-- here exactly as it did against the old direct insert — a duplicate claim
-- still comes back as a 23505, which is what messageLadderCupWalkoverOpponent
-- already checks for ("You've already got an open walkover claim against
-- them."). Nothing about that client-side handling needs to change.
create or replace function start_ladder_cup_walkover_claim(
  p_league_id uuid,
  p_claimant_team_id uuid,
  p_target_team_id uuid,
  p_messaged_at timestamptz,
  p_claimable_at timestamptz
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

  insert into ladder_cup_walkover_claims
    (league_id, claimant_team_id, target_team_id, messaged_at, claimable_at, status)
  values
    (p_league_id, p_claimant_team_id, p_target_team_id, p_messaged_at, p_claimable_at, 'messaged')
  returning ladder_cup_walkover_claims.id into v_claim_id;

  return query select v_claim_id;
end;
$$;

-- Any signed-in user can call this — identical permissiveness to
-- ensure_ladder_cup_entry / initiate_ladder_cup_match: the function's own
-- checks above (not caller identity) are what keep it from being misused.
grant execute on function start_ladder_cup_walkover_claim(uuid, uuid, uuid, timestamptz, timestamptz) to authenticated;
