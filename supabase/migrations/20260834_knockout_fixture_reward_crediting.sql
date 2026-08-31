-- Nets — match reward crediting for "knockout" format fixtures (and
-- groups_knockout's bracket stage, stage 2).
--
-- Follow-on to 20260832, which deliberately left this format out because
-- it was framed at the time as a per-TIE reward — and one fixture's score
-- doesn't tell you who wins a multi-leg tie. That framing turned out to
-- be the wrong one: the reward is per FIXTURE, not per tie. Every played
-- knockout fixture — a home leg, an away leg, or a decider — pays its own
-- winner independently, the same way a league fixture does; nothing here
-- needs to know who eventually advances. That removes the original
-- blocker entirely — no dependency on tie resolution / advanceKnockout.
--
-- Reward amounts port economy.js's computeMatchNets 'knockout' branch
-- exactly: win = 3 + 1*(round-1), loss = 0, +1 participation net on
-- both outcomes (round-1 win = 4, round-1 loss = 1, growing 1/round
-- thereafter on the win side only) — recomputed server-side from
-- fixtures.round, never trusted from the client.
--
-- _credit_knockout_fixture_reward mirrors _credit_league_fixture_reward's
-- shape exactly (internal-only, not granted to authenticated, called from
-- inside the same three fixture-result RPCs after they've written a
-- score) so the two can sit side by side without either one drifting out
-- of sync with the other.
--
-- p_was_already_played has the same meaning as in
-- _credit_league_fixture_reward: true only on record_fixture_result's
-- admin-correction path, which must never re-trigger a reward.
--
-- Safe to run more than once.

create or replace function _credit_knockout_fixture_reward(p_fixture_id uuid, p_was_already_played boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture fixtures%rowtype;
  v_league leagues%rowtype;
  v_eligible boolean;
  v_round integer;
  v_win_reward bigint;
  v_loss_reward bigint := 0 + 1;
  v_member record;
begin
  if p_was_already_played then
    return;
  end if;

  select * into v_fixture from fixtures where id = p_fixture_id;
  if not found or v_fixture.home_team_id is null or v_fixture.away_team_id is null
     or v_fixture.home_score is null or v_fixture.away_score is null then
    return;
  end if;

  select * into v_league from leagues where id = v_fixture.league_id;
  if not found then
    return;
  end if;

  v_eligible := v_league.format = 'knockout'
    or (v_league.format = 'groups_knockout' and v_fixture.stage = 2);
  if not v_eligible then
    return;
  end if;

  -- A level knockout fixture (e.g. a leg that doesn't need to be
  -- decisive on its own) has no winner to reward here — it's covered
  -- when whichever fixture actually settles the tie gets its own score
  -- recorded. Nothing is paid out for a level scoreline.
  if v_fixture.home_score = v_fixture.away_score then
    return;
  end if;

  -- round is 1-indexed straight off the fixture, same field
  -- knockoutRoundFixtures (App.jsx) stamps it with at bracket generation.
  -- winPerRound is a whole 1/round now, so this is exact integer
  -- arithmetic — no fractional-Net rounding needed (unlike the earlier
  -- 0.5/round version this replaces).
  v_round := coalesce(v_fixture.round, 1);
  v_win_reward := 3 + (v_round - 1) + 1; -- winBase + winPerRound*(round-1), +1 participation

  if v_fixture.home_score > v_fixture.away_score then
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.home_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_win_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.home_team_id);
    end loop;
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.away_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_loss_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.away_team_id);
    end loop;
  else
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.away_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_win_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.away_team_id);
    end loop;
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.home_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_loss_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.home_team_id);
    end loop;
  end if;
end;
$$;

-- No grant to authenticated — reachable only from the three fixture-result
-- RPCs below, same as _credit_league_fixture_reward / _nets_credit_internal.

-- Hook into the same three call sites _credit_league_fixture_reward
-- already uses. Each RPC is CREATE OR REPLACE'd unchanged except for one
-- new `perform` line — no other logic in any of them changes here.

create or replace function record_fixture_result(
  p_fixture_id uuid,
  p_home_score integer,
  p_away_score integer,
  p_pens_home integer default null,
  p_pens_away integer default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture fixtures%rowtype;
  is_authorized boolean;
  v_was_already_played boolean;
begin
  select * into v_fixture from fixtures where id = p_fixture_id for update;
  if not found then
    raise exception 'Fixture % not found', p_fixture_id;
  end if;
  v_was_already_played := v_fixture.played;

  select
    exists (select 1 from leagues l where l.id = v_fixture.league_id and l.created_by = auth.uid())
    or exists (select 1 from admins a where a.user_id = auth.uid())
  into is_authorized;
  if not is_authorized then
    raise exception 'Only the league creator or an admin can record this result';
  end if;

  if p_home_score is null or p_away_score is null then
    raise exception 'A score is required';
  end if;
  if p_home_score < 0 or p_away_score < 0
     or (p_pens_home is not null and p_pens_home < 0)
     or (p_pens_away is not null and p_pens_away < 0) then
    raise exception 'Scores cannot be negative';
  end if;
  if p_pens_home is not null and p_pens_away is not null and p_pens_home = p_pens_away then
    raise exception 'Penalty score cannot be level';
  end if;

  update fixtures set
    played = true,
    home_score = p_home_score,
    away_score = p_away_score,
    pens_home = p_pens_home,
    pens_away = p_pens_away,
    played_at = now()
  where id = p_fixture_id;

  perform _credit_league_fixture_reward(p_fixture_id, v_was_already_played);
  perform _credit_knockout_fixture_reward(p_fixture_id, v_was_already_played);
end;
$$;

grant execute on function record_fixture_result(uuid, integer, integer, integer, integer) to authenticated;

create or replace function approve_result_submission(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  s result_submissions%rowtype;
  is_reviewer boolean;
  home_name text;
  away_name text;
  pens_suffix text := '';
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into s from result_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'Submission not found';
  end if;
  if s.status <> 'pending' then
    raise exception 'Submission already reviewed';
  end if;

  select
    exists (select 1 from admins a where a.user_id = auth.uid())
    or exists (select 1 from leagues l where l.id = s.league_id and l.created_by = auth.uid())
  into is_reviewer;
  if not is_reviewer then
    raise exception 'Only a league admin or creator can approve results';
  end if;

  if exists (select 1 from fixtures where id = s.fixture_id and played = true) then
    update result_submissions
    set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_submission_id;
    return;
  end if;

  if s.home_score is null or s.away_score is null then
    raise exception 'Submission is missing a score';
  end if;
  if s.home_score < 0 or s.away_score < 0
     or (s.pens_home is not null and s.pens_home < 0)
     or (s.pens_away is not null and s.pens_away < 0) then
    raise exception 'Scores cannot be negative';
  end if;

  if s.home_score = s.away_score and (s.pens_home is null or s.pens_away is null) then
    raise exception 'Scores are level — penalty scores are required to approve this result';
  end if;

  if s.pens_home is not null and s.pens_away is not null and s.pens_home = s.pens_away then
    raise exception 'Penalty score cannot be level';
  end if;

  update fixtures set played = true, home_score = s.home_score, away_score = s.away_score,
    pens_home = s.pens_home, pens_away = s.pens_away, played_at = now()
  where id = s.fixture_id
  returning
    (select t.name from teams t where t.id = fixtures.home_team_id),
    (select t.name from teams t where t.id = fixtures.away_team_id)
  into home_name, away_name;

  if not found then
    raise exception 'Fixture % not found for submission %', s.fixture_id, p_submission_id;
  end if;

  perform _credit_league_fixture_reward(s.fixture_id, false);
  perform _credit_knockout_fixture_reward(s.fixture_id, false);

  if s.pens_home is not null and s.pens_away is not null then
    pens_suffix := format(' (pens %s–%s)', s.pens_home, s.pens_away);
  end if;

  insert into comments (league_id, user_id, username, body)
  values (
    s.league_id, s.submitted_by, s.submitted_by_username,
    format('⚽ Result posted: %s %s – %s %s%s (submitted with photo proof, approved by admin)',
      coalesce(home_name, 'Home'), s.home_score, s.away_score, coalesce(away_name, 'Away'), pens_suffix)
  );

  update result_submissions
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_submission_id;
end;
$function$;

grant execute on function approve_result_submission(uuid) to authenticated;

create or replace function respond_to_result_submission(p_submission_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_sub result_submissions%rowtype;
  v_fixture fixtures%rowtype;
  v_submitter_team_id uuid;
  v_caller_team_id uuid;
begin
  select * into v_sub from result_submissions where id = p_submission_id for update;
  if not found then
    raise exception 'Submission not found';
  end if;
  if v_sub.status <> 'pending' then
    raise exception 'This result has already been resolved';
  end if;

  select * into v_fixture from fixtures where id = v_sub.fixture_id;
  if not found then
    raise exception 'Fixture not found';
  end if;

  select team_id into v_caller_team_id
  from members
  where league_id = v_sub.league_id and user_id = auth.uid();

  select team_id into v_submitter_team_id
  from members
  where league_id = v_sub.league_id and user_id = v_sub.submitted_by;

  if v_caller_team_id is null
     or v_caller_team_id not in (v_fixture.home_team_id, v_fixture.away_team_id) then
    raise exception 'Only the opposing player can respond to this result';
  end if;

  if v_caller_team_id = v_submitter_team_id then
    raise exception 'You cannot confirm your own submission — waiting on the other player';
  end if;

  if p_accept then
    if v_fixture.played then
      update result_submissions
      set status = 'rejected'
      where id = p_submission_id;
      return;
    end if;

    if v_sub.home_score is null or v_sub.away_score is null then
      raise exception 'Submission is missing a score';
    end if;
    if v_sub.home_score < 0 or v_sub.away_score < 0
       or (v_sub.pens_home is not null and v_sub.pens_home < 0)
       or (v_sub.pens_away is not null and v_sub.pens_away < 0) then
      raise exception 'Scores cannot be negative';
    end if;
    if v_sub.pens_home is not null and v_sub.pens_away is not null and v_sub.pens_home = v_sub.pens_away then
      raise exception 'Penalty score cannot be level';
    end if;

    update fixtures
    set played = true,
        home_score = v_sub.home_score,
        away_score = v_sub.away_score,
        pens_home = v_sub.pens_home,
        pens_away = v_sub.pens_away,
        played_at = now()
    where id = v_fixture.id;

    perform _credit_league_fixture_reward(v_fixture.id, false);
    perform _credit_knockout_fixture_reward(v_fixture.id, false);

    update result_submissions
    set status = 'approved'
    where id = p_submission_id;
  else
    update result_submissions
    set status = 'rejected'
    where id = p_submission_id;
  end if;
end;
$function$;

grant execute on function respond_to_result_submission(uuid, boolean) to authenticated;
