// Admin panel: the link Facebook / Instagram's Commerce Manager reads to keep
// the shop catalogue in sync (see api/shop-feed.js), plus the setup steps and
// a heads-up about products Meta would reject.
import React, { useState } from "react";
import { ChevronDown, ChevronUp, Copy, ExternalLink } from "lucide-react";

export default function CatalogueFeedPanel({ products, photosOf, showToast, c }) {
  const [open, setOpen] = useState(false);
  const url = `${window.location.origin}/shop-feed.xml`;
  const live = (products || []).filter((p) => p.active && !p.exclude_from_catalogue && !p.quote_only);
  const left = (products || []).filter((p) => p.active && p.exclude_from_catalogue).length;
  const noPhoto = live.filter((p) => photosOf(p).length === 0);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); showToast("Feed link copied."); }
    catch { window.prompt("Copy this link:", url); }
  };
  return (
    <div className="rounded-xl border mb-4" style={{ background: c.surface, borderColor: c.border }} data-testid="catalogue-panel">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-3.5 py-3 font-body text-sm font-semibold" aria-expanded={open}>
        <span>Facebook and Instagram catalogue</span>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="px-3.5 pb-3.5 font-body text-xs space-y-3" style={{ color: c.textDim }}>
          <p>One link that keeps your whole shop in your Facebook catalogue. Meta re-reads it by itself, so new products, prices and stock follow along.</p>
          <div className="flex items-center gap-2">
            <input readOnly value={url} aria-label="Catalogue feed link" onFocus={(e) => e.target.select()}
              className="flex-1 min-w-0 border rounded-lg px-2.5 py-2 font-mono text-[11px]" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
            <button onClick={copy} className="shrink-0 font-semibold px-3 py-2 rounded-full flex items-center gap-1.5" style={{ background: c.surfaceHover, color: c.text }}><Copy size={12} /> Copy</button>
          </div>
          <ol className="list-decimal pl-4 space-y-1">
            <li>Open <a href="https://business.facebook.com/commerce" target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-0.5" style={{ color: c.text }}>Commerce Manager <ExternalLink size={10} /></a> and pick your catalogue (or create one).</li>
            <li>Go to Catalogue, then Data sources, then Add items, then Data feed.</li>
            <li>Choose "Scheduled feed", paste the link above, set it to update daily and the currency to ZAR.</li>
            <li>Save. Meta shows how many items it imported and flags any problems.</li>
          </ol>
          <p><b style={{ color: c.text }}>{live.length - noPhoto.length}</b> of {live.length} product{live.length === 1 ? "" : "s"} will be included.{left > 0 && <> {left} you excluded in the product editor {left === 1 ? "is" : "are"} left out.</>}
            {noPhoto.length > 0 && <> Meta needs a photo on every item, so these are left out until they get one: {noPhoto.slice(0, 5).map((p) => p.name).join(", ")}{noPhoto.length > 5 ? ` and ${noPhoto.length - 5} more` : ""}.</>}
            {" "}Products with sizes or colours appear once per option. Hidden products are never included. To keep one out, tick "Exclude from Facebook / Instagram catalogue" when editing it.</p>
        </div>
      )}
    </div>
  );
}
