-- League Ladder — auction winners never labeled 'active', so match-making
-- never seats them.
--
-- ROOT CAUSE: _ladder_settle_bids_internal (live-bidding version, 20260871
-- — the current live definition, superseding 20260861's sealed-bid one)
-- seats a winning bidder's new-week membership row with status='auction_won'.
-- But 20260852's own design comment for ladder_memberships is explicit:
-- status starts 'active' when a week's roster locks in, and is only ever
-- updated to 'promoted' / 'relegated' / 'auction_won' / 'eliminated' by the
-- close job describing what happened to that row's player *that week* — it
-- was never meant to be the STARTING status of a brand-new upcoming-week
-- row. Every fixture-generating query (_ladder_sync_fixtures_internal, and
-- the week-to-week carry-forward inside _ladder_open_week_internal) only
-- ever selects status='active' rosters, so an auction winner's row — seated
-- with the wrong status from the moment it's created — is invisible to
-- both: no fixtures get generated for them, and they don't even carry
-- forward into the following week either. Confirmed nothing else in the
-- schema or frontend reads or transitions on 'auction_won' (not the
-- frontend, not promotion/relegation, not decay penalty, not Wall of
-- Fame) — this is a pure mislabeling at the one place it's written, not a
-- status with its own downstream meaning. Affects every league, not just
-- one — any player who bought back in via auction has been sitting
-- unscheduled ever since.
--
-- FIX: seat the winner with status='active', same as every other new-week
-- roster row, so match-making recognizes them immediately.
--
-- Deliberately does NOT touch any already-existing status='auction_won'
-- rows sitting in the live table. Those are old mislabeled history mixed
-- in with genuinely-played weeks and separately-known duplicate/artifact
-- fixtures, and blindly flipping them now would trigger fixture
-- generation on weeks that haven't been triaged yet — exactly the mess
-- the league-by-league cleanup step exists to sort out safely, one league
-- at a time. Existing 'auction_won' rows are handled there, not here.
--
-- Safe to run more than once.

create or replace function _ladder_settle_bids_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  for v_row in
    select id, target_league_id, bidder_user_id, amount
    from ladder_bids
    where week_number = p_week_number and status = 'pending'
  loop
    update ladder_bids set status = 'won' where id = v_row.id;

    insert into ladder_memberships (user_id, league_id, week_number, status)
    values (v_row.bidder_user_id, v_row.target_league_id, p_week_number + 1, 'active')
    on conflict (user_id, week_number) do nothing;

    insert into ladder_fee_events (user_id, week_number, league_id, fee_type, amount, transitioned)
    values (v_row.bidder_user_id, p_week_number + 1, v_row.target_league_id, 'entry', v_row.amount, true);
  end loop;
end;
$$;
