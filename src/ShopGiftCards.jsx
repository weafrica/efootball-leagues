// Admin screen for gift cards: issue a card with a rand balance, copy its
// code (or send it on WhatsApp), and pause or turn a card back on.
// Shoppers can't see this. Checkout redemption comes in the next step.
import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { Gift, Copy, MessageCircle } from "lucide-react";

const GOLD = "#D4A017";
const money = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const inputCls = "w-full border rounded-lg px-3 py-2 font-body text-sm outline-none";

export function giftCardMessage(card) {
  return `Hi! Here is your WeAfrica Shop gift card.\nCode: ${card.code}\nValue: ${money(card.balance ?? card.initial_amount)}\nEnter the code at checkout on weafrica.co.za/shop to use it.`;
}

export function GiftCardsPanel({ showToast, c }) {
  const [rows, setRows] = useState(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [saving, setSaving] = useState(false);
  const [justMade, setJustMade] = useState(null);
  const st = { background: c.surface, borderColor: c.border, color: c.text };

  const load = useCallback(async () => {
    const { data } = await supabase.from("shop_gift_cards").select("id, code, initial_amount, balance, note, expires_at, active, created_at").order("created_at", { ascending: false }).limit(200);
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const copy = async (text, done) => {
    try { await navigator.clipboard.writeText(text); showToast(done); } catch { showToast("Couldn't copy. Select the text and copy it."); }
  };

  const issue = async () => {
    const value = Number(amount);
    if (!(value >= 1) || value > 50000) return showToast("Enter an amount from R1 to R50 000.");
    setSaving(true);
    const { data, error } = await supabase.rpc("admin_issue_gift_card", { p_amount: value, p_note: note.trim() || null, p_expires: expires || null });
    setSaving(false);
    if (error) return showToast(error.message);
    setJustMade(data); setAmount(""); setNote(""); setExpires(""); load();
  };
  const toggle = async (r) => {
    const { error } = await supabase.rpc("admin_set_gift_card_active", { p_id: r.id, p_active: !r.active });
    if (error) return showToast(error.message);
    load();
  };

  return (
    <div className="rounded-xl p-4 mt-4" style={{ background: c.card || c.surface, border: `1px solid ${c.border}` }} data-testid="giftcard-panel">
      <div className="font-extrabold uppercase tracking-tight text-base mb-1 flex items-center gap-2"><Gift size={16} style={{ color: GOLD }} /> Gift cards</div>
      <p className="font-body text-xs mb-3" style={{ color: c.textDim }}>Issue a card once the customer has paid you, then send them the code. The balance is kept on the server.</p>
      <div className="grid grid-cols-2 gap-2">
        <input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (rand)" aria-label="Gift card amount" data-testid="giftcard-amount" className={inputCls} style={st} />
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} aria-label="Gift card expiry date" className={inputCls} style={st} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note, e.g. who it is for (optional)" aria-label="Gift card note" maxLength={120} className={`${inputCls} col-span-2`} style={st} />
      </div>
      <button onClick={issue} disabled={saving} data-testid="giftcard-issue" className="w-full mt-3 font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>
        {saving ? "Issuing…" : "Issue gift card"}
      </button>

      {justMade && (
        <div className="mt-3 rounded-lg p-3 font-body text-sm" style={{ background: c.surface, border: `1px solid ${GOLD}` }} data-testid="giftcard-new">
          <div style={{ color: c.textDim }} className="text-xs">New gift card</div>
          <div className="font-mono font-bold text-lg select-all">{justMade.code}</div>
          <div className="text-xs" style={{ color: c.textDim }}>{money(justMade.balance)}</div>
          <div className="flex gap-2 mt-2">
            <button onClick={() => copy(justMade.code, "Code copied.")} className="flex items-center gap-1.5 text-xs font-semibold underline"><Copy size={13} /> Copy code</button>
            <a href={`https://wa.me/?text=${encodeURIComponent(giftCardMessage(justMade))}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs font-semibold underline"><MessageCircle size={13} /> Send on WhatsApp</a>
          </div>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {rows === null && <div className="font-body text-xs" style={{ color: c.textDim }}>Loading…</div>}
        {rows && rows.length === 0 && <div className="font-body text-xs" style={{ color: c.textDim }}>No gift cards yet.</div>}
        {(rows || []).map((r) => {
          const expired = r.expires_at && new Date(r.expires_at) < new Date();
          return (
            <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 font-body text-xs" style={{ background: c.surface, opacity: r.active && !expired ? 1 : 0.55 }}>
              <div className="min-w-0">
                <div className="font-mono font-bold text-sm">{r.code}</div>
                <div style={{ color: c.textDim }}>
                  {money(r.balance)} left of {money(r.initial_amount)}
                  {r.expires_at ? ` · ${expired ? "expired" : "until"} ${new Date(r.expires_at).toLocaleDateString("en-ZA")}` : ""}
                  {!r.active ? " · paused" : ""}
                </div>
                {r.note && <div className="truncate" style={{ color: c.textFaint }}>{r.note}</div>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button onClick={() => copy(r.code, "Code copied.")} aria-label={`Copy ${r.code}`}><Copy size={14} /></button>
                <button onClick={() => toggle(r)} className="underline">{r.active ? "Pause" : "Turn on"}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "Have a gift card?" in checkout. Calls onChange({code, balance}) or null.
// The server checks the card again when the order is placed.
export function GiftCardBox({ applied, onChange, c }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const apply = async () => {
    const t = code.trim();
    if (!t) return;
    setBusy(true); setMsg("");
    const { data, error } = await supabase.rpc("shop_check_gift_card", { p_code: t });
    setBusy(false);
    if (error) return setMsg("Couldn't check that card. Try again.");
    if (!data?.valid) return setMsg(data?.message || "That gift card isn't valid.");
    onChange({ code: data.code, balance: Number(data.balance) });
    setCode("");
  };
  if (applied) {
    return (
      <div className="flex items-center justify-between mb-3 rounded-lg px-3 py-2 font-body text-sm" style={{ background: c.surface, border: `1px solid ${c.border}` }} data-testid="giftcard-applied">
        <span><Gift size={14} className="inline mr-1.5" style={{ color: GOLD }} />Gift card <span className="font-mono font-bold">{applied.code}</span> ({money(applied.balance)} available)</span>
        <button onClick={() => onChange(null)} className="underline text-xs">Remove</button>
      </div>
    );
  }
  return (
    <div className="mb-3">
      <div className="flex gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && apply()} placeholder="Gift card code" aria-label="Gift card code" data-testid="giftcard-code"
          className="flex-1 border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button onClick={apply} disabled={busy || !code.trim()} className="font-body text-sm font-semibold px-4 rounded-lg" style={{ background: GOLD, color: "#1a1200", opacity: busy || !code.trim() ? 0.6 : 1 }}>{busy ? "…" : "Apply"}</button>
      </div>
      {msg && <div className="font-body text-xs mt-1.5" style={{ color: c.red || "#e5484d" }} data-testid="giftcard-msg">{msg}</div>}
    </div>
  );
}
