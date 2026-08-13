-- WEAFRICA SURVIVAL LADDER CUP — second-life decision history
--
-- WHY THIS EXISTS: correcting an already-confirmed Ladder Cup result (see
-- 20260822_ladder_cup_result_correction.sql) means replaying every match
-- in the league from scratch through the pure engine (formats/ladderCup.js)
-- with the one corrected score swapped in. Replay reproduces
-- recordLadderCupWin/applyLoss deterministically from the raw
-- match/walkover event log — but a second-life ACCEPT/DECLINE is a human
-- decision that happened outside that event log; ladder_cup_entries only
-- ever stores a club's *current* second_life_used flag / offer window, not
-- which decision was actually made or when. Without a durable record of
-- that decision, replay has no way to know whether a club accepted or
-- declined/let a past offer lapse.
--
-- Each club gets AT MOST ONE second-life offer, ever — applyLoss
-- (formats/ladderCup.js) only creates one while second_life_used is still
-- false; any loss after that is final. So this is a (league_id, team_id)
-- unique row, not a growing log. An offer is recorded the moment
-- apply_ladder_cup_entry_result sees a fresh transition into
-- 'pending_second_life' (a second_life_offered_at value it hasn't stored
-- for this entry before); the decision (accepted / declined / expired) is
-- filled in later by record_ladder_cup_second_life_response, called from
-- App.jsx's respondLadderCupSecondLife and from the lazy 24h-expiry check.
--
-- Rows written before this migration existed have no history here — the
-- recompute (see the correction migration) falls back to the entry's
-- current second_life_used flag for those, same "predates X" carve-out the
-- comment-edit feature already uses for old, non-linked result posts.

create table if not exists ladder_cup_second_life_offers (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references leagues(id) on delete cascade,
  entry_id uuid not null references ladder_cup_entries(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  offered_at timestamptz not null,
  expires_at timestamptz not null,
  responded_at timestamptz,
  response_type text check (response_type in ('accepted', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  unique (league_id, team_id)
);

create index if not exists idx_ladder_cup_second_life_offers_league
  on ladder_cup_second_life_offers(league_id);

-- Re-declared in full (not just alter) so the one function body stays the
-- single source of truth for what an entry write does — same pattern
-- 20260819/20260820 already use for their own re-creates. Only change
-- from 20260819's version: looks up the entry's own team_id/previous
-- offered_at server-side (rather than trusting p_team_a_id/p_team_b_id,
-- which are the winner/loser of the *match*, not necessarily this
-- entry's own club) and upserts an offer row on a genuinely new
-- second_life_offered_at.
create or replace function apply_ladder_cup_entry_result(
  p_entry_id uuid,
  p_league_id uuid,
  p_team_a_id uuid,
  p_team_b_id uuid,
  p_pts integer,
  p_w integer,
  p_l integer,
  p_gd integer,
  p_streak integer,
  p_status text,
  p_second_life_used boolean,
  p_second_life_offered_at timestamptz,
  p_second_life_expires_at timestamptz,
  p_toughest_opponent_beaten_pts integer,
  p_ladder_rating integer,
  p_badge_heater_tier smallint,
  p_badge_giant_slayer integer,
  p_badge_second_life boolean,
  p_badge_walkover integer,
  p_badge_bounty_hunter integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_prev_offered_at timestamptz;
begin
  select team_id, second_life_offered_at into v_team_id, v_prev_offered_at
  from ladder_cup_entries where id = p_entry_id and league_id = p_league_id;

  if not found then
    raise exception 'Ladder cup entry % not found in league %', p_entry_id, p_league_id;
  end if;

  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id in (p_team_a_id, p_team_b_id)
  ) and not exists (
    select 1 from leagues l where l.id = p_league_id and l.created_by = auth.uid()
  ) then
    raise exception 'Not authorized to update this ladder cup entry';
  end if;

  update ladder_cup_entries set
    pts = p_pts, w = p_w, l = p_l, gd = p_gd, streak = p_streak, status = p_status,
    second_life_used = p_second_life_used,
    second_life_offered_at = p_second_life_offered_at,
    second_life_expires_at = p_second_life_expires_at,
    toughest_opponent_beaten_pts = p_toughest_opponent_beaten_pts,
    ladder_rating = p_ladder_rating,
    badge_heater_tier = p_badge_heater_tier,
    badge_giant_slayer = p_badge_giant_slayer,
    badge_second_life = p_badge_second_life,
    badge_walkover = p_badge_walkover,
    badge_bounty_hunter = p_badge_bounty_hunter,
    updated_at = now()
  where id = p_entry_id;

  -- A fresh offer: status just moved to pending_second_life carrying an
  -- offered_at we haven't recorded before. Upsert rather than a bare
  -- insert since a club only ever gets one lifetime row here (see the
  -- table comment above) — keeps this replay-safe if it's ever called
  -- twice with the same offer.
  if p_status = 'pending_second_life' and p_second_life_offered_at is not null
     and p_second_life_offered_at is distinct from v_prev_offered_at then
    insert into ladder_cup_second_life_offers (league_id, entry_id, team_id, offered_at, expires_at)
    values (p_league_id, p_entry_id, v_team_id, p_second_life_offered_at, p_second_life_expires_at)
    on conflict (league_id, team_id) do update set
      entry_id = excluded.entry_id,
      offered_at = excluded.offered_at,
      expires_at = excluded.expires_at,
      responded_at = null,
      response_type = null;
  end if;
end;
$$;

grant execute on function apply_ladder_cup_entry_result(
  uuid, uuid, uuid, uuid, integer, integer, integer, integer, integer, text,
  boolean, timestamptz, timestamptz, integer, integer, smallint, integer, boolean, integer, integer
) to authenticated;

-- Records how a club's one-and-only second-life offer was resolved.
-- Called from respondLadderCupSecondLife (accept/decline, App.jsx) and
-- from the lazy 24h-expiry check (response_type = 'expired'). Same
-- authorization shape as apply_ladder_cup_entry_result: the club's own
-- member, or the league's creator (covers an admin resolving a stale
-- offer on someone's behalf).
create or replace function record_ladder_cup_second_life_response(
  p_entry_id uuid,
  p_league_id uuid,
  p_team_id uuid,
  p_response_type text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_response_type not in ('accepted', 'declined', 'expired') then
    raise exception 'Invalid second-life response type: %', p_response_type;
  end if;

  if not exists (
    select 1 from ladder_cup_entries e where e.id = p_entry_id and e.league_id = p_league_id and e.team_id = p_team_id
  ) then
    raise exception 'Ladder cup entry % not found in league %', p_entry_id, p_league_id;
  end if;

  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id = p_team_id
  ) and not exists (
    select 1 from leagues l where l.id = p_league_id and l.created_by = auth.uid()
  ) then
    raise exception 'Not authorized to respond for this ladder cup entry';
  end if;

  update ladder_cup_second_life_offers set
    responded_at = now(),
    response_type = p_response_type
  where league_id = p_league_id and team_id = p_team_id;

  -- Self-heal: the offer row can be missing if the entry moved into
  -- pending_second_life before this migration existed. Insert a
  -- best-effort record now rather than silently no-opping, so at least
  -- the response itself is captured going forward.
  if not found then
    insert into ladder_cup_second_life_offers (league_id, entry_id, team_id, offered_at, expires_at, responded_at, response_type)
    values (p_league_id, p_entry_id, p_team_id, now(), now(), now(), p_response_type)
    on conflict (league_id, team_id) do update set
      responded_at = excluded.responded_at,
      response_type = excluded.response_type;
  end if;
end;
$$;

grant execute on function record_ladder_cup_second_life_response(uuid, uuid, uuid, text) to authenticated;
