// "Message customer": ready-to-send WhatsApp / email wording for each order
// status. The admin taps Message on an order, checks or edits the text, and
// sends it from their own WhatsApp or email app. (Nothing is sent
// automatically.) The wording per status is editable and saved under the
// shop_settings key "shop_message_templates".
import React, { useState, useEffect } from "react";
import { X, MessageCircle, Mail, Copy, ChevronUp, ChevronDown, RotateCcw } from "lucide-react";
import { supabase } from "./supabaseClient";

const GOLD = "#D4A017";

export const MESSAGE_STATUSES = [
  ["pending_review", "Order received"],
  ["whatsapp_sent", "Order received (WhatsApp)"],
  ["paid", "Payment confirmed"],
  ["packed", "Packed"],
  ["shipped", "Shipped"],
  ["delivered", "Delivered"],
  ["fulfilled", "Completed"],
  ["rejected", "Payment not accepted"],
  ["cancelled", "Cancelled"],
  ["refunded", "Refunded"],
];

export const DEFAULT_TEMPLATES = {
  pending_review: "Hi {name}, thank you for your order {order} ({total}) at {business}. We've received it and will confirm your payment shortly.",
  whatsapp_sent: "Hi {name}, thanks for your order {order} ({total}) at {business}. Let us know how you'd like to pay and we'll get it moving.",
  paid: "Hi {name}, your payment for order {order} ({total}) is confirmed. Thank you! We'll pack it next and let you know when it ships.",
  packed: "Hi {name}, your order {order} is packed and ready. We'll send it off soon.{tracking}",
  shipped: "Hi {name}, your order {order} is on its way!{tracking}",
  delivered: "Hi {name}, your order {order} has been delivered. We hope you love it! If anything isn't right, just reply to this message.",
  fulfilled: "Hi {name}, your order {order} is complete. Thank you for shopping with {business}!",
  rejected: "Hi {name}, we couldn't confirm the payment for order {order}. Please send us your proof of payment again or get in touch and we'll sort it out.",
  cancelled: "Hi {name}, your order {order} has been cancelled. If you didn't ask for this, please contact us.",
  refunded: "Hi {name}, your refund for order {order} ({total}) has been processed. It can take a few days to reach your account.",
};

export function parseTemplates(raw) {
  let p = {};
  try { p = raw ? JSON.parse(raw) : {}; } catch { p = {}; }
  const out = {};
  MESSAGE_STATUSES.forEach(([k]) => { out[k] = typeof p[k] === "string" && p[k].trim() ? p[k] : ""; });
  return out; // "" = use the default
}

const rand = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function renderMessage(template, order, business) {
  const total = Number(order.subtotal || 0) - Number(order.discount_amount || 0) + Number(order.delivery_fee || 0) - Number(order.gift_card_amount || 0);
  const tracking = order.tracking_number
    ? `\n${order.courier_name ? `${order.courier_name} tracking number` : "Tracking number"}: ${order.tracking_number}` : "";
  const first = String(order.buyer_username || "").trim().split(/\s+/)[0] || "there";
  const text = template
    .replace(/\{name\}/g, first)
    .replace(/\{order\}/g, order.order_number || "")
    .replace(/\{total\}/g, rand(total))
    .replace(/\{business\}/g, business?.name || "WeAfrica Shop")
    .replace(/\{tracking\}/g, tracking);
  return text.replace(/[ \t]+\n/g, "\n").trim();
}

// WhatsApp wants digits with the country code. A leading 0 is taken as South Africa.
export function whatsappNumber(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length < 7) return "";
  if (String(phone).trim().startsWith("+")) return d;
  if (d.startsWith("00")) return d.slice(2);
  if (d.startsWith("0")) return `27${d.slice(1)}`;
  return d;
}

export function MessageCustomerButton({ order, business, templates, c }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const wa = whatsappNumber(order.contact_phone);
  const email = (order.buyer_email || "").trim();
  if (!wa && !email) return null;

  const start = () => {
    const tpl = (templates && templates[order.status]) || DEFAULT_TEMPLATES[order.status] || DEFAULT_TEMPLATES.pending_review;
    setText(renderMessage(tpl, order, business)); setCopied(false); setOpen(true);
  };
  const subject = `${business?.name || "WeAfrica Shop"} – order ${order.order_number}`;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* ignore */ } };

  return (
    <>
      <button onClick={start} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.surfaceHover, color: c.text }} data-testid="message-btn">
        <MessageCircle size={12} /> Message
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }} onClick={() => setOpen(false)}>
          <div className="w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl p-4" style={{ background: c.bg, color: c.text }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Message customer" data-testid="message-modal">
            <div className="flex items-center justify-between mb-2">
              <div className="font-extrabold uppercase tracking-tight text-base">Message {String(order.buyer_username || "").split(/\s+/)[0] || "customer"} · {order.order_number}</div>
              <button onClick={() => setOpen(false)} aria-label="Close"><X size={18} style={{ color: c.textDim }} /></button>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label="Message text"
              className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none resize-y" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
            <div className="flex flex-wrap gap-2 mt-3">
              {wa && <a href={`https://wa.me/${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" data-testid="wa-link"
                className="font-body text-sm font-semibold px-4 py-2 rounded-full flex items-center gap-1.5" style={{ background: GOLD, color: "#1a1200" }}><MessageCircle size={14} /> WhatsApp</a>}
              {email && <a href={`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`} data-testid="mail-link"
                className="font-body text-sm font-semibold px-4 py-2 rounded-full flex items-center gap-1.5" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}><Mail size={14} /> Email</a>}
              <button onClick={copy} className="font-body text-sm font-semibold px-4 py-2 rounded-full flex items-center gap-1.5" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}><Copy size={14} /> {copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function MessageTemplatesPanel({ templates, onSaved, showToast, c }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(templates);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(templates); }, [templates]);
  const save = async () => {
    setSaving(true);
    const clean = {}; MESSAGE_STATUSES.forEach(([k]) => { if ((draft[k] || "").trim() && draft[k].trim() !== DEFAULT_TEMPLATES[k]) clean[k] = draft[k].trim(); });
    const { error } = await supabase.from("shop_settings").upsert({ key: "shop_message_templates", value: JSON.stringify(clean), updated_at: new Date().toISOString() });
    setSaving(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    showToast("Messages saved."); onSaved && onSaved();
  };
  return (
    <div className="rounded-xl border mt-4" style={{ background: c.surface, borderColor: c.border }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2.5 font-body text-sm font-semibold" aria-expanded={open}>
        <span>Customer messages (wording for each status)</span>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3" data-testid="templates-panel">
          <p className="font-body text-xs" style={{ color: c.textDim }}>Used by the Message button on each order. You can use <b>{"{name}"}</b>, <b>{"{order}"}</b>, <b>{"{total}"}</b>, <b>{"{business}"}</b> and <b>{"{tracking}"}</b> (the courier and tracking number, when there is one).</p>
          {MESSAGE_STATUSES.map(([key, label]) => (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <label className="font-body text-xs font-semibold" style={{ color: c.textDim }}>{label}</label>
                <button onClick={() => setDraft((d) => ({ ...d, [key]: "" }))} className="font-body text-xs underline flex items-center gap-1" style={{ color: GOLD }}><RotateCcw size={11} /> Reset</button>
              </div>
              <textarea value={draft[key] || DEFAULT_TEMPLATES[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} rows={3} aria-label={label}
                className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none resize-y" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
            </div>
          ))}
          <button onClick={save} disabled={saving} className="w-full font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save messages"}</button>
        </div>
      )}
    </div>
  );
}
