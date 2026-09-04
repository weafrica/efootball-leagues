import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

// Rapid Cup — Phase 8: Spectator Investment (Section 7).
//
// Mirrors RapidCupFeeDisplay.jsx's own pattern (self-contained data hook +
// live realtime refresh) rather than importing from it, so this file has
// no dependency on the fee-editing UI. previewTotalStakePayout below is
// the same Section 4a math as RapidCupFeeDisplay's previewPayout, just
// fed each player's total_stake (fee + investments) instead of bare fee —
// see supabase/migrations/20260904_rapid_cup_spectator_investment.sql for
// the server-side version this mirrors (compute_rapid_cup_payout, now
// called with total_stake).

function computeMaxStake(stakes) {
  return stakes.length ? Math.max(...stakes) : 0;
}

function previewTotalStakePayout(stakes, winnerStake) {
  const totalPool = stakes.reduce((a, b) => a + b, 0);
  const maxStake = computeMaxStake(stakes);
  const remainingPool = totalPool - winnerStake;
  const bonusShare = maxStake > 0 ? winnerStake / maxStake : 0;
  const bonus = remainingPool * bonusShare;
  const winnerBonus = bonus * 0.9;
  return { netTotal: winnerStake + winnerBonus };
}

function useRapidCupStakes(lobbyId) {
  // players: [{ user_id, entry_fee, display_name }]
  // investmentsByTarget: { [target_user_id]: [{ investor_user_id, amount, display_name }] }
  const [players, setPlayers] = useState([]);
  const [investmentsByTarget, setInvestmentsByTarget] = useState({});

  const load = useCallback(async () => {
    if (!lobbyId) { setPlayers([]); setInvestmentsByTarget({}); return; }

    const { data: playerRows } = await supabase
      .from("rapid_cup_lobby_players")
      .select("user_id, entry_fee")
      .eq("lobby_id", lobbyId)
      .order("joined_at", { ascending: true });
    const pRows = playerRows || [];

    const { data: investRows } = await supabase
      .from("rapid_cup_investments")
      .select("investor_user_id, target_user_id, amount")
      .eq("lobby_id", lobbyId);
    const iRows = investRows || [];

    const userIds = [...new Set([...pRows.map((r) => r.user_id), ...iRows.map((r) => r.investor_user_id)])];
    let nameByUserId = {};
    if (userIds.length) {
      const { data: profileRows } = await supabase
        .from("profiles")
        .select("user_id, efootball_username")
        .in("user_id", userIds);
      (profileRows || []).forEach((p) => { nameByUserId[p.user_id] = p.efootball_username; });
    }

    pRows.forEach((r) => { r.display_name = nameByUserId[r.user_id] || null; });
    setPlayers(pRows);

    const grouped = {};
    iRows.forEach((r) => {
      const list = grouped[r.target_user_id] || (grouped[r.target_user_id] = []);
      const existing = list.find((x) => x.investor_user_id === r.investor_user_id);
      if (existing) existing.amount += r.amount;
      else list.push({ investor_user_id: r.investor_user_id, amount: r.amount, display_name: nameByUserId[r.investor_user_id] || null });
    });
    setInvestmentsByTarget(grouped);
  }, [lobbyId]);

  useEffect(() => {
    load();
    if (!lobbyId) return;
    const channel = supabase
      .channel(`rapid_cup_investments_${lobbyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "rapid_cup_investments", filter: `lobby_id=eq.${lobbyId}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [lobbyId, load]);

  return { players, investmentsByTarget, reload: load };
}

// RapidCupInvestorPanel — shown on the tournament page. Every player's
// card shows their entry fee, total stake (fee + investments), who's
// backed them and for how much, and what they'd net if they won right
// now — all 4 cards visible to everyone. The Invest button/amount field
// only renders for a spectator (isSpectator — pass !myTeam from the
// caller, since the 4 competing players can't invest in their own cup,
// Section 7).
export function RapidCupInvestorPanel({ lobbyId, myUserId, isSpectator, showToast, c }) {
  const { players, investmentsByTarget, reload } = useRapidCupStakes(lobbyId);
  const [investingFor, setInvestingFor] = useState(null); // user_id currently showing the amount field
  const [amount, setAmount] = useState(20);
  const [submitting, setSubmitting] = useState(false);

  if (!players.length) return null;

  const stakes = players.map((p) => p.entry_fee + (investmentsByTarget[p.user_id] || []).reduce((a, r) => a + r.amount, 0));
  const maxStake = computeMaxStake(stakes);

  const invest = async (targetUserId) => {
    if (!amount || amount <= 0) { showToast?.("Enter an amount to invest."); return; }
    setSubmitting(true);
    const { error } = await supabase.rpc("invest_in_rapid_cup_player", {
      p_lobby_id: lobbyId, p_target_user_id: targetUserId, p_amount: amount,
    });
    setSubmitting(false);
    if (error) { showToast?.(error.message || "Couldn't place that investment."); return; }
    setInvestingFor(null);
    setAmount(20);
    await reload();
  };

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16, marginTop: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Spectator investment</div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
        Back a player with your own Nets — if they win, you share in their bonus. Your stake comes back in full if they don't.
      </div>
      {players.map((p, i) => {
        const invested = investmentsByTarget[p.user_id] || [];
        const investedTotal = invested.reduce((a, r) => a + r.amount, 0);
        const totalStake = stakes[i];
        const { netTotal } = previewTotalStakePayout(stakes, totalStake);
        const isMe = p.user_id === myUserId;

        return (
          <div key={p.user_id} style={{ borderTop: i > 0 ? `1px solid ${c?.border || "#333"}` : "none", paddingTop: i > 0 ? 10 : 0, marginTop: i > 0 ? 10 : 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                {isMe ? "You" : (p.display_name || `Player ${p.user_id.slice(0, 6)}`)}
                {totalStake === maxStake && totalStake > 0 && <span style={{ opacity: 0.6 }}> · highest stake</span>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div>{totalStake} Nets total{investedTotal > 0 ? ` (${p.entry_fee} own + ${investedTotal} backed)` : ""}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>~{netTotal.toFixed(1)} if they win</div>
              </div>
            </div>

            {invested.length > 0 && (
              <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                {invested.map((r) => (
                  <div key={r.investor_user_id} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{r.investor_user_id === myUserId ? "You" : (r.display_name || `Backer ${r.investor_user_id.slice(0, 6)}`)}</span>
                    <span>{r.amount} Nets</span>
                  </div>
                ))}
              </div>
            )}

            {isSpectator && !isMe && (
              investingFor === p.user_id ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                  <input
                    type="number"
                    min={1}
                    value={amount}
                    disabled={submitting}
                    onChange={(e) => setAmount(Number(e.target.value))}
                    style={{ width: 80, padding: "6px 8px", borderRadius: 8 }}
                  />
                  <button onClick={() => setInvestingFor(null)} disabled={submitting} style={{ padding: "6px 10px", borderRadius: 8 }}>Cancel</button>
                  <button onClick={() => invest(p.user_id)} disabled={submitting} style={{ padding: "6px 10px", borderRadius: 8, fontWeight: 600 }}>
                    {submitting ? "Investing…" : `Invest ${amount}`}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => { setInvestingFor(p.user_id); setAmount(20); }}
                  style={{ marginTop: 8, padding: "6px 10px", borderRadius: 8, fontSize: 13 }}
                >
                  Invest in {p.display_name || "this player"}
                </button>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
