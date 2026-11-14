// Invoices and receipts for shop orders, plus the "business details" the
// admin fills in once (name, address, VAT number...) that go at the top.
//
// The document opens full-screen with a Print / Save as PDF button. While it
// is open a print stylesheet hides the rest of the app, so the printout (or
// the PDF a phone saves) is just the paper.
import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Printer, ChevronUp, ChevronDown } from "lucide-react";
import { supabase } from "./supabaseClient";

const GOLD = "#D4A017";
const money = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Statuses where the order has been paid for, so a receipt makes sense.
export const RECEIPT_STATUSES = ["paid", "packed", "shipped", "delivered", "fulfilled"];
// Statuses with no invoice or receipt (nothing is owed or paid).
export const NO_DOCUMENT_STATUSES = ["rejected", "cancelled", "refunded"];

export const DEFAULT_BUSINESS = {
  name: "We Africa", address: "", phone: "", email: "", website: "weafrica.co.za",
  vat_registered: false, vat_number: "", vat_rate: 15, footer_note: "",
};
export function parseBusiness(raw) {
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
  return { ...DEFAULT_BUSINESS, ...parsed };
}

const METHOD_LABELS = {
  manual_proof: "EFT / bank transfer", ikhokha_link: "Card (iKhokha)", gateway: "Card", whatsapp: "Arranged on WhatsApp",
};
const DELIVERY_NAMES = { collection: "Collection", courier: "Courier delivery", pudo: "Pudo locker", paxi: "PAXI (PEP store)" };

// One shape for every place an order can come from (the shopper's own orders,
// the admin list, and the guest tracking lookup).
export function normalizeOrder(o, paidAt = null) {
  const items = (o.shop_order_items || o.items || []).map((it) => ({
    name: it.product_name, qty: Number(it.qty), unit: Number(it.unit_price),
  }));
  return {
    number: o.order_number,
    createdAt: o.created_at,
    status: o.status,
    method: o.checkout_method,
    buyerName: o.buyer_username || o.buyer_name || "",
    buyerPhone: o.contact_phone || "",
    buyerEmail: o.buyer_email || "",
    items,
    subtotal: Number(o.subtotal || 0),
    discount: Number(o.discount_amount || 0),
    discountCode: o.discount_code || "",
    deliveryFee: Number(o.delivery_fee || 0),
    deliveryMethod: o.delivery_method || null,
    deliveryAddress: o.delivery_address || null,
    deliveryPoint: o.delivery_point || "",
    paidAt,
  };
}

// When the order was marked paid (from its status history), for receipts.
export async function fetchPaidAt(orderId) {
  try {
    const { data } = await supabase.from("shop_order_status_history").select("created_at")
      .eq("order_id", orderId).eq("to_status", "paid").order("created_at", { ascending: true }).limit(1);
    return data?.[0]?.created_at || null;
  } catch { return null; }
}
export function paidAtFromHistory(history) {
  return (history || []).find((h) => h.status === "paid")?.at || null;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }) : "");

export function OrderDocument({ order, kind, business, eftDetails, onClose }) {
  const b = business || DEFAULT_BUSINESS;
  const o = order;
  const isReceipt = kind === "receipt";
  const paid = RECEIPT_STATUSES.includes(o.status);
  const total = Math.max(0, o.subtotal - o.discount) + o.deliveryFee;
  const rate = Number(b.vat_rate) || 15;
  const vatIncluded = b.vat_registered ? (total * rate) / (100 + rate) : 0;
  const title = isReceipt ? "Payment receipt" : (b.vat_registered ? "Tax invoice" : "Invoice");
  const docNumber = `${isReceipt ? "REC" : "INV"}-${String(o.number || "").replace(/^WA-/, "")}`;
  const addr = o.deliveryAddress || {};
  const addrLine = [addr.street, addr.suburb, addr.city, addr.province, addr.postal_code].filter(Boolean).join(", ");

  useEffect(() => {
    const prevTitle = document.title;
    document.title = `${title} ${docNumber}`; // becomes the saved PDF's file name
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.title = prevTitle; window.removeEventListener("keydown", onKey); };
  }, [title, docNumber, onClose]);

  const cell = { padding: "8px 6px", borderBottom: "1px solid #e5e5e5", fontSize: 13 };

  return createPortal(
    <div id="order-doc-portal" className="fixed inset-0 z-[80] overflow-y-auto" style={{ background: "rgba(0,0,0,0.7)" }}>
      <style>{`
        @media print {
          body > *:not(#order-doc-portal) { display: none !important; }
          #order-doc-portal { position: static !important; background: #fff !important; overflow: visible !important; }
          #order-doc-portal .no-print { display: none !important; }
          #order-doc-paper { box-shadow: none !important; margin: 0 !important; max-width: none !important; padding: 0 !important; }
          @page { size: A4; margin: 14mm; }
        }
      `}</style>
      <div className="no-print sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-2.5" style={{ background: "#111", color: "#fff" }}>
        <span className="font-body text-sm font-semibold truncate">{title} {docNumber}</span>
        <span className="flex items-center gap-2 shrink-0">
          <button onClick={() => window.print()} className="font-body text-xs font-semibold px-3.5 py-2 rounded-full flex items-center gap-1.5" style={{ background: GOLD, color: "#1a1200" }}>
            <Printer size={13} /> Print / Save as PDF
          </button>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "#333" }}><X size={15} /></button>
        </span>
      </div>

      <div id="order-doc-paper" data-testid="order-doc" className="mx-auto my-4 bg-white shadow-xl"
        style={{ maxWidth: 760, padding: "28px 26px", color: "#111", fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{b.name}</div>
            {b.address && <div style={{ fontSize: 12, whiteSpace: "pre-line", color: "#444", marginTop: 2 }}>{b.address}</div>}
            <div style={{ fontSize: 12, color: "#444", marginTop: 2 }}>
              {[b.phone, b.email, b.website].filter(Boolean).join(" · ")}
            </div>
            {b.vat_registered && b.vat_number && <div style={{ fontSize: 12, color: "#444", marginTop: 2 }}>VAT no: {b.vat_number}</div>}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#8a6a00" }}>{title}</div>
            <div style={{ fontSize: 13, marginTop: 4 }}><b>{docNumber}</b></div>
            <div style={{ fontSize: 12, color: "#444" }}>Order {o.number}</div>
            <div style={{ fontSize: 12, color: "#444" }}>
              {isReceipt ? `Date paid: ${fmtDate(o.paidAt || o.createdAt)}` : `Date: ${fmtDate(o.createdAt)}`}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginTop: 22 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#777", marginBottom: 3 }}>Billed to</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{o.buyerName || "Customer"}</div>
            {o.buyerPhone && <div style={{ fontSize: 12, color: "#444" }}>{o.buyerPhone}</div>}
            {o.buyerEmail && <div style={{ fontSize: 12, color: "#444" }}>{o.buyerEmail}</div>}
          </div>
          {o.deliveryMethod && (
            <div style={{ maxWidth: 300 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "#777", marginBottom: 3 }}>Delivery</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{DELIVERY_NAMES[o.deliveryMethod] || o.deliveryMethod}</div>
              {(addrLine || o.deliveryPoint) && <div style={{ fontSize: 12, color: "#444" }}>{addrLine || o.deliveryPoint}</div>}
            </div>
          )}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 22 }}>
          <thead>
            <tr style={{ background: "#f3f0e6" }}>
              <th style={{ ...cell, textAlign: "left", fontSize: 11, textTransform: "uppercase" }}>Description</th>
              <th style={{ ...cell, textAlign: "right", fontSize: 11, textTransform: "uppercase" }}>Qty</th>
              <th style={{ ...cell, textAlign: "right", fontSize: 11, textTransform: "uppercase" }}>Unit price</th>
              <th style={{ ...cell, textAlign: "right", fontSize: 11, textTransform: "uppercase" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {o.items.map((it, i) => (
              <tr key={i}>
                <td style={cell}>{it.name}</td>
                <td style={{ ...cell, textAlign: "right" }}>{it.qty}</td>
                <td style={{ ...cell, textAlign: "right" }}>{money(it.unit)}</td>
                <td style={{ ...cell, textAlign: "right" }}>{money(it.qty * it.unit)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginLeft: "auto", width: 280, marginTop: 14, fontSize: 13 }}>
          <Row label="Subtotal" value={money(o.subtotal)} />
          {o.discount > 0 && <Row label={`Discount${o.discountCode ? ` (${o.discountCode})` : ""}`} value={`-${money(o.discount)}`} />}
          {o.deliveryFee > 0 && <Row label="Delivery" value={money(o.deliveryFee)} />}
          {o.deliveryMethod && o.deliveryFee === 0 && <Row label="Delivery" value="Free" />}
          <Row label="Total" value={money(total)} bold border />
          {b.vat_registered && <Row label={`Includes VAT @ ${rate}%`} value={money(vatIncluded)} muted />}
          {paid ? <Row label="Paid" value={money(total)} bold /> : <Row label="Amount due" value={money(total)} bold />}
        </div>

        <div style={{ marginTop: 24, fontSize: 12, color: "#333" }}>
          <div><b>Payment method:</b> {METHOD_LABELS[o.method] || o.method}</div>
          {paid ? (
            <div style={{ marginTop: 10, display: "inline-block", border: "2px solid #1f7a45", color: "#1f7a45", fontWeight: 800, letterSpacing: 2, padding: "4px 14px", borderRadius: 6, transform: "rotate(-4deg)" }}>PAID</div>
          ) : (
            eftDetails && o.method !== "whatsapp" && (
              <div style={{ marginTop: 10, padding: "10px 12px", background: "#f7f7f4", borderRadius: 8 }}>
                <div style={{ fontWeight: 700, marginBottom: 3 }}>How to pay</div>
                <div style={{ whiteSpace: "pre-line" }}>{eftDetails.replace(/Reference:.*$/im, `Reference: ${o.number}`)}</div>
              </div>
            )
          )}
        </div>

        <div style={{ marginTop: 28, paddingTop: 12, borderTop: "1px solid #e5e5e5", fontSize: 11, color: "#666" }}>
          Thank you for shopping with {b.name}.{b.footer_note ? ` ${b.footer_note}` : ""}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ label, value, bold, border, muted }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontWeight: bold ? 700 : 400, color: muted ? "#666" : "#111", borderTop: border ? "1px solid #ccc" : "none", marginTop: border ? 4 : 0 }}>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

// Admin: the details printed at the top of every invoice and receipt.
export function BusinessDetailsPanel({ business, onSaved, showToast, c }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(business);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(business); }, [business]);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const inputCls = "w-full border rounded-lg px-3 py-2 font-body text-sm outline-none";
  const inputStyle = { background: c.bg, borderColor: c.border, color: c.text };

  const save = async () => {
    setSaving(true);
    const value = JSON.stringify({ ...draft, vat_rate: Number(draft.vat_rate) || 15 });
    const { error } = await supabase.from("shop_settings").upsert({ key: "business_details", value, updated_at: new Date().toISOString() });
    setSaving(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    showToast("Business details saved.");
    onSaved && onSaved();
  };

  return (
    <div className="rounded-xl border mb-4" style={{ background: c.surface, borderColor: c.border }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2.5 font-body text-sm font-semibold" aria-expanded={open}>
        <span>Business details on invoices and receipts</span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2.5" data-testid="business-panel">
          {[["name", "Business name"], ["phone", "Phone"], ["email", "Email"], ["website", "Website"]].map(([k, label]) => (
            <div key={k}>
              <label className="font-body text-xs font-semibold block mb-1" style={{ color: c.textDim }}>{label}</label>
              <input value={draft[k] || ""} onChange={(e) => set({ [k]: e.target.value })} className={inputCls} style={inputStyle} />
            </div>
          ))}
          <div>
            <label className="font-body text-xs font-semibold block mb-1" style={{ color: c.textDim }}>Address</label>
            <textarea value={draft.address || ""} onChange={(e) => set({ address: e.target.value })} rows={3} className={`${inputCls} resize-none`} style={inputStyle} />
          </div>
          <label className="flex items-center gap-2 cursor-pointer font-body text-sm">
            <input type="checkbox" checked={!!draft.vat_registered} onChange={(e) => set({ vat_registered: e.target.checked })} /> We are VAT registered
          </label>
          {draft.vat_registered && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="font-body text-xs font-semibold block mb-1" style={{ color: c.textDim }}>VAT number</label>
                <input value={draft.vat_number || ""} onChange={(e) => set({ vat_number: e.target.value })} className={inputCls} style={inputStyle} />
              </div>
              <div>
                <label className="font-body text-xs font-semibold block mb-1" style={{ color: c.textDim }}>VAT rate (%)</label>
                <input type="number" min="0" step="0.5" value={draft.vat_rate} onChange={(e) => set({ vat_rate: e.target.value })} className={inputCls} style={inputStyle} />
              </div>
              <p className="col-span-2 font-body text-xs" style={{ color: c.textFaint }}>Shop prices are treated as VAT-inclusive. Documents become “Tax invoice” and show the VAT included.</p>
            </div>
          )}
          <div>
            <label className="font-body text-xs font-semibold block mb-1" style={{ color: c.textDim }}>Note at the bottom (optional)</label>
            <input value={draft.footer_note || ""} onChange={(e) => set({ footer_note: e.target.value })} placeholder="e.g. Goods remain our property until paid in full." className={inputCls} style={inputStyle} />
          </div>
          <button onClick={save} disabled={saving} className="font-body text-xs font-semibold px-4 py-2 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving..." : "Save business details"}
          </button>
        </div>
      )}
    </div>
  );
}
