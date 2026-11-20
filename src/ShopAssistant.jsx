// A free shop helper that answers from the shop's own information: policies,
// contact details and the product list. It uses no outside AI service, so it
// costs nothing to run. Anything it can't answer is handed to WhatsApp.
import React, { useState, useRef, useEffect } from "react";
import { MessageCircle, X, Send } from "lucide-react";
import { searchProducts } from "./ShopSearch.js";

const GOLD = "#D4A017";

const STOP = new Set(("do you have a an the is are of for to i me my we want need looking look find show got any some please can could would " +
  "how much does cost price what which where when who it in on at with about buy get sell selling available stock hi hello hey").split(" "));

const has = (q, words) => words.some((w) => q.includes(w));

// Works out a reply. Pure function so it is easy to test.
// ctx: { products, policies, business, whatsapp, formatMoney }
export function shopAnswer(raw, ctx) {
  const q = ` ${String(raw || "").toLowerCase().replace(/[^a-z0-9\s+]/g, " ").replace(/\s+/g, " ").trim()} `;
  const { products = [], policies = {}, business = {}, whatsapp = "" } = ctx;
  const policy = (key, label) => (policies[key] || "").trim()
    ? { text: policies[key].trim(), title: label }
    : { text: `We haven't published our ${label.toLowerCase()} policy yet. Please message us on WhatsApp and we'll help.`, whatsapp: true };

  if (has(q, [" track", "where is my order", "my order", "order status", "order number", " wa-"])) return { text: "You can follow your order with your order number and the phone number or email you used.", action: "track" };
  if (has(q, [" refund", " return", " cancel", "exchange", "money back", "faulty", "damaged", "wrong item", "cooling"])) return policy("returns", "Returns & refunds");
  if (has(q, [" ship", " deliver", "courier", "pudo", "paxi", "postage", " post ", "how long", "tracking number", " collect"])) return policy("shipping", "Shipping & delivery");
  if (has(q, ["privacy", "popia", "personal info", "my data", "my details", "data protection"])) return policy("privacy", "Privacy");
  if (has(q, [" terms", "conditions"])) return policy("terms", "Terms of sale");
  if (has(q, [" contact", " phone", " call ", " email", "number", "address", "where are you", "whatsapp", "speak to", "talk to", "human", "person"])) {
    const lines = [business.phone && `Phone: ${business.phone}`, business.email && `Email: ${business.email}`, business.address && `Address: ${business.address}`].filter(Boolean);
    return { text: lines.length ? `${lines.join("\n")}\nOr message us on WhatsApp and we'll reply as soon as we can.` : "Message us on WhatsApp and we'll reply as soon as we can.", whatsapp: true };
  }
  const bigNumber = /\b(\d{2,}|[6-9])\b/.test(q) && has(q, ["buy", "want", "need", "order", "get"]);
  if (has(q, ["quote", "bulk", "wholesale", "in bulk", "many", "team kit", "custom", "personalis", "personaliz", "print"]) || bigNumber) return { text: "For 6 or more of an item, or for printed or personalised orders, open the product and choose to request a quote. You can also message us on WhatsApp with the product and the quantity you want.", whatsapp: true };
  if (has(q, ["discount", "coupon", "promo", "voucher", "code"])) return { text: "If you have a discount code, enter it in the box at checkout and press Apply. The saving shows before you pay." };
  if (has(q, [" pay", "card", " eft", "bank", "payment"])) return { text: "You choose how to pay at checkout. The options we offer for your order are shown there before you confirm. If you have trouble paying, message us on WhatsApp." , whatsapp: true };
  if (has(q, ["vat", "tax invoice", "invoice", "receipt"])) return { text: "Once your order is placed, open Track order or My orders to view and print your invoice or receipt." };

  if (/^ (hi|hello|hey|howzit|sawubona|molo|good (morning|afternoon|evening)|thanks|thank you)( there)? $/.test(q)) return { text: "Hi! Ask me about shipping, returns, tracking an order, or tell me what product you're looking for." };

  const terms = q.split(" ").filter((w) => w && !STOP.has(w)).join(" ");
  if (terms) {
    const found = searchProducts(products.filter((p) => p.active !== false), terms).slice(0, 3);
    if (found.length) return { text: found.length === 1 ? "I found this:" : "Here's what I found:", products: found };
  }
  return { text: "I'm not sure about that one. I can help with shipping, returns, privacy, tracking an order or finding a product, or you can message us on WhatsApp.", whatsapp: true };
}

const QUICK = [["Track my order", "track my order"], ["Shipping", "shipping"], ["Returns & refunds", "returns"], ["Contact us", "contact"]];

export default function ShopAssistant({ products, policies, business, whatsapp, formatMoney, onTrack, onOpenProduct, c }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState([{ from: "bot", text: "Hi! I can help with shipping, returns, tracking an order or finding a product. What do you need?" }]);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [msgs, open]);
  const wa = (whatsapp || "").replace(/\D/g, "");
  const fmt = formatMoney || ((n) => `R${Number(n).toFixed(2)}`);

  const ask = (text) => {
    const t = String(text || "").trim();
    if (!t) return;
    const reply = shopAnswer(t, { products, policies, business, whatsapp });
    setMsgs((m) => [...m, { from: "me", text: t }, { from: "bot", ...reply }]);
    setInput("");
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} aria-label="Open shop helper" data-testid="assistant-open"
        className="fixed bottom-5 left-4 z-40 h-12 px-4 rounded-full flex items-center gap-2 shadow-lg font-body text-sm font-semibold"
        style={{ background: GOLD, color: "#1a1200" }}>
        <MessageCircle size={18} /> Help
      </button>
    );
  }
  return (
    <div role="dialog" aria-label="Shop helper" data-testid="assistant-panel"
      className="fixed bottom-4 left-4 right-4 sm:right-auto sm:w-[360px] z-40 rounded-2xl border shadow-2xl flex flex-col max-h-[75vh]"
      style={{ background: c.bg, borderColor: c.border, color: c.text }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: c.border }}>
        <div className="font-body text-sm font-bold">Shop helper</div>
        <button onClick={() => setOpen(false)} aria-label="Close shop helper" className="p-1"><X size={18} /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
        {msgs.map((m, i) => (
          <div key={i} className={m.from === "me" ? "flex justify-end" : "flex justify-start"}>
            <div className="max-w-[88%] rounded-2xl px-3 py-2 font-body text-sm whitespace-pre-line"
              style={m.from === "me" ? { background: GOLD, color: "#1a1200" } : { background: c.surface, color: c.text, border: `1px solid ${c.border}` }}>
              {m.title && <div className="font-bold mb-1">{m.title}</div>}
              {m.text}
              {m.action === "track" && <button onClick={() => { onTrack && onTrack(); setOpen(false); }} className="block mt-2 underline font-semibold" style={{ color: GOLD }}>Open Track order</button>}
              {m.products && m.products.map((p) => (
                <button key={p.id} onClick={() => { onOpenProduct && onOpenProduct(p); setOpen(false); }} className="block w-full text-left mt-2 rounded-lg px-2 py-1.5 border" style={{ borderColor: c.border }}>
                  <span className="font-semibold">{p.name}</span>
                  <span className="block text-xs" style={{ color: c.textDim }}>{p.quote_only ? "Price on request" : fmt(p.price)}</span>
                </button>
              ))}
              {m.whatsapp && wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="block mt-2 underline font-semibold" style={{ color: GOLD }}>Chat on WhatsApp</a>}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="px-3 pt-1 flex flex-wrap gap-1.5">
        {QUICK.map(([label, q]) => (
          <button key={label} onClick={() => ask(q)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }}>{label}</button>
        ))}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); ask(input); }} className="flex items-center gap-2 p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question or search a product" aria-label="Your question" data-testid="assistant-input"
          className="flex-1 font-body text-sm px-3 py-2 rounded-full outline-none border" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button type="submit" aria-label="Send" className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: GOLD, color: "#1a1200" }}><Send size={16} /></button>
      </form>
    </div>
  );
}
