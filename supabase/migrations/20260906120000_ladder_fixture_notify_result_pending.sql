-- Push notification the instant an opponent reports a League Ladder score —
-- a "go confirm this" nudge, the mirror image of
-- 20260904190000_ladder_fixture_next_match_notifications.sql's "match is
-- set" push. That one pings both sides the moment a fixture is created;
-- this one pings only the side who still needs to act, the moment the
-- *other* side submits a score — the same "your move" state the homepage
-- Ladder banner/nav badge (myLadderActionCount) already surface in-app.
--
-- Fires on every INSERT, not just the first one for a fixture — a rejected
-- attempt followed by a fresh submission genuinely needs a fresh nudge, and
-- unlike ladder_fixtures (which _generate_round_robin_fixtures_internal
-- deletes and reinserts wholesale on every regen), submissions rows are
-- never recreated, so there's no dedup table needed here the way
-- ladder_fixture_notify_sent exists for the fixtures trigger.
--
-- Reuses _notify_match_push as-is (see 20260904105705_next_match_notifications.sql)
-- including its default data.kind = 'next_match' — sw.js's push handler only
-- branches on kind to choose the silent/no-action rendering, which is
-- exactly the shape this notification wants too (a quiet ping, not the
-- Rapid Cup alarm), so there's no reason to add a second kind or touch the
-- client at all.
--
-- Safe to run more than once.

create or replace function _ladder_fixture_notify_result_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture ladder_fixtures%rowtype;
  v_tier integer;
  v_submitter_name text;
  v_notify_user_id uuid;
begin
  -- Always true on a fresh insert (table default), but guarded explicitly
  -- so this trigger stays correct if a future migration ever starts
  -- inserting non-pending rows directly (e.g. a backfill).
  if new.status is distinct from 'pending' then
    return new;
  end if;

  select * into v_fixture from ladder_fixtures where id = new.fixture_id;
  if v_fixture.id is null then
    return new;
  end if;

  v_notify_user_id := case
    when v_fixture.home_user_id = new.submitted_by then v_fixture.away_user_id
    when v_fixture.away_user_id = new.submitted_by then v_fixture.home_user_id
    else null
  end;
  -- submitted_by isn't actually either side of the fixture (shouldn't
  -- happen — the submit RPC only lets a participant report a score — but
  -- cheap to guard rather than notify the wrong person).
  if v_notify_user_id is null then
    return new;
  end if;

  select tier into v_tier from ladder_leagues where id = v_fixture.league_id;
  select coalesce(efootball_username, 'Your opponent') into v_submitter_name
    from profiles where user_id = new.submitted_by;

  perform _notify_match_push(
    array[v_notify_user_id],
    '⚽ Confirm your result',
    coalesce(v_submitter_name, 'Your opponent') || ' reported ' || new.home_score || '-' || new.away_score
      || ' — League Ladder' || case when v_tier is not null then ' ' || v_tier else '' end
      || ', tap to confirm',
    jsonb_build_object('leagueId', v_fixture.league_id, 'ladderFixtureId', v_fixture.id)
  );

  return new;
end;
$$;

drop trigger if exists trg_ladder_fixture_notify_result_pending on ladder_fixture_result_submissions;
create trigger trg_ladder_fixture_notify_result_pending
after insert on ladder_fixture_result_submissions
for each row execute function _ladder_fixture_notify_result_pending();
