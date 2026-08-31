// The popout that opens when NetsBadge is clicked — shows the current
// balance plus recent transaction history. Pulled into its own file (and
// lazy-loaded from NetsBadge.jsx) rather than being inlined there, the same
// way Shop/Terms/LeagueDetail etc. are split out of App.jsx: this panel's
// list rendering + history fetch has no reason to be in every visitor's
// initial bundle just because the tiny balance chip itself is always on
// screen. Most people will never click it.

import React, { useEffect, useState } from "react";
import { ArrowDownCircle, ArrowUpCircle, X } from "lucide-react";
import { watchNetsBalance, getNetsHistory } from "./nets";
import { NetsAmount } from "./NetCoinIcon";

// Turns a stable reason code into something readable — falls back to a
// generic title-cased version of the code itself for any reason this
// mapping doesn't know about yet, so new reasons never render as raw
// snake_case.
const REASON_LABELS = {
  admin_grant: "Admin grant",
  shop_purchase: "Shop purchase",
  shop_purchase_refund: "Refund",
  topup: "Top-up",
};
function reasonLabel(reason) {
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  return (reason || "Transaction").replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatWhen(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
}

export default function NetsPanel({ onClose, c }) {
  const [balance, setBalance] = useState(null);
  const [history, setHistory] = useState(null); // null = loading

  useEffect(() => {
    let unsub;
    let cancelled = false;
    watchNetsBalance((b) => { if (!cancelled) setBalance(b); }).then((fn) => { unsub = fn; });
    getNetsHistory(undefined, 20).then((rows) => { if (!cancelled) setHistory(rows); });
    return () => { cancelled = true; unsub?.(); };
  }, []);

  return (
    <div className="w-72 max-w-[85vw] rounded-xl border shadow-lg overflow-hidden" style={{ background: c.bg, borderColor: c.borderStrong }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: c.border }}>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Nets balance</div>
          <div className="font-mono text-xl font-bold">{balance === null ? "…" : <NetsAmount amount={balance} size={17} />}</div>
        </div>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}>
          <X size={15} />
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto">
        {history === null ? (
          <div className="px-4 py-6 text-center font-body text-xs" style={{ color: c.textFaint }}>Loading history...</div>
        ) : history.length === 0 ? (
          <div className="px-4 py-6 text-center font-body text-xs" style={{ color: c.textFaint }}>No Nets activity yet.</div>
        ) : (
          <div className="divide-y" style={{ borderColor: c.border }}>
            {history.map((tx) => {
              const isCredit = tx.amount > 0;
              return (
                <div key={tx.id} className="flex items-center gap-2.5 px-4 py-2.5">
                  {isCredit
                    ? <ArrowUpCircle size={16} style={{ color: c.greenText }} className="shrink-0" />
                    : <ArrowDownCircle size={16} style={{ color: c.red }} className="shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="font-body text-xs font-semibold truncate">{reasonLabel(tx.reason)}</div>
                    {tx.note && <div className="font-mono text-[10px] truncate" style={{ color: c.textFaint }}>{tx.note}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-xs font-bold" style={{ color: isCredit ? c.greenText : c.red }}>
                      <NetsAmount amount={tx.amount} prefix={isCredit ? "+" : ""} size={12} />
                    </div>
                    <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{formatWhen(tx.created_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
