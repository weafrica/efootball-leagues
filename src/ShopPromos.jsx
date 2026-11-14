// Shop promotions: discount codes (shopper box + admin manager) and
// back-in-stock requests (shopper form + admin list). All checks that matter
// happen on the server (shop_check_discount, place_shop_order,
// request_stock_alert); this file is just the screens.
import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";
import { Tag, Bell, Trash2, Check } from "lucide-react";

const GOLD = "#D4A017";
const money = (n) => `R${Number(n || 0).toLocaleString("en-ZA")}`;
const inputCls = "w-full border rounded-lg px-3 py-2 font-body text-sm outline-none";

// "Have a discount code?" in checkout. Calls onChange({code, amount}) or null.
export function DiscountBox({ cart, applied, onChange, c }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const items = cart.map((it) => ({ product_id: it.productId, variant_id: it.variantId || null, qty: it.qty }));
  const cartKey = cart.map((it) => `${it.productId}:${it.variantId || ""}:${it.qty}`).join(",");

  const check = useCallback(async (value, silent) => {
    setBusy(true); setMsg("");
    const { data, error } = await supabase.rpc("shop_check_discount", { p_code: value, p_items: items });
    setBusy(false);
    if (error || !data?.ok) {
      onChange(null);
      if (!silent) setMsg(error ? "Couldn't check that code. Try again." : data.message);
      else setMsg(data?.message || "");
      return;
    }
    onChange({ code: data.code, amount: Number(data.discount) });
    setMsg("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);

  // The cart changed: re-check the applied code against the new total.
  useEffect(() => { if (applied?.code) check(applied.code, true); }, [cartKey]); // eslint-disable-line

  if (applied?.code) {
    return (
      <div className="flex items-center justify-between rounded-lg px-3 py-2 mb-3 font-body text-sm" style={{ background: c.surface, border: `1px solid ${GOLD}` }} data-testid="discount-applied">
        <span className="flex items-center gap-2"><Check size={14} style={{ color: GOLD }} /> <b>{applied.code}</b> — you save {money(applied.amount)}</span>
        <button onClick={() => { onChange(null); setCode(""); }} className="text-xs underline" style={{ color: c.textDim }}>Remove</button>
      </div>
    );
  }
  return (
    <div className="mb-3">
      <div className="flex gap-2">
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Discount code" aria-label="Discount code"
          autoCapitalize="characters" className={inputCls} style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button onClick={() => code.trim() && check(code.trim(), false)} disabled={busy || !code.trim()}
          className="font-body text-sm font-semibold px-4 rounded-lg" style={{ background: GOLD, color: "#1a1200", opacity: busy || !code.trim() ? 0.6 : 1 }}>
          {busy ? "…" : "Apply"}
        </button>
      </div>
      {msg && <div className="font-body text-xs mt-1" style={{ color: c.red }} data-testid="discount-msg">{msg}</div>}
    </div>
  );
}

// "Notify me when it's back" on an out-of-stock product.
export function StockAlertForm({ productId, variantId, defaultContact = "", c }) {
  const [contact, setContact] = useState(defaultContact);
  const [state, setState] = useState("idle"); // idle | sending | done
  const [err, setErr] = useState("");
  const send = async () => {
    setState("sending"); setErr("");
    const { error } = await supabase.rpc("request_stock_alert", { p_product_id: productId, p_variant_id: variantId || null, p_contact: contact });
    if (error) { setErr(error.message); setState("idle"); } else setState("done");
  };
  if (state === "done") {
    return <div className="mt-3 font-body text-sm text-center py-2.5 rounded-full" style={{ background: c.surface, color: c.text }} data-testid="alert-done">We'll let you know when it's back in stock.</div>;
  }
  return (
    <div className="mt-3" data-testid="stock-alert">
      <div className="font-body text-xs font-semibold mb-1 flex items-center gap-1.5" style={{ color: c.textDim }}><Bell size={13} /> Tell me when it's back</div>
      <div className="flex gap-2">
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Email or phone number" aria-label="Email or phone number"
          className={inputCls} style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button onClick={send} disabled={state === "sending" || !contact.trim()} className="font-body text-sm font-semibold px-4 rounded-lg"
          style={{ background: GOLD, color: "#1a1200", opacity: state === "sending" || !contact.trim() ? 0.6 : 1 }}>Notify me</button>
      </div>
      {err && <div className="font-body text-xs mt-1" style={{ color: c.red }}>{err}</div>}
    </div>
  );
}

const emptyForm = { code: "", kind: "percent", value: "", min_spend: "", expires_at: "", max_uses: "" };

export function DiscountCodesPanel({ showToast, c }) {
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase.from("shop_discount_codes").select("*").order("created_at", { ascending: false });
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const code = form.code.trim().toUpperCase();
    const value = Number(form.value);
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) return showToast("Code must be 3–20 letters or numbers.");
    if (!(value > 0) || (form.kind === "percent" && value > 100)) return showToast(form.kind === "percent" ? "Enter a percentage from 1 to 100." : "Enter an amount above 0.");
    setSaving(true);
    const { error } = await supabase.from("shop_discount_codes").insert({
      code, kind: form.kind, value,
      min_spend: Number(form.min_spend) || 0,
      expires_at: form.expires_at ? new Date(`${form.expires_at}T23:59:59`).toISOString() : null,
      max_uses: form.max_uses ? Math.max(1, parseInt(form.max_uses, 10)) : null,
    });
    setSaving(false);
    if (error) return showToast(error.message.includes("duplicate") ? "That code already exists." : error.message);
    setForm(emptyForm); showToast(`Code ${code} created.`); load();
  };
  const toggle = async (r) => { await supabase.from("shop_discount_codes").update({ active: !r.active }).eq("id", r.id); load(); };
  const remove = async (r) => { await supabase.from("shop_discount_codes").delete().eq("id", r.id); load(); };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const st = { background: c.surface, borderColor: c.border, color: c.text };

  return (
    <div className="rounded-xl p-4 mt-4" style={{ background: c.card || c.surface, border: `1px solid ${c.border}` }} data-testid="discount-panel">
      <div className="font-extrabold uppercase tracking-tight text-base mb-1 flex items-center gap-2"><Tag size={16} style={{ color: GOLD }} /> Discount codes</div>
      <p className="font-body text-xs mb-3" style={{ color: c.textDim }}>The discount comes off the items total (not delivery). Used codes come back if an order is cancelled, rejected or refunded.</p>
      <div className="grid grid-cols-2 gap-2">
        <input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="Code e.g. WELCOME10" aria-label="New code" className={inputCls} style={st} />
        <select value={form.kind} onChange={set("kind")} aria-label="Type" className={inputCls} style={st}>
          <option value="percent">Percent off</option><option value="fixed">Rand amount off</option>
        </select>
        <input type="number" min="0" value={form.value} onChange={set("value")} placeholder={form.kind === "percent" ? "Percent (1-100)" : "Rand off"} aria-label="Value" className={inputCls} style={st} />
        <input type="number" min="0" value={form.min_spend} onChange={set("min_spend")} placeholder="Minimum spend (optional)" aria-label="Minimum spend" className={inputCls} style={st} />
        <input type="date" value={form.expires_at} onChange={set("expires_at")} aria-label="Expiry date" className={inputCls} style={st} />
        <input type="number" min="1" value={form.max_uses} onChange={set("max_uses")} placeholder="Max uses (optional)" aria-label="Max uses" className={inputCls} style={st} />
      </div>
      <button onClick={add} disabled={saving} className="w-full mt-3 font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>Create code</button>

      <div className="mt-3 space-y-2">
        {rows === null && <div className="font-body text-xs" style={{ color: c.textDim }}>Loading…</div>}
        {rows && rows.length === 0 && <div className="font-body text-xs" style={{ color: c.textDim }}>No codes yet.</div>}
        {(rows || []).map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 font-body text-xs" style={{ background: c.surface, opacity: r.active ? 1 : 0.55 }}>
            <div>
              <div className="font-mono font-bold text-sm">{r.code}</div>
              <div style={{ color: c.textDim }}>
                {r.kind === "percent" ? `${r.value}% off` : `${money(r.value)} off`}
                {r.min_spend > 0 ? ` · min ${money(r.min_spend)}` : ""}
                {r.expires_at ? ` · until ${new Date(r.expires_at).toLocaleDateString("en-ZA")}` : ""}
                {` · used ${r.used_count}${r.max_uses ? `/${r.max_uses}` : ""}`}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => toggle(r)} className="underline">{r.active ? "Pause" : "Turn on"}</button>
              <button onClick={() => remove(r)} aria-label="Delete code"><Trash2 size={14} style={{ color: c.red }} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StockAlertsPanel({ showToast, c }) {
  const [rows, setRows] = useState(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from("shop_stock_alerts")
      .select("id, contact, created_at, notified_at, variant_id, shop_products(name), shop_product_variants(name)")
      .order("created_at", { ascending: false }).limit(200);
    setRows(data || []);
  }, []);
  useEffect(() => { load(); }, [load]);
  const mark = async (r) => { await supabase.from("shop_stock_alerts").update({ notified_at: r.notified_at ? null : new Date().toISOString() }).eq("id", r.id); load(); };
  const remove = async (r) => { await supabase.from("shop_stock_alerts").delete().eq("id", r.id); load(); showToast("Removed."); };
  const waLink = (r) => {
    const d = (r.contact || "").replace(/\D/g, "");
    if (!d || r.contact.includes("@")) return `mailto:${r.contact}?subject=${encodeURIComponent(`${r.shop_products?.name || "Your item"} is back in stock`)}`;
    const intl = d.startsWith("0") ? `27${d.slice(1)}` : d;
    return `https://wa.me/${intl}?text=${encodeURIComponent(`Hi! ${r.shop_products?.name || "The item you wanted"} is back in stock at WeAfrica Shop.`)}`;
  };
  const waiting = (rows || []).filter((r) => !r.notified_at).length;

  return (
    <div className="rounded-xl p-4 mt-4" style={{ background: c.card || c.surface, border: `1px solid ${c.border}` }} data-testid="alerts-panel">
      <div className="font-extrabold uppercase tracking-tight text-base mb-1 flex items-center gap-2"><Bell size={16} style={{ color: GOLD }} /> Back-in-stock requests {rows && <span className="font-body text-xs font-normal" style={{ color: c.textDim }}>({waiting} waiting)</span>}</div>
      <p className="font-body text-xs mb-3" style={{ color: c.textDim }}>People who asked to be told when something is back. Tap Message to contact them, then tick them off.</p>
      {rows === null && <div className="font-body text-xs" style={{ color: c.textDim }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="font-body text-xs" style={{ color: c.textDim }}>No requests yet.</div>}
      <div className="space-y-2">
        {(rows || []).map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 font-body text-xs" style={{ background: c.surface, opacity: r.notified_at ? 0.55 : 1 }}>
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">{r.shop_products?.name || "Product"}{r.shop_product_variants?.name ? ` (${r.shop_product_variants.name})` : ""}</div>
              <div style={{ color: c.textDim }} className="truncate">{r.contact} · {new Date(r.created_at).toLocaleDateString("en-ZA")}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <a href={waLink(r)} target="_blank" rel="noreferrer" className="underline">Message</a>
              <button onClick={() => mark(r)} className="underline">{r.notified_at ? "Undo" : "Done"}</button>
              <button onClick={() => remove(r)} aria-label="Delete request"><Trash2 size={14} style={{ color: c.red }} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
