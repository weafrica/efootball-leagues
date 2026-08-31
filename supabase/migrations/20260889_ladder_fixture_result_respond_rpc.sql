-- League Ladder — result approval, RPC 2 of 4: opponent confirm/dispute.
--
-- Mirrors respond_to_result_submission (20260828) almost exactly, just
-- keyed off ladder_fixtures' home_user_id/away_user_id (individual
-- players) instead of a members/team_id join. This is the step that
-- actually finalizes a result on the happy path — and the point where
-- the match reward now gets credited (moved here from the old one-shot
-- submit_ladder_fixture_result), closing the "reward pays out on an
-- unconfirmed report" gap the previous flow had.
--
-- Safe to run more than once.

create or replace function respond_to_ladder_fixture_result_submission(
  p_submission_id uuid,
  p_accept boolean
) returns ladder_fixture_result_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_sub ladder_fixture_result_submissions%rowtype;
  v_fixture ladder_fixtures%rowtype;
begin
  if v_user_id is null then
    raise exception 'respond_to_ladder_fixture_result_submission: must be signed in';
  end if;

  select * into v_sub from ladder_fixture_result_submissions where id = p_submission_id for update;
  if v_sub.id is null then
    raise exception 'respond_to_ladder_fixture_result_submission: submission not found';
  end if;
  if v_sub.status <> 'pending' then
    raise exception 'respond_to_ladder_fixture_result_submission: this result has already been resolved';
  end if;

  select * into v_fixture from ladder_fixtures where id = v_sub.fixture_id for update;
  if v_fixture.id is null then
    raise exception 'respond_to_ladder_fixture_result_submission: fixture not found';
  end if;

  -- Caller must be the OTHER participant in this fixture, not the one who
  -- submitted — same rule respond_to_result_submission enforces via a
  -- team_id comparison; here it's a direct user_id comparison since
  -- ladder_fixtures' participants are individual players.
  if v_user_id <> v_fixture.home_user_id and v_user_id <> v_fixture.away_user_id then
    raise exception 'respond_to_ladder_fixture_result_submission: not a participant in this fixture';
  end if;
  if v_user_id = v_sub.submitted_by then
    raise exception 'respond_to_ladder_fixture_result_submission: you cannot confirm your own submission — waiting on the other player';
  end if;

  if p_accept then
    -- Same race guard approve_result_submission uses: the fixture
    -- already has a result recorded another way (an admin typed it in
    -- directly, or the auto-approve sweep already fired) while this
    -- submission sat pending — reject instead of clobbering it.
    if v_fixture.status <> 'pending' then
      update ladder_fixture_result_submissions
      set status = 'rejected', reviewed_by = v_user_id, reviewed_at = now()
      where id = p_submission_id
      returning * into v_sub;
      return v_sub;
    end if;

    update ladder_fixtures
    set home_score = v_sub.home_score, away_score = v_sub.away_score,
        status = 'played', played_at = now()
    where id = v_fixture.id;

    update ladder_fixture_result_submissions
    set status = 'approved', reviewed_by = v_user_id, reviewed_at = now()
    where id = p_submission_id
    returning * into v_sub;

    perform _credit_ladder_match_reward_internal(v_fixture.id);
  else
    update ladder_fixture_result_submissions
    set status = 'rejected', reviewed_by = v_user_id, reviewed_at = now()
    where id = p_submission_id
    returning * into v_sub;
  end if;

  return v_sub;
end;
$$;

grant execute on function respond_to_ladder_fixture_result_submission(uuid, boolean) to authenticated;
