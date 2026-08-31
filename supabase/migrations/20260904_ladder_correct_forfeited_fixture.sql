-- League Ladder — extend correct_ladder_fixture_result (20260892) to also
-- allow correcting a 'forfeited' fixture, not just 'played' ones.
--
-- A forfeit auto-records a flat 4-0 (isFixtureForfeited /
-- _ladder_forfeit_expired_fixtures_internal), which is sometimes wrong —
-- e.g. the match actually happened but nobody submitted in time, or the
-- forfeit was logged against the wrong side. Admins need to be able to
-- fix that score the same way they already fix a played fixture's score.
--
-- The fixture's status is deliberately left as 'forfeited' — a corrected
-- score still isn't a played match for economy purposes (computeLadderMatchNets
-- already treats every 'forfeited' fixture as ineligible for Match Reward/
-- streak crediting, and that stays true here; only the stored score
-- changes). Everything else — the correction log, the re-run of the
-- weekly resolve if the week's already closed — is identical to the
-- 'played' path.
--
-- Safe to run more than once.

create or replace function correct_ladder_fixture_result(
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
  v_fixture ladder_fixtures%rowtype;
  v_week_closed boolean;
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'correct_ladder_fixture_result: admin only';
  end if;
  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'correct_ladder_fixture_result: scores must be non-negative';
  end if;

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'correct_ladder_fixture_result: fixture not found';
  end if;
  if v_fixture.status not in ('played', 'forfeited') then
    raise exception 'correct_ladder_fixture_result: this fixture has not been confirmed yet — resolve its pending result instead of correcting it';
  end if;

  insert into ladder_fixture_corrections (
    fixture_id, corrected_by,
    previous_home_score, previous_away_score,
    new_home_score, new_away_score
  ) values (
    p_fixture_id, v_user_id,
    v_fixture.home_score, v_fixture.away_score,
    p_home_score, p_away_score
  );

  update ladder_fixtures
  set home_score = p_home_score, away_score = p_away_score
  where id = p_fixture_id
  returning * into v_fixture;

  -- If this fixture's week has already closed (fixtures_locked was set
  -- and the Sunday resolve already ran), re-run it now so the corrected
  -- score actually flows into standings/promotion/fees instead of just
  -- sitting corrected-but-unapplied on the row.
  select fixtures_locked into v_week_closed from ladder_cycle where id = true;
  if v_week_closed then
    perform admin_retrigger_ladder_resolve();
  end if;

  return v_fixture;
end;
$$;

grant execute on function correct_ladder_fixture_result(uuid, integer, integer) to authenticated;
