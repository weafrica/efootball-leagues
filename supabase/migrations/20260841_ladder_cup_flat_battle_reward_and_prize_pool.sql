-- Nets — two Ladder Cup economy changes:
--
-- 1. Ladder Battle match reward flattened to Six-Day Survivor's shape:
--    win 4, loss 0, no draws, no participation net. Previously tiered by
--    beat-higher-rank (winHigher 3 / winLower 1 / draw 2, +1 participation
--    → 4/2/3/1 in practice, per _credit_ladder_battle_match_reward
--    20260833). That tiering is gone — the Ladder Cup's own upset bonus
--    already lives in the standings-points system (ladderCup.js's
--    UPSET_BONUS), so Nets no longer double up on it. Mirrors economy.js's
--    ladder_battle table (now identical to six_day_survivor).
--
--    _nets_credit_internal rejects zero-amount credits (raise exception if
--    p_amount <= 0), and a loss reward of 0 under the new flat scheme would
--    hit that — so the loser side of the credit loop is now guarded and
--    simply skipped when the reward is 0, same fix shape 20260841's
--    knockout/groups_knockout companion changes use elsewhere.
--
--    p_beat_higher_rank is kept in the signature (existing caller in
--    _apply_ladder_cup_match_win, 20260833, still passes it) but is no
--    longer used for the Nets amount — only the standings-points system
--    (computeWinPoints, client-side) still cares about upsets.
--
-- 2. New finalize_ladder_cup_prize_pool(p_league_id, p_ranked_team_ids) —
--    Ladder Cup's own Top 20 payout, separate from finalize_league_prize_pool
--    (20260839), which explicitly excludes ladder_cup. Split: champion
--    takes a flat 50% of the real entry-fee pool; the remaining 50% is
--    spread across 2nd-20th using the SAME relative taper
--    finalize_league_prize_pool's v_split uses for those places, rescaled
--    so 2nd-20th sums to 0.50 instead of 0.70 (scale factor 0.50/0.70).
--    Mirrors economy.js's LADDER_CUP_PRIZE_SPLIT/computeLadderCupPrizePool
--    exactly.
--
--    Gated on the league already being ladder_cup-finalized
--    (ladder_cup_finalized_at is not null) — call this AFTER
--    finalize_ladder_cup (which crowns the champion) has succeeded, passing
--    the client's full ranked standings (including eliminated clubs, same
--    order the standings board shows — rankLadderCupStandings over every
--    entry, not just crownChampion's non-eliminated subset). Ranking is
--    client-trusted, money isn't, same split finalize_league_prize_pool
--    already uses: this recomputes the real pool off nets_transactions and
--    filters the client's ranking down to teams with a real paid entry-fee
--    transaction on record.
--
--    ladder_cup_prizes_paid_at is the double-pay guard, same shape as
--    leagues.prizes_paid_at / leagues.ladder_cup_finalized_at.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Flatten the Ladder Battle match reward.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _credit_ladder_battle_match_reward(
  p_league_id uuid, p_match_id uuid,
  p_winner_team_id uuid, p_loser_team_id uuid, p_beat_higher_rank boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_winner_reward bigint := 4;
  v_loser_reward bigint := 0;
  v_member record;
begin
  for v_member in select user_id from members where league_id = p_league_id and team_id = p_winner_team_id loop
    perform _nets_credit_internal(v_member.user_id, v_winner_reward, 'ladder_battle_reward', null, 'ladder_cup_match', p_match_id::text, p_winner_team_id);
  end loop;

  -- Loser reward is 0 under the flat no-participation scheme —
  -- _nets_credit_internal rejects zero-amount credits, so skip crediting
  -- the loser entirely rather than calling it with 0.
  if v_loser_reward > 0 then
    for v_member in select user_id from members where league_id = p_league_id and team_id = p_loser_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_loser_reward, 'ladder_battle_reward', null, 'ladder_cup_match', p_match_id::text, p_loser_team_id);
    end loop;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Ladder Cup's own Top 20 prize pool payout.
-- ─────────────────────────────────────────────────────────────────────────
alter table leagues add column if not exists ladder_cup_prizes_paid_at timestamptz;

create or replace function finalize_ladder_cup_prize_pool(p_league_id uuid, p_ranked_team_ids uuid[])
returns setof leagues
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league leagues%rowtype;
  v_pool bigint;
  v_clean_ids uuid[];
  v_paid_places integer;
  -- Champion: flat 50%. 2nd-20th: finalize_league_prize_pool's v_split for
  -- those places, each rescaled by 0.50/0.70 so they sum to 0.50 instead
  -- of 0.70. Mirrors economy.js's LADDER_CUP_PRIZE_SPLIT exactly.
  v_split numeric[] := array[
    0.50,
    0.1424, 0.0949, 0.0593, 0.0593,
    0.0356, 0.0356, 0.0356, 0.0356, 0.0356,
    0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166, 0.0166
  ];
  v_scale numeric := 0.50 / 0.70;
  v_floors bigint[] := array[]::bigint[];
  v_floor_sum bigint := 0;
  v_exact_sum numeric := 0;
  v_place integer;
  v_member record;
begin
  -- Rescale places 2-20 in place (1st stays a flat 0.50).
  for v_place in 2..array_length(v_split, 1) loop
    v_split[v_place] := v_split[v_place] * v_scale;
  end loop;

  select * into v_league from leagues where id = p_league_id for update;
  if not found then
    return;
  end if;
  if v_league.ladder_cup_prizes_paid_at is not null then
    return;
  end if;
  if v_league.format <> 'ladder_cup' or v_league.ladder_cup_finalized_at is null then
    return;
  end if;

  -- Real pool: sum of entry fees actually collected for this league, never
  -- a client-supplied figure. nets_debit records entry fee debits as
  -- negative amounts, so the pool is the negated sum.
  select coalesce(-sum(amount), 0) into v_pool
  from nets_transactions
  where reason = 'league_entry_fee' and ref_type = 'league' and ref_id = p_league_id::text;

  if v_pool <= 0 then
    update leagues set ladder_cup_prizes_paid_at = now() where id = p_league_id returning * into v_league;
    return next v_league;
    return;
  end if;

  -- Filter the client-trusted ranking down to teams with a real paid entry
  -- fee on record, preserving rank order via unnest's ordinality.
  select coalesce(array_agg(t.team_id order by t.ord), array[]::uuid[]) into v_clean_ids
  from unnest(p_ranked_team_ids) with ordinality as t(team_id, ord)
  where exists (
    select 1 from members m
    join nets_transactions nt on nt.user_id = m.user_id
      and nt.reason = 'league_entry_fee' and nt.ref_type = 'league' and nt.ref_id = p_league_id::text
    where m.league_id = p_league_id and m.team_id = t.team_id
  );

  v_paid_places := least(coalesce(array_length(v_clean_ids, 1), 0), array_length(v_split, 1));

  if v_paid_places <= 0 then
    update leagues set ladder_cup_prizes_paid_at = now() where id = p_league_id returning * into v_league;
    return next v_league;
    return;
  end if;

  -- Same floor-then-fix-up-on-1st rounding computeLadderCupPrizePool
  -- (economy.js) uses.
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
        v_member.user_id, v_floors[v_place], 'ladder_cup_prize_pool',
        format('Place %s', v_place), 'league', p_league_id::text, v_clean_ids[v_place]
      );
    end loop;
  end loop;

  update leagues set ladder_cup_prizes_paid_at = now() where id = p_league_id returning * into v_league;
  return next v_league;
end;
$$;

grant execute on function finalize_ladder_cup_prize_pool(uuid, uuid[]) to authenticated;
