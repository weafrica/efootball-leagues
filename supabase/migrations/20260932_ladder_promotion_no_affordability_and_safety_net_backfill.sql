-- Repo-drift backfill, part 2. Also applied live in a prior session,
-- confirmed still running via pg_get_functiondef on 2026-09-07, never
-- written back to the repo.
--
-- This one bundles TWO distinct live changes on top of
-- 20260870_ladder_affordability_fallbacks.sql's version:
--
-- 1. Affordability check removed from promotion, matching the same
--    decision as 20260931 (fall-through): standings[1] is always
--    promoted now, no wallet-balance walk, no v_dest_fee gate on who
--    qualifies.
--
-- 2. NEW, UNDOCUMENTED ANYWHERE — a "safety-net backfill" block with no
--    header comment, no mention in CONTINUE-FROM-HERE.md,
--    league-ladder-fix-plan-status.md, or the session notes pasted into
--    this conversation. Found only by diffing pg_get_functiondef against
--    the repo's last known version. FLAGGING FOR REVIEW — the rationale
--    below is reconstructed from the live function's own inline comments,
--    not confirmed against any design doc:
--
--    Every league only ever gets ONE guaranteed replacement (the single
--    promotion) no matter how many players it relegates (up to 2).
--    Every tier below the top receives 2 relegated-in players from the
--    tier above, which happens to cover that gap — except tier 1, which
--    has no tier above to relegate players in from, so it structurally
--    loses a seat every week nobody bids for it (6 -> 5 -> 4 -> ...
--    uncorrected). This block computes how many extra seats a
--    destination tier is short (its own relegate_count, minus the 1
--    guaranteed promotion, minus any pending paid bids already covering
--    it) and fills the gap by promoting extra next-best finishers from
--    the SAME source league's own remaining (non-relegated) standings —
--    never reaching into the relegated group. If the destination's Entry
--    Fee is 0 they qualify unconditionally; otherwise it's still an
--    affordability walk for this extra pool specifically (unlike the
--    single guaranteed promotion above, which is no longer gated at all).
--
--    Needs a design-doc write-up and an explicit decision on whether the
--    inconsistency (guaranteed promotion: no affordability check; extra
--    safety-net promotions: still affordability-checked) is intentional.
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

      if v_n > 0 then
        v_promoted := v_standings[1];
        v_promoted_idx := 1;
      end if;
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
      insert into ladder_memberships (user_id, league_id, week_number, status)
      values (v_promoted, v_target_league_id, v_next_week, 'active')
      on conflict (user_id, week_number) do nothing;

      -- Safety-net backfill — see migration header above. Undocumented
      -- prior to this file; reconstructed from live inline comments only.
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

          insert into ladder_memberships (user_id, league_id, week_number, status)
          select u, v_target_league_id, v_next_week, 'active'
          from unnest(v_extra_promoted) as u
          on conflict (user_id, week_number) do nothing;
        end if;
      end if;
    end if;
  end loop;
end;
$$;
