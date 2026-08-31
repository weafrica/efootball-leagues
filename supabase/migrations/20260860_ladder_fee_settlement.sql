-- League Ladder — Phase 4: fees (Entry Fee / Table Fee) + the match-reward
-- crediting nothing before this migration actually did.
--
-- Two gaps this closes, both flagged by earlier migrations' own comments:
--
-- 1. 20260855_ladder_pool.sql's header note: nets_debit() only ever debits
--    auth.uid() — there is no _nets_debit_internal counterpart to
--    _nets_credit_internal (20260831), so nothing server-side can charge an
--    arbitrary player's wallet. The Sunday 10PM resolve job needs exactly
--    that to settle everyone's fee in one pass. Added below, same shape as
--    _nets_credit_internal: no auth.uid() check, never GRANTed to
--    authenticated, reachable only from inside another SECURITY DEFINER
--    function.
--
-- 2. submit_ladder_fixture_result (20260857) marks a fixture 'played' and
--    stops — nothing has ever credited a League Ladder Match Reward. Table
--    Fee is 20% of "total Nets earned that week" (§5), so without reward
--    crediting there is no earnings figure to tax. Wired in here: every
--    played fixture now credits both participants their league's flat
--    Match Reward from economy.js's LADDER_TIER_TABLE (kept in sync by
--    hand, same convention as _generate_round_robin_fixtures_internal
--    mirroring generateRoundRobinFixtures — see that migration's header).
--    Early Bonus is deliberately NOT credited yet: it depends on Phase 6's
--    countdown-based "completed early" check, which doesn't exist on
--    ladder_fixtures yet. computeLadderMatchNets/economy.js already
--    accepts an earlyCompletion flag for when that lands.
--
-- SETTLEMENT SCOPE NOTE (mirrors 20260859's own scope note): this only
-- settles fees for players whose destination league is already known this
-- cycle — promoted players (Entry Fee for the tier they just moved into)
-- and stayers (Table Fee on this week's earnings). Relegated players are
-- deliberately left unbilled here, same as they're left with no next-week
-- membership row — per §5, Entry Fee is charged "on a league transition:
-- auto-promotion, winning an auction bid, or being relegated into a NEW
-- league," and a relegated player's new league isn't decided until Phase
-- 5's buy-back auction resolves (same league if they win it back, one
-- tier down if they don't). Charging them now would mean charging the
-- wrong tier's fee for roughly half of them. Phase 5 settles their fee
-- alongside writing their actual destination.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _nets_debit_internal — mirrors _nets_credit_internal (20260831): same
-- balance-check-then-write logic nets_debit() already had, but takes an
-- explicit p_user_id instead of assuming auth.uid(), and is never GRANTed
-- to authenticated/anon. Only reachable from inside another SECURITY
-- DEFINER function (the fee-settlement job below) — a client still cannot
-- debit anyone else's wallet directly, that hole stays closed.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _nets_debit_internal(
  p_user_id uuid,
  p_amount bigint,
  p_reason text,
  p_note text default null,
  p_ref_type text default null,
  p_ref_id text default null,
  p_team_id uuid default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_balance bigint;
  v_new_balance bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception '_nets_debit_internal: amount must be positive';
  end if;

  select balance into v_current_balance from nets_wallets where user_id = p_user_id for update;

  if v_current_balance is null then
    v_current_balance := 0;
  end if;

  if v_current_balance < p_amount then
    raise exception '_nets_debit_internal: insufficient balance for user % (have %, need %)',
      p_user_id, v_current_balance, p_amount;
  end if;

  insert into nets_wallets (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  update nets_wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = p_user_id
  returning balance into v_new_balance;

  insert into nets_transactions (user_id, amount, balance_after, reason, note, ref_type, ref_id, team_id, created_by)
  values (p_user_id, -p_amount, v_new_balance, p_reason, p_note, p_ref_type, p_ref_id, p_team_id, auth.uid());

  return v_new_balance;
end;
$$;

-- Deliberately NO grant to authenticated (or anon) — same reasoning as
-- _nets_credit_internal.

-- ─────────────────────────────────────────────────────────────────────────
-- ladder_fee_events — one row per fee actually charged at settlement, so
-- every charge traces back to which week/league/fee-type produced it
-- (needed for the Phase 8 dashboard and for resolving player disputes,
-- per Phase 4's own checklist). nets_transactions already has the
-- individual wallet movement (reason='ladder_entry_fee'/'ladder_table_fee',
-- ref_type='ladder_week', ref_id=week_number) — this table is the
-- ladder-specific view on top of that, same "only if nets_transactions'
-- generic fields can't cleanly express it" bar Phase 1's optional
-- ladder_wallet_events was held to.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ladder_fee_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_number integer not null,
  league_id uuid not null references ladder_leagues(id) on delete cascade,
  fee_type text not null check (fee_type in ('entry', 'table')),
  amount bigint not null check (amount > 0),
  transitioned boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_fee_events_user on ladder_fee_events (user_id, week_number desc);
create index if not exists idx_ladder_fee_events_week on ladder_fee_events (week_number);

alter table ladder_fee_events enable row level security;

drop policy if exists "ladder_fee_events_select" on ladder_fee_events;
create policy "ladder_fee_events_select" on ladder_fee_events for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- No insert/update/delete policies — only the settlement function below
-- ever writes here.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_match_reward_for_tier — mirrors economy.js's LADDER_TIER_TABLE
-- .matchReward. Keep both in sync by hand if the §5 table ever changes —
-- same convention as every other JS/SQL pair in this codebase
-- (_generate_round_robin_fixtures_internal, the standings query in
-- 20260859). Tiers past 8 reuse tier 8's reward, matching economy.js's
-- ladderTierRow clamp.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_match_reward_for_tier(p_tier integer)
returns bigint
language sql
immutable
as $$
  select case least(greatest(p_tier, 1), 8)
    when 1 then 25 when 2 then 20 when 3 then 16 when 4 then 13
    when 5 then 10 when 6 then 8  when 7 then 6  when 8 then 4
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_entry_fee_for_tier — mirrors economy.js's LADDER_TIER_TABLE
-- .entryFee. Same sync convention as above.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_entry_fee_for_tier(p_tier integer)
returns bigint
language sql
immutable
as $$
  select case least(greatest(p_tier, 1), 8)
    when 1 then 80 when 2 then 67 when 3 then 58 when 4 then 48
    when 5 then 36 when 6 then 29 when 7 then 18 when 8 then 10
  end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- _credit_ladder_match_reward_internal — pays both participants of a just-
-- played fixture their league's flat Match Reward. Nets side credits the
-- player (_nets_credit_internal); per §5's shared-pool model, Match Reward
-- is one of the pool's own debit events, so _ladder_pool_debit mirrors it
-- on the pool's ledger. No early bonus yet — see this migration's header.
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
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- submit_ladder_fixture_result — same as 20260857, plus the reward credit
-- once the fixture is marked played. Everything else (auth checks, the
-- pending/locked guards) is unchanged.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function submit_ladder_fixture_result(
  p_fixture_id uuid,
  p_home_score integer,
  p_away_score integer
) returns ladder_fixtures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_is_admin boolean;
  v_fixture ladder_fixtures%rowtype;
  v_locked boolean;
begin
  if v_user_id is null then
    raise exception 'submit_ladder_fixture_result: must be signed in';
  end if;
  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'submit_ladder_fixture_result: scores must be non-negative';
  end if;

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'submit_ladder_fixture_result: fixture not found';
  end if;
  if v_fixture.status <> 'pending' then
    raise exception 'submit_ladder_fixture_result: fixture is not pending';
  end if;

  v_is_admin := exists (select 1 from admins a where a.user_id = v_user_id);

  if not v_is_admin and v_user_id <> v_fixture.home_user_id and v_user_id <> v_fixture.away_user_id then
    raise exception 'submit_ladder_fixture_result: not a participant in this fixture';
  end if;

  select fixtures_locked into v_locked from ladder_cycle where id = true;
  if v_locked and not v_is_admin then
    raise exception 'submit_ladder_fixture_result: fixtures are locked for this week';
  end if;

  update ladder_fixtures
  set home_score = p_home_score, away_score = p_away_score, status = 'played', played_at = now()
  where id = p_fixture_id
  returning * into v_fixture;

  perform _credit_ladder_match_reward_internal(v_fixture.id);

  return v_fixture;
end;
$$;

grant execute on function submit_ladder_fixture_result(uuid, integer, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_settle_week_fees_internal — the Sunday 10PM fee settlement
-- proper. Runs after promotion/relegation has already been resolved for
-- p_week_number (so ladder_memberships.status for that week is final: one
-- of 'active' / 'promoted' / 'relegated'). For every membership row that
-- week:
--   - 'promoted'  -> Entry Fee for the tier they just moved into (their
--                    league's tier - 1). transitioned = true.
--   - 'active'    -> Table Fee: 20% of this week's Match Reward earnings,
--                    rounded (see economy.js's computeTableFee — matches
--                    it exactly, same round-half-up behavior). Skipped
--                    entirely if 0 — "owes nothing", not a $0 event.
--   - 'relegated' -> skipped; see this migration's header scope note.
-- Charging is idempotent per (user, week, fee_type) via a not-exists guard
-- on ladder_fee_events, so re-running this for a week it already settled
-- doesn't double-charge anyone — same "safe to run more than once"
-- standard as every other job in this file.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_settle_week_fees_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_fee bigint;
  v_earnings bigint;
  v_fee_type text;
  v_reason text;
begin
  for v_row in
    select m.user_id, m.status, m.league_id, l.tier as league_tier
    from ladder_memberships m
    join ladder_leagues l on l.id = m.league_id
    where m.week_number = p_week_number
      and m.status in ('active', 'promoted')
  loop
    if v_row.status = 'promoted' then
      v_fee_type := 'entry';
      v_reason := 'ladder_entry_fee';
      v_fee := _ladder_entry_fee_for_tier(v_row.league_tier - 1);
    else
      select coalesce(sum(amount), 0) into v_earnings
      from nets_transactions
      where user_id = v_row.user_id
        and ref_type = 'ladder_fixture'
        and reason = 'ladder_match_reward'
        and ref_id in (
          select id::text from ladder_fixtures where week_number = p_week_number
        );

      v_fee := round(v_earnings * 0.20);
      if v_fee <= 0 then
        continue; -- earned nothing (or a rounding-to-zero week) -> owes nothing
      end if;
      v_fee_type := 'table';
      v_reason := 'ladder_table_fee';
    end if;

    -- Idempotency guard: skip if this exact (user, week, fee_type) was
    -- already charged by a previous run.
    if exists (
      select 1 from ladder_fee_events
      where user_id = v_row.user_id and week_number = p_week_number and fee_type = v_fee_type
    ) then
      continue;
    end if;

    perform _nets_debit_internal(
      v_row.user_id, v_fee, v_reason, null, 'ladder_week', p_week_number::text
    );
    perform _ladder_pool_credit(
      v_fee, v_reason, v_row.user_id, 'ladder_week', p_week_number::text
    );

    insert into ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned)
    values (v_row.user_id, p_week_number, v_row.league_id, v_fee_type, v_fee, v_row.status = 'promoted');
  end loop;
end;
$$;

-- Deliberately no grant on any function above — internal only, reachable
-- solely from the scheduled close-week job below.

-- ─────────────────────────────────────────────────────────────────────────
-- _ladder_close_week_internal — now settles fees right after resolving
-- promotion/relegation (20260859's version resolved but never charged
-- anyone), before flipping the cycle flags. Uses the WEEK THAT'S CLOSING
-- (current_week, read before the flag flip) — memberships/fixtures for
-- that week are what settlement needs, not whatever week opens next.
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
    perform _ladder_settle_week_fees_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;
end;
$$;
