-- League Ladder — let an admin fully UNDO an already-confirmed fixture
-- result (played or forfeited), same "shouldn't exist at all" undo
-- correct_ladder_fixture_result (20260892/20260904) deliberately doesn't
-- attempt — that RPC only ever corrects a score in place, it never sends a
-- fixture back to unplayed. This is the League Ladder equivalent of
-- cancel_fixture_result (20260909_cancel_fixture_result_rpc.sql) for
-- regular league fixtures.
--
-- Sets status back to 'pending' with a null score — countdown_expires_at
-- is left untouched, so the fixture immediately reads exactly like any
-- other pending one: still open to resubmission if its countdown hasn't
-- passed yet, or showing as overdue/about to be auto-forfeited by the
-- hourly sweep (20260862/20260891) if it has. Nothing else to set for
-- that part, same as cancel_fixture_result's fixtures.played+due_at case.
--
-- Standings/promotion/relegation need no separate undo here — League
-- Ladder recomputes those fresh from scratch every resolve run (see
-- 20260887's header), unlike Ladder Cup's replay engine, so a 'pending'
-- fixture just drops out of the next _ladder_close_week_internal() pass
-- on its own. If this fixture's week has already closed, this re-triggers
-- that resolve immediately, same as correct_ladder_fixture_result does.
--
-- KNOWN LIMITATION, same trade-off admin_override_ladder_fixture_result's
-- own header already accepts for corrections: this does NOT claw back the
-- Match Reward / Early Bonus / streak-bonus Nets
-- _credit_ladder_match_reward_internal already paid out to both
-- participants when the fixture first became 'played'. Reversing an
-- already-settled pool debit + two players' credited balances safely
-- (without risking a negative balance, or unwinding streak/Wall of Fame
-- state that may have already been built on top of it) is a separate,
-- larger piece of work than this migration — flagging it here rather than
-- attempting a partial reversal. An admin cancelling a result for a
-- clear-cut mistake (wrong opponent, wrong league) should account for
-- this separately if the Nets matter.
--
-- Mirrors correct_ladder_fixture_result's admin-only auth check exactly.
--
-- Safe to run more than once.

-- Audit trail, mirroring ladder_fixture_corrections (20260887) — logs
-- what a cancelled fixture's status/score were right before the undo, so
-- there's a record even though the fixtures row itself goes back to a
-- blank pending state.
create table if not exists ladder_fixture_cancellations (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references ladder_fixtures(id) on delete cascade,
  cancelled_by uuid references auth.users(id),
  previous_status text not null,
  previous_home_score integer,
  previous_away_score integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_fixture_cancellations_fixture
  on ladder_fixture_cancellations(fixture_id);

alter table ladder_fixture_cancellations enable row level security;

drop policy if exists "ladder_fixture_cancellations_select" on ladder_fixture_cancellations;
create policy "ladder_fixture_cancellations_select" on ladder_fixture_cancellations for select
  to authenticated
  using (true);

-- No insert/update/delete policies — every write goes through
-- cancel_ladder_fixture_result below, same no-direct-writes convention
-- ladder_fixture_corrections already uses.

create or replace function cancel_ladder_fixture_result(
  p_fixture_id uuid
) returns ladder_fixtures
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_fixture ladder_fixtures%rowtype;
  v_week_closed boolean;
begin
  if v_user_id is null or not exists (select 1 from admins a where a.user_id = v_user_id) then
    raise exception 'cancel_ladder_fixture_result: admin only';
  end if;

  select * into v_fixture from ladder_fixtures where id = p_fixture_id for update;
  if v_fixture.id is null then
    raise exception 'cancel_ladder_fixture_result: fixture not found';
  end if;
  if v_fixture.status not in ('played', 'forfeited') then
    raise exception 'cancel_ladder_fixture_result: this fixture has no confirmed result to cancel';
  end if;

  insert into ladder_fixture_cancellations (
    fixture_id, cancelled_by, previous_status, previous_home_score, previous_away_score
  ) values (
    p_fixture_id, v_user_id, v_fixture.status, v_fixture.home_score, v_fixture.away_score
  );

  update ladder_fixtures
  set status = 'pending', home_score = null, away_score = null, played_at = null
  where id = p_fixture_id
  returning * into v_fixture;

  -- Same "if the week's already closed, re-run resolve now" step
  -- correct_ladder_fixture_result takes — without this, a cancelled
  -- fixture from an already-resolved week would leave stale
  -- standings/promotion behind until the next unrelated resolve run.
  select fixtures_locked into v_week_closed from ladder_cycle where id = true;
  if v_week_closed then
    perform admin_retrigger_ladder_resolve();
  end if;

  return v_fixture;
end;
$$;

grant execute on function cancel_ladder_fixture_result(uuid) to authenticated;
