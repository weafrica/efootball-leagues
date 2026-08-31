-- League Ladder — Phase 2: manual result submission.
--
-- Deliberately simple for this phase: either participant (or an admin)
-- submits both scores in one call, the fixture goes straight to 'played'
-- — no separate confirm-by-opponent step, no dispute/escalation window
-- like challenges/open_challenges have. Phase 2's own goal is just
-- "fixtures generate, matches get played, standings compute correctly";
-- a confirm/dispute flow can be layered on top later the same way it
-- exists elsewhere in the app, but nothing here assumes that's coming —
-- this is a real, usable path on its own, not a placeholder.
--
-- Safe to run more than once.

create or replace function submit_ladder_fixture_result(
  p_fixture_id uuid,
  p_home_score integer,
  p_away_score integer
) returns ladder_fixtures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_fixture ladder_fixtures%rowtype;
  v_locked boolean;
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

  -- Admins can still record a result after the Sunday 10PM lock (a late
  -- correction, a dispute resolved after the fact); participants cannot.
  select fixtures_locked into v_locked from ladder_cycle where id = true;
  if v_locked and not v_is_admin then
    raise exception 'submit_ladder_fixture_result: fixtures are locked for this week';
  end if;

  update ladder_fixtures
  set home_score = p_home_score, away_score = p_away_score, status = 'played', played_at = now()
  where id = p_fixture_id
  returning * into v_fixture;

  return v_fixture;
end;
$$;

grant execute on function submit_ladder_fixture_result(uuid, integer, integer) to authenticated;
