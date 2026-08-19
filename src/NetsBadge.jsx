// A small, self-contained "Nets balance" chip — drop it in the header/nav
// next to the user's avatar, same spot most apps put a coin/points balance.
// Handles its own loading + live updates via watchNetsBalance, so it can be
// mounted anywhere without the parent needing to manage balance state.
//
// Usage:
//   import NetsBadge from "./NetsBadge";
//   <NetsBadge c={c} onClick={() => setScreen("nets-history")} />

import React, { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { watchNetsBalance, formatNetsShort } from "./nets";

export default function NetsBadge({ c, onClick, className = "" }) {
  const [balance, setBalance] = useState(null); // null = still loading

  useEffect(() => {
    let unsub;
    let cancelled = false;
    watchNetsBalance((b) => { if (!cancelled) setBalance(b); }).then((fn) => { unsub = fn; });
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const Wrapper = onClick ? "button" : "div";

  return (
    <Wrapper
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-sm font-bold ${className}`}
      style={{ background: c.surfaceHover, color: c.text, border: `1px solid ${c.border}` }}
      title="Nets balance"
    >
      <Coins size={14} style={{ color: "#D4A017" }} />
      {balance === null ? "…" : formatNetsShort(balance)}
    </Wrapper>
  );
}
