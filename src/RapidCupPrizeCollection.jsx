import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

// Rapid Cup — Phase 6: Winbox / Cup box tap-to-collect (Section 8).
//
// Both boxes call a server RPC that determines the amount itself — this
// file never computes or displays a number it isn't already sure the
// server will pay, and never lets the client claim on someone else's
// behalf. See supabase/migrations/20260903210000_rapid_cup_prize_collection.sql
// for the server side (collect_rapid_cup_winbox / collect_rapid_cup_cupbox)
// and the full pack-opening reveal / "Underdog"/"All-In" polish is Section
// 13 (Phase 9) — deliberately not built here, this is the plain
// functional version.

function useCollectionStatus(userId, boxType, refId) {
  const [collected, setCollected] = useState(null); // null = loading, else the row (or false if none)

  const load = useCallback(async () => {
    if (!userId || !refId) { setCollected(false); return; }
    const { data } = await supabase
      .from("rapid_cup_collections")
      .select("amount")
      .eq("user_id", userId)
      .eq("box_type", boxType)
      .eq("ref_id", refId)
      .maybeSingle();
    setCollected(data || false);
  }, [userId, boxType, refId]);

  useEffect(() => { load(); }, [load]);

  return { collected, reload: load };
}

// computeIWon — mirrors collect_rapid_cup_winbox's own winner rule exactly
// (score, or penalties on a level scoreline) so the button only renders
// for an actual winner without the caller having to re-derive that logic
// itself. Returns false for anything not decided yet (unplayed, or level
// with no pens submitted) — same as the server, which has no collectable
// winner in that case either.
function computeIWon(fixture, myTeamId) {
  if (!fixture || !fixture.played || !myTeamId) return false;
  const { home_team_id, away_team_id, home_score, away_score, pens_home, pens_away } = fixture;
  if (myTeamId !== home_team_id && myTeamId !== away_team_id) return false;
  let winnerTeamId = null;
  if (home_score > away_score) winnerTeamId = home_team_id;
  else if (away_score > home_score) winnerTeamId = away_team_id;
  else if (pens_home != null && pens_away != null && pens_home !== pens_away) {
    winnerTeamId = pens_home > pens_away ? home_team_id : away_team_id;
  }
  return winnerTeamId === myTeamId;
}

// RapidCupWinbox — shown on a fixture the viewer just won. Renders nothing
// if the viewer isn't the (known, already-played) winner of this fixture —
// the server enforces this too, this is just so losers don't see a dead
// button. amountHint is optional and purely cosmetic (e.g. "3 Nets") —
// the server-returned amount is always what's actually shown/credited.
//
// Pass EITHER `fixture` + `myTeamId` (preferred — the component works out
// whether you won using the same rule the server uses) OR an explicit
// `iWon` boolean if the caller already knows it. `iWon`, when passed,
// always wins over the computed value.
export function RapidCupWinbox({ fixtureId, myUserId, myTeamId, fixture, iWon, amountHint = 3, showToast, c }) {
  const { collected, reload } = useCollectionStatus(myUserId, "winbox", fixtureId);
  const [collecting, setCollecting] = useState(false);
  const [justWon, setJustWon] = useState(null); // amount from the RPC's own response, for the reveal

  const won = iWon !== undefined ? iWon : computeIWon(fixture, myTeamId);

  if (!won || collected === null) return null;

  const collect = async () => {
    setCollecting(true);
    const { data, error } = await supabase.rpc("collect_rapid_cup_winbox", { p_fixture_id: fixtureId });
    setCollecting(false);
    if (error) { showToast?.(error.message || "Couldn't open the Winbox."); return; }
    setJustWon(data);
    await reload();
  };

  const already = collected && collected.amount != null;
  const revealAmount = justWon ?? (already ? collected.amount : null);

  return (
    <div style={{ borderRadius: 10, border: `1px solid ${c?.border || "#333"}`, padding: 12, marginTop: 8 }}>
      {revealAmount != null ? (
        <div style={{ textAlign: "center", fontWeight: 700 }}>
          🎁 Winbox collected — +{revealAmount} Nets
        </div>
      ) : (
        <button
          onClick={collect}
          disabled={collecting}
          style={{ width: "100%", padding: "10px 0", borderRadius: 8, fontWeight: 700 }}
        >
          {collecting ? "Opening…" : `🎁 Open Winbox (+${amountHint} Nets)`}
        </button>
      )}
    </div>
  );
}

// RapidCupCupbox — shown once the lobby is 'completed' (a rapid_cup_payouts
// row exists). Every participant can tap this, even a loser in a 'split'/
// 'refund' outcome or a non-winner in a 'winner' outcome — the reveal is
// honest about a $0 result rather than hiding the button from them.
export function RapidCupCupbox({ lobbyId, myUserId, showToast, c }) {
  const { collected, reload } = useCollectionStatus(myUserId, "cupbox", lobbyId);
  const [collecting, setCollecting] = useState(false);
  const [justWon, setJustWon] = useState(null);

  if (!lobbyId || !myUserId || collected === null) return null;

  const collect = async () => {
    setCollecting(true);
    const { data, error } = await supabase.rpc("collect_rapid_cup_cupbox", { p_lobby_id: lobbyId });
    setCollecting(false);
    if (error) { showToast?.(error.message || "Couldn't open the Cup box."); return; }
    setJustWon(data);
    await reload();
  };

  const already = collected && collected.amount != null;
  const revealAmount = justWon ?? (already ? collected.amount : null);

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16, marginTop: 12 }}>
      {revealAmount != null ? (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 22 }}>🏆</div>
          <div style={{ fontWeight: 700, marginTop: 4 }}>
            {revealAmount > 0 ? `Cup box collected — +${revealAmount} Nets` : "Cup box collected — nothing this time"}
          </div>
        </div>
      ) : (
        <button
          onClick={collect}
          disabled={collecting}
          style={{ width: "100%", padding: "12px 0", borderRadius: 8, fontWeight: 700, fontSize: 16 }}
        >
          {collecting ? "Opening…" : "🏆 Open Cup Box"}
        </button>
      )}
    </div>
  );
}
