-- Nets — record which club a transaction is tied to, not just which user.
-- Nothing consumed team_id before now (entry fees/purchases/admin grants
-- are all purely per-user), but match reward crediting (see
-- 20260832_league_match_reward_crediting.sql) pays out per club, and
-- "who earned this and for which team" is worth keeping on the ledger
-- row itself rather than only reconstructable via ref_type/ref_id ->
-- fixtures -> teams. Nullable and unused by every existing transaction
-- type — this doesn't change anything about how nets_credit/nets_debit
-- behave for entry fees, purchases, or admin grants.
--
-- Safe to run more than once.

alter table nets_transactions add column if not exists team_id uuid references teams(id);

create index if not exists nets_transactions_team_idx on nets_transactions (team_id) where team_id is not null;
