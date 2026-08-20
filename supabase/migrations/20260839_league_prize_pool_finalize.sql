-- Nets — prize pool payout for finished "fun" leagues (single/double round
-- robin, survivor, and knockout — the entryFeeForLeagueFormat-priced
-- formats). Pays Nets off the pool of entry fees actually collected via
-- nets_transactions, splitting it the same way computePrizePool
-- (economy.js) does. knockout is capped to just the top 2 places —
-- champion + runner-up — mirroring the call KNOCKOUT_PRIZE_SPLIT already
-- makes for the real-money cash-league payout in App.jsx: a bracket only
-- gives a clean ranking to the two finalists, everyone else who exits
-- mid-bracket is a genuine tie for the rest. Every other priced format
-- pays the full top 20.
--
-- ladder_cup is NOT covered here — it already has its own
-- finalize_ladder_cup + per-battle reward system. groups_knockout is now
-- priced too (80 Nets, see 20260840) and pays out through this same RPC —
-- v_cap below already caps it at 2 places same as knockout, since a
-- bracket only cleanly ranks its two finalists.
--
-- leagues.prizes_paid_at (added below) is the double-pay guard, set
-- inside the same row-locked transaction that computes and credits the
-- payout — same shape as leagues.ladder_cup_finalized_at.
--
-- Ranking is client-trusted, money isn't — same trust split
-- finalize_ladder_cup already uses for crowning a champion. The RPC:
--   (a) recomputes the real pool straight off nets_transactions, never a
--       client-supplied figure, and
--   (b) filters the client's ranked_team_ids down to teams with a real
--       paid entry-fee transaction on record before crediting anything —
--       silently dropping anyone without one (e.g. a member who joined
--       before the entry-fee-charging fix shipped) rather than rejecting
--       the whole payout over it.
--
-- League completeness isn't independently re-verified in exact
-- bracket-completeness terms here (isLeagueCompleted's precise knockout
-- check isn't reimplementable in SQL) — instead this uses a looser proxy:
-- every one of the league's fixtures is either played or past its due
-- date. That can't fire early; it just isn't as exact a "who's actually
-- champion" check as the client's. Acceptable here since the ranking
-- itself is already client-trusted.
--
-- Safe to run more than once.

alter table leagues add column if not exists prizes_paid_at timestamptz;

create or replace function finalize_league_prize_pool(p_league_id uuid, p_ranked_team_ids uuid[])
returns setof leagues
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league leagues%rowtype;
  v_pool bigint;
  v_cap integer;
  v_clean_ids uuid[];
  v_paid_places integer;
  -- Mirrors economy.js's TOP20_PRIZE_SPLIT exactly (1st..20th).
  v_split numeric[] := array[
    0.30, 0.1424, 0.0949, 0.0593, 0.0593,
    0.0356, 0.0356, 0.0356, 0.0356, 0.0356,
    0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166
  ];
  v_floors bigint[] := array[]::bigint[];
  v_floor_sum bigint := 0;
  v_exact_sum numeric := 0;
  v_place integer;
  v_member record;
begin
  select * into v_league from leagues where id = p_league_id for update;
  if not found then
    return;
  end if;
  if v_league.prizes_paid_at is not null then
    return;
  end if;
  if v_league.league_type <> 'fun' or v_league.format = 'ladder_cup' then
    return;
  end if;

  -- Loose completeness proxy — see header comment above.
  if exists (
    select 1 from fixtures f
    where f.league_id = p_league_id
      and not f.played
      and (f.due_at is null or f.due_at > now())
  ) then
    return;
  end if;

  -- Real pool: sum of entry fees actually collected for this league,
  -- never a client-supplied figure. nets_debit (20260825) records entry
  -- fee debits as negative amounts, so the pool is the negated sum.
  select coalesce(-sum(amount), 0) into v_pool
  from nets_transactions
  where reason = 'league_entry_fee' and ref_type = 'league' and ref_id = p_league_id::text;

  if v_pool <= 0 then
    update leagues set prizes_paid_at = now() where id = p_league_id returning * into v_league;
    return next v_league;
    return;
  end if;

  -- Filter the client-trusted ranking down to teams with a real paid
  -- entry fee on record, preserving rank order via unnest's ordinality.
  select coalesce(array_agg(t.team_id order by t.ord), array[]::uuid[]) into v_clean_ids
  from unnest(p_ranked_team_ids) with ordinality as t(team_id, ord)
  where exists (
    select 1 from members m
    join nets_transactions nt on nt.user_id = m.user_id
      and nt.reason = 'league_entry_fee' and nt.ref_type = 'league' and nt.ref_id = p_league_id::text
    where m.league_id = p_league_id and m.team_id = t.team_id
  );

  v_cap := case when v_league.format in ('knockout', 'groups_knockout') then 2 else 20 end;
  v_paid_places := least(coalesce(array_length(v_clean_ids, 1), 0), v_cap);

  if v_paid_places <= 0 then
    update leagues set prizes_paid_at = now() where id = p_league_id returning * into v_league;
    return next v_league;
    return;
  end if;

  -- Same floor-then-fix-up-on-1st rounding computePrizePool (economy.js)
  -- uses: floor each place's exact share, then hand the whole flooring
  -- loss across the paid places (never the unclaimed tail below the last
  -- paid place) to 1st, so the pool always pays out in whole Nets.
  for v_place in 1..v_paid_places loop
    v_floors := v_floors || floor(v_pool * v_split[v_place])::bigint;
    v_floor_sum := v_floor_sum + floor(v_pool * v_split[v_place])::bigint;
    v_exact_sum := v_exact_sum + (v_pool * v_split[v_place]);
  end loop;
  v_floors[1] := v_floors[1] + round(v_exact_sum - v_floor_sum);

  for v_place in 1..v_paid_places loop
    if v_floors[v_place] <= 0 then
      continue;
    end if;
    for v_member in select user_id from members where league_id = p_league_id and team_id = v_clean_ids[v_place] loop
      perform _nets_credit_internal(
        v_member.user_id, v_floors[v_place], 'league_prize_pool',
        format('Place %s', v_place), 'league', p_league_id::text, v_clean_ids[v_place]
      );
    end loop;
  end loop;

  update leagues set prizes_paid_at = now() where id = p_league_id returning * into v_league;
  return next v_league;
end;
$$;

grant execute on function finalize_league_prize_pool(uuid, uuid[]) to authenticated;
