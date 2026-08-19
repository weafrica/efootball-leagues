// A small, self-contained "Nets balance" chip — drop it in the header/nav
// next to the user's avatar, same spot most apps put a coin/points balance.
// Handles its own loading + live updates via watchNetsBalance, so it can be
// mounted anywhere without the parent needing to manage balance state.
// Clicking it opens a popout with the full balance + recent transaction
// history (NetsPanel) — that panel is lazy-loaded (see the import below),
// so its code and the history fetch it triggers only ever load for someone
// who actually clicks the chip, not for every visitor who just glances at
// their balance in the header.
//
// Usage:
//   import NetsBadge from "./NetsBadge";
//   <NetsBadge c={c} />

import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import { watchNetsBalance, formatNetsShort } from "./nets";

const NetsPanel = lazy(() => import("./NetsPanel.jsx"));

export default function NetsBadge({ c, className = "" }) {
  const [balance, setBalance] = useState(null); // null = still loading
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    let unsub;
    let cancelled = false;
    watchNetsBalance((b) => { if (!cancelled) setBalance(b); }).then((fn) => { unsub = fn; });
    return () => { cancelled = true; unsub?.(); };
  }, []);

  // Same click-outside-closes pattern as the header's own menu — mousedown
  // AND touchstart, since mousedown alone can fire late (or not at all
  // before the next tap) on touch devices.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("touchstart", onClick);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("touchstart", onClick); };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-sm font-bold ${className}`}
        style={{ background: open ? c.text : c.surfaceHover, color: open ? c.bg : c.text, border: `1px solid ${c.border}` }}
        title="Nets balance"
      >
        <Coins size={14} style={{ color: open ? c.bg : "#D4A017" }} />
        {balance === null ? "…" : formatNetsShort(balance)}
      </button>

      {open && (
        // Fixed to the viewport, not `absolute` relative to this badge's own
        // small wrapper. NetsBadge sits fairly early in the header (right
        // after the logo), nowhere near the header's actual right edge — an
        // `absolute right-0` popout anchored to that narrow wrapper had to
        // extend ~200px further left than the wrapper itself to fit its
        // content, which ran straight off the left edge on a phone-width
        // screen. On a wide desktop layout there was enough margin for that
        // overflow to go unnoticed, which is why this only ever showed up on
        // mobile. Viewport-fixed positioning sidesteps the problem entirely:
        // it no longer matters where the badge sits in the header.
        <div className="fixed top-14 right-3 z-50">
          <Suspense fallback={
            <div className="w-72 max-w-[85vw] rounded-xl border shadow-lg px-4 py-6 text-center font-body text-xs"
              style={{ background: c.bg, borderColor: c.borderStrong, color: c.textFaint }}>
              Loading…
            </div>
          }>
            <NetsPanel c={c} onClose={() => setOpen(false)} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
