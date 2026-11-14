// Shop footer with the business's contact details and policy pages
// (shipping, returns, privacy, terms), the admin editor for those policies,
// and the wishlist ("saved items") helpers.
//
// Policies live in shop_settings under the key "shop_policies" (JSON). A
// policy that is left empty is simply not shown to shoppers.
import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import { X, Heart, ChevronUp, ChevronDown, MessageCircle, Phone, Mail, MapPin } from "lucide-react";
import { supabase } from "./supabaseClient";

const GOLD = "#D4A017";

export const POLICY_KINDS = [
  { key: "shipping", label: "Shipping & delivery" },
  { key: "returns", label: "Returns & refunds" },
  { key: "privacy", label: "Privacy" },
  { key: "terms", label: "Terms of sale" },
];

export function parsePolicies(raw) {
  let p = {};
  try { p = raw ? JSON.parse(raw) : {}; } catch { p = {}; }
  const out = {};
  POLICY_KINDS.forEach(({ key }) => { out[key] = typeof p[key] === "string" ? p[key] : ""; });
  return out;
}

// Plain starting points the admin can edit. Not legal advice: review them.
const STARTERS = {
  shipping: "Orders are packed once payment is confirmed. Delivery times depend on the method you choose at checkout and are estimates, not guarantees. You will receive tracking details when your order ships. Please make sure your address or pick-up point is correct, as we can't redirect a parcel once it's on its way.",
  returns: "If your item arrives damaged or is not what you ordered, contact us within 7 days of receiving it, with your order number and a photo, and we will arrange a replacement or refund. Items must be unused and in their original packaging to be returned. Refunds go back to the original payment method.",
  privacy: "We only collect the details needed to process your order: your name, contact details and delivery address. We use them to confirm, pack and deliver your order and to contact you about it. We do not sell your information. Delivery details are shared with the courier only to deliver your parcel. Contact us any time to have your details removed.",
  terms: "Prices are in rand. An order is confirmed once payment is received. Stock is limited and we may cancel and refund an order if an item turns out to be unavailable. By placing an order you agree to these terms.",
};

// ── Wishlist (saved on this device) ─────────────────────────────────────
const WISH_KEY = "weafrica_shop_wishlist";
const WishlistContext = createContext({ has: () => false, toggle: () => {}, ids: [] });

export function useWishlistState() {
  const [ids, setIds] = useState(() => {
    try { const v = JSON.parse(localStorage.getItem(WISH_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  });
  const save = (next) => { try { localStorage.setItem(WISH_KEY, JSON.stringify(next)); } catch { /* private mode */ } };
  const toggle = useCallback((id) => {
    setIds((cur) => { const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; save(next); return next; });
  }, []);
  const has = useCallback((id) => ids.includes(id), [ids]);
  return { ids, has, toggle };
}
export const WishlistProvider = WishlistContext.Provider;
export const useWishlist = () => useContext(WishlistContext);

export function HeartButton({ productId, name, className = "", size = 16, c }) {
  const { has, toggle } = useWishlist();
  const on = has(productId);
  return (
    <button onClick={(e) => { e.stopPropagation(); toggle(productId); }} aria-pressed={on} aria-label={on ? `Remove ${name} from saved` : `Save ${name}`}
      data-testid="heart" className={`w-8 h-8 rounded-full flex items-center justify-center ${className}`}
      style={{ background: "rgba(0,0,0,0.45)", color: on ? "#ff5a6e" : "#fff" }}>
      <Heart size={size} fill={on ? "#ff5a6e" : "none"} />
    </button>
  );
}

// ── Footer ──────────────────────────────────────────────────────────────
export function ShopFooter({ business, policies, whatsapp, c }) {
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const shown = POLICY_KINDS.filter((k) => (policies[k.key] || "").trim());
  const wa = (whatsapp || "").replace(/\D/g, "");
  const line = { color: c.textDim };

  return (
    <footer className="mt-10 pt-5 border-t font-body text-xs" style={{ borderColor: c.border }} data-testid="shop-footer">
      <div className="font-extrabold uppercase tracking-tight text-sm mb-2" style={{ color: c.text }}>{business.name || "WeAfrica Shop"}</div>
      <div className="space-y-1.5" style={line}>
        {business.address && <div className="flex gap-2"><MapPin size={13} className="mt-0.5 shrink-0" /><span className="whitespace-pre-line">{business.address}</span></div>}
        {business.phone && <div className="flex gap-2 items-center"><Phone size={13} /><a href={`tel:${business.phone.replace(/\s/g, "")}`}>{business.phone}</a></div>}
        {business.email && <div className="flex gap-2 items-center"><Mail size={13} /><a href={`mailto:${business.email}`}>{business.email}</a></div>}
        {wa && <div className="flex gap-2 items-center"><MessageCircle size={13} /><a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">Chat on WhatsApp</a></div>}
      </div>
      {shown.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
          {shown.map((k) => <button key={k.key} onClick={() => setOpen(k)} className="underline" style={{ color: c.text }}>{k.label}</button>)}
        </div>
      )}
      <div className="mt-3" style={{ color: c.textFaint }}>
        {business.vat_registered && business.vat_number ? `VAT no. ${business.vat_number} · ` : ""}Prices in rand.
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }} onClick={() => setOpen(null)}>
          <div className="w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl p-5 max-h-[85vh] overflow-y-auto" style={{ background: c.bg, color: c.text }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={open.label} data-testid="policy-modal">
            <div className="flex items-center justify-between mb-3">
              <div className="font-extrabold uppercase tracking-tight text-lg">{open.label}</div>
              <button onClick={() => setOpen(null)} aria-label="Close"><X size={18} style={{ color: c.textDim }} /></button>
            </div>
            <p className="font-body text-sm whitespace-pre-line leading-relaxed" style={{ color: c.textDim }}>{policies[open.key]}</p>
          </div>
        </div>
      )}
    </footer>
  );
}

// ── Admin editor ────────────────────────────────────────────────────────
export function PoliciesPanel({ policies, onSaved, showToast, c }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(policies);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(policies); }, [policies]);
  const st = { background: c.bg, borderColor: c.border, color: c.text };

  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from("shop_settings").upsert({ key: "shop_policies", value: JSON.stringify(draft), updated_at: new Date().toISOString() });
    setSaving(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    showToast("Policies saved."); onSaved && onSaved();
  };

  return (
    <div className="rounded-xl border mt-4" style={{ background: c.surface, borderColor: c.border }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2.5 font-body text-sm font-semibold" aria-expanded={open}>
        <span>Shop policies (shown in the footer)</span>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3" data-testid="policies-panel">
          <p className="font-body text-xs" style={{ color: c.textDim }}>Leave one empty to hide it. The starter text is only a starting point: read it, change it to match how you really work, and get advice if you need it. Your contact details come from "Business details" above.</p>
          {POLICY_KINDS.map(({ key, label }) => (
            <div key={key}>
              <div className="flex items-center justify-between mb-1">
                <label className="font-body text-xs font-semibold" style={{ color: c.textDim }}>{label}</label>
                {!(draft[key] || "").trim() && <button onClick={() => setDraft((d) => ({ ...d, [key]: STARTERS[key] }))} className="font-body text-xs underline" style={{ color: GOLD }}>Use starter text</button>}
              </div>
              <textarea value={draft[key] || ""} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} rows={4} aria-label={label}
                className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none resize-y" style={st} />
            </div>
          ))}
          <button onClick={save} disabled={saving} className="w-full font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save policies"}</button>
        </div>
      )}
    </div>
  );
}
