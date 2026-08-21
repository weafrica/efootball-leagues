// The "Buy Nets" modal — opened from NetsPanel. Deliberately mirrors
// PaymentModal's layout/flow (App.jsx) since it's the exact same choice a
// player already knows how to make for cash league entry fees: pay by
// card for instant, automatic credit, or pay manually and upload proof
// for an admin to review. Kept as its own small component (not imported
// from App.jsx) so NetsPanel's lazy-loaded chunk doesn't have to pull in
// App.jsx to get it — see paymentConfig.jsx's header comment.

import React, { useState } from "react";
import { Coins, CreditCard, Upload, X } from "lucide-react";
import {
  BANK_DETAILS, MUKURU_DETAILS, IKHOKHA_DETAILS, CardBrandsBadge,
  ENTRY_FEE_MIN, ENTRY_FEE_MAX, ENTRY_FEE_STEP, ENTRY_FEE_PRESETS,
  formatRand, clampFee,
} from "./paymentConfig.jsx";
import { formatNets, netsForRand, netsBonusPct } from "./nets.js";

export default function BuyNetsModal({ onCancel, onSubmit, onPayByCard, c }) {
  const [rand, setRand] = useState(ENTRY_FEE_MIN);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [cardSaving, setCardSaving] = useState(false);
  const inputStyle = { background: c.surfaceHover, borderColor: c.border, color: c.text };
  const netsAmount = netsForRand(rand);
  const bonusPct = netsBonusPct(rand);

  const submit = async () => {
    if (!file || saving) return;
    setSaving(true);
    await onSubmit(rand, file);
    setSaving(false);
  };

  const submitCard = async () => {
    if (cardSaving) return;
    setCardSaving(true);
    await onPayByCard(rand);
    setCardSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Coins size={18} style={{ color: "#D4A017" }} />
            <h2 className="text-xl font-extrabold uppercase tracking-tight">Buy Nets</h2>
          </div>
          <button aria-label="Cancel" onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>
        <div className="font-body text-sm mb-4" style={{ color: c.textDim }}>Top up your balance to enter leagues, spend in the Shop, or bid in the Transfer Market.</div>

        <div className="rounded-lg p-3 mb-3 font-body text-xs" style={{ background: c.surface, color: c.textDim }}>
          {IKHOKHA_DETAILS.payLink && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <CreditCard size={14} style={{ color: c.accent }} />
                <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Pay by card</span>
              </div>
              <button type="button" onClick={submitCard} disabled={cardSaving}
                className="inline-flex items-center gap-1.5 font-body text-xs font-semibold px-3.5 py-2 rounded-full disabled:opacity-60"
                style={{ background: c.accent, color: c.accentText }}>
                <CreditCard size={13} /> {cardSaving ? "Starting checkout…" : "Pay by card"}
              </button>
              <div className="mt-2">
                <CardBrandsBadge />
              </div>
              <div className="font-body text-[10px] mt-1.5 mb-3" style={{ color: c.textFaint }}>
                Opens a secure card checkout page. Nets land in your wallet the moment payment is confirmed — no proof needed.
              </div>
            </>
          )}
          <div className="flex items-center gap-2 mb-2">
            <img src="/capitec-logo.png" alt="Capitec Bank" className="h-4 w-auto object-contain" />
            <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Or via bank transfer</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span style={{ color: c.textFaint }}>Bank</span><span>{BANK_DETAILS.bank}</span>
            <span style={{ color: c.textFaint }}>Account name</span><span>{BANK_DETAILS.accountName}</span>
            <span style={{ color: c.textFaint }}>Account number</span><span className="font-mono">{BANK_DETAILS.accountNumber}</span>
            <span style={{ color: c.textFaint }}>Account type</span><span>{BANK_DETAILS.accountType}</span>
          </div>
          <div className="flex items-center gap-2 mt-3 mb-2">
            <img src="/mukuru-logo.png" alt="Mukuru" className="h-4 w-auto object-contain" />
            <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Or via Mukuru</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span style={{ color: c.textFaint }}>Receiver name</span><span>{MUKURU_DETAILS.receiverName}</span>
            <span style={{ color: c.textFaint }}>Receiver phone</span><span className="font-mono">{MUKURU_DETAILS.receiverPhone}</span>
          </div>
        </div>

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>
          Amount <span style={{ color: c.textFaint }}>({formatRand(ENTRY_FEE_MIN)}–{formatRand(ENTRY_FEE_MAX)})</span>
        </label>
        <div className="flex flex-wrap gap-2 mb-2">
          {ENTRY_FEE_PRESETS.map((amt) => (
            <button key={amt} onClick={() => setRand(amt)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border"
              style={{ borderColor: rand === amt ? c.accent : c.border, background: rand === amt ? c.surfaceHover : "transparent" }}>
              {formatRand(amt)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mb-2">
          <span className="font-mono text-sm" style={{ color: c.textFaint }}>R</span>
          <input type="number" min={ENTRY_FEE_MIN} max={ENTRY_FEE_MAX} step={ENTRY_FEE_STEP} value={rand}
            onChange={(e) => setRand(e.target.value === "" ? "" : Number(e.target.value))}
            onBlur={() => setRand(clampFee(rand))}
            className="w-28 border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
          <span className="font-body text-xs" style={{ color: c.textFaint }}>custom amount</span>
        </div>
        <div className="rounded-lg px-3 py-2 mb-5 flex items-center justify-between" style={{ background: c.surface }}>
          <span className="font-body text-xs" style={{ color: c.textDim }}>You'll receive</span>
          <span className="font-mono text-sm font-bold" style={{ color: "#D4A017" }}>
            {formatNets(netsAmount)}
            {bonusPct > 0 && <span className="font-body text-[10px] font-normal ml-1.5" style={{ color: c.greenText }}>(+{Math.round(bonusPct * 100)}% bonus)</span>}
          </span>
        </div>

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Proof of payment</label>
        <label className="flex items-center gap-2 border border-dashed rounded-lg px-4 py-3 mb-1 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
          <Upload size={15} style={{ color: c.textFaint }} />
          {file ? file.name : "Upload a screenshot or PDF of your payment"}
          <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <div className="font-mono text-[11px] mb-5" style={{ color: c.textFaint }}>
          Only needed for bank transfer / Mukuru. An admin reviews it before your Nets are credited.
        </div>

        <button disabled={!file || saving} onClick={submit} className="w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full"
          style={file && !saving ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {saving ? "Submitting…" : `Submit ${formatRand(clampFee(rand))} for approval`}
        </button>
      </div>
    </div>
  );
}
