// Admin "Customers" list, built from the shop's orders: people are matched by
// phone number or email, so one shopper who ordered twice shows up once.
import React, { useState, useMemo } from "react";
import { Search, Download, MessageCircle, Mail } from "lucide-react";
import { RECEIPT_STATUSES } from "./ShopDocuments.jsx";
import { orderTotal, csvEscape } from "./ShopSales.jsx";
import { whatsappNumber } from "./ShopMessages.jsx";

const GOLD = "#D4A017";
const money = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const NOT_COUNTED = ["rejected", "cancelled", "refunded"];

export function buildCustomers(orders) {
  // Union-find over orders that share a phone (last 9 digits) or an email.
  const parent = orders.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  const seen = new Map();
  const keysOf = (o) => {
    const k = [];
    const d = String(o.contact_phone || "").replace(/\D/g, "");
    if (d.length >= 7) k.push(`p:${d.slice(-9)}`);
    const e = String(o.buyer_email || "").trim().toLowerCase();
    if (e) k.push(`e:${e}`);
    return k;
  };
  orders.forEach((o, i) => keysOf(o).forEach((k) => { if (seen.has(k)) union(i, seen.get(k)); else seen.set(k, i); }));

  const groups = new Map();
  orders.forEach((o, i) => {
    if (!keysOf(o).length) return; // can't tell who this is
    const r = find(i); (groups.get(r) || groups.set(r, []).get(r)).push(o);
  });
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const latest = sorted[0];
    const counted = list.filter((o) => !NOT_COUNTED.includes(o.status));
    const paid = list.filter((o) => RECEIPT_STATUSES.includes(o.status));
    return {
      key: latest.id,
      name: latest.buyer_username || "Customer",
      phone: (sorted.find((o) => o.contact_phone) || {}).contact_phone || "",
      email: (sorted.find((o) => o.buyer_email) || {}).buyer_email || "",
      orders: counted.length, paidOrders: paid.length,
      spent: paid.reduce((s, o) => s + orderTotal(o), 0),
      first: sorted[sorted.length - 1].created_at, last: latest.created_at,
    };
  }).filter((c) => c.orders > 0);
}

export function customersToCsv(rows) {
  const head = ["Name", "Phone", "Email", "Orders", "Paid orders", "Total spent", "First order", "Last order"];
  const body = rows.map((r) => [r.name, r.phone, r.email, r.orders, r.paidOrders, r.spent.toFixed(2), new Date(r.first).toLocaleDateString("en-ZA"), new Date(r.last).toLocaleDateString("en-ZA")]);
  return "﻿" + [head, ...body].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export default function CustomersList({ orders, showToast, c }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("spent");
  const all = useMemo(() => buildCustomers(orders || []), [orders]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const d = term.replace(/\D/g, "");
    const list = all.filter((r) => !term || r.name.toLowerCase().includes(term) || r.email.toLowerCase().includes(term) || (d.length >= 3 && r.phone.replace(/\D/g, "").includes(d)));
    return list.sort((a, b) => (sort === "recent" ? new Date(b.last) - new Date(a.last) : sort === "orders" ? b.orders - a.orders || b.spent - a.spent : b.spent - a.spent || b.orders - a.orders));
  }, [all, q, sort]);
  const repeat = all.filter((r) => r.paidOrders >= 2).length;

  const exportCsv = () => {
    const blob = new Blob([customersToCsv(rows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `weafrica-customers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast(`Exported ${rows.length} customer${rows.length === 1 ? "" : "s"}.`);
  };
  const chip = (on) => ({ background: on ? GOLD : c.surface, color: on ? "#1a1200" : c.text, border: `1px solid ${on ? GOLD : c.border}` });

  return (
    <div data-testid="customers-view">
      <div className="font-body text-xs mb-3" style={{ color: c.textDim }} data-testid="customers-summary">{all.length} customer{all.length === 1 ? "" : "s"} · {repeat} repeat buyer{repeat === 1 ? "" : "s"}</div>
      <div className="relative mb-2.5">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone or email" aria-label="Search customers"
          className="w-full border rounded-full pl-9 pr-3 py-2 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>
      <div className="flex gap-2 mb-3">
        {[["spent", "Top spenders"], ["orders", "Most orders"], ["recent", "Recent"]].map(([k, l]) => (
          <button key={k} onClick={() => setSort(k)} aria-pressed={sort === k} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={chip(sort === k)}>{l}</button>
        ))}
      </div>

      {rows.length === 0 ? <div className="py-8 text-center font-body text-sm" style={{ color: c.textDim }}>{all.length ? "No one matches that search." : "No customers yet."}</div> : (
        <div className="space-y-2" data-testid="customer-rows">
          {rows.map((r) => {
            const wa = whatsappNumber(r.phone);
            return (
              <div key={r.key} className="rounded-xl p-3 flex items-center justify-between gap-2" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
                <div className="min-w-0">
                  <div className="font-body text-sm font-semibold truncate">{r.name}{r.paidOrders >= 2 && <span className="ml-2 font-body text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: GOLD, color: "#1a1200" }}>REPEAT</span>}</div>
                  <div className="font-body text-xs truncate" style={{ color: c.textDim }}>{[r.phone, r.email].filter(Boolean).join(" · ")}</div>
                  <div className="font-body text-xs mt-0.5" style={{ color: c.textFaint }}>{r.orders} order{r.orders === 1 ? "" : "s"} · {money(r.spent)} paid · last {new Date(r.last).toLocaleDateString("en-ZA")}</div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${r.name}`} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><MessageCircle size={14} /></a>}
                  {r.email && <a href={`mailto:${r.email}`} aria-label={`Email ${r.name}`} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><Mail size={14} /></a>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button onClick={exportCsv} disabled={!rows.length} className="w-full mt-4 font-body text-sm font-semibold py-3 rounded-full flex items-center justify-center gap-2" style={{ background: GOLD, color: "#1a1200", opacity: rows.length ? 1 : 0.6 }}>
        <Download size={15} /> Download customers as CSV
      </button>
    </div>
  );
}
