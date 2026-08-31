-- League Ladder — result approval, RPC 3 of 4: admin approve/reject.
--
-- A submission reaches the admin queue once
-- ladderFixtureResultEscalationReason (client) flags it — 30 minutes with
-- no opponent response ("timeout"), or the fixture's already had 2 prior
-- rejected submissions ("dispute-cap"). These two RPCs are the admin-side
-- twins of respond_to_ladder_fixture_result_submission (20260889),
-- authorized against the global admins table (League Ladder has no
-- per-league creator/owner — ladder_leagues carries no created_by column
-- — unlike regular fixtures' approve_result_submission, which also
-- accepts the league creator).
--
-- _admin_approve_ladder_fixture_result_internal is factored out
-- separately so the real admin-facing RPC below and the 1-hour
-- auto-approve sweep (20260891) share one write path — "a human clicked
-- approve" and "the clock ran out" are the same event as far as the
-- fixture/reward/submission rows are concerned.
--
-- Safe to run more than once.

create or replace function _admin_approve_ladder_fixture_result_internal(
  p_submission_id uuid,
  p_admin_user_id uuid
) returns ladder_fixture_result_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub ladder_fixture_result_submissions%rowtype;
  v_fixture ladder_fixtures%rowtype;
begin
  select * into v_sub from ladder_fixture_result_submissions where id = p_submission_id for update;
  if v_sub.id is null then
    raise exception '_admin_approve_ladder_fixture_result_internal: submission not found';
  end if;
  if v_sub.status <> 'pending' then
    raise exception '_admin_approve_ladder_fixture_result_internal: this result has already been resolved';
  end if;

  select * into v_fixture from ladder_fixtures where id = v_sub.fixture_id for update;
  if v_fixture.id is null then
    raise exception '_admin_approve_ladder_fixture_result_internal: fixture not found';
  end if;

  -- Same already-resolved-another-way race guard as the opponent path.
  if v_fixture.status <> 'pending' then
    update ladder_fixture_result_submissions
    set status = 'rejected', reviewed_by = p_admin_user_id, reviewed_at = now()
    where id = p_submission_id
    returning * into v_sub;
    return v_sub;
  end if;

  update ladder_fixtures
  set home_score = v_sub.home_score, away_score = v_sub.away_score,
      status = 'played', played_at = now()
  where id = v_fixture.id;

  update ladder_fixture_result_submissions
  set status = 'approved', reviewed_by = p_admin_user_id, reviewed_at = now()
  where id = p_submission_id
  returning * into v_sub;

  perform _credit_ladder_match_reward_internal(v_fixture.id);

  return v_sub;
end;
$$;

-- Deliberately no grant on the _internal function — reachable only from
-- the two wrappers below and from the auto-approve sweep, same
-- no-direct-grant convention as every other _*_internal function here.

create or replace function admin_approve_ladder_fixture_result(p_submission_id uuid)
returns ladder_fixture_result_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'admin_approve_ladder_fixture_result: admin only';
  end if;

  return _admin_approve_ladder_fixture_result_internal(p_submission_id, v_user_id);
end;
$$;

grant execute on function admin_approve_ladder_fixture_result(uuid) to authenticated;

create or replace function admin_reject_ladder_fixture_result(p_submission_id uuid, p_note text default null)
returns ladder_fixture_result_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_sub ladder_fixture_result_submissions%rowtype;
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'admin_reject_ladder_fixture_result: admin only';
  end if;

  select * into v_sub from ladder_fixture_result_submissions where id = p_submission_id for update;
  if v_sub.id is null then
    raise exception 'admin_reject_ladder_fixture_result: submission not found';
  end if;
  if v_sub.status <> 'pending' then
    raise exception 'admin_reject_ladder_fixture_result: this result has already been resolved';
  end if;

  update ladder_fixture_result_submissions
  set status = 'rejected', reviewed_by = v_user_id, reviewed_at = now(), review_note = p_note
  where id = p_submission_id
  returning * into v_sub;

  return v_sub;
end;
$$;

grant execute on function admin_reject_ladder_fixture_result(uuid, text) to authenticated;
