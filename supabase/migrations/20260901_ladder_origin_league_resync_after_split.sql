-- LEAGUE LADDER — fix: after an overflow split, the ORIGIN league's own
-- fixtures were never resynced, so it kept showing pending matchups for
-- players who'd just been peeled off into the new league.
--
-- CONTEXT: _rebalance_ladder_overflow_internal (20260876/20260877) moves
-- the newest arrivals over the 6-player cap into a brand-new league and
-- resyncs THAT league's fixtures:
--
--   update ladder_memberships set league_id = v_new_league_id
--   where league_id = v_overflow_league.league_id ... user_id = any(v_overflow_ids);
--
--   perform _ladder_sync_fixtures_internal(v_new_league_id, p_week_number);
--
-- but never resyncs v_overflow_league.league_id — the league those
-- players just left. That league's pending fixtures were generated
-- against the full pre-split roster (7+), so after the split it's left
-- holding pending pairings that still involve the departed players —
-- fixture rows whose league_id correctly points at that league, but
-- whose matchups no longer reflect who's actually still in it. An admin
-- (or player) opening that league sees fixtures that don't belong to its
-- current roster.
--
-- Fix: resync the origin league too, right after peeling its overflow
-- off — same delete-pending/skip-already-played rebuild
-- _generate_round_robin_fixtures_internal already does everywhere else,
-- just also applied here. Any already-played fixture involving a departed
-- player is left untouched (results are permanent); only the pending
-- schedule gets rebuilt around the 6 players who actually remain.
--
-- Also resyncs every currently-live league that's already been through a
-- split, so the fix applies retroactively without waiting for the next
-- overflow event.
--
-- Safe to run more than once.

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
      -- Rebuild the origin league's own pending schedule around whoever
      -- actually remains there post-split — otherwise it keeps showing
      -- pending fixtures for the players who just left.
      perform _ladder_sync_fixtures_internal(v_overflow_league.league_id, p_week_number);
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

-- One-off backfill: resync every league that currently has an active week
-- 1+ roster, so any origin league still holding stale pending fixtures
-- from a past split gets cleaned up now rather than waiting for its next
-- roster change.
do $$
declare
  v_row record;
begin
  for v_row in
    select distinct league_id, week_number
    from ladder_memberships
    where status = 'active'
  loop
    perform _ladder_sync_fixtures_internal(v_row.league_id, v_row.week_number);
  end loop;
end $$;
