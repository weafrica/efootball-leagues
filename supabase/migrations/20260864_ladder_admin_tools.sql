-- League Ladder — Phase 8: admin tooling & observability.
--
-- Covers the plan's three concrete Monday-dispute-window actions (override
-- a fixture result, manually re-trigger a week's resolve job, cancel/
-- adjust a bid) plus the roster-balance dashboard view. Reuses the
-- existing admins-table check pattern (see submit_ladder_fixture_result,
-- 20260857) rather than inventing a new authorization scheme.
--
-- No new UI in this migration — these are the callable RPCs +
-- view an admin panel would wire buttons/table rows up to. The panel
-- itself (reusing the existing admin-check pattern in App.jsx, per the
-- plan's own checklist wording) is presentation work on top of these.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- admin_override_ladder_fixture_result — unlike submit_ladder_fixture_result
-- (which only accepts a still-'pending' fixture), this works on a fixture
-- in ANY status: a late correction to an already-played score, or
-- overturning a forfeit into the real result once proof surfaces in the
-- Monday dispute window. Reward handling: the flat per-tier Match Reward
-- doesn't depend on the score, so correcting an already-'played' fixture's
-- score never re-credits anything — only a fixture that WASN'T 'played'
-- before this call (a pending correction, or overturning a forfeit) gets
-- the reward credited now, since forfeits skip it entirely (Phase 6) and
-- pending fixtures haven't earned it yet.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function admin_override_ladder_fixture_result(
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
  v_fixture ladder_fixtures%rowtype;
  v_was_played boolean;
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'admin_override_ladder_fixture_result: admin only';
  end if;
  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'admin_override_ladder_fixture_result: scores must be non-negative';
  end if;

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'admin_override_ladder_fixture_result: fixture not found';
  end if;

  v_was_played := (v_fixture.status = 'played');

  update ladder_fixtures
  set home_score = p_home_score, away_score = p_away_score, status = 'played',
      played_at = coalesce(played_at, now())
  where id = p_fixture_id
  returning * into v_fixture;

  if not v_was_played then
    perform _credit_ladder_match_reward_internal(v_fixture.id);
  end if;

  return v_fixture;
end;
$$;

grant execute on function admin_override_ladder_fixture_result(uuid, integer, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_retrigger_ladder_resolve — re-runs the Sunday 10PM resolve job
-- (_ladder_close_week_internal) on demand, e.g. after an admin_override
-- above changes a result that should flow through to standings/fees/
-- promotion again. Every step it calls is documented "safe to run more
-- than once" in its own migration, so re-running the whole chain is safe
-- by construction rather than something this function has to guard itself
-- — see 20260859/20260860/20260861/20260863's own headers.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function admin_retrigger_ladder_resolve()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'admin_retrigger_ladder_resolve: admin only';
  end if;

  perform _ladder_close_week_internal();
end;
$$;

grant execute on function admin_retrigger_ladder_resolve() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- admin_cancel_ladder_bid — cancels a still-'pending' bid and refunds the
-- escrowed amount in full, same refund shape _ladder_settle_bids_internal
-- uses for a losing bidder. Only 'pending' bids are cancellable — a 'won'
-- or already-'refunded' bid has already been settled and paid out/back,
-- nothing left to cancel.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function admin_cancel_ladder_bid(p_bid_id uuid)
returns ladder_bids
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_bid ladder_bids%rowtype;
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'admin_cancel_ladder_bid: admin only';
  end if;

  select * into v_bid from ladder_bids where id = p_bid_id for update;
  if v_bid.id is null then
    raise exception 'admin_cancel_ladder_bid: bid not found';
  end if;
  if v_bid.status <> 'pending' then
    raise exception 'admin_cancel_ladder_bid: bid has already been settled (status=%)', v_bid.status;
  end if;

  perform _nets_credit_internal(
    v_bid.bidder_user_id, v_bid.amount, 'ladder_bid_admin_cancel_refund', null, 'ladder_bid', v_bid.id::text
  );
  perform _ladder_pool_debit(
    v_bid.amount, 'ladder_bid_admin_cancel_refund', v_bid.bidder_user_id, 'ladder_bid', v_bid.id::text
  );

  update ladder_bids set status = 'refunded' where id = p_bid_id returning * into v_bid;
  return v_bid;
end;
$$;

grant execute on function admin_cancel_ladder_bid(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- ladder_roster_balance — "a simple query/view showing net roster change
-- per league per week," per the plan's own wording for this checklist
-- item. week-over-week delta in each league's roster size; with the
-- fall-through mechanic (Phase 5) in place every league should settle at
-- net zero most weeks — this view is how that gets confirmed in
-- production instead of assumed.
-- ─────────────────────────────────────────────────────────────────────────
create or replace view ladder_roster_balance as
with weekly_counts as (
  select league_id, week_number, count(*) as roster_count
  from ladder_memberships
  group by league_id, week_number
)
select
  ll.tier,
  wc.league_id,
  wc.week_number,
  wc.roster_count,
  wc.roster_count - lag(wc.roster_count) over (partition by wc.league_id order by wc.week_number) as net_change
from weekly_counts wc
join ladder_leagues ll on ll.id = wc.league_id
order by ll.tier, wc.week_number;

-- Readable to any authenticated user, same as the ladder_leagues/
-- ladder_memberships rows it's built from (both already public-read
-- within the app — see their own migrations) — this view derives nothing
-- beyond what those tables' existing RLS policies already expose, so
-- restricting it further here wouldn't add real protection, just an
-- inconsistent read path for the same data.
grant select on ladder_roster_balance to authenticated;
