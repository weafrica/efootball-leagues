-- League Ladder — Phase 7 (continued): Streak Bonuses + Wall of Fame,
-- now that real specs exist for them (20260863's header flagged these,
-- Elite Safety Zone/Checkpoint Safety/Danger Zone, Live Bid Ticker,
-- Placement Bonus, and Transfer Window/Reroll as all needing specs before
-- any code got written).
--
-- Per the confirmed spec:
--   - Elite Safety Zone / Checkpoint Safety / Danger Zone: pure live-
--     standings badges, no server state needed — see leagueLadder.js's
--     classifyLadderZones. Nothing to do here.
--   - Live Bid Ticker: the underlying eligibility pool, RPC, and the
--     Tuesday->Sunday-10PM bidding_open window already exist in full
--     (Phase 5 / 20260856) — "the button that the 9 players... bid from
--     Tuesday until Sunday 10pm" was already wired server-side, it just
--     had no UI yet (added in LeagueLadderDetail.jsx this same change).
--     Nothing to do here either.
--   - Placement Bonus and Transfer Window/Reroll: CONFIRMED DROPPED, not
--     deferred. Neither was ever built, and per spec neither is being
--     built — see economy.js's note. No SQL to remove since none exists.
--   - Streak Bonuses and Wall of Fame: new server-side work, below.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- win_streak — consecutive-win counter per player per league-week row,
-- reset to 0 on a draw or loss, incremented on a win. Lives on
-- ladder_memberships (one row per user/league/week already) rather than a
-- new table since it's naturally scoped to exactly that granularity.
-- ─────────────────────────────────────────────────────────────────────────
alter table ladder_memberships add column if not exists win_streak integer not null default 0;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_streak_bonus_for_tier — mirrors economy.js's
-- computeLadderStreakBonus. Same "keep both in sync by hand" convention
-- as every other JS/SQL pair in this codebase.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_streak_bonus_for_tier(p_tier integer, p_streak integer)
returns bigint
language sql
immutable
as $$
  select case when coalesce(p_streak, 0) < 2 then 0
    else round(_ladder_match_reward_for_tier(p_tier) * 0.10)
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _credit_ladder_match_reward_internal — same flat Match Reward crediting
-- as 20260860's version, now followed by streak bookkeeping: the winner's
-- win_streak on their CURRENT week's ladder_memberships row increments by
-- 1, and if that new streak is >= 2 they're credited the Streak Bonus on
-- top of their Match Reward. The loser's streak resets to 0. A draw
-- resets BOTH sides to 0 — a draw isn't a win, so it breaks the streak
-- same as a loss does.
--
-- win_streak lives on the row for v_fixture.week_number specifically
-- (not "whatever week is current now") — matches how every other Phase
-- 4-7 SQL function scopes itself to the fixture's own week rather than
-- ladder_cycle.current_week, so a late admin correction on an old fixture
-- still updates the right week's streak, not this week's.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _credit_ladder_match_reward_internal(p_fixture_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture ladder_fixtures%rowtype;
  v_tier integer;
  v_reward bigint;
  v_winner uuid;
  v_loser uuid;
  v_is_draw boolean;
  v_new_streak integer;
  v_bonus bigint;
begin
  select * into v_fixture from ladder_fixtures where id = p_fixture_id;
  if v_fixture.id is null then
    raise exception '_credit_ladder_match_reward_internal: fixture not found';
  end if;

  select tier into v_tier from ladder_leagues where id = v_fixture.league_id;
  v_reward := _ladder_match_reward_for_tier(v_tier);

  perform _nets_credit_internal(
    v_fixture.home_user_id, v_reward, 'ladder_match_reward', null, 'ladder_fixture', v_fixture.id::text
  );
  perform _nets_credit_internal(
    v_fixture.away_user_id, v_reward, 'ladder_match_reward', null, 'ladder_fixture', v_fixture.id::text
  );
  perform _ladder_pool_debit(
    v_reward, 'ladder_match_reward', v_fixture.home_user_id, 'ladder_fixture', v_fixture.id::text
  );
  perform _ladder_pool_debit(
    v_reward, 'ladder_match_reward', v_fixture.away_user_id, 'ladder_fixture', v_fixture.id::text
  );

  -- Streak Bonuses — only meaningful for a decisive (played, non-forfeit)
  -- result; this function is never called for a forfeit (see 20260862's
  -- header), so v_fixture.status = 'played' always holds here.
  if v_fixture.home_score = v_fixture.away_score then
    v_is_draw := true;
  else
    v_is_draw := false;
    if v_fixture.home_score > v_fixture.away_score then
      v_winner := v_fixture.home_user_id; v_loser := v_fixture.away_user_id;
    else
      v_winner := v_fixture.away_user_id; v_loser := v_fixture.home_user_id;
    end if;
  end if;

  if v_is_draw then
    update ladder_memberships set win_streak = 0
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id in (v_fixture.home_user_id, v_fixture.away_user_id);
  else
    update ladder_memberships set win_streak = 0
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id = v_loser;

    update ladder_memberships set win_streak = win_streak + 1
    where league_id = v_fixture.league_id and week_number = v_fixture.week_number
      and user_id = v_winner
    returning win_streak into v_new_streak;

    v_bonus := _ladder_streak_bonus_for_tier(v_tier, v_new_streak);
    if v_bonus > 0 then
      perform _nets_credit_internal(
        v_winner, v_bonus, 'ladder_streak_bonus', null, 'ladder_fixture', v_fixture.id::text
      );
      perform _ladder_pool_debit(
        v_bonus, 'ladder_streak_bonus', v_winner, 'ladder_fixture', v_fixture.id::text
      );
    end if;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- ladder_wall_of_fame — one row per week, the League 1 (tier 1) rank-1
-- player at the Sunday 10PM cutoff. Primary key on week_number: one champ
-- per week, no duplicates possible even on a re-run.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ladder_wall_of_fame (
  week_number integer primary key,
  league_id uuid not null references ladder_leagues(id),
  user_id uuid not null,
  pts integer not null,
  recorded_at timestamptz not null default now()
);

alter table ladder_wall_of_fame enable row level security;

drop policy if exists "ladder_wall_of_fame_select" on ladder_wall_of_fame;
create policy "ladder_wall_of_fame_select" on ladder_wall_of_fame for select
  using (true); -- public hall of fame, readable by anyone signed in or not moot — same as standings

-- No insert/update policy for authenticated: only reachable via the
-- SECURITY DEFINER function below, same internal-write convention as
-- every other ladder table.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_record_wall_of_fame_internal — finds tier 1's rank-1 player for
-- the closing week (same standings query shape as
-- _ladder_resolve_promotion_relegation_internal, just scoped to tier = 1
-- and only needing rank 1, not the whole table) and upserts them into
-- ladder_wall_of_fame. On conflict (a re-run/admin retrigger of the same
-- week) overwrites with the freshly-computed result rather than skipping
-- — keeps it consistent with a corrected result, same as every other
-- re-run-safe function in this file's siblings.
--
-- A tier-1 league with no fixtures that week (v_n = 0) records nothing —
-- same "empty standings, nothing to do" behavior as the promotion/
-- relegation resolver.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_record_wall_of_fame_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id uuid;
  v_champion uuid;
  v_champion_pts integer;
begin
  select id into v_league_id from ladder_leagues where tier = 1 and status = 'active';
  if v_league_id is null then
    return;
  end if;

  select s.user_id, s.pts into v_champion, v_champion_pts
  from (
    select m.user_id,
           sum(m.pts) as pts,
           sum(m.played) as played,
           sum(m.gf) - sum(m.ga) as gd,
           sum(m.gf) as gf
    from (
      select home_user_id as user_id,
             case when status = 'played' and home_score > away_score then 3
                  when status = 'played' and home_score = away_score then 1
                  else 0 end as pts,
             case when status in ('played', 'forfeited') then 1 else 0 end as played,
             case when status = 'played' then home_score else 0 end as gf,
             case when status = 'played' then away_score when status = 'forfeited' then 4 else 0 end as ga
      from ladder_fixtures
      where league_id = v_league_id and week_number = p_week_number
      union all
      select away_user_id,
             case when status = 'played' and away_score > home_score then 3
                  when status = 'played' and away_score = home_score then 1
                  else 0 end,
             case when status in ('played', 'forfeited') then 1 else 0 end,
             case when status = 'played' then away_score else 0 end,
             case when status = 'played' then home_score when status = 'forfeited' then 4 else 0 end
      from ladder_fixtures
      where league_id = v_league_id and week_number = p_week_number
    ) m
    group by m.user_id
  ) s
  order by (s.played > 0) desc, s.pts desc, s.gd desc, s.gf desc, s.user_id asc
  limit 1;

  if v_champion is null then
    return; -- no fixtures this week for League 1 — nothing to record
  end if;

  insert into ladder_wall_of_fame (week_number, league_id, user_id, pts)
  values (p_week_number, v_league_id, v_champion, v_champion_pts)
  on conflict (week_number) do update
    set league_id = excluded.league_id, user_id = excluded.user_id,
        pts = excluded.pts, recorded_at = now();
end;
$$;

-- Deliberately no grant — internal only, called from the close-week job.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_close_week_internal — now also records the Wall of Fame entry,
-- right after promotion/relegation resolves (same v_week fixtures the
-- resolver itself just read) and before the cycle flags flip.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_close_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week integer;
begin
  select current_week into v_week from ladder_cycle where id = true;

  perform _ladder_resolve_promotion_relegation_internal();

  if v_week is not null and v_week > 0 then
    perform _ladder_record_wall_of_fame_internal(v_week);
    perform _ladder_settle_week_fees_internal(v_week);
    perform _ladder_settle_bids_internal(v_week);
    perform _ladder_fall_through_internal(v_week);
    perform _ladder_apply_decay_penalty_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;
end;
$$;
