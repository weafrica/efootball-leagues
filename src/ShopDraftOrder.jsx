// Staff-created orders ("draft orders"): for a customer who ordered over
// WhatsApp or in person. Uses the same server rules as checkout (stock,
// prices, delivery, discount codes) through admin_create_shop_order.
// The order is created as "awaiting payment" (or paid, if you tick it).
import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";
import { X, Plus, Copy } from "lucide-react";

const GOLD = "#D4A017";
const money = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const inputCls = "w-full border rounded-lg px-3 py-2 font-body text-sm outline-none";

// Pure: the message staff can send the customer once the order exists.
export function draftOrderMessage(result, buyerName) {
  const due = Number(result?.amount_due ?? result?.total ?? 0);
  return `Hi ${buyerName || "there"}! Your WeAfrica Shop order ${result?.order_number} is created. ` +
    `${result?.status === "paid" ? "It is marked as paid." : `Amount to pay: ${money(due)}. Please use ${result?.order_number} as your payment reference and send us the proof of payment.`} ` +
    `You can track it any time at https://weafrica.co.za/shop with your order number.`;
}

export default function DraftOrderModal({ products, onClose, onCreated, showToast, c }) {
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };
  const sellable = useMemo(() => (products || []).filter((p) => p.active && !p.quote_only), [products]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ productId: "", variantId: "", qty: 1 }]);
  const [code, setCode] = useState("");
  const [paid, setPaid] = useState(false);
  const [options, setOptions] = useState([]);
  const [method, setMethod] = useState("");
  const [addr, setAddr] = useState({ street: "", suburb: "", city: "", province: "", postal_code: "" });
  const [point, setPoint] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  const valid = lines.filter((l) => l.productId && Number(l.qty) >= 1);
  const payloadItems = valid.map((l) => ({ product_id: l.productId, variant_id: l.variantId || null, qty: Math.floor(Number(l.qty)) }));
  const itemsKey = JSON.stringify(payloadItems);

  useEffect(() => {
    let cancelled = false;
    if (!payloadItems.length) { setOptions([]); setMethod(""); return undefined; }
    (async () => {
      const { data, error } = await supabase.rpc("shop_delivery_options", { p_items: payloadItems });
      if (cancelled) return;
      const list = !error && Array.isArray(data) ? data : [];
      setOptions(list);
      setMethod((cur) => (list.some((o) => o.method === cur && o.available) ? cur : (list.find((o) => o.available)?.method || "")));
    })();
    return () => { cancelled = true; };
  }, [itemsKey]);

  const productOf = (id) => sellable.find((p) => p.id === id);
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const estimate = valid.reduce((n, l) => {
    const p = productOf(l.productId); if (!p) return n;
    const v = (p.variants || []).find((x) => x.id === l.variantId);
    return n + Number(v?.price ?? p.price) * Math.floor(Number(l.qty));
  }, 0);
  const chosen = options.find((o) => o.method === method && o.available);
  const needsDelivery = options.length > 0;

  const create = async () => {
    if (!name.trim()) { showToast("Enter the customer's name."); return; }
    if (!phone.trim() && !email.trim()) { showToast("Add a phone number or email so they can track the order."); return; }
    if (!payloadItems.length) { showToast("Add at least one product."); return; }
    for (const l of valid) {
      const p = productOf(l.productId);
      if ((p?.variants || []).some((v) => v.active) && !l.variantId) { showToast(`Choose an option for ${p.name}.`); return; }
    }
    if (needsDelivery && !chosen) { showToast("Choose a delivery option."); return; }
    setSaving(true);
    const { data, error } = await supabase.rpc("admin_create_shop_order", {
      p_items: payloadItems, p_buyer_name: name.trim(), p_phone: phone.trim() || null, p_email: email.trim() || null,
      p_note: note.trim() || null,
      p_delivery: needsDelivery ? { method, address: method === "courier" ? addr : null, point: point.trim() || null } : null,
      p_discount_code: code.trim() || null, p_paid: paid,
    });
    setSaving(false);
    if (error) { showToast(error.message); return; }
    setResult(data);
    onCreated && onCreated(data);
  };

  const copyMsg = async () => {
    try { await navigator.clipboard.writeText(draftOrderMessage(result, name.trim())); showToast("Message copied."); } catch { showToast("Couldn't copy. Select the text and copy it."); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-5 max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }} data-testid="draft-order">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-extrabold tracking-tight">New order</h2>
          <button aria-label="Close" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>

        {result ? (
          <div data-testid="draft-done">
            <div className="rounded-xl p-4 mb-3" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
              <div className="font-body text-xs" style={{ color: c.textDim }}>Order created</div>
              <div className="font-mono text-2xl font-bold" style={{ color: GOLD }}>{result.order_number}</div>
              <div className="font-body text-sm mt-1">{result.status === "paid" ? "Marked as paid." : `Awaiting payment: ${money(result.amount_due ?? result.total)}`}</div>
            </div>
            <textarea readOnly value={draftOrderMessage(result, name.trim())} rows={5} className={inputCls} style={inputStyle} />
            <div className="flex gap-2 mt-3">
              <button onClick={copyMsg} className="flex-1 font-body text-sm font-semibold py-2.5 rounded-full flex items-center justify-center gap-1.5" style={{ background: GOLD, color: "#1a1200" }}><Copy size={14} /> Copy message</button>
              <button onClick={onClose} className="font-body text-sm font-semibold px-5 py-2.5 rounded-full" style={{ background: c.surface, color: c.text }}>Done</button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" aria-label="Customer name" className={inputCls} style={inputStyle} />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" aria-label="Customer phone" inputMode="tel" className={inputCls} style={inputStyle} />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" aria-label="Customer email" className={`${inputCls} col-span-2`} style={inputStyle} />
            </div>

            <div>
              <div className="font-body text-xs font-semibold mb-1.5" style={{ color: c.textDim }}>Items</div>
              {lines.map((l, i) => {
                const p = productOf(l.productId); const vs = (p?.variants || []).filter((v) => v.active);
                return (
                  <div key={i} className="flex gap-2 mb-2" data-testid="draft-line">
                    <select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value, variantId: "" })} aria-label="Product" className={`${inputCls} flex-1 min-w-0`} style={inputStyle}>
                      <option value="">Choose a product…</option>
                      {sellable.map((x) => <option key={x.id} value={x.id}>{x.name} · {money(x.price)}</option>)}
                    </select>
                    {vs.length > 0 && (
                      <select value={l.variantId} onChange={(e) => setLine(i, { variantId: e.target.value })} aria-label="Option" className="border rounded-lg px-2 py-2 font-body text-sm" style={inputStyle}>
                        <option value="">Option…</option>
                        {vs.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                    )}
                    <input type="number" min="1" max="99" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="Quantity" className="w-16 border rounded-lg px-2 py-2 font-body text-sm" style={inputStyle} />
                    {lines.length > 1 && <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="font-body text-xs px-1" style={{ color: c.red }}>Remove</button>}
                  </div>
                );
              })}
              <button type="button" onClick={() => setLines((ls) => [...ls, { productId: "", variantId: "", qty: 1 }])} data-testid="draft-add-line"
                className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1" style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}><Plus size={12} /> Add another product</button>
            </div>

            {needsDelivery && (
              <div data-testid="draft-delivery">
                <div className="font-body text-xs font-semibold mb-1.5" style={{ color: c.textDim }}>Delivery</div>
                {options.map((o) => (
                  <label key={o.method} className="flex items-center gap-2 font-body text-sm mb-1" style={{ opacity: o.available ? 1 : 0.45 }}>
                    <input type="radio" name="draft-delivery" checked={method === o.method} disabled={!o.available} onChange={() => setMethod(o.method)} />
                    <span className="flex-1">{o.label}</span>
                    <span className="font-mono text-xs">{o.available ? (Number(o.fee) > 0 ? money(o.fee) : "Free") : ""}</span>
                  </label>
                ))}
                {method === "courier" && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <input value={addr.street} onChange={(e) => setAddr({ ...addr, street: e.target.value })} placeholder="Street address" aria-label="Street address" className={`${inputCls} col-span-2`} style={inputStyle} />
                    <input value={addr.suburb} onChange={(e) => setAddr({ ...addr, suburb: e.target.value })} placeholder="Suburb" className={inputCls} style={inputStyle} />
                    <input value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} placeholder="City" aria-label="City" className={inputCls} style={inputStyle} />
                    <input value={addr.province} onChange={(e) => setAddr({ ...addr, province: e.target.value })} placeholder="Province" className={inputCls} style={inputStyle} />
                    <input value={addr.postal_code} onChange={(e) => setAddr({ ...addr, postal_code: e.target.value })} placeholder="Postal code" aria-label="Postal code" className={inputCls} style={inputStyle} />
                  </div>
                )}
                {(method === "pudo" || method === "paxi") && (
                  <input value={point} onChange={(e) => setPoint(e.target.value)} placeholder={method === "pudo" ? "Pudo locker" : "PAXI point"} aria-label="Pickup point" className={`${inputCls} mt-2`} style={inputStyle} />
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Discount code (optional)" aria-label="Discount code" className={inputCls} style={inputStyle} />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" aria-label="Order note" className={inputCls} style={inputStyle} />
            </div>
            <label className="font-body text-sm flex items-center gap-2">
              <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} data-testid="draft-paid" /> Already paid (cash or EFT received)
            </label>

            <div className="font-body text-xs" style={{ color: c.textFaint }}>
              Items {money(estimate)}{chosen && Number(chosen.fee) > 0 ? ` + delivery ${money(chosen.fee)}` : ""}. Final total, stock and discount are checked when you create the order.
            </div>
            <button onClick={create} disabled={saving} data-testid="draft-create" className="w-full font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>
              {saving ? "Creating…" : "Create order"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
