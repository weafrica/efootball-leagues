-- League Ladder redesign — Phase F: retroactive global top-up.
--
-- Live per-tier pricing (Phase A) prices Match Reward off d = maxActiveTier
-- - tier. d is RELATIVE, not absolute, so it moves for every existing
-- league the instant the ladder grows a new frontier tier — a player who
-- already played and got paid for a fixture earlier in the week was paid
-- at the d that held at that moment, and now owes nothing more only
-- because nothing since has changed for them... except something has: the
-- ladder just grew, so their d (and therefore what that same fixture would
-- pay today) just went up too. Per spec, that gap gets topped up, not left
-- as a quirk of "when in the week you happened to play."
--
-- Three pieces, in dependency order:
--
-- 1. ladder_reward_ledger — one row per (fixture, participant) that's
--    already been paid a Match Reward, recording exactly which tier and
--    which max-active-tier-at-the-time it was priced at (so "how much
--    more is owed now" is a lookup, not a re-derivation from match
--    history). _credit_ladder_match_reward_internal now writes one row
--    per participant alongside its existing nets_credit_internal calls —
--    same data, just also kept in a shape a later top-up pass can query
--    without recomputing from scratch. Early Bonus and Streak Bonus are
--    NOT ledgered here — this is specifically the flat Match Reward the
--    d formula prices, matching the spec's own "per credited match-reward
--    transaction" wording. Unique on (fixture_id, user_id): each fixture
--    is only ever credited once in its lifetime (see 20260864's header —
--    admin_override_ladder_fixture_result only calls the credit function
--    the first time a fixture becomes 'played'), so this is a belt-and-
--    braces guard against a double-insert, not an expected conflict path.
--
-- 2. _ladder_retroactive_topup_internal(week_number) — walks every ledger
--    row for that week whose league is still active, recomputes what its
--    tier's Match Reward is at the CURRENT max active tier, and — only
--    when that's actually gone up since this row was last paid/topped up
--    — credits the player the difference and updates the ledger row to
--    the new baseline (so a later, bigger split tops up from there, not
--    from the original amount again). Always additive: d only ever grows
--    within a week under this formula (the frontier only ever moves up,
--    never down, mid-week), so there's no clawback branch to write. A
--    league whose own tier didn't change position relative to the new
--    frontier (d unchanged) simply sees delta = 0 and nothing happens for
--    its rows — most of the ladder, most of the time.
--
-- 3. _rebalance_ladder_overflow_internal — unchanged peeling logic, plus
--    one call to the top-up function after the loop (not inside it): if a
--    single overflow pass splits more than one league, every split has
--    already landed and max_tier is at its final value for this pass by
--    the time top-up runs once at the end, rather than re-running it
--    (harmlessly, since it's idempotent per-row) after every individual
--    split. This is the ONLY call site left for
--    _rebalance_ladder_overflow_internal as of 20260876 — join_ladder_
--    league() is both "the weekly trigger" and "the mid-week trigger" the
--    original build spec (Phase E step 16) described as two separate
--    things; the auto-start redesign already collapsed them into one path
--    before this migration, so there is only one place to wire this in,
--    not two. Global by design, per spec: top-up walks every active
--    league's ledger rows for the week, not just the league that split.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- ladder_reward_ledger
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ladder_reward_ledger (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references ladder_fixtures(id),
  user_id uuid not null,
  league_id uuid not null references ladder_leagues(id),
  week_number integer not null,
  tier integer not null,              -- the league's tier — fixed, never changes for this row
  max_tier_at_credit integer not null, -- the ladder's max active tier as of the most recent (re)payment
  paid_at_d integer not null,          -- max_tier_at_credit - tier, i.e. the d this row was last priced at
  reward_amount bigint not null,       -- total Match Reward actually paid so far for this fixture/participant
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fixture_id, user_id)
);

create index if not exists idx_ladder_reward_ledger_week
  on ladder_reward_ledger (week_number);

alter table ladder_reward_ledger enable row level security;

-- Same own-row-or-admin visibility as ladder_pool_transactions
-- (20260855) — this names individual players and amounts, not public.
drop policy if exists "ladder_reward_ledger_select" on ladder_reward_ledger;
create policy "ladder_reward_ledger_select" on ladder_reward_ledger for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.admins a where a.user_id = auth.uid())
  );

-- No insert/update/delete policies — written only from inside
-- _credit_ladder_match_reward_internal / _ladder_retroactive_topup_internal
-- below, both SECURITY DEFINER, same internal-write convention as every
-- other ladder table.

-- ─────────────────────────────────────────────────────────────────────────
-- _credit_ladder_match_reward_internal — identical to 20260865's version
-- (flat Match Reward credit, then streak bookkeeping), plus one ledger
-- row per participant recording the tier/max-tier/d/amount this payment
-- was priced at, for _ladder_retroactive_topup_internal to read later.
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
  v_max_tier integer;
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
  v_max_tier := _ladder_current_max_tier_internal();
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

  insert into ladder_reward_ledger
    (fixture_id, user_id, league_id, week_number, tier, max_tier_at_credit, paid_at_d, reward_amount)
  values
    (v_fixture.id, v_fixture.home_user_id, v_fixture.league_id, v_fixture.week_number, v_tier, v_max_tier, v_max_tier - v_tier, v_reward),
    (v_fixture.id, v_fixture.away_user_id, v_fixture.league_id, v_fixture.week_number, v_tier, v_max_tier, v_max_tier - v_tier, v_reward)
  on conflict (fixture_id, user_id) do nothing;

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
-- _ladder_retroactive_topup_internal — see this migration's header for the
-- full rationale. Returns the number of ledger rows actually topped up
-- (0 most of the time — most splits don't move most leagues' d), purely
-- so a caller/test can assert something happened without querying the
-- ledger separately.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_retroactive_topup_internal(p_week_number integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_tier integer;
  v_row record;
  v_new_d integer;
  v_new_reward bigint;
  v_delta bigint;
  v_topped_up integer := 0;
begin
  v_max_tier := _ladder_current_max_tier_internal();

  for v_row in
    select rl.id, rl.fixture_id, rl.user_id, rl.tier, rl.paid_at_d, rl.reward_amount
    from ladder_reward_ledger rl
    join ladder_leagues ll on ll.id = rl.league_id
    where rl.week_number = p_week_number
      and ll.status = 'active'
    for update of rl
  loop
    v_new_d := v_max_tier - v_row.tier;
    if v_new_d > v_row.paid_at_d then
      v_new_reward := _ladder_match_reward_for_tier(v_row.tier);
      v_delta := v_new_reward - v_row.reward_amount;
      if v_delta > 0 then
        perform _nets_credit_internal(
          v_row.user_id, v_delta, 'ladder_match_reward_topup', null, 'ladder_fixture', v_row.fixture_id::text
        );
        perform _ladder_pool_debit(
          v_delta, 'ladder_match_reward_topup', v_row.user_id, 'ladder_fixture', v_row.fixture_id::text
        );

        update ladder_reward_ledger
        set max_tier_at_credit = v_max_tier, paid_at_d = v_new_d, reward_amount = v_new_reward, updated_at = now()
        where id = v_row.id;

        v_topped_up := v_topped_up + 1;
      end if;
    end if;
  end loop;

  return v_topped_up;
end;
$$;

-- Deliberately no grant — internal only, called from
-- _rebalance_ladder_overflow_internal below.

-- ─────────────────────────────────────────────────────────────────────────
-- _rebalance_ladder_overflow_internal — identical peeling logic to
-- 20260876's version, plus one top-up call after the loop. See this
-- migration's header for why this is the only call site that needs it.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _rebalance_ladder_overflow_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_overflow_league record;
  v_max_tier integer;
  v_overflow_ids uuid[];
  v_new_league_id uuid;
  v_split_happened boolean := false;
begin
  for v_overflow_league in
    select league_id, count(*) as cnt
    from ladder_memberships
    where week_number = p_week_number
    group by league_id
    having count(*) > 6
  loop
    select max(tier) into v_max_tier from ladder_leagues where status = 'active';

    select array_agg(user_id) into v_overflow_ids
    from (
      select user_id
      from ladder_memberships
      where league_id = v_overflow_league.league_id and week_number = p_week_number
      order by joined_at desc
      limit (v_overflow_league.cnt - 6)
    ) newest_arrivals;

    if v_overflow_ids is not null and array_length(v_overflow_ids, 1) > 0 then
      v_new_league_id := _ensure_ladder_league_internal(v_max_tier + 1);
      update ladder_memberships
      set league_id = v_new_league_id
      where league_id = v_overflow_league.league_id
        and week_number = p_week_number
        and user_id = any(v_overflow_ids);

      perform _ladder_sync_fixtures_internal(v_new_league_id, p_week_number);
      v_split_happened := true;
    end if;
  end loop;

  -- Global top-up, once, after every split in this pass has landed and
  -- the ladder's max active tier is at its final value — not skipped when
  -- nothing split (harmless no-op: no ledger row will show a d increase).
  if v_split_happened then
    perform _ladder_retroactive_topup_internal(p_week_number);
  end if;
end;
$$;
