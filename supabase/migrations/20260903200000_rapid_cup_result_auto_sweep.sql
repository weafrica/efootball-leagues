-- Rapid Cup — Phase 5: 2min/2min auto-accept/auto-approve on top of the
-- EXISTING, league-type-agnostic result pipeline.
--
-- Section 6 says "direct port of the League Ladder result system" — but
-- the score-submission / photo-proof / opponent-confirm-dispute /
-- admin-approve-reject / cancel-before-response pipeline already lives on
-- the generic `fixtures` + `result_submissions` tables (see
-- 20260828_result_submission_rpcs.sql, 20260909/20260911's
-- cancel_fixture_result, 20260829's record_fixture_result), and Rapid Cup
-- fixtures already sit in that same `fixtures` table with real
-- members/teams rows (from generate_rapid_cup_bracket). So none of that
-- needs porting or rebuilding — a Rapid Cup player submitting a result,
-- their opponent confirming/disputing it, an admin approving/rejecting
-- it, or a player cancelling their own recent submission all already
-- work today, for free, with zero Rapid-Cup-specific code.
--
-- What's actually new for Rapid Cup (Section 6, "Timers" bullet): a
-- 2-minute opponent window, then a 2-minute admin window, auto-resolving
-- if nobody acts. Mirrors _ladder_fixture_result_auto_approve_expired_internal
-- (20260891) in shape/cadence, simplified because Rapid Cup's generic
-- result_submissions has no ladder-style dispute-cap escalation concept:
-- deadline = created_at + 2min (opponent) + 2min (admin) = 4 minutes,
-- single tier. Scoped to Rapid Cup leagues ONLY via the rapid_cup_lobbies
-- join, so this can never reach into a normal league/knockout/weekend
-- submission's pending window.
--
-- Auto-resolution takes the submitted score as-is (same effect as the
-- opponent accepting) — same sanity checks as approve_result_submission/
-- respond_to_result_submission (no negative scores, no level penalties),
-- and the same already-played race guard (auto-reject instead of
-- clobbering a result that landed another way while this sat pending).
-- Idempotent by construction: status = 'pending' filter means an
-- already-resolved submission is never touched twice.
--
-- Not covered here: walkover claims (Section 6) — deferred, no existing
-- generic (non-ladder) walkover RPC to build on, and it needs its own
-- design pass for a 4-team single-elimination bracket rather than a
-- 1v1 ladder challenge. Flagging as a known gap, not silently dropped.
--
-- Guarded against a real timing bug: without checking the lobby is still
-- 'live', a submission sitting pending right as the 4hr auto-finish
-- deadline passes could get auto-accepted here a few minutes AFTER
-- Phase 4's sweep already finished the lobby and paid out based on the
-- state at that moment — leaving a fixture marked played with a score
-- the payout never reflected. Guarded the same way
-- _rapid_cup_finish_lobby_internal guards itself.
create or replace function _rapid_cup_result_auto_sweep_internal()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub result_submissions%rowtype;
  v_fixture fixtures%rowtype;
  v_count integer := 0;
  home_name text;
  away_name text;
  pens_suffix text;
begin
  for v_sub in
    select s.*
    from result_submissions s
    join rapid_cup_lobbies rcl on rcl.league_id = s.league_id
    where s.status = 'pending'
      and rcl.status = 'live'
      and s.created_at + interval '2 minutes' + interval '2 minutes' <= now()
    order by s.created_at
    for update of s skip locked
  loop
    select * into v_fixture from fixtures where id = v_sub.fixture_id for update;
    if not found then
      continue;
    end if;

    -- Fixture already has a result recorded another way while this sat
    -- pending (e.g. an admin typed it in directly) — auto-reject instead
    -- of clobbering it, same guard as approve_result_submission.
    if v_fixture.played then
      update result_submissions set status = 'rejected' where id = v_sub.id;
      continue;
    end if;

    if v_sub.home_score is null or v_sub.away_score is null then
      continue; -- shouldn't happen (columns are not null), skip defensively
    end if;
    if v_sub.home_score < 0 or v_sub.away_score < 0
       or (v_sub.pens_home is not null and v_sub.pens_home < 0)
       or (v_sub.pens_away is not null and v_sub.pens_away < 0)
       or (v_sub.pens_home is not null and v_sub.pens_away is not null and v_sub.pens_home = v_sub.pens_away) then
      -- Malformed submission (shouldn't exist given client-side
      -- validation, but never silently apply a broken score) — leave
      -- pending for a human to sort out rather than guessing.
      continue;
    end if;

    update fixtures set
      played = true,
      home_score = v_sub.home_score,
      away_score = v_sub.away_score,
      pens_home = v_sub.pens_home,
      pens_away = v_sub.pens_away,
      played_at = now()
    where id = v_fixture.id
    returning
      (select t.name from teams t where t.id = fixtures.home_team_id),
      (select t.name from teams t where t.id = fixtures.away_team_id)
    into home_name, away_name;

    pens_suffix := '';
    if v_sub.pens_home is not null and v_sub.pens_away is not null then
      pens_suffix := format(' (pens %s–%s)', v_sub.pens_home, v_sub.pens_away);
    end if;

    insert into comments (league_id, user_id, username, body)
    values (
      v_sub.league_id, v_sub.submitted_by, v_sub.submitted_by_username,
      format('⚽ Result posted: %s %s – %s %s%s (no response within 2 min — auto-accepted)',
        coalesce(home_name, 'Home'), v_sub.home_score, v_sub.away_score, coalesce(away_name, 'Away'), pens_suffix)
    );

    update result_submissions set status = 'approved' where id = v_sub.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- Deliberately no grant — internal only, reachable solely from the
-- scheduled sweep below, same posture as every other _*_internal
-- function in this migration history.
revoke all on function _rapid_cup_result_auto_sweep_internal() from public, anon, authenticated;

select cron.unschedule('rapid-cup-result-auto-sweep')
where exists (select 1 from cron.job where jobname = 'rapid-cup-result-auto-sweep');

-- Every 1 minute — fine granularity for a 2min/2min (4-minute total)
-- window, same reasoning Phase 4's rapid-cup-sweep used for its own
-- fast cadence on a short-format cup.
select cron.schedule(
  'rapid-cup-result-auto-sweep',
  '* * * * *',
  $$select _rapid_cup_result_auto_sweep_internal();$$
);
