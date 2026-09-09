-- Extends 20260904105705_next_match_notifications to League Ladder, the one
-- league type it didn't cover yet (Ladder Cup already gets the same
-- treatment for free, since it also runs through the `challenges` table —
-- see economy.js's comment on that table). ladder_fixtures pairs players
-- directly (home_user_id/away_user_id), no teams/members join needed.
--
-- Dedup table, not just an "already paired before this update" guard like
-- _fixture_notify_next_match uses: _generate_round_robin_fixtures_internal
-- deletes every 'pending' row for the week and reinserts the whole
-- schedule from scratch on every regen (a player joining or leaving mid-
-- week re-runs it), so the same fixture can get a brand-new id and arrive
-- as a fresh INSERT more than once. This table remembers which exact
-- (league, week, leg, pairing) has already been pinged so a regen can
-- never re-notify the same match twice.
create table if not exists ladder_fixture_notify_sent (
  league_id uuid not null,
  week_number integer not null,
  leg smallint not null,
  home_user_id uuid not null,
  away_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (league_id, week_number, leg, home_user_id, away_user_id)
);

alter table ladder_fixture_notify_sent enable row level security;
-- No policies on purpose — this is internal bookkeeping for the trigger
-- function below (SECURITY DEFINER, runs as its owner), never read or
-- written by a client directly.

create or replace function _ladder_fixture_notify_next_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
  v_tier integer;
  v_home_name text;
  v_away_name text;
begin
  if new.home_user_id is null or new.away_user_id is null then
    return new;
  end if;

  insert into ladder_fixture_notify_sent (league_id, week_number, leg, home_user_id, away_user_id)
  values (new.league_id, new.week_number, new.leg, new.home_user_id, new.away_user_id)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return new; -- a regen re-created a pairing that was already notified
  end if;

  select tier into v_tier from ladder_leagues where id = new.league_id;
  select coalesce(efootball_username, 'Player') into v_home_name from profiles where user_id = new.home_user_id;
  select coalesce(efootball_username, 'Player') into v_away_name from profiles where user_id = new.away_user_id;

  perform _notify_match_push(
    array[new.home_user_id],
    '⚡ Next match set',
    coalesce(v_away_name, 'Your opponent') || ' — League Ladder' || case when v_tier is not null then ' ' || v_tier else '' end,
    jsonb_build_object('leagueId', new.league_id, 'ladderFixtureId', new.id)
  );
  perform _notify_match_push(
    array[new.away_user_id],
    '⚡ Next match set',
    coalesce(v_home_name, 'Your opponent') || ' — League Ladder' || case when v_tier is not null then ' ' || v_tier else '' end,
    jsonb_build_object('leagueId', new.league_id, 'ladderFixtureId', new.id)
  );

  return new;
end;
$$;

drop trigger if exists trg_ladder_fixture_notify_next_match on ladder_fixtures;
create trigger trg_ladder_fixture_notify_next_match
after insert on ladder_fixtures
for each row execute function _ladder_fixture_notify_next_match();
