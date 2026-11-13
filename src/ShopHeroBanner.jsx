// The big "WeAfrica Shop" hero banner with real product photos bouncing
// around inside it. Used at the top of the guest/login page (App.jsx) and at
// the top of the shop home (Shop.jsx), so it lives in its own small file that
// both can import without pulling in the other.
import React, { useState, useEffect, useRef } from "react";
import { ShoppingBag, Shirt, Package, Tag, ChevronRight } from "lucide-react";
import { supabase } from "./supabaseClient";
import { toProxiedUrl } from "./utils/mediaUrl";

const SHOP_GOLD = "#D4A017";
const SHOP_NAME = "WeAfrica Shop";
// Product ids the banner showed last visit, so the next visit picks different ones.
const BANNER_SEEN_KEY = "weafrica-banner-products-v1";

// Real shop products (photos) that drift and bounce off every edge of the
// hero banner, in all directions (DVD-screensaver style), with a slight tilt.
// Pulls a random handful of active products that have a photo; until they
// load (or if there are none / the fetch fails) it shows the gold icons
// instead. Driven by requestAnimationFrame writing transforms straight to the
// DOM, so React doesn't re-render 60 times a second. Sits behind the banner
// text; pointer events are off so the whole card stays one tap target.
// Honors prefers-reduced-motion by leaving them still.
export function BouncingProducts() {
  const wrapRef = useRef(null);
  const [products, setProducts] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.from("shop_products")
          .select("id, name, price, image_url").eq("active", true).not("image_url", "is", null).limit(300);
        const withPhoto = (data || []).filter((p) => p.image_url);
        // Fisher-Yates shuffle.
        for (let i = withPhoto.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [withPhoto[i], withPhoto[j]] = [withPhoto[j], withPhoto[i]];
        }
        // Show a different set on every visit: products shown last time go to
        // the back of the line (a stable sort keeps the shuffle otherwise), so
        // as long as there are enough products none repeat back-to-back.
        let lastShown = [];
        try { lastShown = JSON.parse(localStorage.getItem(BANNER_SEEN_KEY) || "[]"); } catch (e) { /* ignore */ }
        withPhoto.sort((a, b) => (lastShown.includes(a.id) ? 1 : 0) - (lastShown.includes(b.id) ? 1 : 0));
        const picked = withPhoto.slice(0, 5);
        try { localStorage.setItem(BANNER_SEEN_KEY, JSON.stringify(picked.map((p) => p.id))); } catch (e) { /* ignore */ }
        if (!cancelled) setProducts(picked);
      } catch (e) { if (!cancelled) setProducts([]); }
    })();
    return () => { cancelled = true; };
  }, []);

  const useIcons = !products || products.length === 0;
  const count = useIcons ? 4 : products.length;
  const ICON_SIZES = [22, 26, 20, 24];
  const PHOTO = 56;
  const PHOTO_H = PHOTO + 22; // photo + price tag underneath

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const els = Array.from(wrap.children);
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const items = els.map((el, i) => {
      const ang = Math.random() * Math.PI * 2;
      const speed = 34 + Math.random() * 28; // px per second
      return {
        el, size: useIcons ? ICON_SIZES[i % ICON_SIZES.length] : PHOTO, sizeH: useIcons ? ICON_SIZES[i % ICON_SIZES.length] : PHOTO_H,
        x: 0, y: 0, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        phase: Math.random() * Math.PI * 2, placed: false,
      };
    });
    let raf = 0, last = 0, clock = 0;
    const tick = (t) => {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
      last = t; clock += dt;
      items.forEach((it) => {
        const maxX = Math.max(0, w - it.size), maxY = Math.max(0, h - it.sizeH);
        if (!it.placed) { it.x = Math.random() * maxX; it.y = Math.random() * maxY; it.placed = true; }
        if (!reduce) {
          it.x += it.vx * dt; it.y += it.vy * dt;
          if (it.x <= 0) { it.x = 0; it.vx = Math.abs(it.vx); }
          else if (it.x >= maxX) { it.x = maxX; it.vx = -Math.abs(it.vx); }
          if (it.y <= 0) { it.y = 0; it.vy = Math.abs(it.vy); }
          else if (it.y >= maxY) { it.y = maxY; it.vy = -Math.abs(it.vy); }
        }
        const rot = useIcons ? clock * 40 + it.phase * 57 : Math.sin(clock * 1.6 + it.phase) * 9;
        if (useIcons) {
          it.el.style.transform = `translate(${it.x}px, ${it.y}px) rotate(${rot}deg)`;
        } else {
          // Only the photo tilts; the price tag stays level so it reads clearly.
          it.el.style.transform = `translate(${it.x}px, ${it.y}px)`;
          if (it.el.firstChild) it.el.firstChild.style.transform = `rotate(${rot}deg)`;
        }
      });
      if (!reduce) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [useIcons, count]);

  if (useIcons) {
    const icons = [ShoppingBag, Shirt, Package, Tag];
    return (
      <div ref={wrapRef} className="absolute inset-0">
        {icons.map((Icon, i) => (
          <Icon key={i} size={ICON_SIZES[i]} className="absolute top-0 left-0" style={{ color: SHOP_GOLD, opacity: 0.85, filter: `drop-shadow(0 0 6px ${SHOP_GOLD}99)`, willChange: "transform" }} />
        ))}
      </div>
    );
  }
  return (
    <div ref={wrapRef} className="absolute inset-0" style={{ zIndex: 5 }}>
      {products.map((p) => (
        <div key={p.id} className="absolute top-0 left-0" style={{ width: PHOTO, height: PHOTO_H, willChange: "transform" }}>
          <img src={toProxiedUrl(p.image_url)} alt="" draggable={false}
            className="object-cover rounded-xl"
            style={{ width: PHOTO, height: PHOTO, border: `2px solid ${SHOP_GOLD}`, boxShadow: `0 4px 14px rgba(0,0,0,0.35), 0 0 12px ${SHOP_GOLD}66` }} />
          {p.price != null && (
            <span className="absolute left-1/2 whitespace-nowrap font-mono text-[12px] font-extrabold leading-none px-2 py-1 rounded-full"
              style={{ top: PHOTO + 4, transform: "translateX(-50%)", background: SHOP_GOLD, color: "#1a1200", boxShadow: "0 2px 8px rgba(0,0,0,0.5)" }}>
              {`R${Number(p.price).toLocaleString("en-ZA")}`}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// Big, bold "WeAfrica Shop" banner for the very top of the guest/login page.
// Same gold store identity as ShopBanner (SHOP_GOLD) but much larger and
// title-led, so the shop is the first thing a visitor sees. The whole card
// is the tap target; open to guests, no account needed.
export function ShopHeroBanner({ onOpen, c, cta = "Shop now" }) {
  return (
    <section onClick={onOpen} role="button" tabIndex={0} aria-label={`Open ${SHOP_NAME}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="relative mt-4 rounded-3xl overflow-hidden cursor-pointer active:scale-[0.98] transition-transform"
      style={{ background: `linear-gradient(135deg, ${SHOP_GOLD}55, ${SHOP_GOLD}1A 55%, ${c.surface})`, border: `1.5px solid ${SHOP_GOLD}99` }}>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-glow-drift absolute -top-20 -right-12 w-56 h-56 rounded-full blur-3xl" style={{ background: SHOP_GOLD, opacity: 0.35 }} />
        <div className="animate-glow-drift absolute -bottom-24 -left-16 w-48 h-48 rounded-full blur-3xl" style={{ background: SHOP_GOLD, opacity: 0.18, animationDelay: "2s" }} />
        <BouncingProducts />
      </div>
      <div className="relative px-5 py-7 sm:py-9">
        <div className="font-mono text-[11px] tracking-[0.25em] uppercase mb-2" style={{ color: SHOP_GOLD }}>Official store</div>
        <div className="font-extrabold uppercase tracking-tight leading-[0.95] text-[2.6rem] sm:text-6xl" style={{ color: c.text }}>
          WeAfrica<br /><span style={{ color: SHOP_GOLD }}>Shop</span>
        </div>
        <p className="font-body text-sm sm:text-base mt-3 max-w-xs" style={{ color: c.textDim }}>Kits, jerseys & gear — open to everyone, no account needed.</p>
        <span className="inline-flex items-center gap-2 mt-5 font-body text-sm font-bold px-6 py-3 rounded-full shadow-lg" style={{ background: SHOP_GOLD, color: "#1a1200" }}>
          {cta} <ChevronRight size={16} />
        </span>
      </div>
    </section>
  );
}
