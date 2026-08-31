-- WEAFRICA SURVIVAL LADDER CUP — rebirth fee now scales with career wins.
--
-- Both "buy your life back" prices in this format — the free second-life
-- points deduction and the paid rebirth Nets fee — go up 10% per win the
-- club is carrying, rounded at each step (see winScaledFee,
-- src/formats/ladderCup.js, for the exact rounding rule and the reasoning
-- behind computing it live off `w` rather than storing a price on the
-- offer). The second-life half of that is pure client-computed pts, no DB
-- change needed. The rebirth half is a real Nets charge (nets_debit,
-- inside this SECURITY DEFINER function) — that has to be computed
-- server-side, off the row's own `w`, or a club could just tell the
-- client to charge less.
--
-- Because the fee is computed off `w` at the moment of rebirth rather than
-- being fixed at 6 forever, this already prices every currently-eliminated
-- club correctly the instant this migration runs — nothing to backfill.
--
-- Only change from 20260914: v_fee is no longer a flat constant. Every
-- other check (eligibility, cutoff, ownership) and every other column this
-- touches (status/second_life/rating/badges resetting, pts/w/l/gd/streak
-- NOT resetting, rebirth_count/past_lives/reborn_at bookkeeping) is
-- unchanged.
--
-- Safe to run more than once.

-- Same compounding-with-rounding-at-each-step rule as winScaledFee()
-- (src/formats/ladderCup.js) — the two need to agree since the client
-- shows this price as an estimate before the server charges it for real.
create or replace function ladder_cup_win_scaled_fee(p_base_fee bigint, p_wins integer)
returns bigint
language plpgsql
immutable
as $$
declare
  v_amount bigint := p_base_fee;
  v_i integer := 0;
begin
  while v_i < coalesce(p_wins, 0) loop
    v_amount := round(v_amount * 1.1);
    v_i := v_i + 1;
  end loop;
  return v_amount;
end;
$$;

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
  v_base_fee constant bigint := 6; -- LADDER_CUP_REBIRTH_FEE_NETS — keep in sync with src/economy.js
  v_fee bigint;
  v_entry ladder_cup_entries;
  v_status text;
  v_w integer;
  v_cutoff timestamptz;
  v_finalized timestamptz;
begin
  select e.status, e.w, l.ladder_cup_cutoff_at, l.ladder_cup_finalized_at
    into v_status, v_w, v_cutoff, v_finalized
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

  v_fee := ladder_cup_win_scaled_fee(v_base_fee, v_w);

  -- Charge before touching the entry — see header. nets_debit resolves
  -- auth.uid() itself (same JWT, same transaction), so this debits the
  -- actual caller, not this function's owner.
  perform nets_debit(v_fee, 'ladder_cup_rebirth', 'Bought life back — Survival Ladder Cup', 'ladder_cup_entry', p_entry_id::text);

  -- pts/w/l/gd/streak deliberately absent from this SET list — rebirth
  -- doesn't reset them (see 20260914).
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
