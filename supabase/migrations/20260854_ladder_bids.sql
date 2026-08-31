-- League Ladder — Phase 1, table 4 of 5: ladder_bids.
--
-- unique(bidder_user_id, target_league_id, week_number) makes a bid a
-- "place or raise" action rather than allowing a stack of separate bid
-- rows from the same person for the same spot — Phase 5's placeLadderBid
-- is expected to upsert against this constraint (raise their existing bid
-- if one exists, insert if not), not append a new row every time someone
-- ups their offer. Enforced here at the schema level so that behavior is
-- guaranteed regardless of how carefully the RPC is written later.
--
-- amount is bigint (matching nets_wallets/nets_transactions' existing
-- amount type) rather than integer, for consistency with the rest of the
-- Nets ledger rather than any expectation of needing that range here.
--
-- Safe to run more than once.

create table if not exists ladder_bids (
  id uuid primary key default gen_random_uuid(),
  bidder_user_id uuid not null references auth.users(id) on delete cascade,
  target_league_id uuid not null references ladder_leagues(id) on delete cascade,
  week_number integer not null,
  amount bigint not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'won', 'refunded')),
  placed_at timestamptz not null default now(),
  unique (bidder_user_id, target_league_id, week_number)
);

-- The live bid ticker's exact query: every bid for this league/week,
-- highest first. Also the shape Phase 5's settlement job uses to pick the
-- winner.
create index if not exists idx_ladder_bids_league_week_amount
  on ladder_bids (target_league_id, week_number, amount desc);

alter table ladder_bids enable row level security;

-- Public read — the live bid ticker is a public spectacle by design (see
-- plan §4/§7), not private per-bidder data.
drop policy if exists "ladder_bids_select" on ladder_bids;
create policy "ladder_bids_select" on ladder_bids for select
  to authenticated
  using (true);

-- No insert/update/delete policies — placing, raising, winning, and
-- refunding a bid are all Phase 5's placeLadderBid / settlement-job
-- responsibility (SECURITY DEFINER), not built yet. This migration is the
-- table only.
