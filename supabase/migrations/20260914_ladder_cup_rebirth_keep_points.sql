-- WEAFRICA SURVIVAL LADDER CUP — rebirth stops zeroing pts/w/l/gd/streak.
--
-- Until now rebirth_ladder_cup_entry (20260823, fee added in 20260897)
-- reset a reborn club to a brand-new day-one run: pts/w/l/gd/streak all
-- back to 0, with the finished life archived into past_lives purely for
-- display. Paying LADDER_CUP_REBIRTH_FEE_NETS (6N) is now what buys the
-- club back onto the ladder WITHOUT losing that standing — the archived
-- past_lives entry becomes a checkpoint ("life 2 started at 340 pts"), not
-- a record of points that got wiped.
--
-- Only change from 20260897: pts, w, l, gd, streak are dropped from the
-- SET list entirely (an UPDATE only touches columns it lists — omitting
-- them leaves the current value untouched). Everything else about rebirth
-- is unchanged: the fee, eligibility checks (only a fully 'eliminated'
-- entry can be reborn), the cutoff guard, ownership check, second life /
-- ladder_rating / badges resetting (those gated the elimination itself,
-- not the standing), and rebirth_count / past_lives / reborn_at
-- bookkeeping. Matches the corresponding change in reborn()
-- (src/formats/ladderCup.js) — that function no longer zeroes those same
-- five fields either, so the client-computed life checkpoint and this
-- RPC's persisted row agree on what "reborn" now means.
--
-- Safe to run more than once.
create or replace function rebirth_ladder_cup_entry(
  p_entry_id uuid,
  p_league_id uuid,
  p_team_id uuid,
  p_past_life jsonb
)
returns ladder_cup_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee constant bigint := 6; -- LADDER_CUP_REBIRTH_FEE_NETS — keep in sync with src/economy.js
  v_entry ladder_cup_entries;
  v_status text;
  v_cutoff timestamptz;
  v_finalized timestamptz;
begin
  select e.status, l.ladder_cup_cutoff_at, l.ladder_cup_finalized_at
    into v_status, v_cutoff, v_finalized
  from ladder_cup_entries e
  join leagues l on l.id = e.league_id
  where e.id = p_entry_id and e.league_id = p_league_id and e.team_id = p_team_id;

  if not found then
    raise exception 'Ladder cup entry % not found in league %', p_entry_id, p_league_id;
  end if;

  if v_status <> 'eliminated' then
    raise exception 'Only a fully eliminated club can be reborn.';
  end if;

  if v_finalized is not null or (v_cutoff is not null and v_cutoff <= now()) then
    raise exception 'The Ladder Cup cutoff has passed — rebirth is closed.';
  end if;

  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id = p_team_id
  ) then
    raise exception 'Not authorized to revive this club.';
  end if;

  -- Charge before touching the entry — see header. nets_debit resolves
  -- auth.uid() itself (same JWT, same transaction), so this debits the
  -- actual caller, not this function's owner.
  perform nets_debit(v_fee, 'ladder_cup_rebirth', 'Bought life back — Survival Ladder Cup', 'ladder_cup_entry', p_entry_id::text);

  -- pts/w/l/gd/streak deliberately absent from this SET list — rebirth no
  -- longer resets them, see header.
  update ladder_cup_entries set
    status = 'active',
    second_life_used = false,
    second_life_offered_at = null,
    second_life_expires_at = null,
    toughest_opponent_beaten_pts = 0,
    ladder_rating = 1000,
    badge_heater_tier = 0,
    badge_giant_slayer = 0,
    badge_second_life = false,
    badge_walkover = 0,
    badge_bounty_hunter = 0,
    rebirth_count = rebirth_count + 1,
    past_lives = past_lives || jsonb_build_array(p_past_life),
    reborn_at = now(),
    updated_at = now()
  where id = p_entry_id
  returning * into v_entry;

  return v_entry;
end;
$$;

grant execute on function rebirth_ladder_cup_entry(uuid, uuid, uuid, jsonb) to authenticated;
