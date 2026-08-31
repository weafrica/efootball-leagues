-- WEAFRICA SURVIVAL LADDER CUP — rebirth now costs 6N ("buy your life
-- back") instead of being free.
--
-- Until now rebirth_ladder_cup_entry (20260823) was a pure state reset —
-- no Nets involved anywhere in the rebirth path. This migration charges
-- LADDER_CUP_REBIRTH_FEE_NETS (6, src/economy.js) via nets_debit inside
-- the same transaction as the reset, same atomic charge-and-mutate
-- pattern join_ladder() (20260849) uses: nets_debit is called first and
-- raises its own "insufficient balance" error (matched client-side via
-- /insufficient/i, same convention as every other Nets-gated action in
-- this codebase) before anything on the entry itself is touched, so
-- there's no way to end up charged-but-not-reborn or
-- reborn-but-uncharged — a failed debit rolls the whole call back.
--
-- Only the signature-compatible body changes; everything else about
-- rebirth (eligibility checks, the reset itself, ownership check) is
-- unchanged from 20260823. Safe to run more than once.
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

  update ladder_cup_entries set
    pts = 0, w = 0, l = 0, gd = 0, streak = 0,
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
