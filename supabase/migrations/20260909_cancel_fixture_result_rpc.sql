-- Fixtures — let an admin/creator fully UNDO an already-recorded result,
-- not just correct its score (record_fixture_result already covers
-- corrections). This is for "that result shouldn't exist at all" — wrong
-- match, wrong league, submitted by mistake, whatever — and puts the
-- fixture back to being unplayed. Whether it then shows as a normal
-- upcoming fixture or as expired/overdue falls out automatically from
-- isExpired()/isFixtureLocked() in App.jsx, which only look at
-- `played` + `due_at` — nothing else to set here for that part.
--
-- Mirrors record_fixture_result's auth check exactly (same SECURITY
-- DEFINER pattern, same "league creator or platform admin" gate) so
-- cancelling isn't any more permissive than recording was.
--
-- Deliberately does NOT touch `teams.eliminated` — that's knockout-format
-- state and depends on the OTHER leg(s) of the tie too, so App.jsx's
-- cancelFixtureResult reverses it client-side the same way
-- applyKnockoutElimination sets it, right after this RPC succeeds.
-- Deliberately does NOT touch the `comments` table either — the
-- auto-posted "Matchday N — Home 2 – 1 Away" result row (and any photo
-- proof reply) gets deleted client-side too, same reasoning: that's a
-- normal RLS-governed delete, no need to bypass it here.
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
    raise exception 'Only the league creator or an admin can cancel this result';
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
