-- League Ladder — same self-service widening as
-- 20260911_cancel_fixture_result_self_service.sql, applied to
-- cancel_ladder_fixture_result (20260910): the player who submitted a
-- result can cancel/reverse it themselves within 30 minutes, no admin
-- needed.
--
-- "The player who submitted it" reads off
-- ladder_fixture_result_submissions — the row that actually got approved
-- (status = 'approved') carries submitted_by and created_at already, so
-- no new column needed here either. Deliberately requires status =
-- 'approved' specifically (not just "any row by this user for this
-- fixture") — a fixture can accumulate rejected/expired prior attempts
-- (see priorRejectedCount in LeagueLadderDetail.jsx), and only the one
-- that actually became the live result should open a self-cancel window.
--
-- This means a 'forfeited' fixture can never be self-cancelled — a
-- forfeit has no submissions row at all (it's the hourly sweep's own
-- doing, not a player upload), so the self-cancel check below simply
-- never matches one. That's intentional: only an admin can undo a
-- forfeit, same as before this migration.
--
-- 30 minutes measured from the approved submission's own created_at
-- (when the player originally typed the score in), not from played_at —
-- deliberately, so a result an admin let sit in the queue for a while
-- before approving doesn't hand the submitter a fresh 30 minutes they
-- didn't actually have.
--
-- Safe to run more than once.

create or replace function cancel_ladder_fixture_result(
  p_fixture_id uuid
) returns ladder_fixtures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_fixture ladder_fixtures%rowtype;
  v_week_closed boolean;
  v_is_admin boolean;
  v_self_cancel boolean;
begin
  if v_user_id is null then
    raise exception 'cancel_ladder_fixture_result: must be signed in';
  end if;

  v_is_admin := exists (select 1 from admins a where a.user_id = v_user_id);

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'cancel_ladder_fixture_result: fixture not found';
  end if;

  if not v_is_admin then
    select exists (
      select 1 from ladder_fixture_result_submissions
      where fixture_id = p_fixture_id
        and submitted_by = v_user_id
        and status = 'approved'
        and created_at > now() - interval '30 minutes'
    ) into v_self_cancel;
    if not v_self_cancel then
      raise exception 'cancel_ladder_fixture_result: admin only, or the player who submitted this result, within 30 minutes of submitting';
    end if;
  end if;

  if v_fixture.status not in ('played', 'forfeited') then
    raise exception 'cancel_ladder_fixture_result: this fixture has no confirmed result to cancel';
  end if;

  insert into ladder_fixture_cancellations (
    fixture_id, cancelled_by, previous_status, previous_home_score, previous_away_score
  ) values (
    p_fixture_id, v_user_id, v_fixture.status, v_fixture.home_score, v_fixture.away_score
  );

  update ladder_fixtures
  set status = 'pending', home_score = null, away_score = null, played_at = null
  where id = p_fixture_id
  returning * into v_fixture;

  -- Calls the internal resolve step directly rather than going through
  -- admin_retrigger_ladder_resolve — that wrapper re-checks "is this
  -- caller an admin", which would wrongly fail a legitimate non-admin
  -- self-cancel here even though authorization for the cancel itself was
  -- already established above. Authorization was this function's job;
  -- _ladder_close_week_internal itself has no auth check of its own
  -- (same as every other place in this migration set that calls it
  -- directly from inside an already-authorized SECURITY DEFINER function).
  select fixtures_locked into v_week_closed from ladder_cycle where id = true;
  if v_week_closed then
    perform _ladder_close_week_internal();
  end if;

  return v_fixture;
end;
$$;

grant execute on function cancel_ladder_fixture_result(uuid) to authenticated;
