// Private notes on an order, for the shop owner and helpers only. Stored in
// shop_order_notes, which the customer's account cannot read (see migration
// 20260968). Loads an order's notes only when the thread is opened.
import React, { useState } from "react";
import { StickyNote, Trash2 } from "lucide-react";
import { supabase } from "./supabaseClient";

const when = (iso) => new Date(iso).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function OrderNotes({ orderId, count = 0, userId, isAdmin, onCountChange, showToast, c }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const { data, error } = await supabase.from("shop_order_notes").select("id, note, author_id, author_label, created_at")
      .eq("order_id", orderId).order("created_at", { ascending: true });
    if (error) { showToast("Couldn't load notes."); setNotes([]); return; }
    setNotes(data || []); onCountChange && onCountChange(orderId, (data || []).length);
  };
  const toggle = () => { const next = !open; setOpen(next); if (next && notes === null) load(); };

  const add = async () => {
    const note = text.trim();
    if (!note || busy) return;
    setBusy(true);
    const { error } = await supabase.from("shop_order_notes").insert({ order_id: orderId, note });
    setBusy(false);
    if (error) { showToast(`Couldn't save note: ${error.message}`); return; }
    setText(""); await load();
  };
  const remove = async (n) => {
    if (!window.confirm("Delete this note?")) return;
    const { error } = await supabase.from("shop_order_notes").delete().eq("id", n.id);
    if (error) { showToast("Couldn't delete the note."); return; }
    await load();
  };

  return (
    <div className="mt-2.5" data-testid="order-notes">
      <button onClick={toggle} aria-expanded={open} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.surfaceHover, color: c.text }}>
        <StickyNote size={12} /> Notes{(notes ? notes.length : count) > 0 ? ` (${notes ? notes.length : count})` : ""}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border p-2.5" style={{ background: c.bg, borderColor: c.border }}>
          <div className="font-body text-[11px] mb-2" style={{ color: c.textFaint }}>Private. Only you and your helpers can see these, never the customer.</div>
          {notes === null ? <div className="font-body text-xs" style={{ color: c.textDim }}>Loading…</div> : (
            <ul className="space-y-1.5 mb-2">
              {notes.length === 0 && <li className="font-body text-xs" style={{ color: c.textDim }}>No notes yet.</li>}
              {notes.map((n) => (
                <li key={n.id} className="font-body text-xs flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="whitespace-pre-wrap break-words" style={{ color: c.text }}>{n.note}</span>
                    <span className="block text-[10px]" style={{ color: c.textFaint }}>{n.author_label} · {when(n.created_at)}</span>
                  </span>
                  {(isAdmin || n.author_id === userId) && (
                    <button onClick={() => remove(n)} aria-label="Delete note" className="shrink-0 w-6 h-6 flex items-center justify-center rounded-full" style={{ color: c.red }}><Trash2 size={12} /></button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 1000))} rows={2} aria-label="Add a private note" placeholder="e.g. Customer will collect Friday"
              className="flex-1 border rounded-lg px-2.5 py-2 font-body text-xs outline-none resize-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
            <button onClick={add} disabled={!text.trim() || busy} className="shrink-0 font-body text-xs font-semibold px-3 py-2 rounded-full" style={{ background: "#D4A017", color: "#1a1200", opacity: !text.trim() || busy ? 0.5 : 1 }}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}
