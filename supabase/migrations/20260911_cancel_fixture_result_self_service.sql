-- Fixtures — let the player who posted a result cancel/reverse it
-- themselves within 30 minutes, without needing an admin. Same
-- cancel_fixture_result RPC (20260909) and same end state (fixture back
-- to unplayed, comment/elimination cleanup still handled client-side in
-- App.jsx's cancelFixtureResult) — this only widens WHO can call it.
--
-- "The player who posted it" is read straight off the comments table
-- rather than adding new plumbing: the auto-posted "Matchday N — Home 2 –
-- 1 Away" row already carries fixture_id, is_result, user_id and
-- created_at, and that row's author IS the uploader on every path
-- (recordResult posts it as whoever's recording; approve_result_submission
-- posts it "under the player's own identity" per App.jsx's own comment on
-- approveResult) — so "does a comments row for this fixture, posted by
-- me, in the last 30 minutes, exist" is exactly the right self-cancel
-- check with no new column or table needed.
--
-- 30 minutes deliberately matches League Ladder's own
-- RESULT_CONFIRM_WINDOW_MINUTES (opponent confirm/dispute window) for a
-- comparable "you've got a short grace period to fix an honest mistake"
-- feel across both systems, even though the two windows measure from
-- different events (there, the opponent's response clock; here, the
-- poster's own undo clock).
--
-- Safe to run more than once.

create or replace function cancel_fixture_result(
  p_fixture_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture fixtures%rowtype;
  is_authorized boolean;
  v_self_cancel boolean;
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
    select exists (
      select 1 from comments
      where fixture_id = p_fixture_id
        and is_result = true
        and user_id = auth.uid()
        and created_at > now() - interval '30 minutes'
    ) into v_self_cancel;
    is_authorized := v_self_cancel;
  end if;

  if not is_authorized then
    raise exception 'Only the league creator, an admin, or the player who posted this result (within 30 minutes of posting) can cancel it';
  end if;

  if not v_fixture.played then
    raise exception 'This fixture has no result to cancel';
  end if;

  update fixtures set
    played = false,
    home_score = null,
    away_score = null,
    pens_home = null,
    pens_away = null,
    played_at = null
  where id = p_fixture_id;
end;
$$;

grant execute on function cancel_fixture_result(uuid) to authenticated;
