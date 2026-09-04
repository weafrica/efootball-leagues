-- "Next match" push notifications — every league besides Rapid Cup (which
-- already has its own dedicated alarm/push, untouched here) plus the
-- random-match challenge board (challenges / open_challenges — the same
-- system economy.js's 'random_match' reward category refers to).
--
-- Deliberately the opposite of the Rapid Cup alarm: one quiet, silent,
-- no-action push the instant a match is set — see send-match-push and
-- public/sw.js's "kind": "next_match" branch. No lead-time warning, no
-- ramp, nothing to stop. It just shows up.
--
-- Shared helper — same pg_net + Vault pattern as generate_rapid_cup_bracket
-- (rapid_cup_push_trigger.sql), reusing the same
-- 'rapid_cup_push_service_role_key' Vault secret since it's just the
-- project's service role key, not actually Rapid-Cup-specific.
create or replace function _notify_match_push(
  p_user_ids uuid[],
  p_title text,
  p_body text,
  p_data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service_key text;
  v_user_ids uuid[];
begin
  select array_agg(x) into v_user_ids from unnest(p_user_ids) x where x is not null;
  if v_user_ids is null or array_length(v_user_ids, 1) = 0 then
    return;
  end if;

  begin
    select decrypted_secret into v_service_key
    from vault.decrypted_secrets
    where name = 'rapid_cup_push_service_role_key';

    if v_service_key is not null then
      perform net.http_post(
        url := 'https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/send-match-push',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_service_key
        ),
        body := jsonb_build_object(
          'user_ids', to_jsonb(v_user_ids),
          'title', p_title,
          'body', p_body,
          'data', p_data
        )
      );
    else
      raise warning '_notify_match_push: rapid_cup_push_service_role_key not found in Vault — skipping push';
    end if;
  exception when others then
    -- Never let a notification problem fail whatever DB write triggered
    -- it — same "best-effort, log only" reasoning as the Rapid Cup push
    -- trigger this mirrors.
    raise warning '_notify_match_push: push failed — %', sqlerrm;
  end;
end;
$$;

-- Regular leagues (round robin, knockout, groups, weekend league, survivor
-- — anything using leagues+fixtures+teams+members). Fires the instant a
-- fixture becomes fully paired (both sides known) and wasn't already —
-- covers a freshly-generated round (INSERT) and a knockout bracket advance
-- filling in a previously-unknown opponent (UPDATE) alike.
--
-- Rapid Cup fixtures are explicitly excluded — those already get their own
-- alarm + push the moment the lobby goes live; this would otherwise double
-- up on the exact same fixtures.
create or replace function _fixture_notify_next_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_name text;
  v_home_user uuid;
  v_away_user uuid;
  v_home_name text;
  v_away_name text;
begin
  if new.home_team_id is null or new.away_team_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.home_team_id is not null and old.away_team_id is not null then
    return new; -- already paired before this update — not a new pairing
  end if;
  if exists (select 1 from rapid_cup_lobbies where league_id = new.league_id) then
    return new; -- Rapid Cup already notifies via its own alarm/push
  end if;

  select name into v_league_name from leagues where id = new.league_id;

  select m.user_id, t.name into v_home_user, v_home_name
  from members m join teams t on t.id = m.team_id
  where m.team_id = new.home_team_id limit 1;

  select m.user_id, t.name into v_away_user, v_away_name
  from members m join teams t on t.id = m.team_id
  where m.team_id = new.away_team_id limit 1;

  if v_home_user is not null then
    perform _notify_match_push(
      array[v_home_user],
      '⚡ Next match set',
      coalesce(v_away_name, 'Your opponent') || ' — ' || coalesce(v_league_name, 'your league'),
      jsonb_build_object('leagueId', new.league_id, 'fixtureId', new.id)
    );
  end if;
  if v_away_user is not null then
    perform _notify_match_push(
      array[v_away_user],
      '⚡ Next match set',
      coalesce(v_home_name, 'Your opponent') || ' — ' || coalesce(v_league_name, 'your league'),
      jsonb_build_object('leagueId', new.league_id, 'fixtureId', new.id)
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_fixture_notify_next_match on fixtures;
create trigger trg_fixture_notify_next_match
after insert or update of home_team_id, away_team_id on fixtures
for each row execute function _fixture_notify_next_match();

-- Random matches — direct challenges. Fires the instant a challenge is
-- accepted (not on send — that's still just a pending invite, nothing to
-- notify about yet).
create or replace function _challenge_notify_next_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from 'accepted') then
    perform _notify_match_push(
      array[new.challenger_id, new.opponent_id],
      '⚡ Next match set',
      'Your challenge match is on — good luck!',
      jsonb_build_object('challengeId', new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_challenge_notify_next_match on challenges;
create trigger trg_challenge_notify_next_match
after insert or update of status on challenges
for each row execute function _challenge_notify_next_match();

-- Random matches — the open challenge board. Fires the instant someone
-- accepts an open challenge, pairing two players who weren't matched
-- before that moment (the actually "random" part).
create or replace function _open_challenge_notify_next_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted' and (tg_op = 'INSERT' or old.status is distinct from 'accepted') and new.accepted_by is not null then
    perform _notify_match_push(
      array[new.creator_id, new.accepted_by],
      '⚡ Next match set',
      'A random match just got matched — good luck!',
      jsonb_build_object('openChallengeId', new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_open_challenge_notify_next_match on open_challenges;
create trigger trg_open_challenge_notify_next_match
after insert or update of status on open_challenges
for each row execute function _open_challenge_notify_next_match();
