// Returns & refunds: the shopper's "Request a return" form and status line,
// and the admin's approve / reject / refund controls. The rules live in the
// database (request_shop_return, admin_resolve_shop_return); a refund marks
// the order Refunded, which puts the stock and any discount use back.
import React, { useState } from "react";
import { RotateCcw } from "lucide-react";
import { supabase } from "./supabaseClient";

const GOLD = "#D4A017";
export const RETURNABLE_STATUSES = ["shipped", "delivered", "fulfilled"];
const LABELS = { requested: "Return requested", approved: "Return approved", rejected: "Return declined", refunded: "Refunded" };

export const latestReturn = (list) => (list || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
export const returnIsOpen = (r) => !!r && (r.status === "requested" || r.status === "approved");

export function ReturnStatus({ ret, c }) {
  if (!ret) return null;
  const tone = ret.status === "refunded" || ret.status === "approved" ? { background: c.greenSoft, color: c.greenText } : ret.status === "rejected" ? { background: c.redSoft, color: c.red } : { background: c.surfaceHover, color: c.text };
  return (
    <div className="rounded-lg px-3 py-2 mt-3 font-body text-xs" style={tone} data-testid="return-status">
      <div className="font-semibold">{LABELS[ret.status] || ret.status}</div>
      <div className="mt-0.5" style={{ opacity: 0.85 }}>Your reason: {ret.reason}</div>
      {ret.admin_note && <div className="mt-0.5">Shop: {ret.admin_note}</div>}
    </div>
  );
}

// Shown on delivered / shipped orders that don't have an open return.
export function RequestReturn({ orderNumber, contact, onDone, c }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const send = async () => {
    setBusy(true); setErr("");
    const { error } = await supabase.rpc("request_shop_return", { p_order_number: orderNumber, p_contact: contact || "", p_reason: reason });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setOpen(false); setReason(""); onDone && onDone();
  };
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-3 font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.surfaceHover, color: c.text }} data-testid="return-open">
        <RotateCcw size={12} /> Request a return
      </button>
    );
  }
  return (
    <div className="mt-3" data-testid="return-form">
      <label className="font-body text-xs font-semibold block mb-1" style={{ color: c.textDim }}>What's wrong with your order?</label>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder="e.g. The hoodie arrived with a torn seam"
        className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none resize-none" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
      {err && <div className="font-body text-xs mt-1" style={{ color: c.red }}>{err}</div>}
      <div className="flex gap-2 mt-2">
        <button onClick={send} disabled={busy || reason.trim().length < 5} className="font-body text-xs font-semibold px-4 py-2 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: busy || reason.trim().length < 5 ? 0.6 : 1 }}>{busy ? "Sending…" : "Send request"}</button>
        <button onClick={() => { setOpen(false); setErr(""); }} className="font-body text-xs font-semibold px-4 py-2 rounded-full" style={{ background: c.surface, color: c.textDim }}>Cancel</button>
      </div>
    </div>
  );
}

// Admin controls on an order card.
export function ReturnAdminPanel({ ret, onChanged, showToast, c }) {
  const [note, setNote] = useState(ret.admin_note || "");
  const [busy, setBusy] = useState(false);
  const [confirmRefund, setConfirmRefund] = useState(false);
  if (!ret) return null;
  const open = returnIsOpen(ret);
  const act = async (action) => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_resolve_shop_return", { p_return_id: ret.id, p_action: action, p_note: note || null });
    setBusy(false); setConfirmRefund(false);
    if (error) { showToast(error.message); return; }
    showToast(action === "refund" ? "Refunded. Stock has been put back." : action === "approve" ? "Return approved." : "Return declined.");
    onChanged && onChanged(action);
  };
  const btn = { background: c.surfaceHover, color: c.text };
  return (
    <div className="rounded-lg p-2.5 mt-2.5 font-body text-xs" style={{ background: c.bg, border: `1px solid ${open ? GOLD : c.border}` }} data-testid="return-admin">
      <div className="font-semibold mb-0.5">{LABELS[ret.status] || ret.status}</div>
      <div style={{ color: c.textDim }}>"{ret.reason}"</div>
      {open && (
        <>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the customer (optional)" aria-label="Note to customer"
            className="w-full border rounded-lg px-2.5 py-1.5 mt-2 text-xs outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {ret.status === "requested" && <button disabled={busy} onClick={() => act("approve")} className="font-semibold px-3 py-1.5 rounded-full" style={{ background: c.greenSoft, color: c.greenText }}>Approve</button>}
            <button disabled={busy} onClick={() => (confirmRefund ? act("refund") : setConfirmRefund(true))} className="font-semibold px-3 py-1.5 rounded-full" style={{ background: confirmRefund ? GOLD : c.greenSoft, color: confirmRefund ? "#1a1200" : c.greenText }}>
              {confirmRefund ? "Tap again: refund + restock" : "Refund"}
            </button>
            <button disabled={busy} onClick={() => act("reject")} className="font-semibold px-3 py-1.5 rounded-full" style={{ background: c.redSoft, color: c.red }}>Decline</button>
          </div>
          <div className="mt-1.5" style={{ color: c.textFaint }}>Refund marks the order Refunded and puts all its items back in stock. Send the money back yourself.</div>
        </>
      )}
      {!open && ret.admin_note && <div className="mt-1" style={{ color: c.textDim }}>Note: {ret.admin_note}</div>}
    </div>
  );
}
