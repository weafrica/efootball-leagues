-- League Ladder redesign — Phase D, step 15 (the one piece of Phase D that
-- was never built): live re-eligibility, tied to fixture results.
--
-- _ladder_bid_eligible_pool_internal (already live) keeps a newly-rank-1
-- player from placing a NEW bid on the league above. But nothing rechecked
-- an EXISTING pending bid when a fixture result changes the standings
-- mid-week -- a player could place a bid while sitting at rank 2, then win
-- a match that puts them at rank 1 (on track for free auto-promotion),
-- and their now-stale bid just sits there uncontested.
--
-- This closes that gap: whenever a fixture's result is recorded (status
-- becomes 'played'/'forfeited', or an already-recorded result is
-- corrected), recheck whether the current bid leader for the league one
-- tier above has newly become rank 1 of the league that just played. If
-- so, void and refund their bid immediately -- same refund path Phase C's
-- dethrone case already uses (_nets_credit_internal + _ladder_pool_debit,
-- reason 'ladder_bid_refund').
--
-- No "promote the 2nd-highest pending bid" step is needed here: under the
-- live "beat-the-leader" model Phase C already deployed, a dethroned
-- bidder is refunded immediately at bid time, so there is never a second
-- 'pending' bid sitting behind the leader for a given league. If that
-- invariant is ever relaxed, the next place_ladder_bid call or Sunday's
-- _ladder_settle_bids_internal will naturally pick up the next-highest
-- pending bid as leader -- nothing here needs to do that itself.
--
-- Deliberately no JS mirror: like Phase F's retroactive top-up loop, this
-- is backend orchestration tied to a live table trigger, not a pure
-- pricing function every other JS/SQL pair in this codebase mirrors.
--
-- Safe to run more than once.

create or replace function _ladder_recheck_bid_leader_eligibility_internal(
  p_league_id uuid,
  p_week_number integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier integer;
  v_target_league_id uuid;
  v_standings uuid[];
  v_rank1 uuid;
  v_leader ladder_bids%rowtype;
begin
  select tier into v_tier from ladder_leagues where id = p_league_id;
  if v_tier is null or v_tier <= 1 then
    return; -- tier 1 has no league above to bid into
  end if;

  select id into v_target_league_id from ladder_leagues where tier = v_tier - 1;
  if v_target_league_id is null then
    return; -- no active league one tier up right now
  end if;

  v_standings := _ladder_live_standings_internal(p_league_id, p_week_number);
  if coalesce(array_length(v_standings, 1), 0) = 0 then
    return;
  end if;
  v_rank1 := v_standings[1];

  -- Lock the target league's current leading bid before comparing, same
  -- pattern place_ladder_bid already uses.
  select * into v_leader
  from ladder_bids
  where target_league_id = v_target_league_id
    and week_number = p_week_number
    and status = 'pending'
  order by amount desc, placed_at asc
  limit 1
  for update;

  if v_leader.id is null then
    return; -- nobody currently leading a bid on this league
  end if;

  if v_leader.bidder_user_id <> v_rank1 then
    return; -- leader hasn't (newly or otherwise) become rank 1 below
  end if;

  update ladder_bids set status = 'refunded' where id = v_leader.id;
  perform _nets_credit_internal(
    v_leader.bidder_user_id, v_leader.amount, 'ladder_bid_refund', null, 'ladder_bid', v_leader.id::text
  );
  perform _ladder_pool_debit(
    v_leader.amount, 'ladder_bid_refund', v_leader.bidder_user_id, 'ladder_bid', v_leader.id::text
  );
end;
$$;

create or replace function _ladder_fixture_result_recheck_bid_leader_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('played', 'forfeited') then
    if tg_op = 'INSERT'
       or old.status is distinct from new.status
       or old.home_score is distinct from new.home_score
       or old.away_score is distinct from new.away_score
    then
      perform _ladder_recheck_bid_leader_eligibility_internal(new.league_id, new.week_number);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists ladder_fixture_result_recheck_bid_leader on ladder_fixtures;
create trigger ladder_fixture_result_recheck_bid_leader
after insert or update on ladder_fixtures
for each row
execute function _ladder_fixture_result_recheck_bid_leader_trigger();
