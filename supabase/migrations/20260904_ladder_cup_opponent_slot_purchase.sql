-- WEAFRICA SURVIVAL LADDER CUP — pay-to-reveal extra opponents.
--
-- Until now the opponent board showed all of getOpponentPool's slate
-- (up to LADDER_CUP_RULES.SHOWN_OPPONENTS = 10) for free, just windowed
-- behind a 3-row-tall scroll (LADDER_CUP_OPPONENT_VISIBLE_ROWS,
-- LeagueDetail.jsx) — scrolling revealed the rest at no cost. This
-- flips that: only LADDER_CUP_BASE_VISIBLE_OPPONENTS (3, src/economy.js)
-- are shown for free; unlocking each opponent beyond that costs
-- LADDER_CUP_OPPONENT_SLOT_FEE_NETS (1N) via buy_ladder_cup_opponent_slot
-- below, up to the existing SHOWN_OPPONENTS ceiling of 10 total (the
-- underlying matchmaking pool itself is unchanged — this only gates how
-- much of it a club can see without paying).
--
-- purchased_opponent_slots tracks how many extra slots a club has bought
-- this cup — 3 base + purchased, capped so the total never exceeds 10,
-- mirroring the client-side clamp in LadderCupOpponentBoard.

alter table ladder_cup_entries
  add column if not exists purchased_opponent_slots integer not null default 0;

-- Same atomic charge-then-mutate pattern as rebirth_ladder_cup_entry
-- (20260897): nets_debit is called first and raises its own
-- "insufficient balance" error (matched client-side via /insufficient/i,
-- same convention as every other Nets-gated action in this codebase)
-- before the entry is touched, so there's no way to end up
-- charged-but-not-unlocked or unlocked-but-uncharged — a failed debit
-- rolls the whole call back. `for update of e` locks the entry row so
-- two near-simultaneous taps on the button can't both slip past the cap
-- check before either write lands.
create or replace function buy_ladder_cup_opponent_slot(
  p_entry_id uuid,
  p_league_id uuid,
  p_team_id uuid
)
returns ladder_cup_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee constant bigint := 1;   -- LADDER_CUP_OPPONENT_SLOT_FEE_NETS — keep in sync with src/economy.js
  v_base constant integer := 3; -- LADDER_CUP_BASE_VISIBLE_OPPONENTS — keep in sync with src/economy.js
  v_max constant integer := 10; -- LADDER_CUP_RULES.SHOWN_OPPONENTS (formats/ladderCup.js) — the hard ceiling
  v_entry ladder_cup_entries;
  v_status text;
  v_cutoff timestamptz;
  v_finalized timestamptz;
begin
  select e.status, l.ladder_cup_cutoff_at, l.ladder_cup_finalized_at
    into v_status, v_cutoff, v_finalized
  from ladder_cup_entries e
  join leagues l on l.id = e.league_id
  where e.id = p_entry_id and e.league_id = p_league_id and e.team_id = p_team_id
  for update of e;

  if not found then
    raise exception 'Ladder cup entry % not found in league %', p_entry_id, p_league_id;
  end if;

  if v_status <> 'active' then
    raise exception 'Only an active club can unlock more opponents.';
  end if;

  if v_finalized is not null or (v_cutoff is not null and v_cutoff <= now()) then
    raise exception 'The Ladder Cup cutoff has passed — opponent slots are closed.';
  end if;

  if not exists (
    select 1 from members m where m.user_id = auth.uid() and m.team_id = p_team_id
  ) then
    raise exception 'Not authorized to buy opponent slots for this club.';
  end if;

  if (select purchased_opponent_slots from ladder_cup_entries where id = p_entry_id) + v_base >= v_max then
    raise exception 'Already unlocked the maximum of % opponents.', v_max;
  end if;

  perform nets_debit(v_fee, 'ladder_cup_opponent_slot', 'Unlocked an extra Ladder Cup opponent', 'ladder_cup_entry', p_entry_id::text);

  update ladder_cup_entries
  set purchased_opponent_slots = purchased_opponent_slots + 1,
      updated_at = now()
  where id = p_entry_id
  returning * into v_entry;

  return v_entry;
end;
$$;

grant execute on function buy_ladder_cup_opponent_slot(uuid, uuid, uuid) to authenticated;
