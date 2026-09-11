-- WEAFRICA SURVIVAL LADDER CUP — rebirth fee drops to a 3N base and
-- switches from the 10%-compounding win scaling (20260915) to a flat
-- +1N per win instead.
--
-- ladder_cup_win_scaled_fee (20260915) stays exactly as it was — it's
-- still what prices the second-life pts deduction on the client
-- (winScaledFee, src/formats/ladderCup.js) — this migration doesn't
-- touch it. A new function, ladder_cup_rebirth_fee, is added
-- specifically for the Nets rebirth charge, mirroring the client's new
-- rebirthScaledFee(): baseFee + wins, no rounding needed since both
-- terms are already integers.
--
-- Only change from 20260915: v_base_fee moves from 6 to 3
-- (LADDER_CUP_REBIRTH_FEE_NETS, src/economy.js) and v_fee is computed
-- via ladder_cup_rebirth_fee() instead of ladder_cup_win_scaled_fee().
-- Every other check (eligibility, cutoff, ownership) and every other
-- column this touches (status/second_life/rating/badges resetting,
-- pts/w/l/gd/streak NOT resetting, rebirth_count/past_lives/reborn_at
-- bookkeeping) is unchanged.
--
-- Because the fee is still computed off `w` at the moment of rebirth
-- rather than being fixed forever, this already prices every
-- currently-eliminated club correctly the instant this migration runs —
-- nothing to backfill.
--
-- Safe to run more than once.

-- Same flat-per-win rule as rebirthScaledFee() (src/formats/ladderCup.js)
-- — the two need to agree since the client shows this price as an
-- estimate before the server charges it for real.
create or replace function ladder_cup_rebirth_fee(p_base_fee bigint, p_wins integer)
returns bigint
language sql
immutable
as $$
  select p_base_fee + coalesce(p_wins, 0);
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
  v_base_fee constant bigint := 3; -- LADDER_CUP_REBIRTH_FEE_NETS — keep in sync with src/economy.js
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

  v_fee := ladder_cup_rebirth_fee(v_base_fee, v_w);

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
