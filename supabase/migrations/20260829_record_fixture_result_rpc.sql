-- Fixtures — give the admin/creator direct-entry path (recordResult in
-- App.jsx) the same score-sanity checks the other two result paths have,
-- via a SECURITY DEFINER RPC.
--
-- NOT a security fix — the fixtures UPDATE RLS policy ("League creator
-- or admin can edit fixtures") already restricts this write to the
-- league's creator or a platform admin; a plain client .update() here
-- was never an open hole the way nets_credit was. This closes a
-- validation gap instead: recordResult was the only one of the three
-- result-entry paths with no negative-score check and no
-- level-penalties-can't-be-level check, so a typo (a negative score, or
-- matching penalty scores) that would be rejected via player-submission
-- or admin-approval sailed straight through when entered directly by an
-- admin.
--
-- Deliberately NOT included, matching respond_to_result_submission's fix
-- (20260828_result_submission_rpcs.sql) and NOT approve_result_submission's
-- known-buggy behavior: no "level score requires a penalty score" check.
-- That rule only actually applies to a knockout final — see the note in
-- 20260828 — and this RPC has no way to know if a given fixture IS the
-- final without the same bracket-detection logic that fix was
-- deliberately deferred, so it stays out here too rather than guessing.
--
-- Also deliberately NOT guarding "fixture already played" the way the
-- other two paths do: unlike a submission being approved for the first
-- time, this path is explicitly also how an admin corrects an
-- already-recorded result after the fact (see applyKnockoutElimination's
-- comment in App.jsx about re-logging a score on an already-decided
-- tie) — blocking replays here would break that intentional feature.
--
-- Because this runs SECURITY DEFINER (bypassing RLS internally), it
-- re-implements the same creator-or-admin check the RLS UPDATE policy
-- already enforces for the plain-.update() path, so authorization
-- doesn't quietly get looser by moving through this function.
--
-- Safe to run more than once.

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
begin
  select * into v_fixture from fixtures where id = p_fixture_id for update;
  if not found then
    raise exception 'Fixture % not found', p_fixture_id;
  end if;

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
end;
$$;

grant execute on function record_fixture_result(uuid, integer, integer, integer, integer) to authenticated;
