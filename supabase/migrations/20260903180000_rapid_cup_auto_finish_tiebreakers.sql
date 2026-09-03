-- Rapid Cup — Phase 4b: 4-hour auto-finish + Section 4d tiebreaker rules,
-- plus the cron sweep that drives both this and the Phase 4a bracket
-- advance. See RAPID-CUP-BUILD-PLAN.md Section 4d.
--
-- Phase 3's finalize_rapid_cup_payout() only ever handles a single named
-- winner. Two of the four Section 4d outcomes aren't a single winner
-- (an even split, or a full refund), so this migration extends
-- rapid_cup_payouts to describe those too, rather than inventing a
-- second payouts table:
--   * winner_user_id and every payout-math column become nullable —
--     they only apply to the 'winner' outcome (Phase 3's shape,
--     completely unchanged for that case).
--   * a new `outcome` column ('winner' | 'split' | 'refund') says which
--     kind of row this is.
--   * a new rapid_cup_payout_recipients table holds one row per player
--     for the 'split' and 'refund' cases, since those pay more than one
--     person. 'winner' rows don't use this table — the existing single
--     payout row already says who got what.

alter table rapid_cup_payouts alter column winner_user_id drop not null;
alter table rapid_cup_payouts alter column winner_stake drop not null;
alter table rapid_cup_payouts alter column base_return drop not null;
alter table rapid_cup_payouts alter column remaining_pool drop not null;
alter table rapid_cup_payouts alter column bonus_share drop not null;
alter table rapid_cup_payouts alter column bonus drop not null;
alter table rapid_cup_payouts alter column organizer_keep drop not null;
alter table rapid_cup_payouts alter column winner_bonus drop not null;
alter table rapid_cup_payouts alter column winner_net_total drop not null;
alter table rapid_cup_payouts alter column leftover drop not null;

alter table rapid_cup_payouts add column if not exists outcome text not null default 'winner';
alter table rapid_cup_payouts drop constraint if exists rapid_cup_payouts_outcome_check;
alter table rapid_cup_payouts add constraint rapid_cup_payouts_outcome_check
  check (outcome in ('winner', 'split', 'refund'));

create table if not exists rapid_cup_payout_recipients (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references rapid_cup_payouts(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  stake numeric not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);

alter table rapid_cup_payout_recipients enable row level security;

create policy "rapid_cup_payout_recipients readable by all signed-in users"
  on rapid_cup_payout_recipients for select
  using (auth.role() = 'authenticated');

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_cup_finish_lobby_internal — Section 4d, in order:
--   1. most matches won -> single winner -> Phase 3's finalize_rapid_cup_payout()
--   2. still tied on wins -> most goals across played matches -> same
--      finalize_rapid_cup_payout() path (it's still a single winner)
--   3. still tied (goals too) -> pool splits evenly among the tied players,
--      each guaranteed their own stake back, remainder split evenly
--   4. nobody played a single match -> full refund, no fees, no winner
--      (checked first, since it short-circuits 1-3 entirely)
-- Idempotent: no-ops if this lobby already has a payout row.
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

  select sum(entry_fee), max(entry_fee) into v_total_pool, v_max_stake
  from rapid_cup_lobby_players where lobby_id = p_lobby_id;

  select exists(select 1 from fixtures where league_id = v_league_id and stage = 1 and played = true)
  into v_any_played;

  -- Case 4: nobody played a single match.
  if not v_any_played then
    insert into rapid_cup_payouts (lobby_id, league_id, winner_user_id, outcome, total_pool, max_stake)
    values (p_lobby_id, v_league_id, null, 'refund', v_total_pool, v_max_stake)
    returning * into v_payout;

    for v_row in
      select user_id, entry_fee from rapid_cup_lobby_players where lobby_id = p_lobby_id
    loop
      insert into rapid_cup_payout_recipients (payout_id, user_id, stake, amount)
      values (v_payout.id, v_row.user_id, v_row.entry_fee, v_row.entry_fee);
    end loop;

    update rapid_cup_lobbies set status = 'completed' where id = p_lobby_id;
    return;
  end if;

  -- Cases 1-3: figure out who's tied on wins, then (if still tied) on goals.
  -- Penalties count as a decisive result here too, same rule as bracket
  -- advance — a level scoreline only ever stays a "no winner" fixture if
  -- penalties were never entered for it.
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

  -- Case 3: still tied on both -> split evenly among the tied players.
  -- Each guaranteed their own stake back; the rest of the pool (after
  -- removing every tied player's stake) splits evenly across them as
  -- bonus. Non-tied players get nothing extra beyond what they already
  -- lost, same as a normal loss in the single-winner case.
  select sum(lp.entry_fee) into v_tied_stake_sum
  from rapid_cup_lobby_players lp
  join members m on m.user_id = lp.user_id and m.league_id = v_league_id
  where lp.lobby_id = p_lobby_id and m.team_id = any(v_goal_winners);

  v_remaining := v_total_pool - v_tied_stake_sum;
  v_bonus_each := v_remaining / array_length(v_goal_winners, 1);

  insert into rapid_cup_payouts (lobby_id, league_id, winner_user_id, outcome, total_pool, max_stake)
  values (p_lobby_id, v_league_id, null, 'split', v_total_pool, v_max_stake)
  returning * into v_payout;

  for v_row in
    select lp.user_id, lp.entry_fee, m.team_id
    from rapid_cup_lobby_players lp
    join members m on m.user_id = lp.user_id and m.league_id = v_league_id
    where lp.lobby_id = p_lobby_id
  loop
    if v_row.team_id = any(v_goal_winners) then
      insert into rapid_cup_payout_recipients (payout_id, user_id, stake, amount)
      values (v_payout.id, v_row.user_id, v_row.entry_fee, round(v_row.entry_fee + v_bonus_each, 2));
    else
      insert into rapid_cup_payout_recipients (payout_id, user_id, stake, amount)
      values (v_payout.id, v_row.user_id, v_row.entry_fee, 0);
    end if;
  end loop;

  update rapid_cup_lobbies set status = 'completed' where id = p_lobby_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _rapid_cup_sweep_internal — cron entrypoint. For every live lobby:
-- try to advance the bracket (4a, harmless no-op if not ready), then if
-- the shared 4hr deadline has passed, finish it (4b). Every fixture in a
-- cup shares one due_at (set once at bracket generation), so checking any
-- one round-1 fixture's due_at is enough to know the deadline has passed.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rapid_cup_sweep_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  for v_row in
    select id as lobby_id, league_id from rapid_cup_lobbies
    where status = 'live' and league_id is not null
  loop
    perform _rapid_cup_advance_bracket_internal(v_row.league_id);

    if exists (
      select 1 from fixtures
      where league_id = v_row.league_id and round = 1 and stage = 1 and due_at <= now()
    ) then
      perform _rapid_cup_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$$;

select cron.unschedule('rapid-cup-sweep')
where exists (select 1 from cron.job where jobname = 'rapid-cup-sweep');

select cron.schedule(
  'rapid-cup-sweep',
  '*/2 * * * *', -- every 2 minutes — fast enough for a 4hr format
  $$select _rapid_cup_sweep_internal();$$
);

-- None of _rapid_cup_finish_lobby_internal / _rapid_cup_sweep_internal is
-- granted to `authenticated` — same restricted posture as Phase 3's
-- finalize_rapid_cup_payout(). Only the cron job (running as the
-- scheduling role) calls into this chain; a client still can't declare
-- its own winner, split, or refund.
