-- cash_ladder_tables_rls
-- Enables RLS and mirrors the exact ladder_* policies onto their cash_ladder_* counterparts.
-- This file documents the migration already applied live to the Supabase project
-- (migration 20260917061233 in project history) so it exists in git as well.

-- === Enable RLS ===
alter table cash_ladder_bids enable row level security;
alter table cash_ladder_cycle enable row level security;
alter table cash_ladder_fee_events enable row level security;
alter table cash_ladder_fixture_cancellations enable row level security;
alter table cash_ladder_fixture_corrections enable row level security;
alter table cash_ladder_fixture_notify_sent enable row level security;
alter table cash_ladder_fixture_result_submissions enable row level security;
alter table cash_ladder_fixtures enable row level security;
alter table cash_ladder_league_comment_likes enable row level security;
alter table cash_ladder_league_comments enable row level security;
alter table cash_ladder_leagues enable row level security;
alter table cash_ladder_memberships enable row level security;
alter table cash_ladder_pool enable row level security;
alter table cash_ladder_pool_transactions enable row level security;
alter table cash_ladder_reward_ledger enable row level security;
alter table cash_ladder_reward_payout_queue enable row level security;
alter table cash_ladder_wall_of_fame enable row level security;

-- === Policies (1:1 with ladder_* originals, table refs renamed) ===

create policy cash_ladder_bids_select on cash_ladder_bids
  for select to authenticated using (true);

create policy cash_ladder_cycle_select on cash_ladder_cycle
  for select to authenticated using (true);

create policy cash_ladder_fee_events_select on cash_ladder_fee_events
  for select to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_fixture_cancellations_select on cash_ladder_fixture_cancellations
  for select to authenticated using (true);

create policy cash_ladder_fixture_corrections_select on cash_ladder_fixture_corrections
  for select to authenticated using (true);

create policy cash_ladder_fixture_result_submissions_select on cash_ladder_fixture_result_submissions
  for select to authenticated using (true);

create policy cash_ladder_fixtures_select on cash_ladder_fixtures
  for select to authenticated using (true);

create policy cash_ladder_league_comment_likes_select on cash_ladder_league_comment_likes
  for select to authenticated using (true);
create policy cash_ladder_league_comment_likes_insert on cash_ladder_league_comment_likes
  for insert to authenticated with check (user_id = auth.uid());
create policy cash_ladder_league_comment_likes_update on cash_ladder_league_comment_likes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cash_ladder_league_comment_likes_delete on cash_ladder_league_comment_likes
  for delete to authenticated using (user_id = auth.uid());

create policy cash_ladder_league_comments_select on cash_ladder_league_comments
  for select to authenticated using (true);
create policy cash_ladder_league_comments_insert on cash_ladder_league_comments
  for insert to authenticated with check (
    user_id = auth.uid() and (
      exists (
        select 1 from cash_ladder_memberships lm
        where lm.league_id = cash_ladder_league_comments.league_id
          and lm.user_id = auth.uid()
          and lm.status = 'active'
      )
      or exists (select 1 from admins a where a.user_id = auth.uid())
    )
  );
create policy cash_ladder_league_comments_delete on cash_ladder_league_comments
  for delete to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_leagues_select on cash_ladder_leagues
  for select to authenticated using (true);

create policy cash_ladder_memberships_select on cash_ladder_memberships
  for select to authenticated using (true);

create policy cash_ladder_pool_select on cash_ladder_pool
  for select to authenticated using (true);

create policy cash_ladder_pool_transactions_select on cash_ladder_pool_transactions
  for select to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_reward_ledger_select on cash_ladder_reward_ledger
  for select to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_reward_payout_queue_select on cash_ladder_reward_payout_queue
  for select to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_wall_of_fame_select on cash_ladder_wall_of_fame
  for select to authenticated using (true);

-- NOTE: cash_ladder_fixture_notify_sent has RLS enabled but currently carries
-- no policy at all (deny-all to authenticated/anon; only service-role backend
-- code can touch it). Its ladder_* counterpart wasn't in the policy set either,
-- so this is very likely correct as-is -- flagging for your confirmation.
