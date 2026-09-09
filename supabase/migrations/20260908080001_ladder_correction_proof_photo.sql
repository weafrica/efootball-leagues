-- League Ladder — let an admin attach/replace a proof photo when
-- correcting a fixture's result (correct_ladder_fixture_result,
-- 20260892/20260904).
--
-- Two things prompted this:
--   1. A forfeited fixture (auto-recorded 4-0 by the sweep) never had a
--      proof photo in the first place — there's nothing to show even
--      after an admin corrects its score. Admins need a way to attach
--      one, e.g. after getting a screenshot from a player after the fact.
--   2. A played fixture's existing proof photo (from
--      ladder_fixture_result_submissions) might itself be wrong, blurry,
--      or need replacing — admins need to be able to swap it out as part
--      of a correction, not just the score.
--
-- Storage: proof_url lives on ladder_fixture_corrections itself (one
-- column, nullable) rather than trying to retrofit
-- ladder_fixture_result_submissions — a correction is already its own
-- audit-logged event per row (20260887), so "this correction's photo"
-- fits naturally next to "this correction's score change". The client
-- resolves which photo to display for a fixture by taking the most
-- recent correction with a non-null proof_url, falling back to the
-- original approved submission's proof_url if no correction ever
-- attached one.
--
-- Also hardens ladder_fixture_corrections with RLS + a public-read
-- policy — it was created back in 20260887 without either, unlike its
-- sibling ladder_fixture_result_submissions. Purely additive/safety; no
-- behavior change for existing readers since Postgres tables default to
-- open access until RLS is turned on, so this only tightens, never loosens.
--
-- Safe to run more than once.

alter table ladder_fixture_corrections
  add column if not exists proof_url text;

alter table ladder_fixture_corrections enable row level security;

drop policy if exists "ladder_fixture_corrections_select" on ladder_fixture_corrections;
create policy "ladder_fixture_corrections_select" on ladder_fixture_corrections for select
  to authenticated
  using (true);

-- No insert/update/delete policies — same as
-- ladder_fixture_result_submissions, every write goes through the
-- SECURITY DEFINER correct_ladder_fixture_result RPC below.

-- Replace correct_ladder_fixture_result with a 4th, optional parameter.
-- Dropping the old 3-arg signature first (rather than just
-- `create or replace`) so there isn't a stale 3-arg overload left behind
-- once every caller has moved to passing p_proof_url.
drop function if exists correct_ladder_fixture_result(uuid, integer, integer);

create or replace function correct_ladder_fixture_result(
  p_fixture_id uuid,
  p_home_score integer,
  p_away_score integer,
  p_proof_url text default null
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
    new_home_score, new_away_score,
    proof_url
  ) values (
    p_fixture_id, v_user_id,
    v_fixture.home_score, v_fixture.away_score,
    p_home_score, p_away_score,
    p_proof_url
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

grant execute on function correct_ladder_fixture_result(uuid, integer, integer, text) to authenticated;
