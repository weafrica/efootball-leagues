-- Result submissions — bring the three live RPCs into version control,
-- and fix a real bug in respond_to_result_submission along the way.
--
-- approve_result_submission and reject_result_submission below are
-- captured EXACTLY as pulled from production on 2026-08-28 — no logic
-- changes. They're the admin-approval half of the submit -> confirm-or-
-- dispute pipeline (see 20260818_ladder_cup_result_pipeline.sql for the
-- equivalent shape on the ladder cup side); this repo just never had
-- them checked in.
--
-- KNOWN BUG, DELIBERATELY NOT FIXED HERE: approve_result_submission
-- rejects ANY level scoreline that doesn't carry a penalty score —
-- unconditionally, regardless of league format or round. But per the
-- client's own isFinalFixture/isFinalRoundFixtures logic (App.jsx),
-- penalties only ever matter for the final of a knockout bracket — a
-- draw in single_round_robin/double_round_robin/survivor/groups_knockout
-- group stage, or an earlier knockout round tied on aggregate, is a
-- completely normal result with no penalty score attached. As it
-- stands, approving a submitted league draw through this RPC would
-- raise "Scores are level — penalty scores are required", forcing an
-- admin to enter a fake pens score to get past it. Left as-is
-- intentionally pending confirmation this is actually biting real
-- leagues before reworking it — see the finals-detection discussion for
-- the full fix. The two functions below do NOT carry this check forward
-- to keep the same bug from spreading to two more code paths.
--
-- Safe to run more than once.

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

  -- lock the row so two admins approving at once can't both succeed
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

  -- fixture already has a result recorded another way (e.g. admin typed it in directly
  -- while this submission sat pending) — auto-reject instead of clobbering it or getting stuck
  if exists (select 1 from fixtures where id = s.fixture_id and played = true) then
    update result_submissions
    set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_submission_id;
    return;
  end if;

  -- basic sanity on the scores themselves
  if s.home_score is null or s.away_score is null then
    raise exception 'Submission is missing a score';
  end if;
  if s.home_score < 0 or s.away_score < 0
     or (s.pens_home is not null and s.pens_home < 0)
     or (s.pens_away is not null and s.pens_away < 0) then
    raise exception 'Scores cannot be negative';
  end if;

  -- guard against a level final being approved with no penalty score
  if s.home_score = s.away_score and (s.pens_home is null or s.pens_away is null) then
    raise exception 'Scores are level — penalty scores are required to approve this result';
  end if;

  -- guard against penalties being level (impossible outcome)
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

create or replace function reject_result_submission(p_submission_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  s result_submissions%rowtype;
  is_reviewer boolean;
begin
  select * into s from result_submissions where id = p_submission_id;
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
    raise exception 'Only a league admin or creator can reject results';
  end if;

  update result_submissions
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
  where id = p_submission_id;
end;
$function$;

grant execute on function reject_result_submission(uuid, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- respond_to_result_submission — THE FIX. Live version only ever wrote
-- played/home_score/away_score/played_at: pens_home/pens_away were
-- silently dropped even when the submission carried them, and there was
-- no negative-score check or already-played race guard, unlike its
-- sibling approve_result_submission. Concretely: a knockout final drawn
-- 1-1 and decided on penalties, confirmed by the OPPONENT instead of an
-- admin, landed with pens_home/pens_away both null — applyKnockoutElimination
-- (App.jsx) then sees a level aggregate with no penalty score to break
-- it, and neither club gets eliminated. Fixed to write pens through and
-- match approve_result_submission's negative-score / already-played /
-- level-pens-is-impossible checks. Deliberately NOT adding
-- approve_result_submission's "level score requires pens" check — see
-- the top-of-file note, that check is wrong for anything but a knockout
-- final and this fix isn't the place to spread it further.
-- ─────────────────────────────────────────────────────────────────────────
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

  -- Caller must be a member of this league, fielding one of the two teams
  -- in this fixture, and must NOT be the person who submitted the result.
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
    -- Same race this guards against in approve_result_submission: the
    -- fixture already has a result recorded another way (e.g. an admin
    -- typed it in directly while this submission sat pending). Auto-reject
    -- instead of clobbering it.
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
