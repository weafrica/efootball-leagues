import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Rapid Cup — Phase 9: Hall of Fame leaderboard (Section 13, v2/optional).
// All-time top earners, from get_rapid_cup_hall_of_fame() — see
// supabase/migrations/20260905_rapid_cup_hall_of_fame.sql for why it sums
// rapid_cup_collections (actually-claimed Nets) rather than payout rows.
export function RapidCupHallOfFame({ myUserId, limit = 10, c }) {
  const [rows, setRows] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    supabase.rpc("get_rapid_cup_hall_of_fame", { p_limit: limit }).then(({ data, error }) => {
      if (!cancelled) setRows(error ? [] : (data || []));
    });
    return () => { cancelled = true; };
  }, [limit]);

  if (rows === null) return null;
  if (!rows.length) {
    return (
      <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16, textAlign: "center", opacity: 0.7 }}>
        No Rapid Cup earnings collected yet — be the first on the board.
      </div>
    );
  }

  const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 12, textAlign: "center" }}>🏆 Rapid Cup Hall of Fame</div>
      {rows.map((r, i) => (
        <div
          key={r.user_id}
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 4px",
            borderTop: i > 0 ? `1px solid ${c?.border || "#333"}` : "none",
            fontWeight: r.user_id === myUserId ? 700 : 400,
          }}
        >
          <span>{medal(i)} {r.user_id === myUserId ? "You" : (r.display_name || `Player ${r.user_id.slice(0, 6)}`)}</span>
          <span>{r.total_earned} Nets</span>
        </div>
      ))}
    </div>
  );
}
