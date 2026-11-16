// Shop team (staff) management and the activity log. Admins only.
//
// Staff can work through orders (status, tracking, returns, back-in-stock
// requests) but cannot refund, edit products, codes or settings, or manage
// staff. The people list lives in shop_staff, separate from the app-wide
// admins list, so adding a helper here never makes them a Matchday admin.
import React, { useState, useEffect, useCallback } from "react";
import { ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import { supabase } from "./supabaseClient";

const GOLD = "#D4A017";

export function TeamPanel({ showToast, c }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase.from("shop_staff").select("user_id, email, created_at").order("created_at");
    setRows(data || []);
  }, []);
  useEffect(() => { if (open && rows === null) load(); }, [open, rows, load]);

  const add = async () => {
    setBusy(true);
    const { error } = await supabase.rpc("admin_add_shop_staff", { p_email: email });
    setBusy(false);
    if (error) { showToast(error.message); return; }
    showToast(`${email.trim().toLowerCase()} added to the shop team.`); setEmail(""); load();
  };
  const remove = async (r) => {
    if (!window.confirm(`Remove ${r.email} from the shop team?`)) return;
    const { error } = await supabase.rpc("admin_remove_shop_staff", { p_user_id: r.user_id });
    if (error) { showToast(error.message); return; }
    showToast("Removed."); load();
  };

  return (
    <div className="rounded-xl border mt-4" style={{ background: c.surface, borderColor: c.border }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2.5 font-body text-sm font-semibold" aria-expanded={open}>
        <span>Shop team (helpers)</span>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="px-3 pb-3" data-testid="team-panel">
          <p className="font-body text-xs mb-2.5" style={{ color: c.textDim }}>A helper can see orders and payment proofs, change order status, add tracking, answer returns and back-in-stock requests, and see Sales. They can't refund, edit products, codes or settings, or add people. They need a Matchday account first.</p>
          <div className="flex gap-2">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their account email" aria-label="Helper email"
              className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
            <button onClick={add} disabled={busy || !email.trim()} className="font-body text-sm font-semibold px-4 rounded-lg" style={{ background: GOLD, color: "#1a1200", opacity: busy || !email.trim() ? 0.6 : 1 }}>Add</button>
          </div>
          <div className="mt-3 space-y-1.5">
            {rows === null && <div className="font-body text-xs" style={{ color: c.textDim }}>Loading…</div>}
            {rows && rows.length === 0 && <div className="font-body text-xs" style={{ color: c.textDim }}>No helpers yet.</div>}
            {(rows || []).map((r) => (
              <div key={r.user_id} className="flex items-center justify-between rounded-lg px-3 py-2 font-body text-sm" style={{ background: c.bg }}>
                <span className="truncate pr-2">{r.email}</span>
                <button onClick={() => remove(r)} aria-label={`Remove ${r.email}`}><Trash2 size={14} style={{ color: c.red }} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_WORDS = { pending_review: "pending review", whatsapp_sent: "WhatsApp", paid: "paid", packed: "packed", shipped: "shipped", delivered: "delivered", fulfilled: "completed", rejected: "rejected", cancelled: "cancelled", refunded: "refunded" };
export function describeAudit(e) {
  const d = e.detail || {};
  const t = e.target || "";
  switch (e.action) {
    case "order.status": return `Order ${t}: ${STATUS_WORDS[d.from] || d.from} → ${STATUS_WORDS[d.to] || d.to}`;
    case "order.tracking": return `Order ${t}: tracking ${d.courier ? `${d.courier} ` : ""}${d.tracking || "(cleared)"}`;
    case "return.approved": return `Return approved on ${t}${d.note ? ` ("${d.note}")` : ""}`;
    case "return.rejected": return `Return declined on ${t}${d.note ? ` ("${d.note}")` : ""}`;
    case "return.refunded": return `Return refunded on ${t}`;
    case "product.created": return `Product added: ${t}`;
    case "product.deleted": return `Product deleted: ${t}`;
    case "product.updated": return `Product changed: ${t} (${Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? `${v[0]} → ${v[1]}` : v}`).join(", ")})`;
    case "code.created": return `Discount code ${t} created`;
    case "code.deleted": return `Discount code ${t} deleted`;
    case "code.updated": return `Discount code ${t} changed`;
    case "settings.updated": return `Setting changed: ${t}`;
    case "staff.added": return `Helper added: ${t}`;
    case "staff.removed": return `Helper removed: ${t}`;
    default: return `${e.action} ${t}`.trim();
  }
}

export function ActivityLogPanel({ c }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from("shop_audit_log").select("id, actor_label, action, target, detail, created_at").order("created_at", { ascending: false }).limit(100);
    setRows(data || []);
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);
  return (
    <div className="rounded-xl border mt-4" style={{ background: c.surface, borderColor: c.border }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2.5 font-body text-sm font-semibold" aria-expanded={open}>
        <span>Activity log (who did what)</span>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="px-3 pb-3" data-testid="audit-panel">
          {rows === null && <div className="font-body text-xs" style={{ color: c.textDim }}>Loading…</div>}
          {rows && rows.length === 0 && <div className="font-body text-xs" style={{ color: c.textDim }}>Nothing recorded yet. Changes from now on will show here.</div>}
          <ul className="space-y-2">
            {(rows || []).map((e) => (
              <li key={e.id} className="font-body text-xs">
                <div style={{ color: c.text }}>{describeAudit(e)}</div>
                <div style={{ color: c.textFaint }}>{e.actor_label} · {new Date(e.created_at).toLocaleString("en-ZA")}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
