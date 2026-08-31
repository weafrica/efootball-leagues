// src/LadderPoolAdminPanel.jsx
//
// Admin-only control for ladder_pool (League Ladder's shared reward/
// escrow balance, 20260855) — shows the current balance, lets an admin
// credit it by a specific amount via admin_topup_ladder_pool (20260904),
// and lists the pool's recent transactions for an audit trail. Deliberately
// manual: there's no auto-refill anywhere in this system, on purpose (see
// league-ladder-redesign-build-spec.md's 20260902/20260903/20260904
// addenda) — an admin decides a specific amount, on purpose, every time,
// with a note recorded against it in ladder_pool_transactions.
//
// ladder_pool is a GLOBAL singleton, not per-league — the balance and
// ledger shown here are identical no matter which league an admin came
// from. Originally this was just an inline card mounted on
// LeagueLadderDetail (any league's own screen an admin happened to be on
// already), which meant it was buried a couple of taps deep behind
// whichever specific league someone opened, and re-fetched from scratch
// every time a different league's screen mounted it. Promoted to its own
// full screen (own `view`, own back button, own history entry) so it's
// one consistent place to reach instead of "wherever I last saw it" —
// LeagueLadderDetail now just links here instead of rendering it inline.

import React, { useEffect, useState, useCallback } from "react";
import { ArrowLeft, PiggyBank, History } from "lucide-react";
import { supabase } from "./supabaseClient";
import { NetsAmount } from "./NetCoinIcon";

// TXN_REASON_LABEL — ladder_pool_transactions.reason values, in the plain
// language an admin skimming the ledger actually wants, not the raw
// snake_case reason string the credit/debit helpers write. Falls back to
// the raw reason itself for anything not listed (new reasons introduced
// elsewhere shouldn't have to touch this file to render at all, just to
// render prettily).
const TXN_REASON_LABEL = {
  ladder_pool_admin_topup: "Admin top-up",
  ladder_entry_fee: "Entry fee",
  ladder_table_fee: "Table fee",
  ladder_bid_commission: "Winning bid commission",
  ladder_match_reward: "Match reward",
  ladder_placement_bonus: "Placement bonus",
  ladder_bid_refund: "Bid refund",
};

export default function LadderPoolAdminPanel({ onBack, showToast, c }) {
  const [balance, setBalance] = useState(null); // null = still loading
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [transactions, setTransactions] = useState(null); // null = still loading
  const [profilesById, setProfilesById] = useState({});

  const load = useCallback(async () => {
    const [{ data: poolRow, error: poolError }, { data: txnRows, error: txnError }] = await Promise.all([
      supabase.from("ladder_pool").select("balance").eq("id", true).maybeSingle(),
      supabase.from("ladder_pool_transactions").select("id, user_id, amount, reason, ref_id, created_at").order("created_at", { ascending: false }).limit(20),
    ]);
    if (poolError) { showToast(poolError.message); }
    setBalance(poolRow?.balance ?? null);
    if (txnError) { showToast(txnError.message); setTransactions([]); return; }
    setTransactions(txnRows || []);

    const userIds = [...new Set((txnRows || []).map((t) => t.user_id).filter(Boolean))];
    if (userIds.length > 0) {
      const { data: profileRows } = await supabase.from("profiles")
        .select("user_id, efootball_username").in("user_id", userIds);
      const map = {};
      (profileRows || []).forEach((p) => { map[p.user_id] = p; });
      setProfilesById(map);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const submitTopup = async () => {
    const parsed = Number(amount);
    if (!amount || !Number.isFinite(parsed) || parsed <= 0) {
      showToast("Enter a positive top-up amount.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc("admin_topup_ladder_pool", {
      p_amount: parsed,
      p_note: note.trim() || null,
    });
    setSubmitting(false);
    if (error) { showToast(error.message); return; }
    setAmount("");
    setNote("");
    await load();
  };

  return (
    <div className="p-4 max-w-2xl mx-auto" style={{ minHeight: "100%", background: c.bg }}>
      <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}>
        <ArrowLeft size={15} /> Back
      </button>

      <div className="flex items-center gap-2 mb-1">
        <PiggyBank size={18} style={{ color: c.accent }} />
        <h1 className="font-body font-bold text-lg" style={{ color: c.text }}>Ladder Pool</h1>
      </div>
      <div className="font-body text-xs mb-5" style={{ color: c.textDim }}>
        League Ladder's shared reward/escrow balance — one pool, shared across every tier.
      </div>

      <div className="rounded-xl border p-4 mb-6" style={{ borderColor: c.border }}>
        <div className="font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: c.textFaint }}>Current balance</div>
        <div className="font-body font-bold text-2xl mb-4" style={{ color: c.text }}>
          {balance === null ? "…" : <NetsAmount amount={balance} size={20} />}
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
          <input
            type="number"
            min="1"
            placeholder="Amount"
            className="flex-1 rounded font-mono text-xs p-2.5"
            style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <input
            type="text"
            placeholder="Note (why)"
            className="flex-[2] rounded font-mono text-xs p-2.5"
            style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            onClick={submitTopup}
            disabled={submitting || !amount}
            className="font-mono text-[10px] uppercase px-4 py-2.5 rounded shrink-0"
            style={{ background: c.accent, color: c.accentText }}
          >
            {submitting ? "…" : "Top Up"}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <History size={14} style={{ color: c.accent }} />
        <span className="font-body font-bold text-sm" style={{ color: c.text }}>Recent activity</span>
      </div>
      <div className="rounded-xl border overflow-hidden" style={{ borderColor: c.border }}>
        {transactions === null ? (
          <div className="p-4 text-center font-mono text-xs" style={{ color: c.textFaint }}>Loading…</div>
        ) : transactions.length === 0 ? (
          <div className="p-4 text-center font-mono text-xs" style={{ color: c.textFaint }}>No pool activity yet.</div>
        ) : (
          <div className="divide-y" style={{ borderColor: c.border }}>
            {transactions.map((t) => {
              const credit = t.amount > 0;
              const who = t.user_id ? (profilesById[t.user_id]?.efootball_username || "Unknown player") : null;
              return (
                <div key={t.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="font-body text-xs font-semibold truncate" style={{ color: c.text }}>
                      {TXN_REASON_LABEL[t.reason] || t.reason}
                    </div>
                    <div className="font-mono text-[10px] truncate" style={{ color: c.textFaint }}>
                      {who ? `${who} · ` : ""}{new Date(t.created_at).toLocaleString()}
                      {t.reason === "ladder_pool_admin_topup" && t.ref_id ? ` · "${t.ref_id}"` : ""}
                    </div>
                  </div>
                  <div className="font-mono text-sm font-bold shrink-0" style={{ color: credit ? c.accent : c.red }}>
                    <NetsAmount amount={t.amount} prefix={credit ? "+" : ""} size={13} />
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
