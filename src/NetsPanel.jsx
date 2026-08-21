// The popout that opens when NetsBadge is clicked — shows the current
// balance plus recent transaction history. Pulled into its own file (and
// lazy-loaded from NetsBadge.jsx) rather than being inlined there, the same
// way Shop/Terms/LeagueDetail etc. are split out of App.jsx: this panel's
// list rendering + history fetch has no reason to be in every visitor's
// initial bundle just because the tiny balance chip itself is always on
// screen. Most people will never click it.

import React, { useEffect, useState } from "react";
import { ArrowDownCircle, ArrowUpCircle, Plus, X } from "lucide-react";
import { supabase } from "./supabaseClient";
import { logActivity } from "./activityLog";
import { compressImage } from "./utils/imageCompress";
import { watchNetsBalance, getNetsHistory, formatNets, netsForRand } from "./nets";
import BuyNetsModal from "./BuyNetsModal.jsx";

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
  const [buyOpen, setBuyOpen] = useState(false);
  const [notice, setNotice] = useState(null); // brief inline status message

  useEffect(() => {
    let unsub;
    let cancelled = false;
    watchNetsBalance((b) => { if (!cancelled) setBalance(b); }).then((fn) => { unsub = fn; });
    getNetsHistory(undefined, 20).then((rows) => { if (!cancelled) setHistory(rows); });
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 4000); };

  // Manual (bank transfer / Mukuru) top-up: same proof-upload + admin-review
  // flow as a cash league entry (see joinCashLeague in App.jsx) — upload the
  // proof to the same private payment-proofs bucket, then create a pending
  // nets_purchases row for an admin to approve. Nothing is credited yet.
  const handleBuyNetsSubmit = async (rand, rawFile) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { flash("You need to be signed in to buy Nets."); return; }

    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
    const ext = (file.name.split(".").pop() || "dat").toLowerCase();
    const path = `${session.user.id}/nets-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("payment-proofs").upload(path, file, { cacheControl: "31536000" });
    if (uploadErr) { flash(`Couldn't upload proof of payment: ${uploadErr.message}`); return; }
    logActivity("storage_upload", { bucket: "payment-proofs", purpose: "nets_purchase", bytes: file.size ?? null });

    const { error } = await supabase.from("nets_purchases").insert({
      user_id: session.user.id,
      rand_amount: rand,
      nets_amount: netsForRand(rand),
      payment_status: "pending",
      payment_method: "bank_transfer",
      payment_proof_path: path,
    });
    if (error) { flash(`Couldn't submit: ${error.message}`); return; }

    logActivity("nets_purchase_submitted", { rand_amount: rand, method: "bank_transfer" });
    setBuyOpen(false);
    flash(`Submitted — R${rand} pending admin approval.`);
  };

  // Card top-up: create the pending purchase row first, then ask
  // create-nets-payment for an iKhokha checkout link — its webhook flips
  // this exact row to "approved" and credits the wallet the instant the
  // card payment succeeds, same as a cash league's card entry fee.
  const handleBuyNetsByCard = async (rand) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { flash("You need to be signed in to buy Nets."); return; }

    const { data: purchase, error } = await supabase.from("nets_purchases").insert({
      user_id: session.user.id,
      rand_amount: rand,
      nets_amount: netsForRand(rand),
      payment_status: "pending",
    }).select().single();
    if (error) { flash(`Couldn't start purchase: ${error.message}`); return; }

    const response = await fetch(
      "https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/create-nets-payment",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ purchase_id: purchase.id }),
      }
    );

    const data = await response.json();
    if (!response.ok) { flash(data.error || "Couldn't start card payment. Please try again."); return; }

    logActivity("nets_purchase_submitted", { rand_amount: rand, method: "card" });
    window.location.href = data.paylinkUrl;
  };

  return (
    <div className="w-72 max-w-[85vw] rounded-xl border shadow-lg overflow-hidden" style={{ background: c.bg, borderColor: c.borderStrong }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: c.border }}>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Nets balance</div>
          <div className="font-mono text-xl font-bold">{balance === null ? "…" : formatNets(balance)}</div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setBuyOpen(true)}
            className="flex items-center gap-1 font-body text-xs font-semibold px-3 py-1.5 rounded-full"
            style={{ background: c.accent, color: c.accentText }}>
            <Plus size={13} /> Buy Nets
          </button>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}>
            <X size={15} />
          </button>
        </div>
      </div>

      {notice && (
        <div className="px-4 py-2 font-body text-xs border-b" style={{ borderColor: c.border, color: c.textDim, background: c.surface }}>
          {notice}
        </div>
      )}

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
                      {isCredit ? "+" : ""}{formatNets(tx.amount)}
                    </div>
                    <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{formatWhen(tx.created_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {buyOpen && (
        <BuyNetsModal
          c={c}
          onCancel={() => setBuyOpen(false)}
          onSubmit={handleBuyNetsSubmit}
          onPayByCard={handleBuyNetsByCard}
        />
      )}
    </div>
  );
}
