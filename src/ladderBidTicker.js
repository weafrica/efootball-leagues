// src/ladderBidTicker.js
//
// League Ladder — Phase 5's "live bid ticker: Supabase Realtime channel on
// ladder_bids filtered by target_league_id." Split out of
// formats/leagueLadder.js on purpose — that file is pure functions only
// (no React, no Supabase, see its own header); this one is the Supabase
// side, same separation nets.js keeps between economy.js's pure pricing
// and its own live-balance subscription (watchNetsBalance).
//
// Usage (inside a component):
//   useEffect(() => {
//     let unsub;
//     watchLadderBidTicker(targetLeagueId, weekNumber, setBids).then((fn) => { unsub = fn; });
//     return () => unsub?.();
//   }, [targetLeagueId, weekNumber]);

import { supabase } from "./supabaseClient";

// Phase G — under the Phase C/D live-auction model at most one 'pending'
// bid can ever exist per league/week (every dethroned or voided bid is
// flipped to 'refunded' immediately, see 20260871/20260873's own
// headers), so the current leader is simply whichever row (if any) still
// has status 'pending'. NOT bids[0]/the highest amount overall — a bid
// voided by Phase D's re-eligibility recheck (rank-1 auto-promotion) can
// leave the single largest-ever amount sitting on a 'refunded' row with
// no 'pending' bid behind it, so amount-sorted position alone would point
// at a stale, already-refunded "leader".
function findLeader(bids) {
  return bids.find((b) => b.status === "pending") || null;
}

// One-time fetch of the current bid list for a league/week, highest
// first — matches idx_ladder_bids_league_week_amount's own ordering, so
// this is index-friendly rather than an arbitrary sort. Also resolves the
// current leader's display name (a lightweight companion lookup against
// profiles, same public-read efootball_username/avatar_url shape
// LeagueLadderDetail's own profilesById fetch already relies on — see
// that file's `load()`) and returns it alongside the full bid list rather
// than requiring every call site to join it separately.
export async function getLadderBids(targetLeagueId, weekNumber) {
  const { data, error } = await supabase
    .from("ladder_bids")
    .select("*")
    .eq("target_league_id", targetLeagueId)
    .eq("week_number", weekNumber)
    .order("amount", { ascending: false });

  if (error) {
    console.warn("getLadderBids failed:", error.message);
    return { bids: [], currentLeader: null };
  }
  const bids = data || [];

  const leaderBid = findLeader(bids);
  let currentLeader = null;
  if (leaderBid) {
    const { data: profileRow, error: profileError } = await supabase
      .from("profiles")
      .select("efootball_username")
      .eq("user_id", leaderBid.bidder_user_id)
      .maybeSingle();
    if (profileError) {
      console.warn("getLadderBids: leader profile lookup failed:", profileError.message);
    }
    currentLeader = {
      userId: leaderBid.bidder_user_id,
      name: profileRow?.efootball_username || null,
      amount: leaderBid.amount,
    };
  }

  return { bids, currentLeader };
}

// Loads the current bid list (and current leader) immediately, then keeps
// both live via Realtime — every insert/update on ladder_bids for this
// league+week re-fetches and re-emits { bids, currentLeader } (simplest
// correct approach: bid counts per league are small, a re-fetch per
// change is cheap, and it sidesteps hand-merging partial payloads into a
// sorted list / re-deriving the leader's name from a partial row).
// Returns an unsubscribe function; call it on unmount. One channel per
// (league, week) pair — no fan-out sharing like watchNetsBalance's, since
// a bid ticker is normally mounted by exactly one screen at a time (the
// league's own auction view), not scattered across the header the way a
// wallet balance is.
export async function watchLadderBidTicker(targetLeagueId, weekNumber, onUpdate) {
  const emit = async () => onUpdate(await getLadderBids(targetLeagueId, weekNumber));
  await emit();

  const channel = supabase
    .channel(`ladder-bids-${targetLeagueId}-${weekNumber}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "ladder_bids",
        filter: `target_league_id=eq.${targetLeagueId}`,
      },
      () => emit()
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

// Places or raises a bid — thin wrapper around the place_ladder_bid RPC
// (supabase/migrations/20260861_ladder_bidding.sql), same
// throw-on-failure/return-new-state shape as nets.js's creditNets/debitNets
// so call sites can catch and toast consistently.
export async function placeLadderBidRpc(targetLeagueId, amount) {
  const { data, error } = await supabase.rpc("place_ladder_bid", {
    p_target_league_id: targetLeagueId,
    p_amount: amount,
  });
  if (error) throw error;
  return data;
}
