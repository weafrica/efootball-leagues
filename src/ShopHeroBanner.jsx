// The "WeAfrica Shop" banner. Used at the top of the guest/login page
// (App.jsx) and at the top of the shop home (Shop.jsx), so it lives in its
// own small file that both can import without pulling in the other.
//
// Calm and storefront-like: solid surface, a thin gold accent, clear text,
// one primary button, and a tidy row of real product photos with prices (no
// animation). The whole card is the tap target; open to guests.
import React, { useState, useEffect } from "react";
import { ChevronRight, ImageIcon } from "lucide-react";
import { supabase } from "./supabaseClient";
import { toProxiedUrl } from "./utils/mediaUrl";

const SHOP_GOLD = "#D4A017";
const SHOP_NAME = "WeAfrica Shop";
// Product ids shown last visit, so the next visit picks different ones.
const BANNER_SEEN_KEY = "weafrica-banner-products-v1";

// Pure: pick up to n products with a photo, preferring ones not shown last
// time. `random` is injectable so it can be tested.
export function pickFeatured(products, lastShown = [], n = 4, random = Math.random) {
  const withPhoto = (products || []).filter((p) => p && p.image_url);
  for (let i = withPhoto.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [withPhoto[i], withPhoto[j]] = [withPhoto[j], withPhoto[i]];
  }
  withPhoto.sort((a, b) => (lastShown.includes(a.id) ? 1 : 0) - (lastShown.includes(b.id) ? 1 : 0));
  return withPhoto.slice(0, n);
}

function useFeaturedProducts(n = 4) {
  const [products, setProducts] = useState(null); // null = loading
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.from("shop_products")
          .select("id, name, price, image_url").eq("active", true).not("image_url", "is", null).limit(300);
        let lastShown = [];
        try { lastShown = JSON.parse(localStorage.getItem(BANNER_SEEN_KEY) || "[]"); } catch (e) { /* ignore */ }
        const picked = pickFeatured(data, lastShown, n);
        try { localStorage.setItem(BANNER_SEEN_KEY, JSON.stringify(picked.map((p) => p.id))); } catch (e) { /* ignore */ }
        if (!cancelled) setProducts(picked);
      } catch (e) { if (!cancelled) setProducts([]); }
    })();
    return () => { cancelled = true; };
  }, [n]);
  return products;
}

function FeaturedTiles({ products, c }) {
  if (products && products.length === 0) return null;
  const tiles = products || [null, null, null, null];
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 md:w-[46%] md:shrink-0" data-testid="banner-featured">
      {tiles.map((p, i) => (
        <div key={p ? p.id : i} className={`min-w-0 ${i === 3 ? "hidden sm:block" : ""}`}>
          <div className="aspect-square rounded-lg overflow-hidden flex items-center justify-center" style={{ background: c.surfaceHover, border: `1px solid ${c.border}` }}>
            {p ? <img src={toProxiedUrl(p.image_url)} alt={p.name || ""} loading="lazy" draggable={false} className="w-full h-full object-cover" />
               : <ImageIcon size={16} style={{ color: c.textFaint }} />}
          </div>
          {p ? (
            <div className="mt-1.5 min-w-0">
              <div className="font-body text-[11px] leading-tight truncate" style={{ color: c.textDim }}>{p.name}</div>
              {p.price != null && <div className="font-mono text-xs font-bold mt-0.5" style={{ color: c.text }}>{`R${Number(p.price).toLocaleString("en-ZA")}`}</div>}
            </div>
          ) : <div className="mt-1.5 h-3 rounded w-2/3" style={{ background: c.surfaceHover }} />}
        </div>
      ))}
    </div>
  );
}

export function ShopHeroBanner({ onOpen, c, cta = "Shop now", tagline = "Kits, jerseys & gear — open to everyone, no account needed.", compact = false }) {
  const products = useFeaturedProducts(4);
  return (
    <section onClick={onOpen} role="button" tabIndex={0} aria-label={`Open ${SHOP_NAME}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className={`relative ${compact ? "mt-0" : "mt-4"} rounded-2xl overflow-hidden cursor-pointer`}
      style={{ background: c.surface, border: `1px solid ${c.border}` }} data-testid="shop-banner">
      <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: SHOP_GOLD }} />
      <div className={`relative flex flex-col md:flex-row md:items-center gap-5 md:gap-8 pl-6 pr-5 ${compact ? "py-5" : "py-6 sm:py-7"}`}>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] tracking-[0.22em] uppercase mb-1.5" style={{ color: SHOP_GOLD }}>Official store</div>
          <h2 className={`font-extrabold tracking-tight leading-tight ${compact ? "text-2xl sm:text-3xl" : "text-3xl sm:text-4xl"}`} style={{ color: c.text }}>
            {SHOP_NAME}
          </h2>
          <p className="font-body text-sm mt-1.5 max-w-md" style={{ color: c.textDim }}>{tagline}</p>
          <span className="inline-flex items-center gap-1.5 mt-4 font-body text-sm font-semibold px-5 py-2.5 rounded-lg" style={{ background: SHOP_GOLD, color: "#1a1200" }}>
            {cta} <ChevronRight size={15} />
          </span>
        </div>
        <FeaturedTiles products={products} c={c} />
      </div>
    </section>
  );
}
