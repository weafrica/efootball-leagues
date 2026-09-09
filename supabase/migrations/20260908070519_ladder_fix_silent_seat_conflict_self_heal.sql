-- FIX: silent "on conflict (user_id, week_number) do nothing" was letting
-- promotions and relegations get RECORDED as successful (status updated to
-- 'promoted' / 'relegated' on the old-week row) while the player's actual
-- seat for next week silently failed to move, whenever a row already
-- existed for (user_id, next_week) at insert time.
--
-- Found 2026-09-08 while manually repairing week 3: 8 promoted players and
-- 7 relegated players were stuck/misplaced this way. The status column
-- said they'd moved; the membership row said they hadn't. Nothing in the
-- app surfaced the mismatch, so it went undetected until someone counted
-- league rosters by hand.
--
-- ROOT CAUSE (mechanism, not exhaustively diagnosed): both functions treat
-- "a row already exists for (user_id, next_week)" as "someone else already
-- correctly seated this player, nothing to do" and silently skip. That
-- assumption doesn't hold in every case a conflicting row can appear
-- (retried close-week runs, bid settlement ordering, manual admin fixes,
-- etc.) — when it doesn't hold, the player is left wherever the stale row
-- points, and the skip means nobody ever notices or corrects it.
--
-- FIX: replace the silent skip with a self-healing upsert. If a row
-- already exists for that (user_id, next_week), we now overwrite its
-- league_id to the one this function just computed as correct, instead of
-- leaving whatever was there. This makes both functions idempotent AND
-- corrective — safe to re-run, and no longer able to leave a player
-- stranded in the wrong league while claiming they were moved.
--
-- The one legitimate case where we must NOT overwrite — a relegated
-- player who won a bid back into their OWN league — is still handled by
-- the existing "already_won" check in fall-through, which still skips
-- (continues) before the upsert ever runs. That check is unchanged.
--
-- Safe to run more than once.

create or replace function _ladder_resolve_promotion_relegation_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week integer;
  v_next_week integer;
  v_league record;
  v_standings uuid[];
  v_n integer;
  v_promoted uuid;
  v_promoted_idx integer;
  v_dest_tier integer;
  v_dest_fee bigint;
  v_balance bigint;
  v_remaining uuid[];
  v_relegated uuid[];
  v_relegate_count integer;
  v_target_league_id uuid;
  v_dest_relegate_count integer;
  v_pending_bids integer;
  v_extra_needed integer;
  v_extra_filled integer;
  v_stayers uuid[];
  v_stayer_count integer;
  v_candidate uuid;
  v_extra_promoted uuid[];
  i integer;
begin
  select current_week into v_week from ladder_cycle where id = true;
  if v_week is null or v_week = 0 then
    return;
  end if;
  v_next_week := v_week + 1;

  create temporary table if not exists tmp_ladder_tier_relegate_count (
    tier integer primary key,
    league_id uuid,
    relegate_count integer
  ) on commit drop;
  delete from tmp_ladder_tier_relegate_count;

  for v_league in select id, tier from ladder_leagues where status = 'active' order by tier loop
    select array_agg(s.user_id order by (s.played > 0) desc, s.pts desc, s.gd desc, s.gf desc, s.user_id asc)
    into v_standings
    from (
      select m.user_id,
             sum(m.pts) as pts,
             sum(m.played) as played,
             sum(m.gf) as gf,
             sum(m.gf) - sum(m.ga) as gd
      from (
        select home_user_id as user_id,
               case when status = 'played' and home_score > away_score then 3
                    when status = 'forfeited' and home_score is not null and away_score is not null and home_score > away_score then 3
                    when status = 'played' and home_score = away_score then 1
                    when status = 'forfeited' and home_score is not null and away_score is not null and home_score = away_score then 1
                    else 0 end as pts,
               case when status in ('played', 'forfeited') then 1 else 0 end as played,
               case when status = 'played' then home_score
                    when status = 'forfeited' and home_score is not null then home_score
                    else 0 end as gf,
               case when status = 'played' then away_score
                    when status = 'forfeited' and away_score is not null then away_score
                    when status = 'forfeited' then 4
                    else 0 end as ga
        from ladder_fixtures
        where league_id = v_league.id and week_number = v_week
        union all
        select away_user_id,
               case when status = 'played' and away_score > home_score then 3
                    when status = 'forfeited' and home_score is not null and away_score is not null and away_score > home_score then 3
                    when status = 'played' and away_score = home_score then 1
                    when status = 'forfeited' and home_score is not null and away_score is not null and away_score = home_score then 1
                    else 0 end,
               case when status in ('played', 'forfeited') then 1 else 0 end,
               case when status = 'played' then away_score
                    when status = 'forfeited' and away_score is not null then away_score
                    else 0 end,
               case when status = 'played' then home_score
                    when status = 'forfeited' and home_score is not null then home_score
                    when status = 'forfeited' then 4
                    else 0 end
        from ladder_fixtures
        where league_id = v_league.id and week_number = v_week
      ) m
      group by m.user_id
    ) s;

    v_n := coalesce(array_length(v_standings, 1), 0);
    if v_n = 0 then
      continue;
    end if;

    v_promoted := null;
    v_promoted_idx := null;

    if v_league.tier > 1 then
      v_dest_tier := v_league.tier - 1;
      v_dest_fee := _ladder_entry_fee_for_tier(v_dest_tier);

      for i in 1 .. v_n loop
        if v_dest_fee <= 0 then
          v_promoted := v_standings[i];
          v_promoted_idx := i;
          exit;
        end if;

        select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_standings[i];

        if coalesce(v_balance, 0) >= v_dest_fee then
          v_promoted := v_standings[i];
          v_promoted_idx := i;
          exit;
        end if;
      end loop;
    end if;

    if v_promoted_idx is not null then
      v_remaining := v_standings[1 : v_promoted_idx - 1] || v_standings[v_promoted_idx + 1 : v_n];
    else
      v_remaining := v_standings;
    end if;

    v_relegate_count := least(2, coalesce(array_length(v_remaining, 1), 0));
    if v_relegate_count > 0 then
      v_relegated := v_remaining[(array_length(v_remaining, 1) - v_relegate_count + 1) : array_length(v_remaining, 1)];
    else
      v_relegated := array[]::uuid[];
    end if;

    insert into tmp_ladder_tier_relegate_count (tier, league_id, relegate_count)
    values (v_league.tier, v_league.id, v_relegate_count);

    if v_promoted is not null then
      update ladder_memberships set status = 'promoted'
      where user_id = v_promoted and league_id = v_league.id and week_number = v_week;
    end if;
    if array_length(v_relegated, 1) > 0 then
      update ladder_memberships set status = 'relegated'
      where user_id = any(v_relegated) and league_id = v_league.id and week_number = v_week;
    end if;

    if v_promoted is not null then
      v_target_league_id := _ensure_ladder_league_internal(v_dest_tier);

      -- FIX: was "on conflict (user_id, week_number) do nothing", which
      -- silently dropped this seat change whenever a next-week row already
      -- existed. Now self-heals: if a row exists, correct its league_id
      -- instead of leaving it wherever it was.
      insert into ladder_memberships (user_id, league_id, week_number, status)
      values (v_promoted, v_target_league_id, v_next_week, 'active')
      on conflict (user_id, week_number) do update
        set league_id = excluded.league_id, status = 'active'
        where ladder_memberships.league_id <> excluded.league_id;

      -- Safety-net backfill — see 20260932 header for full rationale.
      select relegate_count into v_dest_relegate_count
      from tmp_ladder_tier_relegate_count where tier = v_dest_tier;

      select count(*) into v_pending_bids
      from ladder_bids
      where target_league_id = v_target_league_id
        and week_number = v_week
        and status = 'pending';

      v_extra_needed := coalesce(v_dest_relegate_count, 0) - 1 - coalesce(v_pending_bids, 0);

      if v_extra_needed > 0 then
        v_stayer_count := greatest(coalesce(array_length(v_remaining, 1), 0) - v_relegate_count, 0);
        v_stayers := case when v_stayer_count > 0 then v_remaining[1 : v_stayer_count] else array[]::uuid[] end;

        v_extra_promoted := array[]::uuid[];
        v_extra_filled := 0;

        if v_stayer_count > 0 then
          for i in 1 .. v_stayer_count loop
            exit when v_extra_filled >= v_extra_needed;
            v_candidate := v_stayers[i];

            if v_dest_fee <= 0 then
              v_extra_promoted := v_extra_promoted || v_candidate;
              v_extra_filled := v_extra_filled + 1;
            else
              select coalesce(balance, 0) into v_balance from nets_wallets where user_id = v_candidate;
              if coalesce(v_balance, 0) >= v_dest_fee then
                v_extra_promoted := v_extra_promoted || v_candidate;
                v_extra_filled := v_extra_filled + 1;
              end if;
            end if;
          end loop;
        end if;

        if array_length(v_extra_promoted, 1) > 0 then
          update ladder_memberships set status = 'promoted'
          where user_id = any(v_extra_promoted) and league_id = v_league.id and week_number = v_week;

          -- FIX: same self-healing upsert as above, applied to the
          -- safety-net extra promotions too.
          insert into ladder_memberships (user_id, league_id, week_number, status)
          select u, v_target_league_id, v_next_week, 'active'
          from unnest(v_extra_promoted) as u
          on conflict (user_id, week_number) do update
            set league_id = excluded.league_id, status = 'active'
            where ladder_memberships.league_id <> excluded.league_id;
        end if;
      end if;
    end if;
  end loop;
end;
$$;

create or replace function _ladder_fall_through_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_already_won boolean;
  v_below_league_id uuid;
begin
  for v_row in
    select m.user_id, m.league_id, l.tier as tier
    from ladder_memberships m
    join ladder_leagues l on l.id = m.league_id
    where m.week_number = p_week_number and m.status = 'relegated'
  loop
    select exists(
      select 1 from ladder_bids
      where bidder_user_id = v_row.user_id
        and target_league_id = v_row.league_id
        and week_number = p_week_number + 1
        and status = 'won'
    ) into v_already_won;

    if v_already_won then
      continue; -- bought their way back into their own league — settled above, must not override
    end if;

    v_below_league_id := _ensure_ladder_league_internal(v_row.tier + 1);

    -- FIX: was a separate "already_seated" existence check that skipped
    -- (continue) outright if ANY row existed for next week, regardless of
    -- whether it pointed at the right league. That's what let relegated
    -- players get stuck or land 1-2 tiers off with no correction. Now a
    -- single self-healing upsert: if a row exists and is wrong, fix it.
    insert into ladder_memberships (user_id, league_id, week_number, status)
    values (v_row.user_id, v_below_league_id, p_week_number + 1, 'active')
    on conflict (user_id, week_number) do update
      set league_id = excluded.league_id, status = 'active'
      where ladder_memberships.league_id <> excluded.league_id;
  end loop;
end;
$$;
