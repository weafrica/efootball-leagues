import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

// Shared earnings-leaderboard renderer behind both RapidCupHallOfFame
// (Rapid Cup only, used on a completed cup's own page) and
// RapidChampionsBoard (Rapid Cup + Rapid League combined, used in the
// homepage Wall of Fame — see App.jsx's WallOfFameModal). Only the RPC
// name and copy differ; the row markup is identical.
function RapidEarningsBoard({ myUserId, limit, rpc, title, emptyText, c }) {
  const [rows, setRows] = useState(null); // null = loading

  useEffect(() => {
    let cancelled = false;
    supabase.rpc(rpc, { p_limit: limit }).then(({ data, error }) => {
      if (!cancelled) setRows(error ? [] : (data || []));
    });
    return () => { cancelled = true; };
  }, [limit, rpc]);

  if (rows === null) return null;
  if (!rows.length) {
    return (
      <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16, textAlign: "center", opacity: 0.7 }}>
        {emptyText}
      </div>
    );
  }

  const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 12, textAlign: "center" }}>{title}</div>
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

// Rapid Cup — Phase 9: Hall of Fame leaderboard (Section 13, v2/optional).
// All-time top earners, from get_rapid_cup_hall_of_fame() — see
// supabase/migrations/20260905_rapid_cup_hall_of_fame.sql for why it sums
// rapid_cup_collections (actually-claimed Nets) rather than payout rows.
export function RapidCupHallOfFame({ myUserId, limit = 10, c }) {
  return (
    <RapidEarningsBoard myUserId={myUserId} limit={limit} rpc="get_rapid_cup_hall_of_fame"
      title="🏆 Rapid Cup Hall of Fame"
      emptyText="No Rapid Cup earnings collected yet — be the first on the board."
      c={c} />
  );
}

// Combined Rapid Cup + Rapid League earnings board for the homepage Wall
// of Fame (see App.jsx's WallOfFameModal) — from get_rapid_hall_of_fame()
// (20260945_rapid_combined_hall_of_fame.sql), which unions both formats'
// collections tables. Kept as its own section below the main trophy-score
// ranking rather than mixed into it, since Rapid Cup/League winners are
// filtered out of that ranking entirely (see isRapidLeagueTitle in App.jsx).
export function RapidChampionsBoard({ myUserId, limit = 10, c }) {
  return (
    <RapidEarningsBoard myUserId={myUserId} limit={limit} rpc="get_rapid_hall_of_fame"
      title="⚡ Rapid Cup / Rapid League Champions"
      emptyText="No Rapid Cup or Rapid League earnings collected yet — be the first on the board."
      c={c} />
  );
}

