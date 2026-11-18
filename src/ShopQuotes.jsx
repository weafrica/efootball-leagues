// "Price on request" products: the shopper's quote form, and the inbox where
// the shop owner and helpers answer requests. Data lives in shop_quote_requests
// (created through the request_shop_quote function, see migration 20260969).
import React, { useState, useEffect, useMemo } from "react";
import { FileText, Trash2, CheckCircle2 } from "lucide-react";
import { supabase } from "./supabaseClient";

const GOLD = "#D4A017";
const rand = (n) => `R${Number(n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const QUOTE_LINK_BASE = "https://weafrica.co.za/shop";
const STATUS = { new: "New", quoted: "Quoted", ordered: "Ordered", closed: "Closed" };

export function QuoteRequestForm({ product, session, profile, c }) {
  const [name, setName] = useState(profile?.username || "");
  const [phone, setPhone] = useState(profile?.phone || "");
  const [email, setEmail] = useState(session?.user?.email || "");
  const [qty, setQty] = useState(1);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ref, setRef] = useState(null);
  const input = "w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none";
  const style = { background: c.surface, borderColor: c.border, color: c.text };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const { data, error: err } = await supabase.rpc("request_shop_quote", {
      p_product_id: product.id, p_name: name, p_phone: phone || null, p_email: email || null,
      p_qty: Number(qty) || 0, p_details: details,
    });
    setBusy(false);
    if (err) { setError(err.message || "Couldn't send your request."); return; }
    setRef(data?.ref || "sent");
  };

  if (ref) {
    return (
      <div className="mt-4 rounded-xl p-4 text-center font-body" style={{ background: c.surface, border: `1px solid ${c.border}` }} data-testid="quote-sent">
        <CheckCircle2 size={26} className="mx-auto mb-2" style={{ color: c.greenText }} />
        <div className="font-bold text-sm">Request sent</div>
        {ref !== "sent" && <div className="font-mono text-base mt-1" style={{ color: GOLD }}>{ref}</div>}
        <p className="text-xs mt-1.5" style={{ color: c.textDim }}>We'll send you a price on the phone number or email you gave. No payment is taken until you agree to the quote.</p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="mt-4 space-y-2.5" data-testid="quote-form">
      <div className="font-body text-xs font-semibold" style={{ color: c.textDim }}>This item is priced on request. Tell us what you need and we'll send you a quote.</div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" maxLength={80} className={input} style={style} />
      <div className="grid grid-cols-2 gap-2">
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" aria-label="Phone" inputMode="tel" className={input} style={style} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" aria-label="Email" inputMode="email" className={input} style={style} />
      </div>
      <div className="flex items-center gap-2">
        <label className="font-body text-xs" style={{ color: c.textDim }} htmlFor="quote-qty">How many</label>
        <input id="quote-qty" type="number" min="1" max="10000" value={qty} onChange={(e) => setQty(e.target.value)} className="w-24 border rounded-lg px-3 py-2 font-body text-sm outline-none" style={style} />
      </div>
      <textarea value={details} onChange={(e) => setDetails(e.target.value.slice(0, 1000))} rows={4} aria-label="What you need" placeholder="e.g. Logo on the left chest, navy shirts, sizes S to XL"
        className={`${input} resize-none`} style={style} />
      {error && <div role="alert" className="font-body text-xs" style={{ color: c.red }}>{error}</div>}
      <button type="submit" disabled={busy} className="w-full font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: busy ? 0.6 : 1 }}>
        {busy ? "Sending…" : "Request a quote"}
      </button>
    </form>
  );
}

const waNumber = (phone) => { const d = (phone || "").replace(/\D/g, ""); return d ? (d.startsWith("0") ? `27${d.slice(1)}` : d) : ""; };

export function QuotesPanel({ isAdmin, business, showToast, onOrderCreated, c }) {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("new");
  const [open, setOpen] = useState(false);

  const load = async () => {
    const { data, error } = await supabase.from("shop_quote_requests")
      .select("id, ref, product_name, qty, details, buyer_name, contact_phone, contact_email, status, quote_amount, admin_note, created_at, order:shop_orders(order_number)")
      .order("created_at", { ascending: false }).limit(300);
    if (error) { showToast("Couldn't load quote requests."); setRows([]); return; }
    setRows(data || []);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const counts = useMemo(() => {
    const n = { all: (rows || []).length, new: 0, quoted: 0, ordered: 0, closed: 0 };
    (rows || []).forEach((r) => { n[r.status] = (n[r.status] || 0) + 1; });
    return n;
  }, [rows]);
  const shown = (rows || []).filter((r) => filter === "all" || r.status === filter);
  const chip = (on) => ({ background: on ? GOLD : c.surface, color: on ? "#1a1200" : c.text, border: `1px solid ${on ? GOLD : c.border}` });

  return (
    <div className="rounded-xl p-4 mt-4" style={{ background: c.card || c.surface, border: `1px solid ${c.border}` }} data-testid="quotes-panel">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full text-left font-extrabold uppercase tracking-tight text-base flex items-center gap-2">
        <FileText size={16} style={{ color: GOLD }} /> Quote requests
        {rows && counts.new > 0 && <span className="font-body text-xs font-semibold normal-case" style={{ color: GOLD }}>({counts.new} new)</span>}
      </button>
      {open && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {[["new", "New"], ["quoted", "Quoted"], ["ordered", "Ordered"], ["closed", "Closed"], ["all", "All"]].map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={chip(filter === k)}>{l} {counts[k] || 0}</button>
            ))}
          </div>
          {rows === null && <div className="font-body text-xs" style={{ color: c.textDim }}>Loading…</div>}
          {rows && shown.length === 0 && <div className="font-body text-xs" style={{ color: c.textDim }}>Nothing here.</div>}
          <div className="space-y-2.5">
            {shown.map((r) => <QuoteRow key={r.id + r.status + (r.quote_amount ?? "")} r={r} isAdmin={isAdmin} business={business} showToast={showToast} onChanged={load} onOrderCreated={onOrderCreated} c={c} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function QuoteRow({ r, isAdmin, business, showToast, onChanged, onOrderCreated, c }) {
  const [amount, setAmount] = useState(r.quote_amount ?? "");
  const [note, setNote] = useState(r.admin_note || "");
  const [busy, setBusy] = useState(false);
  const update = async (patch, okMsg) => {
    setBusy(true);
    const { error } = await supabase.from("shop_quote_requests").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", r.id);
    setBusy(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    showToast(okMsg); onChanged();
  };
  const saveQuote = () => {
    const n = Number(amount);
    if (!(n > 0)) { showToast("Enter the quoted price first."); return; }
    update({ status: "quoted", quote_amount: n, admin_note: note.trim() || null }, `${r.ref} marked quoted.`);
  };
  const createOrder = async () => {
    if (!window.confirm(`Create an order for ${rand(r.quote_amount)} from ${r.ref}? The customer then pays you as usual.`)) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("admin_create_order_from_quote", { p_quote_id: r.id });
    setBusy(false);
    if (error) { showToast(error.message || "Couldn't create the order."); return; }
    showToast(`Order ${data?.order_number || ""} created from ${r.ref}.`);
    onChanged(); onOrderCreated && onOrderCreated();
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${r.ref}?`)) return;
    const { error } = await supabase.from("shop_quote_requests").delete().eq("id", r.id);
    if (error) { showToast("Couldn't delete it."); return; }
    onChanged();
  };
  const text = r.quote_amount
    ? `Hi ${r.buyer_name}, here is your quote ${r.ref} from ${business?.name || "WeAfrica Shop"}: ${r.qty} x ${r.product_name} = ${rand(r.quote_amount)}.${r.admin_note ? ` ${r.admin_note.trim().replace(/[.!?]*$/, ".")}` : ""} You can see and accept it online: ${QUOTE_LINK_BASE}?quote=${r.ref} (use this phone number or email to open it). Or reply YES to go ahead.`
    : `Hi ${r.buyer_name}, thanks for your request ${r.ref} for ${r.qty} x ${r.product_name}. We're working on your quote and will send it shortly.`;
  const wa = waNumber(r.contact_phone);
  const link = wa ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}`
    : r.contact_email ? `mailto:${r.contact_email}?subject=${encodeURIComponent(`Your quote ${r.ref}`)}&body=${encodeURIComponent(text)}` : null;
  const inputStyle = { background: c.bg, borderColor: c.border, color: c.text };

  return (
    <div className="rounded-lg p-3 font-body text-xs" style={{ background: c.surface, opacity: r.status === "closed" ? 0.6 : 1 }} data-testid="quote-row">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono font-bold text-sm" style={{ color: GOLD }}>{r.ref}</span>
        <span className="font-semibold" style={{ color: r.status === "new" ? GOLD : c.textDim }}>{STATUS[r.status]}</span>
      </div>
      <div className="font-semibold text-sm mt-1">{r.qty} x {r.product_name}</div>
      <div className="whitespace-pre-wrap break-words mt-1" style={{ color: c.text }}>{r.details}</div>
      <div className="mt-1.5" style={{ color: c.textDim }}>{r.buyer_name} · {[r.contact_phone, r.contact_email].filter(Boolean).join(" · ")} · {new Date(r.created_at).toLocaleDateString("en-ZA")}</div>
      {(r.status === "new" || r.status === "quoted") && (
        <div className="flex flex-wrap items-center gap-2 mt-2.5">
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Quote R" aria-label={`Quote amount for ${r.ref}`} className="w-28 border rounded-lg px-2.5 py-1.5 outline-none" style={inputStyle} />
          <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} placeholder="Note to customer (optional)" aria-label={`Note for ${r.ref}`} className="flex-1 min-w-[8rem] border rounded-lg px-2.5 py-1.5 outline-none" style={inputStyle} />
          <button onClick={saveQuote} disabled={busy} className="font-semibold px-3 py-1.5 rounded-full" style={{ background: GOLD, color: "#1a1200" }}>Save quote</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 mt-2.5">
        {link && <a href={link} target="_blank" rel="noopener noreferrer" className="underline font-semibold">{r.quote_amount ? "Send quote" : "Reply"}</a>}
        {r.status === "quoted" && r.quote_amount > 0 && (
          <button onClick={createOrder} disabled={busy} data-testid="create-order" className="font-semibold px-3 py-1.5 rounded-full" style={{ background: c.greenSoft, color: c.greenText }}>Create order</button>
        )}
        {r.status === "ordered" && <span className="font-semibold" data-testid="quote-order-number" style={{ color: c.greenText }}>Order {r.order?.order_number || ""} created ({rand(r.quote_amount)})</span>}
        {r.status === "ordered" ? null : r.status !== "closed"
          ? <button onClick={() => update({ status: "closed" }, `${r.ref} closed.`)} disabled={busy} className="underline">Close</button>
          : <button onClick={() => update({ status: r.quote_amount ? "quoted" : "new" }, `${r.ref} reopened.`)} disabled={busy} className="underline">Reopen</button>}
        {isAdmin && <button onClick={remove} aria-label={`Delete ${r.ref}`} className="ml-auto"><Trash2 size={13} style={{ color: c.red }} /></button>}
      </div>
    </div>
  );
}

// Customer side: look up a quote with its reference plus the phone or email
// given when asking, then accept it. Accepting creates a normal order that
// then waits for payment.
export function QuoteLookup({ initialRef, eftDetails, onAccepted, onTrack, c }) {
  const [ref, setRef] = useState(initialRef || "");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState(undefined); // undefined = not searched, null = not found
  const [error, setError] = useState("");
  const [placed, setPlaced] = useState(null); // { order_number, total }
  const input = "w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none";
  const style = { background: c.surface, borderColor: c.border, color: c.text };
  const ready = ref.trim() && contact.trim();

  const find = async (e) => {
    e && e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(""); setPlaced(null);
    const { data, error: err } = await supabase.rpc("lookup_shop_quote", { p_ref: ref, p_contact: contact });
    setBusy(false);
    setQuote(err ? null : data);
  };
  const accept = async () => {
    if (!window.confirm(`Accept this quote for ${rand(quote.quote_amount)}? We'll create your order and you can pay.`)) return;
    setBusy(true); setError("");
    const { data, error: err } = await supabase.rpc("accept_shop_quote", { p_ref: ref, p_contact: contact });
    setBusy(false);
    if (err) { setError(err.message || "Couldn't accept the quote."); return; }
    setPlaced(data); onAccepted && onAccepted(data.order_number);
  };

  return (
    <div data-testid="quote-lookup">
      <div className="flex items-center gap-2 mb-1.5">
        <FileText size={20} style={{ color: GOLD }} />
        <h1 className="text-2xl font-extrabold tracking-tight leading-none">Your quote</h1>
      </div>
      <p className="font-body text-sm mb-5" style={{ color: c.textDim }}>Enter your quote reference and the phone number or email you gave when you asked for it.</p>
      <form onSubmit={find} className="space-y-3 mb-5">
        <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="QT-1001" aria-label="Quote reference" autoCapitalize="characters" className={input} style={style} />
        <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Phone number or email" aria-label="Phone or email" className={input} style={style} />
        <button type="submit" disabled={busy || !ready} className="w-full font-body text-sm font-semibold py-3 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: busy || !ready ? 0.6 : 1 }}>
          {busy && !placed ? "Looking…" : "Find my quote"}
        </button>
      </form>

      {quote === null && <div className="font-body text-sm text-center py-4" style={{ color: c.textDim }}>We couldn't find that quote. Check the reference and the phone or email you used.</div>}

      {quote && !placed && (
        <div className="rounded-xl p-4 border font-body" style={{ background: c.surface, borderColor: c.border }} data-testid="quote-card">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono font-bold text-base" style={{ color: GOLD }}>{quote.ref}</span>
            <span className="text-xs font-semibold" style={{ color: c.textDim }}>{STATUS[quote.status]}</span>
          </div>
          <div className="font-semibold text-sm mt-1.5">{quote.qty} x {quote.product_name}</div>
          <div className="text-xs mt-1 whitespace-pre-wrap break-words" style={{ color: c.textDim }}>{quote.details}</div>
          {quote.status === "new" && <div className="text-sm mt-3" style={{ color: c.textDim }}>We're still working on your price. We'll message you as soon as it's ready.</div>}
          {quote.status === "closed" && <div className="text-sm mt-3" style={{ color: c.textDim }}>This quote has been closed. Message us if you'd still like it.</div>}
          {(quote.status === "quoted" || quote.status === "ordered") && quote.quote_amount > 0 && (
            <div className="mt-3 pt-3 border-t" style={{ borderColor: c.border }}>
              <div className="text-xs" style={{ color: c.textDim }}>Our price</div>
              <div className="font-mono text-2xl font-bold" style={{ color: c.text }} data-testid="quote-price">{rand(quote.quote_amount)}</div>
              {quote.admin_note && <div className="text-xs mt-1" style={{ color: c.textDim }}>{quote.admin_note}</div>}
            </div>
          )}
          {quote.status === "quoted" && quote.quote_amount > 0 && (
            <>
              {error && <div role="alert" className="text-xs mt-3" style={{ color: c.red }}>{error}</div>}
              <button onClick={accept} disabled={busy} data-testid="accept-quote" className="w-full mt-3 font-body text-sm font-semibold py-3 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: busy ? 0.6 : 1 }}>
                {busy ? "Working…" : `Accept quote · ${rand(quote.quote_amount)}`}
              </button>
              <div className="text-[11px] text-center mt-2" style={{ color: c.textFaint }}>Nothing is charged until you pay. Questions? Reply to our message.</div>
            </>
          )}
          {quote.status === "ordered" && (
            <div className="mt-3 text-sm" style={{ color: c.greenText }}>
              Order <b className="font-mono">{quote.order_number}</b> was created from this quote.
              {onTrack && <button onClick={onTrack} className="block underline mt-1.5" style={{ color: c.text }}>Track this order</button>}
            </div>
          )}
        </div>
      )}

      {placed && (
        <div className="rounded-xl p-4 border font-body text-center" style={{ background: c.surface, borderColor: c.border }} data-testid="quote-accepted">
          <CheckCircle2 size={30} className="mx-auto mb-2" style={{ color: c.greenText }} />
          <div className="font-bold text-base">Quote accepted</div>
          <div className="text-xs mt-2" style={{ color: c.textFaint }}>Your order number</div>
          <div className="font-mono text-xl font-bold" style={{ color: GOLD }}>{placed.order_number}</div>
          <div className="text-sm mt-1">Total {rand(placed.total)}</div>
          {eftDetails ? (
            <div className="text-left text-xs mt-3 rounded-lg p-3 whitespace-pre-line" style={{ background: c.bg, color: c.textDim }}>
              <div className="font-semibold mb-1" style={{ color: c.text }}>How to pay</div>
              {eftDetails.replace(/Reference:.*$/im, `Reference: ${placed.order_number}`)}
            </div>
          ) : <p className="text-xs mt-3" style={{ color: c.textDim }}>We'll send you the payment details on WhatsApp.</p>}
          <p className="text-xs mt-3" style={{ color: c.textDim }}>Send your proof of payment to us, quoting the order number. We start once it's confirmed.</p>
          {onTrack && <button onClick={onTrack} className="mt-3 text-sm font-semibold underline">Track my order</button>}
        </div>
      )}
    </div>
  );
}
