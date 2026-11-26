// Admin "Customers" list, built from the shop's orders: people are matched by
// phone number or email, so one shopper who ordered twice shows up once.
import React, { useState, useMemo, useEffect, useCallback } from "react";
import { Search, Download, MessageCircle, Mail, StickyNote } from "lucide-react";
import { supabase } from "./supabaseClient";
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
    const keys = [...new Set(list.flatMap(keysOf))].sort((a, b) => (b.startsWith("p:") ? 1 : 0) - (a.startsWith("p:") ? 1 : 0));
    return {
      key: latest.id, keys,
      name: latest.buyer_username || "Customer",
      phone: (sorted.find((o) => o.contact_phone) || {}).contact_phone || "",
      email: (sorted.find((o) => o.buyer_email) || {}).buyer_email || "",
      orders: counted.length, paidOrders: paid.length,
      spent: paid.reduce((s, o) => s + orderTotal(o), 0),
      first: sorted[sorted.length - 1].created_at, last: latest.created_at,
    };
  }).filter((c) => c.orders > 0);
}

// Tags are short labels ("VIP", "Pays late"). Trim, drop empties and
// duplicates (ignoring case), cap the count and length.
export function parseCustomerTags(text) {
  const seen = new Set(); const out = [];
  for (const raw of String(text || "").split(",")) {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, 24);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out.slice(0, 8);
}
// The saved note row for a customer: any of the customer's contact keys can match.
export function noteFor(notes, customer) {
  for (const k of customer.keys || []) if (notes.has(k)) return notes.get(k);
  return null;
}
export const SUGGESTED_TAGS = ["VIP", "Wholesale", "Pays late", "Collects in person"];

export function customersToCsv(rows, notes = new Map()) {
  const head = ["Name", "Phone", "Email", "Orders", "Paid orders", "Total spent", "First order", "Last order", "Tags", "Note"];
  const body = rows.map((r) => { const n = noteFor(notes, r); return [r.name, r.phone, r.email, r.orders, r.paidOrders, r.spent.toFixed(2), new Date(r.first).toLocaleDateString("en-ZA"), new Date(r.last).toLocaleDateString("en-ZA"), (n?.tags || []).join("; "), n?.note || ""]; });
  return "﻿" + [head, ...body].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export default function CustomersList({ orders, showToast, c }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("spent");
  const [tagFilter, setTagFilter] = useState("");
  const [notes, setNotes] = useState(new Map()); // contact_key -> { note, tags }
  const [editing, setEditing] = useState(null); // customer key being edited
  const [draftNote, setDraftNote] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [saving, setSaving] = useState(false);
  const loadNotes = useCallback(async () => {
    const { data, error } = await supabase.from("shop_customer_notes").select("contact_key, note, tags");
    if (!error && Array.isArray(data)) setNotes(new Map(data.map((r) => [r.contact_key, r])));
  }, []);
  useEffect(() => { loadNotes(); }, [loadNotes]);
  const all = useMemo(() => buildCustomers(orders || []), [orders]);
  const allTags = useMemo(() => {
    const counts = new Map();
    all.forEach((r) => (noteFor(notes, r)?.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [all, notes]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const d = term.replace(/\D/g, "");
    const list = all.filter((r) => {
      const n = noteFor(notes, r);
      if (tagFilter && !(n?.tags || []).includes(tagFilter)) return false;
      return !term || r.name.toLowerCase().includes(term) || r.email.toLowerCase().includes(term) || (d.length >= 3 && r.phone.replace(/\D/g, "").includes(d))
        || (n?.tags || []).some((t) => t.toLowerCase().includes(term)) || (n?.note || "").toLowerCase().includes(term);
    });
    return list.sort((a, b) => (sort === "recent" ? new Date(b.last) - new Date(a.last) : sort === "orders" ? b.orders - a.orders || b.spent - a.spent : b.spent - a.spent || b.orders - a.orders));
  }, [all, q, sort, notes, tagFilter]);
  const repeat = all.filter((r) => r.paidOrders >= 2).length;

  const exportCsv = () => {
    const blob = new Blob([customersToCsv(rows, notes)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `weafrica-customers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast(`Exported ${rows.length} customer${rows.length === 1 ? "" : "s"}.`);
  };
  const startEdit = (r) => { const n = noteFor(notes, r); setEditing(r.key); setDraftNote(n?.note || ""); setDraftTags((n?.tags || []).join(", ")); };
  const saveNote = async (r) => {
    const tags = parseCustomerTags(draftTags); const note = draftNote.trim().slice(0, 2000);
    const existingKey = (r.keys || []).find((k) => notes.has(k));
    const key = existingKey || (r.keys || [])[0];
    if (!key) { showToast("This customer has no phone or email to attach a note to."); return; }
    setSaving(true);
    const { error } = (!note && !tags.length)
      ? await supabase.from("shop_customer_notes").delete().eq("contact_key", key)
      : await supabase.from("shop_customer_notes").upsert({ contact_key: key, note, tags }, { onConflict: "contact_key" });
    setSaving(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    setEditing(null); showToast("Customer note saved."); loadNotes();
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

      {allTags.length > 0 && (
        <div className="flex gap-1.5 mb-3 overflow-x-auto no-scrollbar" data-testid="customer-tag-filters">
          {allTags.map((t) => (
            <button key={t} onClick={() => setTagFilter(tagFilter === t ? "" : t)} aria-pressed={tagFilter === t} className="font-body text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0" style={chip(tagFilter === t)}>{t}</button>
          ))}
        </div>
      )}

      {rows.length === 0 ? <div className="py-8 text-center font-body text-sm" style={{ color: c.textDim }}>{all.length ? "No one matches that search." : "No customers yet."}</div> : (
        <div className="space-y-2" data-testid="customer-rows">
          {rows.map((r) => {
            const wa = whatsappNumber(r.phone);
            const n = noteFor(notes, r);
            return (
              <div key={r.key} className="rounded-xl p-3" style={{ background: c.surface, border: `1px solid ${c.border}` }} data-testid="customer-row">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-body text-sm font-semibold truncate">{r.name}{r.paidOrders >= 2 && <span className="ml-2 font-body text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: GOLD, color: "#1a1200" }}>REPEAT</span>}</div>
                  <div className="font-body text-xs truncate" style={{ color: c.textDim }}>{[r.phone, r.email].filter(Boolean).join(" · ")}</div>
                  <div className="font-body text-xs mt-0.5" style={{ color: c.textFaint }}>{r.orders} order{r.orders === 1 ? "" : "s"} · {money(r.spent)} paid · last {new Date(r.last).toLocaleDateString("en-ZA")}</div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => (editing === r.key ? setEditing(null) : startEdit(r))} aria-label={`Note for ${r.name}`} data-testid="note-btn" className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: n ? GOLD : c.surfaceHover, color: n ? "#1a1200" : c.text }}><StickyNote size={14} /></button>
                  {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${r.name}`} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><MessageCircle size={14} /></a>}
                  {r.email && <a href={`mailto:${r.email}`} aria-label={`Email ${r.name}`} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><Mail size={14} /></a>}
                </div>
              </div>
              {n && (n.tags.length > 0 || n.note) && editing !== r.key && (
                <div className="mt-2 pt-2 border-t" style={{ borderColor: c.border }} data-testid="customer-note-view">
                  {n.tags.length > 0 && <div className="flex flex-wrap gap-1 mb-1">{n.tags.map((t) => <span key={t} className="font-body text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: c.surfaceHover, color: GOLD }}>{t}</span>)}</div>}
                  {n.note && <div className="font-body text-xs whitespace-pre-wrap" style={{ color: c.textDim }}>{n.note}</div>}
                </div>
              )}
              {editing === r.key && (
                <div className="mt-2 pt-2 border-t space-y-2" style={{ borderColor: c.border }} data-testid="customer-note-editor">
                  <input value={draftTags} onChange={(e) => setDraftTags(e.target.value)} placeholder="Tags, separated by commas" aria-label="Customer tags"
                    className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTED_TAGS.map((t) => (
                      <button key={t} type="button" onClick={() => setDraftTags(parseCustomerTags(`${draftTags}, ${t}`).join(", "))} className="font-body text-[11px] px-2.5 py-1 rounded-full" style={{ background: c.surfaceHover, color: c.textDim }}>+ {t}</button>
                    ))}
                  </div>
                  <textarea value={draftNote} onChange={(e) => setDraftNote(e.target.value)} rows={3} maxLength={2000} placeholder="Private note, only the shop team sees this" aria-label="Customer note"
                    className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none resize-none" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
                  <div className="flex gap-2">
                    <button onClick={() => saveNote(r)} disabled={saving} data-testid="note-save" className="flex-1 font-body text-sm font-semibold py-2 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
                    <button onClick={() => setEditing(null)} className="font-body text-sm font-semibold px-4 py-2 rounded-full" style={{ background: c.surfaceHover, color: c.text }}>Cancel</button>
                  </div>
                </div>
              )}
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
