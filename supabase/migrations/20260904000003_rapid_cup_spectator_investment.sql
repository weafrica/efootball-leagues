-- Rapid Cup — Phase 8: Spectator Investment (Section 7).
--
-- New: rapid_cup_investments (append-only ledger, same shape as
-- nets_transactions/ladder_pool_transactions elsewhere in this repo — a
-- spectator can top up an investment more than once, so this is a ledger
-- of contributions, not a single mutable row) + invest_in_rapid_cup_player(),
-- the only way money ever lands in it.
--
-- This also REWRITES Phase 3's finalize_rapid_cup_payout() and Phase 4b's
-- _rapid_cup_finish_lobby_internal() so the payout math is driven by each
-- player's total_stake (own entry fee + everything invested in them, per
-- Section 7: "Total stake counts toward max_stake and the bonus-share
-- calculation") instead of entry_fee alone. Both are CREATE OR REPLACE —
-- a cup with zero investments in it computes byte-identical numbers to
-- before (invested = 0 for everyone collapses every formula below back to
-- the original entry-fee-only math), so this is additive, not a behavior
-- change for existing/ordinary cups.
--
-- BUG FOUND WHILE WIRING THIS UP, FIXED HERE (flagged because it's
-- load-bearing for Section 4c's investor guarantee, not just cosmetic):
-- Section 4a's own spec says "Leftover (when the winner wasn't the top
-- stake) is refunded to the 3 losers, split proportional to their own
-- stakes" — but neither Phase 3 nor Phase 6 ever actually paid that out.
-- collect_rapid_cup_cupbox's 'winner' branch pays the winner
-- winner_net_total and gives every other player a flat $0, full stop —
-- the `leftover` column was computed and stored on rapid_cup_payouts but
-- never distributed to anyone. In the plan's own worked example (P1 wins
-- with a 1-Net stake against a 397-Net max_stake), leftover is 398 Nets
-- that simply vanished into no one's wallet. Section 4c promises investor
-- principal is "guaranteed back in every outcome — win, loss, or leftover
-- refund" — that promise cannot hold for an investor backing a losing
-- player unless the leftover actually gets refunded, so this migration
-- implements it now as part of enabling investment, not as a separate
-- unrelated fix. Case 3 (split) and Case 4 (refund) already did this
-- correctly for players and are untouched in their own outcome shape,
-- just extended to also cover investors.
--
-- Section 4d Case 3 (tied on both wins and goals) is left matching the
-- plan's literal wording: only the tied players' pool splits, non-tied
-- losers (and, new here, their investors) get an honest $0 recipient row
-- — the plan never describes a refund path for them the way it does for
-- Case 1/2's leftover or Case 4's full refund, so this is read as
-- intentional, not the same gap as above.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- rapid_cup_investments — ledger of spectator top-ups. target_user_id is
-- which of the 4 players the investment backs; investor_user_id is who put
-- the money in. No unique constraint — the same spectator can invest in
-- the same player more than once (top-ups), and each row is its own
-- immutable contribution, same ledger shape as nets_transactions.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists rapid_cup_investments (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid not null references rapid_cup_lobbies(id) on delete cascade,
  investor_user_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_rapid_cup_investments_lobby_target
  on rapid_cup_investments (lobby_id, target_user_id);
create index if not exists idx_rapid_cup_investments_investor
  on rapid_cup_investments (investor_user_id);

alter table rapid_cup_investments enable row level security;

drop policy if exists "rapid_cup_investments readable by all signed-in users" on rapid_cup_investments;
create policy "rapid_cup_investments readable by all signed-in users"
  on rapid_cup_investments for select
  using (auth.role() = 'authenticated');

-- Writes only happen through invest_in_rapid_cup_player() below — no
-- direct insert/update policy granted to regular users.

-- ─────────────────────────────────────────────────────────────────────────
-- rapid_cup_payout_recipients gets two new columns so it can describe an
-- investor's own row alongside a player's, in the SAME outcome/payout —
-- previously this table only ever held rows for the 4 players themselves
-- (Case 3/4). Existing rows default to role='player',
-- invested_in_user_id=null, which is exactly what they already were.
-- ─────────────────────────────────────────────────────────────────────────
alter table rapid_cup_payout_recipients add column if not exists role text not null default 'player';
alter table rapid_cup_payout_recipients drop constraint if exists rapid_cup_payout_recipients_role_check;
alter table rapid_cup_payout_recipients add constraint rapid_cup_payout_recipients_role_check
  check (role in ('player', 'investor'));
alter table rapid_cup_payout_recipients add column if not exists invested_in_user_id uuid references auth.users(id);

create index if not exists idx_rapid_cup_payout_recipients_payout_user
  on rapid_cup_payout_recipients (payout_id, user_id);

-- ─────────────────────────────────────────────────────────────────────────
-- invest_in_rapid_cup_player — spectator-facing. Debits the caller's own
-- Nets via the existing nets_debit() (so it's subject to the same
-- insufficient-balance guard everything else in the app already uses),
-- then records the contribution. Same last-40-minute lock as entry fees
-- (Section 3's rule extends naturally to investment, since both feed the
-- same bonus_share/max_stake math and both would let someone game the
-- payout in the final seconds otherwise) — no mid-match restriction,
-- matching raise_rapid_cup_entry_fee's current (post-"allow anytime")
-- behavior.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function invest_in_rapid_cup_player(p_lobby_id uuid, p_target_user_id uuid, p_amount numeric)
returns rapid_cup_investments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_cup_ends_at timestamptz;
  v_investor_id uuid := auth.uid();
  v_row rapid_cup_investments;
begin
  if v_investor_id is null then
    raise exception 'invest_in_rapid_cup_player: must be signed in';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Investment amount must be greater than 0 Nets';
  end if;

  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id for update;
  if v_lobby.id is null then
    raise exception 'Rapid Cup lobby % not found', p_lobby_id;
  end if;

  if v_lobby.status <> 'live' or v_lobby.league_id is null then
    raise exception 'This Rapid Cup isn''t live yet — nothing to invest in';
  end if;

  if exists (select 1 from rapid_cup_payouts where lobby_id = p_lobby_id) then
    raise exception 'This Rapid Cup has already finished';
  end if;

  -- Same lock window as entry fees (Section 2/3) — can't invest in the
  -- final 40 minutes before the shared 4hr auto-finish.
  v_cup_ends_at := coalesce(v_lobby.started_at, v_lobby.created_at) + interval '4 hours';
  if v_cup_ends_at - now() <= interval '40 minutes' then
    raise exception 'Investing is locked in the last 40 minutes of the cup';
  end if;

  -- Spectators only — not one of the 4 competing players.
  if exists (select 1 from rapid_cup_lobby_players where lobby_id = p_lobby_id and user_id = v_investor_id) then
    raise exception 'Players in this Rapid Cup can''t invest in it — only spectators can';
  end if;

  -- Target must be one of the 4 actual players in this lobby.
  if not exists (select 1 from rapid_cup_lobby_players where lobby_id = p_lobby_id and user_id = p_target_user_id) then
    raise exception 'That player isn''t in this Rapid Cup';
  end if;

  -- Debits the caller's own wallet; raises on insufficient balance.
  perform nets_debit(p_amount::bigint, 'rapid_cup_investment', null, 'lobby', p_lobby_id::text);

  insert into rapid_cup_investments (lobby_id, investor_user_id, target_user_id, amount)
  values (p_lobby_id, v_investor_id, p_target_user_id, p_amount)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function invest_in_rapid_cup_player(uuid, uuid, numeric) from public, anon;
grant execute on function invest_in_rapid_cup_player(uuid, uuid, numeric) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_cup_player_stakes_internal — each of the 4 players' entry_fee,
-- what's been invested in them, and the combined total_stake (Section 7).
-- Shared by finalize_rapid_cup_payout and _rapid_cup_finish_lobby_internal
-- so both compute stakes exactly the same way.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rapid_cup_player_stakes_internal(p_lobby_id uuid)
returns table (user_id uuid, entry_fee numeric, invested numeric, total_stake numeric)
language sql
stable
as $$
  select
    lp.user_id,
    lp.entry_fee,
    coalesce(inv.invested, 0) as invested,
    lp.entry_fee + coalesce(inv.invested, 0) as total_stake
  from rapid_cup_lobby_players lp
  left join (
    select target_user_id, sum(amount) as invested
    from rapid_cup_investments
    where lobby_id = p_lobby_id
    group by target_user_id
  ) inv on inv.target_user_id = lp.user_id
  where lp.lobby_id = p_lobby_id;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_cup_split_recipient_internal — inserts one 'player' recipient row
-- for p_player_user_id and one 'investor' row per person who backed them,
-- splitting a principal amount (returned to everyone in proportion to
-- their own contribution, no skim) and a profit amount (Section 7: split
-- self_share/invested_share by contribution, then invested_share itself
-- 80% to investors / 20% to the player) between them. Pass p_profit_amount
-- = 0 for a pure refund (Case 4, and the leftover-to-losers case below) —
-- Section 4c: "no 80/20 split applied to a refund".
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rapid_cup_split_recipient_internal(
  p_payout_id uuid,
  p_lobby_id uuid,
  p_player_user_id uuid,
  p_own_fee numeric,
  p_invested_total numeric,
  p_total_stake numeric,
  p_principal_amount numeric,
  p_profit_amount numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_own_ratio numeric := case when p_total_stake > 0 then p_own_fee / p_total_stake else 0 end;
  v_invested_ratio numeric := case when p_total_stake > 0 then p_invested_total / p_total_stake else 0 end;
  v_invested_profit numeric := p_profit_amount * v_invested_ratio;
  v_investor_profit_pool numeric := v_invested_profit * 0.80; -- Section 7: investors get 80% of invested_share
  v_player_amount numeric;
  v_row record;
begin
  v_player_amount := (p_principal_amount * v_own_ratio)
                    + (p_profit_amount * v_own_ratio)
                    + (v_invested_profit * 0.20);

  insert into rapid_cup_payout_recipients (payout_id, user_id, stake, amount, role, invested_in_user_id)
  values (p_payout_id, p_player_user_id, p_own_fee, round(v_player_amount, 2), 'player', null);

  if p_invested_total > 0 then
    for v_row in
      select investor_user_id, sum(amount) as amt
      from rapid_cup_investments
      where lobby_id = p_lobby_id and target_user_id = p_player_user_id
      group by investor_user_id
    loop
      insert into rapid_cup_payout_recipients (payout_id, user_id, stake, amount, role, invested_in_user_id)
      values (
        p_payout_id,
        v_row.investor_user_id,
        v_row.amt,
        round((p_principal_amount * v_row.amt / p_total_stake) + (v_investor_profit_pool * v_row.amt / p_invested_total), 2),
        'investor',
        p_player_user_id
      );
    end loop;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- finalize_rapid_cup_payout — REPLACED. Same signature/table shape as
-- Phase 3 (still not granted to authenticated — see that migration's
-- note, unchanged reasoning). Now: stakes are total_stake (fee +
-- investment) not bare entry_fee, and every stakeholder — the winner AND
-- the 3 losers, plus each one's investors — gets a rapid_cup_payout_recipients
-- row in the same pass (see header comment re: the leftover-refund fix).
-- winner_stake/max_stake/winner_net_total columns on rapid_cup_payouts
-- keep recording the same combined (player + their investors) figures
-- Phase 3 always stored there — collect_rapid_cup_cupbox now reads the
-- recipients table first and only falls back to these columns for a
-- payout row that predates this migration and has no recipient rows.
-- ─────────────────────────────────────────────────────────────────────────
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
  v_winner_own_fee numeric;
  v_winner_invested numeric;
  v_calc record;
  v_payout rapid_cup_payouts;
  v_row record;
begin
  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid Cup lobby % not found', p_lobby_id;
  end if;

  select * into v_existing from rapid_cup_payouts where lobby_id = p_lobby_id;
  if v_existing.id is not null then
    return v_existing;
  end if;

  if v_lobby.status <> 'live' or v_lobby.league_id is null then
    raise exception 'Rapid Cup lobby % is not live with a generated bracket', p_lobby_id;
  end if;

  select sum(total_stake), max(total_stake) into v_total_pool, v_max_stake
  from _rapid_cup_player_stakes_internal(p_lobby_id);

  select entry_fee, invested, total_stake into v_winner_own_fee, v_winner_invested, v_winner_stake
  from _rapid_cup_player_stakes_internal(p_lobby_id)
  where user_id = p_winner_user_id;

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

  -- Winner's side: guaranteed stake-back (base_return) + winner_bonus,
  -- split between the player and their investors per Section 7.
  perform _rapid_cup_split_recipient_internal(
    v_payout.id, p_lobby_id, p_winner_user_id,
    v_winner_own_fee, v_winner_invested, v_winner_stake,
    v_calc.base_return, v_calc.winner_bonus
  );

  -- The 3 losers: leftover refunded proportional to their own total_stake
  -- (Section 4a) — principal only, no profit skim, same as any refund.
  for v_row in
    select user_id, entry_fee, invested, total_stake
    from _rapid_cup_player_stakes_internal(p_lobby_id)
    where user_id <> p_winner_user_id
  loop
    perform _rapid_cup_split_recipient_internal(
      v_payout.id, p_lobby_id, v_row.user_id,
      v_row.entry_fee, v_row.invested, v_row.total_stake,
      case when v_calc.remaining_pool > 0 then v_calc.leftover * (v_row.total_stake / v_calc.remaining_pool) else 0 end,
      0
    );
  end loop;

  update rapid_cup_lobbies set status = 'completed' where id = p_lobby_id;

  return v_payout;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_cup_finish_lobby_internal — REPLACED. Case 1/2 unchanged in
-- shape (still delegate to finalize_rapid_cup_payout, now stake-aware
-- automatically). Case 3 and Case 4 rewritten to use total_stake and to
-- create investor recipient rows alongside each player's, via the same
-- split helper.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rapid_cup_finish_lobby_internal(p_lobby_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_league_id uuid;
  v_existing rapid_cup_payouts;
  v_total_pool numeric;
  v_max_stake numeric;
  v_any_played boolean;
  v_winners_at_max uuid[];
  v_max_wins integer;
  v_goal_winners uuid[];
  v_winner_user_id uuid;
  v_payout rapid_cup_payouts;
  v_row record;
  v_stake_row record;
  v_tied_stake_sum numeric;
  v_remaining numeric;
  v_bonus_each numeric;
begin
  select * into v_lobby from rapid_cup_lobbies where id = p_lobby_id for update;
  if v_lobby.id is null or v_lobby.status <> 'live' or v_lobby.league_id is null then
    return;
  end if;

  select * into v_existing from rapid_cup_payouts where lobby_id = p_lobby_id;
  if v_existing.id is not null then
    return; -- already finished
  end if;

  v_league_id := v_lobby.league_id;

  select sum(total_stake), max(total_stake) into v_total_pool, v_max_stake
  from _rapid_cup_player_stakes_internal(p_lobby_id);

  select exists(select 1 from fixtures where league_id = v_league_id and stage = 1 and played = true)
  into v_any_played;

  -- Case 4: nobody played a single match — full refund, principal only,
  -- for every player AND every investor (Section 4c: guaranteed back
  -- "no fees taken" in this outcome).
  if not v_any_played then
    insert into rapid_cup_payouts (lobby_id, league_id, winner_user_id, outcome, total_pool, max_stake)
    values (p_lobby_id, v_league_id, null, 'refund', v_total_pool, v_max_stake)
    returning * into v_payout;

    for v_stake_row in
      select user_id, entry_fee, invested, total_stake from _rapid_cup_player_stakes_internal(p_lobby_id)
    loop
      perform _rapid_cup_split_recipient_internal(
        v_payout.id, p_lobby_id, v_stake_row.user_id,
        v_stake_row.entry_fee, v_stake_row.invested, v_stake_row.total_stake,
        v_stake_row.total_stake, 0
      );
    end loop;

    update rapid_cup_lobbies set status = 'completed' where id = p_lobby_id;
    return;
  end if;

  -- Cases 1-3: figure out who's tied on wins, then (if still tied) on goals.
  with fixture_results as (
    select f.home_team_id, f.away_team_id, f.played, f.home_score, f.away_score,
      case
        when f.played and f.home_score > f.away_score then f.home_team_id
        when f.played and f.away_score > f.home_score then f.away_team_id
        when f.played and f.home_score = f.away_score and f.pens_home is not null and f.pens_away is not null and f.pens_home <> f.pens_away
          then case when f.pens_home > f.pens_away then f.home_team_id else f.away_team_id end
        else null
      end as winner_team_id
    from fixtures f
    where f.league_id = v_league_id and f.stage = 1
  ),
  team_stats as (
    select t.id as team_id,
      count(fr.winner_team_id) filter (where fr.winner_team_id = t.id) as wins,
      coalesce(sum(
        case when fr.home_team_id = t.id then fr.home_score
             when fr.away_team_id = t.id then fr.away_score
             else 0 end
      ) filter (where fr.played), 0) as goals
    from teams t
    left join fixture_results fr on fr.home_team_id = t.id or fr.away_team_id = t.id
    where t.league_id = v_league_id
    group by t.id
  ),
  max_w as (select max(wins) as mw from team_stats),
  wins_tied as (select ts.* from team_stats ts, max_w where ts.wins = max_w.mw),
  max_g as (select max(goals) as mg from wins_tied)
  select
    (select array_agg(team_id) from wins_tied),
    (select mw from max_w),
    (select array_agg(team_id) from wins_tied, max_g where wins_tied.goals = max_g.mg)
  into v_winners_at_max, v_max_wins, v_goal_winners;

  -- Case 1: one team strictly ahead on wins.
  if array_length(v_winners_at_max, 1) = 1 then
    select m.user_id into v_winner_user_id
    from members m where m.league_id = v_league_id and m.team_id = v_winners_at_max[1];
    perform finalize_rapid_cup_payout(p_lobby_id, v_winner_user_id);
    return;
  end if;

  -- Case 2: tied on wins, one team strictly ahead on goals.
  if array_length(v_goal_winners, 1) = 1 then
    select m.user_id into v_winner_user_id
    from members m where m.league_id = v_league_id and m.team_id = v_goal_winners[1];
    perform finalize_rapid_cup_payout(p_lobby_id, v_winner_user_id);
    return;
  end if;

  -- Case 3: still tied on both -> pool splits evenly among the tied
  -- players, each guaranteed their own total_stake back, remainder split
  -- evenly as profit (self/invested split per player same as a win).
  -- Non-tied players (and, new here, their investors) get an honest $0 —
  -- the plan describes no refund path for them in this specific outcome
  -- (see header comment).
  select sum(s.total_stake) into v_tied_stake_sum
  from _rapid_cup_player_stakes_internal(p_lobby_id) s
  join members m on m.user_id = s.user_id and m.league_id = v_league_id
  where m.team_id = any(v_goal_winners);

  v_remaining := v_total_pool - v_tied_stake_sum;
  v_bonus_each := v_remaining / array_length(v_goal_winners, 1);

  insert into rapid_cup_payouts (lobby_id, league_id, winner_user_id, outcome, total_pool, max_stake)
  values (p_lobby_id, v_league_id, null, 'split', v_total_pool, v_max_stake)
  returning * into v_payout;

  for v_row in
    select s.user_id, s.entry_fee, s.invested, s.total_stake, m.team_id
    from _rapid_cup_player_stakes_internal(p_lobby_id) s
    join members m on m.user_id = s.user_id and m.league_id = v_league_id
  loop
    if v_row.team_id = any(v_goal_winners) then
      perform _rapid_cup_split_recipient_internal(
        v_payout.id, p_lobby_id, v_row.user_id,
        v_row.entry_fee, v_row.invested, v_row.total_stake,
        v_row.total_stake, v_bonus_each
      );
    else
      perform _rapid_cup_split_recipient_internal(
        v_payout.id, p_lobby_id, v_row.user_id,
        v_row.entry_fee, v_row.invested, v_row.total_stake,
        0, 0
      );
    end if;
  end loop;

  update rapid_cup_lobbies set status = 'completed' where id = p_lobby_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- collect_rapid_cup_cupbox — REPLACED. Now looks up the caller's amount in
-- rapid_cup_payout_recipients FIRST (covers players and investors alike,
-- for every outcome, summed across rows in the rare case a spectator
-- invested in more than one of the 4 players). Only falls back to the old
-- winner_user_id/winner_net_total column check when no recipient rows
-- exist at all for this payout — i.e. a 'winner'-outcome payout recorded
-- before this migration, which never got per-player recipient rows.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function collect_rapid_cup_cupbox(p_lobby_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout rapid_cup_payouts%rowtype;
  v_amount numeric;
  v_amount_int bigint;
  v_found boolean;
  v_is_participant boolean;
  v_claim rapid_cup_collections;
begin
  if auth.uid() is null then
    raise exception 'collect_rapid_cup_cupbox: must be signed in';
  end if;

  select * into v_payout from rapid_cup_payouts where lobby_id = p_lobby_id;
  if v_payout.id is null then
    raise exception 'This cup hasn''t finished yet';
  end if;

  select coalesce(sum(amount), 0), count(*) > 0
  into v_amount, v_found
  from rapid_cup_payout_recipients
  where payout_id = v_payout.id and user_id = auth.uid();

  if not v_found then
    if v_payout.outcome = 'winner' then
      select exists(select 1 from rapid_cup_lobby_players where lobby_id = p_lobby_id and user_id = auth.uid())
      into v_is_participant;

      if not v_is_participant then
        raise exception 'You weren''t in this cup';
      end if;

      v_amount := case when v_payout.winner_user_id = auth.uid() then v_payout.winner_net_total else 0 end;
    else
      raise exception 'You weren''t in this cup';
    end if;
  end if;

  -- Same rounding fix as Phase 6 — Nets are bigint, payout math is not.
  v_amount_int := round(coalesce(v_amount, 0))::bigint;

  insert into rapid_cup_collections (user_id, box_type, ref_id, amount)
  values (auth.uid(), 'cupbox', p_lobby_id, v_amount_int)
  on conflict (user_id, box_type, ref_id) do nothing
  returning * into v_claim;

  if v_claim.id is null then
    return 0; -- already collected
  end if;

  if v_amount_int > 0 then
    perform _nets_credit_internal(auth.uid(), v_amount_int, 'rapid_cup_cupbox', null, 'lobby', p_lobby_id::text, null);
  end if;

  return v_amount_int;
end;
$$;

revoke all on function collect_rapid_cup_cupbox(uuid) from public, anon;
grant execute on function collect_rapid_cup_cupbox(uuid) to authenticated;
