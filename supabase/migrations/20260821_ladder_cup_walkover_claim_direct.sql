-- WEAFRICA SURVIVAL LADDER CUP — walkover claims go direct, no message/wait
--
-- Previously: message opponent (status 'messaged') → wait 24h
-- (claimable_at) → submit screenshot → 'pending_review'. Product change:
-- the app now has a single "Claim walkover" button that requires a
-- screenshot up front and drops the claim straight into 'pending_review' —
-- no messaging step, no waiting period. This migration reshapes the table
-- and RLS-safe insert path to match; see src/formats/ladderCup.js
-- (createWalkoverClaim) and App.jsx (claimLadderCupWalkover) for the
-- application-side change.

-- 0. Any claim still sitting in 'messaged' is mid-flight under the old
--    flow (opponent messaged, no screenshot yet) — there's no proof to
--    carry forward and no wait left to finish, so these can't become
--    valid 'pending_review' rows. Reject them outright rather than
--    silently deleting; same end state a claimant would've reached by
--    letting an old claim lapse, and it keeps a visible trail (a rejected
--    claim just means "no open claim" for uq_ladder_cup_claim_per_target).
--    Safe to run even if the table has no 'messaged' rows.
update ladder_cup_walkover_claims set status = 'rejected'
  where status = 'messaged';

-- 0b. Some rows can still have a null proof_url after the above — e.g. an
--     'approved'/'rejected' claim from before screenshots were mandatory
--     at all. Backfill a placeholder rather than touch their status: an
--     approved claim already had its result applied to the ladder, and
--     rewriting history there would misrepresent what actually happened.
--     The placeholder is obviously not a real URL, so a "View screenshot"
--     tap on one of these just 404s — same as it effectively does today
--     with proof_url null.
update ladder_cup_walkover_claims set proof_url = 'legacy-no-proof-on-file'
  where proof_url is null;

-- 1. messaged_at → claimed_at (same column, new name/meaning: the moment
--    the claim — proof and all — was submitted, not the moment someone
--    was messaged).
alter table ladder_cup_walkover_claims rename column messaged_at to claimed_at;

-- 2. claimable_at no longer means anything — there's no wait to clear.
--    Drop it rather than leave a dead not-null column the app would have
--    to keep faking a value for.
alter table ladder_cup_walkover_claims drop column if exists claimable_at;

-- 3. proof_url is now supplied at insert time, not filled in later by a
--    follow-up update — make that required. Only 'approved'/'rejected'/
--    'pending_review' rows remain after step 0, and 'pending_review' was
--    already only reachable via a screenshot upload, so every remaining
--    row already has one; this is safe to enforce now.
alter table ladder_cup_walkover_claims alter column proof_url set not null;

-- 4. 'messaged' is no longer a reachable status — every claim is created
--    straight into 'pending_review'.
alter table ladder_cup_walkover_claims drop constraint if exists ladder_cup_walkover_claims_status_check;
alter table ladder_cup_walkover_claims add constraint ladder_cup_walkover_claims_status_check
  check (status in ('pending_review', 'approved', 'rejected'));
alter table ladder_cup_walkover_claims alter column status set default 'pending_review';

-- 5. Same "one open claim per target" rule, just against the narrower
--    status set now that 'messaged' can't occur.
drop index if exists uq_ladder_cup_claim_per_target;
create unique index if not exists uq_ladder_cup_claim_per_target
  on ladder_cup_walkover_claims(claimant_team_id, target_team_id)
  where status = 'pending_review';

-- 6. RLS-safe direct-claim insert, replacing start_ladder_cup_walkover_claim
-- (20260816) the same way that one replaced a raw client insert — regular
-- authenticated clients still can't INSERT into ladder_cup_walkover_claims
-- directly. Re-validates everything the client already checked: the
-- caller really controls p_claimant_team_id, both clubs really belong to
-- this ladder_cup league, and the cutoff hasn't passed — a caller can't
-- use it to plant a claim for an arbitrary team/league pair. Proof is
-- required — this function is the one place a walkover claim can be
-- created at all now, so "no photo, no claim" is enforced here too, not
-- just client-side.
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

  insert into ladder_cup_walkover_claims
    (league_id, claimant_team_id, target_team_id, claimed_at, status, proof_url)
  values
    (p_league_id, p_claimant_team_id, p_target_team_id, p_claimed_at, 'pending_review', p_proof_url)
  returning ladder_cup_walkover_claims.id into v_claim_id;

  return query select v_claim_id;
end;
$$;

grant execute on function claim_ladder_cup_walkover(uuid, uuid, uuid, timestamptz, text) to authenticated;

-- 7. Retire the old two-step RPC — nothing calls it anymore.
drop function if exists start_ladder_cup_walkover_claim(uuid, uuid, uuid, timestamptz, timestamptz);
