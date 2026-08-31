-- WEAFRICA SURVIVAL LADDER CUP — result submit -> confirm/dispute ->
-- admin-escalation pipeline
--
-- Before this migration, recordLadderCupMatchResult (App.jsx) wrote a
-- finalized result the instant either side submitted one: it set
-- finalized_at and applied the win/loss straight to both clubs'
-- ladder_cup_entries in the same call. That's a first-submit-wins race —
-- nothing stopped a losing side from quickly logging a favourable score
-- before their opponent got to it, and nothing gave the other side a
-- chance to confirm or dispute what got logged. Every other result path
-- in this app (league fixtures' result_submissions, challenges,
-- open_challenges) already goes through a report -> opponent
-- confirms-or-disputes -> admin-escalates-on-timeout-or-repeat-dispute
-- shape; this brings ladder_cup_matches in line with that instead of
-- special-casing it.
--
-- ladder_cup_matches is a single evolving row per match (much closer to
-- the `challenges` table's shape than to `result_submissions`, which is
-- one row per attempt) — so this follows the challenges pattern: plain
-- columns tracking who reported and when, confirm/dispute/admin-approve/
-- admin-reject all done with a normal client .update() (no RPC needed for
-- those — see App.jsx respondLadderCupMatchResult / adminResolveLadderCupMatchResult),
-- and challengeResultConfirmDeadline/Expired/MinutesLeft (App.jsx) reused
-- as-is since they only ever read `.result_reported_at` off whatever row
-- is passed in.
--
-- The one step that isn't a plain client update is the *first* submit:
-- two players tapping "Log result" on the same match within the same
-- instant is a genuine race (unlike confirm/dispute, which only the
-- non-reporting side is ever offered), so that step goes through a
-- SECURITY DEFINER RPC that re-checks the match is still open before
-- writing — same reasoning initiate_ladder_cup_match (20260815) already
-- applies to match creation.

alter table ladder_cup_matches
  add column if not exists result_status text check (result_status in ('pending', 'confirmed')),
  add column if not exists result_reported_by uuid references auth.users(id),
  add column if not exists result_reported_by_team_id uuid references teams(id),
  add column if not exists result_reported_at timestamptz,
  add column if not exists result_confirmed_at timestamptz,
  add column if not exists result_dispute_count integer not null default 0;

-- result_status is null while no result has been reported (or the last
-- reported one was disputed/rejected and cleared back to scratch),
-- 'pending' while it's reported but not yet confirmed/finalized, and
-- 'confirmed' once applied — at which point finalized_at is also set, so
-- existing `!m.finalized_at` filters (the live opponent board, cutoff
-- finalization) keep working unchanged without needing to know about
-- result_status at all.

create index if not exists idx_ladder_cup_matches_pending_result
  on ladder_cup_matches(league_id)
  where result_status = 'pending';

-- Reports a result for an open match. Re-validates match + team state
-- server-side (the caller really controls p_team_id, p_team_id is
-- actually one of the two sides on this match, the match isn't already
-- finalized or already carrying a pending report) so two callers racing
-- to submit for the same match can't both succeed — the loser of the
-- race gets a clear error instead of silently clobbering the winner's
-- report. Winner/decided_by are computed client-side by resolveMatchWinner
-- (App.jsx) before this is called and passed straight through — this RPC
-- only guards *whether* a report can land, not the scoreline arithmetic
-- itself, same division of labour recordLadderCupWin/resolveMatchWinner
-- already had.
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
  -- The race this guards against: result_status is null (or was cleared
  -- back to null by a dispute/admin-reject) right up until the instant a
  -- report lands — a second caller hitting this after the first commits
  -- lands here and is turned away rather than overwriting the first
  -- report.
  if v_match.result_status is not null then
    raise exception 'A result has already been reported for this match';
  end if;
  if p_winner_team_id <> v_match.home_team_id and p_winner_team_id <> v_match.away_team_id then
    raise exception 'Winner must be one of the two clubs in this match';
  end if;
  if p_decided_by not in ('regulation', 'extra_time', 'penalties') then
    raise exception 'Invalid result type';
  end if;

  update ladder_cup_matches set
    home_goals = p_home_goals,
    away_goals = p_away_goals,
    extra_time_home_goals = p_extra_time_home_goals,
    extra_time_away_goals = p_extra_time_away_goals,
    penalties_home = p_pens_home,
    penalties_away = p_pens_away,
    decided_by = p_decided_by,
    is_walkover = false,
    winner_team_id = p_winner_team_id,
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
