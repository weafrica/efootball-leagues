-- League Ladder — result approval, RPC 1 of 4: report-only submit.
--
-- ROOT CAUSE this replaces: submit_ladder_fixture_result (20260857,
-- amended by 20260878) writes a finalized result the instant EITHER
-- participant submits one — it sets status='played' and credits the
-- match reward in the same call. That's the exact "first-submit-wins,
-- no chance for the other side to confirm or dispute" shape
-- 20260818_ladder_cup_result_pipeline.sql's own header describes Ladder
-- Cup having before its pipeline went in. This migration brings
-- ladder_fixtures in line the same way, using the
-- ladder_fixture_result_submissions table from 20260887.
--
-- Return type changes from ladder_fixtures to
-- ladder_fixture_result_submissions (this no longer writes the fixture
-- row at all), so the old function is dropped first rather than
-- CREATE OR REPLACE'd in place.
drop function if exists submit_ladder_fixture_result(uuid, integer, integer);

create or replace function submit_ladder_fixture_result(
  p_fixture_id uuid,
  p_home_score integer,
  p_away_score integer,
  p_proof_url text default null
) returns ladder_fixture_result_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_fixture ladder_fixtures%rowtype;
  v_locked boolean;
  v_submission ladder_fixture_result_submissions%rowtype;
begin
  if v_user_id is null then
    raise exception 'submit_ladder_fixture_result: must be signed in';
  end if;
  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'submit_ladder_fixture_result: scores must be non-negative';
  end if;

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'submit_ladder_fixture_result: fixture not found';
  end if;
  if v_fixture.status <> 'pending' then
    raise exception 'submit_ladder_fixture_result: fixture is not pending';
  end if;

  v_is_admin := exists (select 1 from admins a where a.user_id = v_user_id);

  if not v_is_admin and v_user_id <> v_fixture.home_user_id and v_user_id <> v_fixture.away_user_id then
    raise exception 'submit_ladder_fixture_result: not a participant in this fixture';
  end if;

  -- Same lock-window carve-out as before: admins can still log a result
  -- after the Sunday 10PM lock, participants cannot.
  select fixtures_locked into v_locked from ladder_cycle where id = true;
  if v_locked and not v_is_admin then
    raise exception 'submit_ladder_fixture_result: fixtures are locked for this week';
  end if;

  -- One open submission per fixture at a time — the race this guards
  -- against: two callers racing to submit for the same still-pending
  -- fixture. Mirrors the "result already reported" guard
  -- submit_ladder_cup_match_result uses, applied here to a
  -- one-pending-row-per-fixture rule instead of a single status column.
  if exists (
    select 1 from ladder_fixture_result_submissions
    where fixture_id = p_fixture_id and status = 'pending'
  ) then
    raise exception 'submit_ladder_fixture_result: a result is already awaiting confirmation for this fixture';
  end if;

  insert into ladder_fixture_result_submissions (fixture_id, submitted_by, home_score, away_score, proof_url)
  values (p_fixture_id, v_user_id, p_home_score, p_away_score, p_proof_url)
  returning * into v_submission;

  return v_submission;
end;
$$;

grant execute on function submit_ladder_fixture_result(uuid, integer, integer, text) to authenticated;
