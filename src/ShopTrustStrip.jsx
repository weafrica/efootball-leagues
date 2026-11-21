// A slim row under the banner telling shoppers what to expect. Every item is
// worked out from the shop's real settings, so nothing is promised that the
// shop doesn't offer: delivery only shows once a delivery method is switched
// on, and returns only once a returns policy is published.
import React from "react";
import { Truck, RotateCcw, MessageCircle, PackageSearch } from "lucide-react";

const METHODS = ["collection", "courier", "pudo", "paxi"];

export function parseDeliveryConfig(raw) {
  try { const p = raw ? JSON.parse(raw) : {}; return p && typeof p === "object" ? p : {}; } catch { return {}; }
}

// Pure function: returns the items to show. money formats a rand amount.
export function trustItems({ deliveryConfig = {}, policies = {}, whatsapp = "", money = (n) => `R${n}` }) {
  const items = [];
  const on = METHODS.filter((m) => deliveryConfig[m]?.enabled);
  if (on.length > 0) {
    const freeOver = Number(deliveryConfig.free_over) || 0;
    items.push({ key: "delivery", icon: Truck, title: "Delivery & collection", sub: freeOver > 0 ? `Free delivery over ${money(freeOver)}` : "Choose how you get it at checkout" });
  }
  if ((policies.returns || "").trim()) items.push({ key: "returns", icon: RotateCcw, title: "Easy returns", sub: "Read our returns policy below" });
  if ((whatsapp || "").replace(/\D/g, "")) items.push({ key: "support", icon: MessageCircle, title: "WhatsApp support", sub: "Chat to us any time" });
  items.push({ key: "track", icon: PackageSearch, title: "Track your order", sub: "With your order number" });
  return items;
}

export function TrustStrip({ items, c }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={`grid grid-cols-2 ${items.length >= 4 ? "lg:grid-cols-4" : items.length === 3 ? "lg:grid-cols-3" : ""} gap-2 mb-6`} data-testid="trust-strip">
      {items.map(({ key, icon: Icon, title, sub }) => (
        <div key={key} className="flex items-center gap-2.5 rounded-xl border px-3 py-2.5" style={{ background: c.surface, borderColor: c.border }}>
          <Icon size={20} className="shrink-0" style={{ color: "#D4A017" }} />
          <div className="min-w-0">
            <div className="font-body text-xs font-bold leading-tight" style={{ color: c.text }}>{title}</div>
            <div className="font-body text-[11px] leading-tight mt-0.5" style={{ color: c.textDim }}>{sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
