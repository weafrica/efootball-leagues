-- Rapid Cup — Phase 3: Payout calculation (guaranteed stake-back
-- formula), server-side RPC. See RAPID-CUP-BUILD-PLAN.md Section 4a/4b.
--
-- Two functions:
--   1. compute_rapid_cup_payout() — pure math, no table access. Takes
--      the pool/winner_stake/max_stake and returns the full payout
--      breakdown. Easy to unit-test in isolation (see worked examples
--      in 4b) and reusable once Phase 8 (investor splits) needs the
--      same core numbers.
--   2. finalize_rapid_cup_payout() — looks up the real stakes for a
--      lobby, calls the formula, records the result, and marks the
--      lobby 'completed'. Idempotent: calling it twice for the same
--      lobby just returns the already-recorded payout.
--
-- Deliberately NOT granted to `authenticated` yet — see note at the
-- bottom. Winner determination from match results is Phase 4/5 work
-- (bracket completion + Section 4d tiebreakers); until that exists,
-- nothing should let a client simply declare itself the winner.

create or replace function compute_rapid_cup_payout(
  p_total_pool numeric,
  p_winner_stake numeric,
  p_max_stake numeric
)
returns table (
  base_return numeric,
  remaining_pool numeric,
  bonus_share numeric,
  bonus numeric,
  organizer_keep numeric,
  winner_bonus numeric,
  winner_net_total numeric,
  leftover numeric
)
language sql
immutable
as $$
  with calc as (
    select
      p_winner_stake as base_return,
      p_total_pool - p_winner_stake as remaining_pool,
      -- "highest fee = 100%" rule; nullif guards div-by-zero when
      -- every player set a 0 fee (winner_stake is then 0 too).
      coalesce(p_winner_stake / nullif(p_max_stake, 0), 0) as bonus_share
  ),
  bonus_calc as (
    select *, remaining_pool * bonus_share as bonus from calc
  )
  select
    base_return,
    remaining_pool,
    bonus_share,
    bonus,
    round(bonus * 0.10, 2) as organizer_keep,
    round(bonus * 0.90, 2) as winner_bonus,
    round(base_return + bonus * 0.90, 2) as winner_net_total,
    round(remaining_pool - bonus, 2) as leftover
  from bonus_calc;
$$;

create table if not exists rapid_cup_payouts (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid not null unique references rapid_cup_lobbies(id),
  league_id uuid,
  winner_user_id uuid not null references auth.users(id),
  total_pool numeric not null,
  winner_stake numeric not null,
  max_stake numeric not null,
  base_return numeric not null,
  remaining_pool numeric not null,
  bonus_share numeric not null,
  bonus numeric not null,
  organizer_keep numeric not null,
  winner_bonus numeric not null,
  winner_net_total numeric not null,
  leftover numeric not null,
  created_at timestamptz not null default now()
);

alter table rapid_cup_payouts enable row level security;

create policy "rapid_cup_payouts readable by all signed-in users"
  on rapid_cup_payouts for select
  using (auth.role() = 'authenticated');

create or replace function finalize_rapid_cup_payout(p_lobby_id uuid, p_winner_user_id uuid)
returns rapid_cup_payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_existing rapid_cup_payouts;
  v_total_pool numeric;
  v_max_stake numeric;
  v_winner_stake numeric;
  v_calc record;
  v_payout rapid_cup_payouts;
begin
  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid Cup lobby % not found', p_lobby_id;
  end if;

  -- Idempotent — already paid out, just hand back the same record.
  select * into v_existing from rapid_cup_payouts where lobby_id = p_lobby_id;
  if v_existing.id is not null then
    return v_existing;
  end if;

  if v_lobby.status <> 'live' or v_lobby.league_id is null then
    raise exception 'Rapid Cup lobby % is not live with a generated bracket', p_lobby_id;
  end if;

  select sum(entry_fee), max(entry_fee) into v_total_pool, v_max_stake
  from rapid_cup_lobby_players
  where lobby_id = p_lobby_id;

  select entry_fee into v_winner_stake
  from rapid_cup_lobby_players
  where lobby_id = p_lobby_id and user_id = p_winner_user_id;

  if v_winner_stake is null then
    raise exception 'User % is not one of the 4 players in lobby %', p_winner_user_id, p_lobby_id;
  end if;

  select * into v_calc from compute_rapid_cup_payout(v_total_pool, v_winner_stake, v_max_stake);

  insert into rapid_cup_payouts (
    lobby_id, league_id, winner_user_id, total_pool, winner_stake, max_stake,
    base_return, remaining_pool, bonus_share, bonus, organizer_keep, winner_bonus, winner_net_total, leftover
  ) values (
    p_lobby_id, v_lobby.league_id, p_winner_user_id, v_total_pool, v_winner_stake, v_max_stake,
    v_calc.base_return, v_calc.remaining_pool, v_calc.bonus_share, v_calc.bonus,
    v_calc.organizer_keep, v_calc.winner_bonus, v_calc.winner_net_total, v_calc.leftover
  )
  returning * into v_payout;

  update rapid_cup_lobbies set status = 'completed' where id = p_lobby_id;

  return v_payout;
end;
$$;

-- NOT granted to `authenticated`. Winner determination (who actually
-- won the bracket, including the Section 4d tiebreakers for an
-- unfinished bracket at the 4hr mark) is Phase 4/5 work and doesn't
-- exist yet. Once that auto-finish logic can compute a server-verified
-- winner, it should call finalize_rapid_cup_payout() itself (as
-- security definer, or via a scheduled job) — a client should never be
-- able to call this directly and name itself the winner.
