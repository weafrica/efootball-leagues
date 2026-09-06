import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { EntryFeeSlider } from "./RapidCupFeeSlider";

// Rapid Cup — Phase 2: fee slider join modal + live fee/payout display.
//
// max_stake (Section 3) is the highest fee among the 4 players — it's the
// 100% baseline for the bonus-pool proportion (Section 4). previewPayout
// below mirrors the Section 4a core formula so players can see "if I win
// right now, this is what I'd get" as fees change live. It's a preview
// only — the real payout is computed server-side (Phase 3 RPC) once a
// winner is actually declared; this never touches Nets balances.

// ---- Section 4a math, pure functions so they're easy to unit test later ----

export function computeMaxStake(fees) {
  return fees.length ? Math.max(...fees) : 0;
}

// Returns { baseReturn, bonus, organizerKeep, winnerBonus, netTotal } for a
// hypothetical win by the player with `winnerStake`, given the full pool.
export function previewPayout(fees, winnerStake) {
  const totalPool = fees.reduce((a, b) => a + b, 0);
  const maxStake = computeMaxStake(fees);
  const remainingPool = totalPool - winnerStake;
  const bonusShare = maxStake > 0 ? winnerStake / maxStake : 0;
  const bonus = remainingPool * bonusShare;
  const organizerKeep = bonus * 0.1;
  const winnerBonus = bonus * 0.9;
  return {
    totalPool, maxStake, baseReturn: winnerStake, bonus,
    organizerKeep, winnerBonus, netTotal: winnerStake + winnerBonus,
  };
}

function usePlayerFees(lobbyId) {
  const [players, setPlayers] = useState([]); // [{ user_id, entry_fee, display_name? }]

  const load = useCallback(async () => {
    if (!lobbyId) { setPlayers([]); return; }
    const { data } = await supabase
      .from("rapid_cup_lobby_players")
      .select("user_id, entry_fee")
      .eq("lobby_id", lobbyId)
      .order("joined_at", { ascending: true });
    const rows = data || [];
    // Usernames — profiles is publicly readable to any signed-in member
    // (profiles_select_public_fields), same source every other screen in
    // the app uses for a display name. Without this, players only ever
    // saw each other as "Player a1b2c3" (a sliced user id).
    if (rows.length) {
      const { data: profileRows } = await supabase
        .from("profiles")
        .select("user_id, efootball_username")
        .in("user_id", rows.map((r) => r.user_id));
      const nameByUserId = {};
      (profileRows || []).forEach((p) => { nameByUserId[p.user_id] = p.efootball_username; });
      rows.forEach((r) => { r.display_name = nameByUserId[r.user_id] || null; });
    }
    setPlayers(rows);
  }, [lobbyId]);

  useEffect(() => {
    load();
    if (!lobbyId) return;
    // Live updates as fees change — realtime channel scoped to this lobby's
    // players, falling back to nothing if realtime isn't enabled for the
    // table (the banner's own 5s poll will still pick changes up eventually
    // via a full reload; this just makes the fee card feel instant).
    const channel = supabase
      .channel(`rapid_cup_fees_${lobbyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rapid_cup_lobby_players", filter: `lobby_id=eq.${lobbyId}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [lobbyId, load]);

  return { players, reload: load };
}

// useMyFeeCap — 20% of the player's own Nets balance, floored at 400 (the
// slider's absolute ceiling regardless of balance). Mirrors the same cap
// join_rapid_cup_lobby/raise_rapid_cup_entry_fee enforce server-side, so
// the slider stops where the server would actually reject anyway, rather
// than letting a player drag to 400 and only find out it's too high once
// they hit Join/Raise.
function useMyFeeCap() {
  const [cap, setCap] = useState(400);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase.from("balances").select("amount").eq("user_id", user.id).maybeSingle();
      if (cancelled) return;
      const balance = data?.amount || 0;
      setCap(Math.max(0, Math.min(400, Math.floor(balance * 0.2))));
    })();
    return () => { cancelled = true; };
  }, []);
  return cap;
}

// Fee-picker modal — shown before the initial join() call. Wire this in
// wherever the banner's "Join" tap currently calls join() directly.
export function RapidCupJoinModal({ open, onClose, onConfirm, joining, c }) {
  const [fee, setFee] = useState(0);
  const feeCap = useMyFeeCap();
  // If the cap loads in lower than whatever's already dragged (or the
  // player had it set from a previous open), pull it back down rather than
  // leaving the slider showing a value the server will reject on confirm.
  useEffect(() => { setFee((f) => Math.min(f, feeCap)); }, [feeCap]);
  if (!open) return null;
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div style={{ background: c?.cardBg || "#1a1a1a", border: `1px solid ${c?.border || "#333"}`, borderRadius: 12, padding: 20, width: 320 }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Set your entry fee</div>
        <EntryFeeSlider value={fee} onChange={setFee} max={feeCap} disabled={joining} />
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
          Capped at 20% of your Nets balance ({feeCap} Nets right now). You can raise this later before your next match — never mid-match, and never lower.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} disabled={joining} style={{ flex: 1, padding: "8px 0", borderRadius: 8 }}>Cancel</button>
          <button onClick={() => onConfirm(fee)} disabled={joining} style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontWeight: 600 }}>
            {joining ? "Joining…" : "Join"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Live fee + expected-payout display for the tournament/lobby page — all 4
// seats, each player's current fee, max_stake, and what they'd net if they
// won right now. myUserId + myLobbyRowId let the viewer raise their own fee
// inline; everyone else's row is read-only.
export function RapidCupLiveFees({ lobbyId, myUserId, showToast, c }) {
  const { players, reload } = usePlayerFees(lobbyId);
  const [raising, setRaising] = useState(false);
  const [draftFee, setDraftFee] = useState(null);
  const feeCap = useMyFeeCap();

  const fees = players.map((p) => p.entry_fee);
  const maxStake = computeMaxStake(fees);
  const mine = players.find((p) => p.user_id === myUserId);

  const raise = async (newFee) => {
    setRaising(true);
    const { error } = await supabase.rpc("raise_rapid_cup_entry_fee", { p_lobby_id: lobbyId, p_new_fee: newFee });
    setRaising(false);
    if (error) { showToast?.(error.message || "Couldn't raise entry fee."); return; }
    setDraftFee(null);
    await reload();
  };

  if (!players.length) return null;

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Entry fees</div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
        Highest fee ({maxStake} Nets) sets the 100% bonus baseline — see each player's expected return if they win.
      </div>
      {players.map((p) => {
        const { netTotal } = previewPayout(fees, p.entry_fee);
        const isMe = p.user_id === myUserId;
        return (
          <div key={p.user_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
            <div>
              {isMe ? "You" : (p.display_name || `Player ${p.user_id.slice(0, 6)}`)}
              {p.entry_fee === maxStake && p.entry_fee > 0 && <span style={{ opacity: 0.6 }}> · highest</span>}
            </div>
            <div style={{ textAlign: "right" }}>
              <div>{p.entry_fee} Nets</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>~{netTotal.toFixed(1)} if they win</div>
            </div>
          </div>
        );
      })}

      {mine && (
        draftFee === null ? (
          <button
            onClick={() => setDraftFee(mine.entry_fee)}
            style={{ marginTop: 12, width: "100%", padding: "8px 0", borderRadius: 8 }}
          >
            Raise your fee
          </button>
        ) : (
          <div style={{ marginTop: 12 }}>
            <EntryFeeSlider value={draftFee} onChange={setDraftFee} min={mine.entry_fee} max={Math.max(feeCap, mine.entry_fee)} disabled={raising} />
            {feeCap < 400 && (
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>Capped at 20% of your Nets balance ({feeCap} Nets).</div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={() => setDraftFee(null)} disabled={raising} style={{ flex: 1, padding: "8px 0", borderRadius: 8 }}>Cancel</button>
              <button
                onClick={() => raise(draftFee)}
                disabled={raising || draftFee <= mine.entry_fee}
                style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontWeight: 600 }}
              >
                {raising ? "Raising…" : `Raise to ${draftFee}`}
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
