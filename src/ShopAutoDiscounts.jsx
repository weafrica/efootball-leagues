// Automatic discounts: "spend R500, get 10% off" with no code. The server
// (place_shop_order) is the source of truth and applies the better of a typed
// code or the best automatic rule; these helpers mirror that so the cart and
// checkout show the same number before the order is placed.
import React, { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import { Percent, Trash2 } from "lucide-react";

const GOLD = "#D4A017";
const money = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const inputCls = "w-full border rounded-lg px-3 py-2 font-body text-sm outline-none";

// ── Pure helpers (same maths as shop_auto_discount in the database) ──────────
export function autoDiscountAmount(rule, subtotal) {
  const sub = Number(subtotal) || 0;
  const raw = rule.kind === "percent" ? Math.round(sub * Number(rule.value)) / 100 : Number(rule.value);
  return Math.max(0, Math.min(sub, Math.round(raw * 100) / 100));
}
export function bestAutoDiscount(rules, subtotal) {
  let best = null;
  for (const r of rules || []) {
    if (r.active === false || Number(r.min_spend) > subtotal) continue;
    const amount = autoDiscountAmount(r, subtotal);
    if (amount > 0 && (!best || amount > best.amount)) best = { name: r.name, amount };
  }
  return best;
}
// The closest rule the shopper hasn't reached yet (and that would beat what they have).
export function nextAutoDiscount(rules, subtotal) {
  const have = bestAutoDiscount(rules, subtotal)?.amount || 0;
  let next = null;
  for (const r of rules || []) {
    if (r.active === false || !(Number(r.min_spend) > subtotal)) continue;
    if (autoDiscountAmount(r, Number(r.min_spend)) <= have) continue;
    if (!next || Number(r.min_spend) < Number(next.min_spend)) next = r;
  }
  return next ? { rule: next, remaining: Number(next.min_spend) - subtotal } : null;
}
export const ruleText = (r) => `${r.kind === "percent" ? `${Number(r.value)}%` : money(r.value)} off${Number(r.min_spend) > 0 ? ` when you spend ${money(r.min_spend)}` : ""}`;

// ── Shopper side ────────────────────────────────────────────────────────────
let cache = null;
export function useAutoDiscounts() {
  const [rules, setRules] = useState(cache || []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from("shop_auto_discounts").select("id, name, kind, value, min_spend, active").eq("active", true);
      if (cancelled || error || !Array.isArray(data)) return;
      cache = data; setRules(data);
    })();
    return () => { cancelled = true; };
  }, []);
  return rules;
}

export function AutoDiscountNudge({ rules, total, c }) {
  const have = bestAutoDiscount(rules, total);
  const next = nextAutoDiscount(rules, total);
  if (!have && !next) return null;
  return (
    <div className="mb-3 rounded-xl px-3 py-2.5 font-body text-xs" style={{ background: c.surface, border: `1px solid ${GOLD}`, color: c.textDim }} data-testid="auto-discount-nudge">
      {have && <div style={{ color: c.text }}><b style={{ color: GOLD }}>You're saving {money(have.amount)}</b> with {have.name}. Applied automatically at checkout.</div>}
      {next && <div className={have ? "mt-1" : ""}>Spend <b style={{ color: c.text }}>{money(next.remaining)}</b> more to get {ruleText(next.rule).replace(/ when you spend.*/, "")} ({next.rule.name}).</div>}
    </div>
  );
}

// ── Admin side ──────────────────────────────────────────────────────────────
export function AutoDiscountsPanel({ showToast, c }) {
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };
  const [rows, setRows] = useState(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("percent");
  const [value, setValue] = useState("");
  const [minSpend, setMinSpend] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data, error } = await supabase.from("shop_auto_discounts").select("*").order("min_spend");
    if (!error) setRows(data || []);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    const v = Number(value);
    if (!name.trim()) { showToast("Give the offer a name, for example Spend R500 save 10%."); return; }
    if (!(v > 0) || (kind === "percent" && v > 100)) { showToast(kind === "percent" ? "Enter a percentage between 1 and 100." : "Enter an amount in rand."); return; }
    setBusy(true);
    const { error } = await supabase.from("shop_auto_discounts").insert({ name: name.trim(), kind, value: v, min_spend: Math.max(0, Number(minSpend) || 0) });
    setBusy(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    cache = null; setName(""); setValue(""); setMinSpend(""); showToast("Automatic discount added."); load();
  };
  const toggle = async (r) => {
    const { error } = await supabase.from("shop_auto_discounts").update({ active: !r.active }).eq("id", r.id);
    if (error) { showToast(error.message); return; }
    cache = null; load();
  };
  const remove = async (r) => {
    const { error } = await supabase.from("shop_auto_discounts").delete().eq("id", r.id);
    if (error) { showToast(error.message); return; }
    cache = null; load();
  };

  return (
    <div className="mt-6" data-testid="auto-discounts-panel">
      <div className="flex items-center gap-2 mb-1.5">
        <Percent size={16} style={{ color: GOLD }} />
        <h2 className="font-body text-sm font-bold">Automatic discounts</h2>
      </div>
      <p className="font-body text-xs mb-3" style={{ color: c.textDim }}>Applied at checkout with no code. If a shopper also types a code, they get whichever saves more.</p>

      <div className="space-y-1.5 mb-3">
        {rows === null && <div className="font-body text-xs" style={{ color: c.textFaint }}>Loading…</div>}
        {rows && rows.length === 0 && <div className="font-body text-xs" style={{ color: c.textFaint }}>None yet.</div>}
        {(rows || []).map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-xl p-2.5 border" style={{ background: c.surface, borderColor: c.border, opacity: r.active ? 1 : 0.55 }} data-testid="auto-row">
            <div className="min-w-0 flex-1">
              <div className="font-body text-xs font-semibold truncate">{r.name}</div>
              <div className="font-mono text-[10px]" style={{ color: c.textDim }}>{ruleText(r)}{!r.active && " · paused"}</div>
            </div>
            <button onClick={() => toggle(r)} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full" style={{ background: c.surfaceHover, color: c.text }}>{r.active ? "Pause" : "Turn on"}</button>
            <button onClick={() => remove(r)} aria-label="Delete" className="w-7 h-7 flex items-center justify-center rounded-full" style={{ color: c.red }}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Spend R500 save 10%" aria-label="Offer name" className={`${inputCls} col-span-2`} style={inputStyle} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Automatic discount type" className={inputCls} style={inputStyle}>
          <option value="percent">Percent off</option>
          <option value="fixed">Rand off</option>
        </select>
        <input type="number" min="0" value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === "percent" ? "Percent (1 to 100)" : "Amount in R"} aria-label="Automatic discount value" className={inputCls} style={inputStyle} />
        <input type="number" min="0" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} placeholder="Minimum spend in R (0 = always)" aria-label="Automatic minimum spend" className={`${inputCls} col-span-2`} style={inputStyle} />
      </div>
      <button onClick={add} disabled={busy} data-testid="auto-add" className="w-full mt-2 font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: busy ? 0.6 : 1 }}>Add automatic discount</button>
    </div>
  );
}
