// Admin "Sales" view: revenue, best sellers, a 14-day chart, low-stock list
// and a CSV export of orders. Everything is worked out in the browser from
// the orders and products the admin already has access to.
import React, { useState, useEffect, useMemo } from "react";
import { Download, AlertTriangle } from "lucide-react";
import { supabase } from "./supabaseClient";
import { RECEIPT_STATUSES } from "./ShopDocuments.jsx";
import CustomersList from "./ShopCustomers.jsx";

const GOLD = "#D4A017";
const money = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `R${Math.round(Number(n || 0)).toLocaleString("en-ZA")}`;
const AWAITING = ["pending_review", "whatsapp_sent"];
const COLS = "id, order_number, created_at, status, subtotal, discount_code, discount_amount, delivery_fee, delivery_method, checkout_method, buyer_username, buyer_email, contact_phone, shop_order_items(qty, product_name, unit_price)";

export const orderTotal = (o) => Number(o.subtotal || 0) - Number(o.discount_amount || 0) + Number(o.delivery_fee || 0);
const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

export function csvEscape(v) {
  const s = v == null ? "" : String(v);
  // Stop spreadsheet formulas in customer-entered text (=, +, -, @).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function ordersToCsv(orders) {
  const head = ["Order", "Date", "Status", "Customer", "Phone", "Email", "Items", "Subtotal", "Discount code", "Discount", "Delivery", "Total", "Payment", "Delivery method"];
  const rows = orders.map((o) => [
    o.order_number, new Date(o.created_at).toLocaleString("en-ZA"), o.status, o.buyer_username, o.contact_phone, o.buyer_email,
    (o.shop_order_items || []).map((i) => `${i.qty} x ${i.product_name}`).join("; "),
    Number(o.subtotal || 0).toFixed(2), o.discount_code || "", Number(o.discount_amount || 0).toFixed(2), Number(o.delivery_fee || 0).toFixed(2),
    orderTotal(o).toFixed(2), o.checkout_method, o.delivery_method || "",
  ]);
  return "﻿" + [head, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

const PERIODS = [
  { key: "today", label: "Today", days: 1 },
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "all", label: "All time", days: null },
];

export function lowStockItems(products, threshold) {
  const out = [];
  (products || []).filter((p) => p.active).forEach((p) => {
    const vs = (p.variants || []).filter((v) => v.active);
    if (vs.length) vs.forEach((v) => { if (v.stock_qty <= threshold) out.push({ id: v.id, name: `${p.name} (${v.name})`, qty: v.stock_qty }); });
    else if ((p.stock_qty ?? 0) <= threshold) out.push({ id: p.id, name: p.name, qty: p.stock_qty ?? 0 });
  });
  return out.sort((a, b) => a.qty - b.qty);
}

export default function AdminSales({ products, onOpenOrders, onOpenProducts, showToast, c }) {
  const [orders, setOrders] = useState(null);
  const [tab, setTab] = useState("overview");
  const [period, setPeriod] = useState("30");
  const [threshold, setThreshold] = useState(() => { try { return Number(localStorage.getItem("weafrica_shop_low_stock")) || 5; } catch { return 5; } });
  useEffect(() => { try { localStorage.setItem("weafrica_shop_low_stock", String(threshold)); } catch { /* ignore */ } }, [threshold]);

  useEffect(() => {
    let off = false;
    (async () => {
      const { data, error } = await supabase.from("shop_orders").select(COLS).order("created_at", { ascending: false }).limit(5000);
      if (off) return;
      if (error) { showToast("Couldn't load orders."); setOrders([]); } else setOrders(data || []);
    })();
    return () => { off = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    if (!orders) return null;
    const p = PERIODS.find((x) => x.key === period);
    const from = p.days ? startOfDay(new Date(Date.now() - (p.days - 1) * 86400000)) : null;
    const inPeriod = orders.filter((o) => !from || new Date(o.created_at) >= from);
    const sold = inPeriod.filter((o) => RECEIPT_STATUSES.includes(o.status));
    const awaiting = orders.filter((o) => AWAITING.includes(o.status));
    const revenue = sold.reduce((s, o) => s + orderTotal(o), 0);
    const discounts = sold.reduce((s, o) => s + Number(o.discount_amount || 0), 0);
    const byProduct = {};
    sold.forEach((o) => (o.shop_order_items || []).forEach((i) => {
      const k = i.product_name; const e = byProduct[k] || (byProduct[k] = { name: k, units: 0, revenue: 0 });
      e.units += i.qty; e.revenue += i.qty * Number(i.unit_price || 0);
    }));
    const top = Object.values(byProduct).sort((a, b) => b.units - a.units || b.revenue - a.revenue).slice(0, 5);
    // Last 14 days of paid revenue.
    const days = [];
    for (let i = 13; i >= 0; i--) days.push({ date: startOfDay(new Date(Date.now() - i * 86400000)), key: "", value: 0 });
    days.forEach((d) => { d.key = dayKey(d.date); });
    orders.filter((o) => RECEIPT_STATUSES.includes(o.status)).forEach((o) => { const d = days.find((x) => x.key === dayKey(o.created_at)); if (d) d.value += orderTotal(o); });
    return { inPeriod, sold, awaiting, revenue, discounts, top, days, avg: sold.length ? revenue / sold.length : 0,
      awaitingValue: awaiting.reduce((s, o) => s + orderTotal(o), 0) };
  }, [orders, period]);

  const low = useMemo(() => lowStockItems(products, threshold), [products, threshold]);

  const exportCsv = () => {
    if (!stats) return;
    const blob = new Blob([ordersToCsv(stats.inPeriod)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `weafrica-orders-${dayKey(new Date())}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast(`Exported ${stats.inPeriod.length} order${stats.inPeriod.length === 1 ? "" : "s"}.`);
  };

  const chip = (on) => ({ background: on ? GOLD : c.surface, color: on ? "#1a1200" : c.text, border: `1px solid ${on ? GOLD : c.border}` });
  const maxDay = Math.max(1, ...(stats?.days || []).map((d) => d.value));
  const card = { background: c.surface, border: `1px solid ${c.border}` };

  return (
    <div data-testid="sales-view">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Sales</h1>
        <div className="flex gap-2">
          <button onClick={onOpenOrders} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surface, color: c.textDim }}>Orders</button>
          <button onClick={onOpenProducts} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surface, color: c.textDim }}>Products</button>
        </div>
      </div>

      <div className="flex gap-2 mb-4" role="tablist">
        {[["overview", "Overview"], ["customers", "Customers"]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="font-body text-sm font-semibold px-4 py-1.5 rounded-full" style={chip(tab === k)}>{l}</button>
        ))}
      </div>

      {tab === "customers" && (orders === null ? <div className="py-10 text-center font-body text-sm" style={{ color: c.textDim }}>Loading…</div> : <CustomersList orders={orders} showToast={showToast} c={c} />)}

      {tab === "overview" && <>
      <div className="flex flex-wrap gap-2 mb-3">
        {PERIODS.map((p) => <button key={p.key} onClick={() => setPeriod(p.key)} aria-pressed={period === p.key} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={chip(period === p.key)}>{p.label}</button>)}
      </div>

      {!stats ? <div className="py-10 text-center font-body text-sm" style={{ color: c.textDim }}>Loading…</div> : (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-xl p-3" style={card}><div className="font-body text-xs" style={{ color: c.textDim }}>Paid revenue</div><div className="font-mono text-xl font-bold mt-0.5" data-testid="revenue">{money(stats.revenue)}</div></div>
            <div className="rounded-xl p-3" style={card}><div className="font-body text-xs" style={{ color: c.textDim }}>Paid orders</div><div className="font-mono text-xl font-bold mt-0.5" data-testid="paid-count">{stats.sold.length}</div></div>
            <div className="rounded-xl p-3" style={card}><div className="font-body text-xs" style={{ color: c.textDim }}>Average order</div><div className="font-mono text-xl font-bold mt-0.5">{money(stats.avg)}</div></div>
            <div className="rounded-xl p-3" style={card}><div className="font-body text-xs" style={{ color: c.textDim }}>Discounts given</div><div className="font-mono text-xl font-bold mt-0.5">{money(stats.discounts)}</div></div>
          </div>
          <button onClick={onOpenOrders} className="w-full text-left rounded-xl p-3 mt-2.5 font-body text-sm" style={{ ...card, borderColor: stats.awaiting.length ? GOLD : c.border }} data-testid="awaiting">
            <b>{stats.awaiting.length}</b> order{stats.awaiting.length === 1 ? "" : "s"} waiting for you · {money(stats.awaitingValue)}
          </button>

          <div className="rounded-xl p-3 mt-4" style={card}>
            <div className="font-body text-xs font-semibold mb-2" style={{ color: c.textDim }}>Paid revenue, last 14 days</div>
            <div className="flex items-end gap-1 h-24" data-testid="chart">
              {stats.days.map((d) => (
                <div key={d.key} className="flex-1 flex flex-col justify-end h-full" title={`${d.date.toLocaleDateString("en-ZA")}: ${money(d.value)}`}>
                  <div className="rounded-t" style={{ height: `${Math.max(d.value ? 6 : 2, (d.value / maxDay) * 100)}%`, background: d.value ? GOLD : c.border }} />
                </div>
              ))}
            </div>
            <div className="flex justify-between font-body text-[10px] mt-1" style={{ color: c.textFaint }}>
              <span>{stats.days[0].date.toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}</span><span>Today</span>
            </div>
          </div>

          <div className="rounded-xl p-3 mt-4" style={card}>
            <div className="font-body text-xs font-semibold mb-2" style={{ color: c.textDim }}>Best sellers</div>
            {stats.top.length === 0 ? <div className="font-body text-xs" style={{ color: c.textDim }}>No paid orders in this period.</div> : (
              <ol className="space-y-1.5" data-testid="top">
                {stats.top.map((t, i) => (
                  <li key={t.name} className="flex items-center justify-between gap-2 font-body text-sm">
                    <span className="truncate"><span className="font-mono mr-2" style={{ color: c.textFaint }}>{i + 1}</span>{t.name}</span>
                    <span className="shrink-0 font-mono text-xs" style={{ color: c.textDim }}>{t.units} sold · {money0(t.revenue)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}

      <div className="rounded-xl p-3 mt-4" style={card} data-testid="low-stock">
        <div className="flex items-center justify-between mb-2">
          <div className="font-body text-xs font-semibold flex items-center gap-1.5" style={{ color: c.textDim }}><AlertTriangle size={13} style={{ color: GOLD }} /> Low stock ({low.length})</div>
          <label className="font-body text-xs flex items-center gap-1.5" style={{ color: c.textDim }}>at or below
            <input type="number" min="0" max="99" value={threshold} aria-label="Low stock level" onChange={(e) => setThreshold(Math.max(0, Math.min(99, Number(e.target.value) || 0)))}
              className="w-12 border rounded px-1.5 py-0.5 text-center" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
          </label>
        </div>
        {low.length === 0 ? <div className="font-body text-xs" style={{ color: c.textDim }}>Everything is well stocked.</div> : (
          <ul className="space-y-1">
            {low.map((it) => (
              <li key={it.id} className="flex items-center justify-between font-body text-sm">
                <span className="truncate pr-2">{it.name}</span>
                <span className="font-mono text-xs font-bold shrink-0" style={{ color: it.qty === 0 ? c.red : GOLD }}>{it.qty === 0 ? "Out" : `${it.qty} left`}</span>
              </li>
            ))}
          </ul>
        )}
        {low.length > 0 && <button onClick={onOpenProducts} className="font-body text-xs underline mt-2" style={{ color: c.textDim }}>Restock in Products</button>}
      </div>

      <button onClick={exportCsv} disabled={!stats} className="w-full mt-4 font-body text-sm font-semibold py-3 rounded-full flex items-center justify-center gap-2" style={{ background: GOLD, color: "#1a1200", opacity: stats ? 1 : 0.6 }}>
        <Download size={15} /> Download orders as CSV ({PERIODS.find((p) => p.key === period).label.toLowerCase()})
      </button>
      </>}
    </div>
  );
}
