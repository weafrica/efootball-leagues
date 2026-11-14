import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";
import { compressImage } from "./utils/imageCompress";
import { toProxiedUrl } from "./utils/mediaUrl";
import { uploadToR2 } from "./utils/r2Upload";
import { ShopHeroBanner } from "./ShopHeroBanner.jsx";
import ProductReviews, { StarRow } from "./ShopReviews.jsx";
import BackgroundRemover from "./BackgroundRemover.jsx";
import {
  ArrowLeft, X, Plus, Minus, Trash2, Upload, CheckCircle2, XCircle, Clock,
  Package, Settings2, MessageCircle, CreditCard, Lock, ShoppingCart, ShoppingBag,
  Search, ClipboardList, Image as ImageIcon, Truck, LayoutGrid, ChevronUp, ChevronDown, Share2, Trophy, ChevronRight,
  AlertTriangle, Facebook, Wand2,
} from "lucide-react";

// ════════════════════════════════════════════════════════════════════
// SHOP CONFIGURATION — edit these as the real store comes together.
// Nothing below this block needs to change for that.
// ════════════════════════════════════════════════════════════════════

// WhatsApp number orders get sent to for the "Order on WhatsApp" checkout
// option. Digits only, with country code, no spaces or symbols — e.g. a
// South African number would be "27821234567". Leave blank to hide that
// checkout option entirely.
export const SHOP_WHATSAPP_NUMBER = "+27694362789";

// EFT / bank-transfer details are no longer hard-coded: the admin edits them
// in Orders > "Bank details shown at checkout" and they're stored in the
// shop_settings table (key "eft_details"). Blank = the bank block is hidden.

// Shown next to the EFT details as an alternative way to pay manually.
export const SHOP_MUKURU_DETAILS = `Receiver name: Saul
Receiver phone: +27694362789
Reference: your order number (shown after you submit)`;

// Flip to true once a real payment gateway (Paystack, Flutterwave, Yoco,
// etc.) is wired up in payWithGateway() below. Until then the card option
// is visible but disabled, so nothing breaks in production.
export const SHOP_GATEWAY_ENABLED = false;

// iKhokha Pay Link — a reusable link where the buyer enters the amount
// themselves. We open it in a new tab and log the order as pending review,
// same as the WhatsApp flow, since a static link has no automatic
// payment-confirmation callback back into this app. Leave blank to hide
// this checkout option.
export const SHOP_IKHOKHA_LINK = "https://pay.ikhokha.com/weafrica/mpr/weafrica";

const SHOP_GOLD = "#D4A017";
const CURRENCY_PREFIX = "R"; // South African Rand — change if selling elsewhere
const formatMoney = (n) => `${CURRENCY_PREFIX}${Number(n).toLocaleString("en-ZA")}`;

// Options (variants), quantity prices and photos. The server re-prices every
// order with the same rules (shop_unit_price), this only mirrors them for display.
const activeVariants = (p) => (p?.variants || []).filter((v) => v.active);
// A product can sit in several departments and categories (dept_ids / cat_ids,
// filled in by loadProducts); department_id / category_id are its main ones.
const productDepts = (p) => p.dept_ids || (p.department_id ? [p.department_id] : []);
const productCats = (p) => p.cat_ids || (p.category_id ? [p.category_id] : []);
const lineKey = (it) => `${it.productId}:${it.variantId || ""}`;
const unitPriceFor = (product, variantId, totalQty) => {
  const v = variantId ? (product.variants || []).find((x) => x.id === variantId) : null;
  let unit = Number(v?.price ?? product.price);
  const best = (product.breaks || []).filter((b) => b.min_qty <= totalQty).sort((a, b) => b.min_qty - a.min_qty)[0];
  if (best) unit = Math.min(unit, Number(best.unit_price));
  return unit;
};
const productPhotos = (p) => {
  const urls = [p.image_url, ...(p.images || []).map((i) => i.url)].filter(Boolean);
  return urls.filter((u, i) => urls.indexOf(u) === i);
};
// Cart lines with the current price (variant + quantity price) and full name.
const priceCartLines = (cart, products) => {
  const byId = new Map((products || []).map((p) => [p.id, p]));
  const qtyOf = new Map();
  cart.forEach((it) => qtyOf.set(it.productId, (qtyOf.get(it.productId) || 0) + it.qty));
  return cart.map((it) => {
    const p = byId.get(it.productId);
    const price = p ? unitPriceFor(p, it.variantId, qtyOf.get(it.productId)) : it.price;
    return { ...it, key: lineKey(it), price, listPrice: p ? Number((p.variants || []).find((v) => v.id === it.variantId)?.price ?? p.price) : it.price,
      name: it.variantName ? `${it.name} (${it.variantName})` : it.name };
  });
};

const CART_KEY = "efootball-shop-cart-v1";
const DELIVERY_LABELS = { collection: "Collect from us", courier: "Courier to your door", pudo: "Pudo locker", paxi: "PAXI at a PEP store" };
// One short line describing where an order is going.
function deliverySummary(o) {
  if (!o.delivery_method) return "";
  const label = DELIVERY_LABELS[o.delivery_method] || o.delivery_method;
  const a = o.delivery_address;
  const where = a ? [a.street, a.suburb, a.city, a.province, a.postal_code].filter(Boolean).join(", ") : (o.delivery_point || "");
  return where ? `${label}: ${where}` : label;
}
const numOrNull = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Number(v));

// Postgres egress fix (postgres-egress-fix-plan.md Step 2) — the order
// queries below used to select("*, shop_order_items(*)"). Narrowed to
// exactly the fields this file reads (verified against every `o.` / `it.`
// property access in MyOrders and AdminOrders below).
const SHOP_ORDER_SELECT = "id, order_number, created_at, status, subtotal, buyer_username, checkout_method, contact_phone, delivery_note, payment_proof_path, delivery_method, delivery_address, delivery_point, delivery_fee, courier_name, tracking_number, shop_order_items(id, qty, product_name, unit_price)";

function waLink(phone, text) {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

// Shared product links use a clean path — weafrica.co.za/shop/<id> — rather
// than a query string, so they read like a real page and not like a param
// dump. Requires the SPA fallback rewrite in vercel.json so any /shop/<id>
// path still serves index.html.
// Always the public address, even when shared from the installed shop app or
// a preview URL, so every link people send lands on https://weafrica.co.za/shop.
const SHOP_PUBLIC_URL = "https://weafrica.co.za/shop";
function buildProductLink(product) {
  return `${SHOP_PUBLIC_URL}/${product.id}`;
}

function loadCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
}
function persistCart(items) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch { /* storage unavailable */ }
}

// Placeholder for wiring up a real gateway later — kept here so the whole
// checkout flow (order creation, cart clearing, confirmation) already
// exists and this is the only piece left to fill in. Should return
// { success, reference } once real integration lands.
async function payWithGateway() {
  return { success: false, reference: null };
}

// "Cards accepted" indicator for the card payment option — renders the
// Mastercard/Visa logo image the site owner supplies at
// /public/card-brands.png (drop the real file in yourself; nothing here
// reproduces the artwork).
function CardBrandsBadge({ c }) {
  return <img src="/card-brands.png" alt="Mastercard, Visa" className="h-5 w-auto object-contain" />;
}

function Spinner({ c }) {
  return (
    <div className="flex items-center justify-center h-40">
      <div className="w-7 h-7 rounded-full animate-spin" style={{ border: `2px solid ${c.green}`, borderTopColor: "transparent" }} />
    </div>
  );
}

const STATUS_META = {
  pending_review: { label: "Pending review", icon: Clock, color: "#B8860B" },
  paid: { label: "Paid", icon: CheckCircle2, color: "#2D6A4F" },
  rejected: { label: "Rejected", icon: XCircle, color: "#C4293A" },
  whatsapp_sent: { label: "Sent via WhatsApp", icon: MessageCircle, color: "#25D366" },
  fulfilled: { label: "Fulfilled", icon: Truck, color: "#2D6A4F" },
  packed: { label: "Packed", icon: Package, color: "#1B6C8F" },
  shipped: { label: "Shipped", icon: Truck, color: "#7B3FA0" },
  delivered: { label: "Delivered", icon: CheckCircle2, color: "#2D6A4F" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "#888" },
  refunded: { label: "Refunded", icon: XCircle, color: "#888" },
};

function StatusBadge({ status, c }) {
  const meta = STATUS_META[status] || { label: status, icon: Clock, color: c.textDim };
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1 font-body text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: `${meta.color}22`, color: meta.color }}>
      <Icon size={11} /> {meta.label}
    </span>
  );
}

// ════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════════════════════════

// Guards destructive admin actions (delete product, department, category)
// behind several sequential confirmations rather than one click — same
// pattern as Matchday's own ConfirmStepModal, kept as a local copy here
// since Shop.jsx loads as its own lazy chunk and manages its own toast
// state independently of the rest of the app. `flow` is
// { steps, step, action } from requestConfirm/advanceConfirm below.
function ConfirmStepModal({ flow, onCancel, onAdvance, c }) {
  if (!flow) return null;
  const { steps, step } = flow;
  const isLast = step === steps.length - 1;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.65)" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl p-5" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center gap-2 mb-3" style={{ color: "#E63946" }}>
          <AlertTriangle size={16} />
          <span className="font-mono text-[10px] uppercase tracking-wider">Confirm {step + 1} of {steps.length}</span>
        </div>
        <div className="text-sm mb-5" style={{ color: c.text }}>{steps[step]}</div>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 text-sm font-semibold px-4 py-2.5 rounded-full" style={{ background: c.surface, color: c.text }}>
            Cancel
          </button>
          <button onClick={onAdvance} className="flex-1 text-sm font-semibold px-4 py-2.5 rounded-full" style={{ background: "#E63946", color: "#fff" }}>
            {isLast ? "Yes, do it" : "Yes, continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ShopPage({ c, session, profile, isAdmin, onBack, onRequireAuth, initialProductId }) {
  const [subview, setSubview] = useState(() => (window.history.state?.shopNav ? window.history.state.shopSubview : null) || "browse");
  const [products, setProducts] = useState(null);
  const [departments, setDepartments] = useState(null);
  const [categories, setCategories] = useState(null);
  const [cart, setCart] = useState(loadCart);
  const [activeProduct, setActiveProduct] = useState(null);
  const [myOrders, setMyOrders] = useState(null);
  const [lastOrderNumber, setLastOrderNumber] = useState(null);
  const [eftDetails, setEftDetails] = useState("");
  const [toast, setToast] = useState(null);
  // Guards deleting a product, department, or category behind several
  // sequential confirmations — same requestConfirm/advanceConfirm shape
  // Matchday's admin actions use. { steps, step, action }
  const [confirmFlow, setConfirmFlow] = useState(null);
  const requestConfirm = (steps, action) => setConfirmFlow({ steps, step: 0, action });
  const cancelConfirm = () => setConfirmFlow(null);
  const advanceConfirm = () => {
    setConfirmFlow((prev) => {
      if (!prev) return prev;
      if (prev.step >= prev.steps.length - 1) {
        prev.action();
        return null;
      }
      return { ...prev, step: prev.step + 1 };
    });
  };
  const [sharedLinkHandled, setSharedLinkHandled] = useState(false);
  const [restoredProductHandled, setRestoredProductHandled] = useState(false);
  // Which department/category the shopper has drilled into on the browse
  // screen — "all"/[] means the shop's own root (department directory, no
  // category selected). Lifted up from DepartmentBrowser (rather than kept
  // local to it) so drilling in/out can be tracked in the same real
  // browser-history stack as everything else — otherwise swipe-back has
  // nothing to step through and jumps straight past every drill-down level.
  const [shopDept, setShopDept] = useState(() => (window.history.state?.shopNav ? window.history.state.shopDept : null) || "all");
  const [shopCatPath, setShopCatPath] = useState(() => (window.history.state?.shopNav && Array.isArray(window.history.state.shopCatPath)) ? window.history.state.shopCatPath : []);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast((t) => (t === msg ? null : t)), 3000); };

  useEffect(() => { persistCart(cart); }, [cart]);

  // Real browser-history navigation inside the shop itself: browsing → cart
  // → checkout, and opening/closing a product modal, are all real history
  // entries layered on top of whichever entry the parent (App or
  // PublicHome) already pushed for "entering the shop". That way swiping
  // back inside the shop steps back through cart/checkout/product screens
  // one at a time, and only leaves the shop once you're back at its root.
  //
  // The base context here is hardcoded (appView: true, view: "shop",
  // activeLeagueId: null) rather than captured from window.history.state at
  // mount, because this component only ever renders while the parent's
  // `view` is already "shop" — and capturing it dynamically raced against
  // the parent's own history push (child effects run before parent effects
  // within the same commit), which meant the very first shop navigation
  // could silently overwrite the entry the parent had just pushed for
  // "entering the shop" before it existed, leaving nothing correct to land
  // on and making back skip straight past every shop screen.
  const shopNavFirstRef = useRef(true);
  useEffect(() => {
    // Skip the very first run entirely — the parent (App/PublicHome) has
    // already pushed a real entry for "entering the shop" by the time this
    // renders, so there's nothing more to record for the initial browse
    // view. ShopPage re-mounts fresh every single time the shop is opened
    // (unlike the parent, which only mounts once for the whole session), so
    // treating this "first write" the same way the parent treats its own
    // would mean *every* shop visit does a destructive replaceState over
    // whatever entry was already current — silently overwriting the very
    // entry the parent just created.
    if (shopNavFirstRef.current) { shopNavFirstRef.current = false; return; }
    const productId = activeProduct?.id ?? null;
    const state = { appView: true, view: "shop", activeLeagueId: null, shopNav: true, shopSubview: subview, shopProductId: productId, shopDept, shopCatPath };
    const cur = window.history.state;
    const catPathEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
    if (cur && cur.shopNav && cur.shopSubview === subview && (cur.shopProductId ?? null) === productId
      && (cur.shopDept || "all") === shopDept && catPathEqual(cur.shopCatPath || [], shopCatPath)) return;
    window.history.pushState(state, "", productId ? `/shop/${productId}` : "/shop");
  }, [subview, activeProduct, shopDept, shopCatPath]);

  useEffect(() => {
    const onPopState = (e) => {
      const state = e.state;
      if (!state) {
        // The page's very first history entry has no state (e.g. the shop app
        // opened directly): that is the shop root, so close whatever is open.
        setSubview("browse");
        setShopDept("all");
        setShopCatPath([]);
        setActiveProduct(null);
        return;
      }
      if (state.shopNav) {
        setSubview(state.shopSubview || "browse");
        setShopDept(state.shopDept || "all");
        setShopCatPath(Array.isArray(state.shopCatPath) ? state.shopCatPath : []);
        if (state.shopProductId && products) {
          const found = products.find((p) => String(p.id) === String(state.shopProductId));
          setActiveProduct(found || null);
        } else {
          setActiveProduct(null);
        }
        return;
      }
      // Landing back on the bare entry the parent pushed for "entering the
      // shop" (no shopNav tag, since that entry belongs to the parent, not
      // us) still means "shop root, nothing open" from this component's own
      // point of view — reset local state to match instead of silently
      // ignoring it, or the *next* back press would jump straight past this
      // point to wherever's beneath the shop entirely (e.g. Home).
      if (state.appView && state.view === "shop") {
        setSubview("browse");
        setShopDept("all");
        setShopCatPath([]);
        setActiveProduct(null);
      }
      // Anything else has popped past our own entries — the parent's own
      // listener handles leaving the shop.
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [products]);

  // Same fix as the main app's goBack: the shop's own "Back"/"X" controls
  // used to call setSubview(...) or setActiveProduct(null) directly, which
  // *pushes* a fresh history entry rather than stepping back through the
  // ones the effect above already laid down (browse → cart → checkout,
  // product modal open/close). That clutters the real history stack with
  // duplicates, so the hardware/gesture back action often re-lands on a
  // screen you'd already left instead of the one before it. Using real
  // browser back navigation here lets the popstate handler above restore
  // the true previous shop screen instead.
  const shopGoBack = () => {
    if (window.history.state?.shopNav) window.history.back();
    else setSubview("browse");
  };

  // A shared product link (weafrica.co.za/shop/<id>) lands here — open that
  // product automatically once the catalog has loaded, for anyone,
  // signed in or not. Only tried once per page load.
  useEffect(() => {
    if (sharedLinkHandled || !initialProductId || products === null) return;
    const found = products.find((p) => String(p.id) === String(initialProductId));
    if (found) setActiveProduct(found);
    else showToast("That product link isn't available anymore.");
    setSharedLinkHandled(true);
  }, [initialProductId, products, sharedLinkHandled]);

  // Same idea as the shared-link effect above, but for a plain refresh: the
  // subview itself is restored synchronously from history state (see the
  // useState above), but a product modal can't be resolved until the
  // catalog has actually loaded, so it's restored here once `products`
  // arrives. Skipped whenever a shared-link product is already being
  // handled, so the two don't race each other.
  useEffect(() => {
    if (restoredProductHandled || initialProductId || products === null) return;
    const restoredId = window.history.state?.shopNav ? window.history.state.shopProductId : null;
    if (restoredId) {
      const found = products.find((p) => String(p.id) === String(restoredId));
      if (found) setActiveProduct(found);
    }
    setRestoredProductHandled(true);
  }, [initialProductId, products, restoredProductHandled]);

  // Anyone can share a link straight to a product — no sign-in or admin
  // access required to generate or open one.
  const shareProduct = async (product) => {
    const url = buildProductLink(product);
    if (navigator.share) {
      try { await navigator.share({ title: product.name, text: `${product.name} — ${formatMoney(product.price)}`, url }); }
      catch { /* user cancelled the share sheet */ }
      return;
    }
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(url); showToast("Product link copied."); return; }
      catch { /* fall through to showing the link itself */ }
    }
    showToast(url);
  };

  const loadProducts = async () => {
    const [prod, vars, brks, imgs, rats, pdeps, pcats] = await Promise.all([
      supabase.from("shop_products")
        .select("id, name, description, price, compare_at_price, facebook_url, stock_qty, image_url, active, department_id, category_id, weight_kg, length_cm, width_cm, height_cm")
        .order("created_at", { ascending: false }),
      supabase.from("shop_product_variants").select("id, product_id, name, price, stock_qty, position, active").order("position"),
      supabase.from("shop_price_breaks").select("id, product_id, min_qty, unit_price").order("min_qty"),
      supabase.from("shop_product_images").select("id, product_id, url, position").order("position"),
      supabase.from("shop_product_rating_summary").select("product_id, rating_avg, rating_count"),
      supabase.from("shop_product_departments").select("product_id, department_id"),
      supabase.from("shop_product_categories").select("product_id, category_id"),
    ]);
    if (prod.error) return;
    const group = (res) => { const m = new Map(); (res.data || []).forEach((r) => { if (!m.has(r.product_id)) m.set(r.product_id, []); m.get(r.product_id).push(r); }); return m; };
    const gv = group(vars), gb = group(brks), gi = group(imgs);
    const rs = new Map((rats.data || []).map((r) => [r.product_id, r]));
    const idsOf = (res, key) => { const m = new Map(); (res.data || []).forEach((r) => { if (!m.has(r.product_id)) m.set(r.product_id, []); m.get(r.product_id).push(r[key]); }); return m; };
    const gd = idsOf(pdeps, "department_id"), gc = idsOf(pcats, "category_id");
    const union = (list, main) => [...new Set([...(main ? [main] : []), ...(list || [])])];
    setProducts((prod.data || []).map((p) => ({ ...p, dept_ids: union(gd.get(p.id), p.department_id), cat_ids: union(gc.get(p.id), p.category_id), variants: gv.get(p.id) || [], breaks: gb.get(p.id) || [], images: gi.get(p.id) || [],
      rating_avg: Number(rs.get(p.id)?.rating_avg || 0), rating_count: rs.get(p.id)?.rating_count || 0 })));
  };
  useEffect(() => { loadProducts(); }, []);

  const loadDepartments = async () => {
    const { data, error } = await supabase.from("shop_departments").select("id, name, position").order("position", { ascending: true });
    if (!error) setDepartments(data || []);
  };
  useEffect(() => { loadDepartments(); }, []);

  // Categories are a second, optional level under a department (e.g.
  // department "Kits" -> categories "Home", "Away", "Training"). A category
  // always belongs to exactly one department.
  const loadCategories = async () => {
    const { data, error } = await supabase.from("shop_categories")
      .select("id, name, position, department_id, parent_category_id")
      .order("position", { ascending: true });
    if (!error) setCategories(data || []);
  };
  useEffect(() => { loadCategories(); }, []);

  const loadSettings = async () => {
    const { data } = await supabase.from("shop_settings").select("key, value").eq("key", "eft_details");
    setEftDetails((data || []).find((r) => r.key === "eft_details")?.value || "");
  };
  useEffect(() => { loadSettings(); }, []);

  const loadMyOrders = async () => {
    if (!session) return;
    const { data, error } = await supabase.from("shop_orders").select(SHOP_ORDER_SELECT)
      .eq("user_id", session.user.id).order("created_at", { ascending: false });
    if (!error) setMyOrders(data || []);
  };

  const visibleProducts = isAdmin ? (products || []) : (products || []).filter((p) => p.active);

  const addToCart = (product, qty, variant = null) => {
    const vid = variant?.id || null;
    setCart((prev) => {
      const key = `${product.id}:${vid || ""}`;
      const existing = prev.find((it) => lineKey(it) === key);
      const cap = (variant ? variant.stock_qty : product.stock_qty) ?? 99;
      if (existing) return prev.map((it) => lineKey(it) === key ? { ...it, qty: Math.min(it.qty + qty, cap) } : it);
      return [...prev, { productId: product.id, variantId: vid, variantName: variant?.name || null, name: product.name, price: product.price, image_url: product.image_url, qty: Math.min(qty, cap) }];
    });
    showToast(`Added ${product.name}${variant ? ` (${variant.name})` : ""} to cart.`);
  };
  const updateQty = (key, qty) => {
    setCart((prev) => qty <= 0 ? prev.filter((it) => lineKey(it) !== key) : prev.map((it) => lineKey(it) === key ? { ...it, qty } : it));
  };
  const removeFromCart = (key) => setCart((prev) => prev.filter((it) => lineKey(it) !== key));
  const clearCart = () => setCart([]);

  const pricedCart = priceCartLines(cart, products);
  const cartCount = cart.reduce((sum, it) => sum + it.qty, 0);
  const cartTotal = pricedCart.reduce((sum, it) => sum + it.qty * it.price, 0);

  const goCheckout = () => {
    if (cart.length === 0) { showToast("Your cart is empty."); return; }
    setSubview("checkout");
  };

  const atShopRoot = subview === "browse" && !activeProduct && shopDept === "all" && shopCatPath.length === 0;

  return (
    <div className={`pt-8 ${subview === "browse" && cartCount > 0 ? "pb-24" : "pb-10"}`}>
      <div className="flex items-center justify-between mb-5">
        {atShopRoot && !onBack ? (
          <div />
        ) : atShopRoot ? (
          <button onClick={onBack} className="flex items-center gap-1.5" title="Back to the other apps">
            <div className="w-5 h-5 rounded flex items-center justify-center" style={{ background: c.green }}><LayoutGrid size={11} color={c.accent} /></div>
            <div className="text-xs font-extrabold tracking-tight uppercase" style={{ color: c.textDim }}>Other apps</div>
          </button>
        ) : (
          <button onClick={shopGoBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}>
            <ArrowLeft size={15} /> Shop
          </button>
        )}
        <div className="flex items-center gap-2">
          <button onClick={() => setSubview("track")} title="Track an order" aria-label="Track an order"
            className="w-8 h-8 flex items-center justify-center rounded-full" style={subview === "track" ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
            <Truck size={14} />
          </button>
          {session && (
            <button onClick={() => { setSubview("my-orders"); loadMyOrders(); }} title="My orders"
              className="w-8 h-8 flex items-center justify-center rounded-full" style={subview === "my-orders" ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
              <ClipboardList size={14} />
            </button>
          )}
          {isAdmin && (
            <button onClick={() => setSubview("admin-products")} title="Manage shop"
              className="w-8 h-8 flex items-center justify-center rounded-full" style={subview.startsWith("admin") ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
              <Settings2 size={14} />
            </button>
          )}
          <button onClick={() => setSubview("cart")} title="Cart" className="relative w-8 h-8 flex items-center justify-center rounded-full" style={subview === "cart" ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
            <ShoppingCart size={14} />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center font-mono text-[9px] font-bold" style={{ background: SHOP_GOLD, color: "#1a1200" }}>{cartCount}</span>
            )}
          </button>
        </div>
      </div>

      {subview === "browse" && (
        <>
          <div className="mb-4">
            <h1 className="text-[1.75rem] font-extrabold tracking-tight leading-none">WeAfrica Shop</h1>
            <p className="font-body text-sm mt-1.5" style={{ color: c.textDim }}>Clothing, bags, gear, toys and more. Order in minutes, no account needed.</p>
          </div>
          <DepartmentBrowser products={visibleProducts} departments={departments || []} categories={categories || []} loading={products === null}
            selected={shopDept} setSelected={setShopDept} catPath={shopCatPath} setCatPath={setShopCatPath}
            onOpen={setActiveProduct} onQuickAdd={(p) => (activeVariants(p).length ? setActiveProduct(p) : addToCart(p, 1))} c={c} />
        </>
      )}

      {subview === "cart" && (
        <CartView cart={pricedCart} onUpdateQty={updateQty} onRemove={removeFromCart} onCheckout={goCheckout} onContinue={shopGoBack} c={c} />
      )}

      {subview === "checkout" && (
        <CheckoutView cart={pricedCart} total={cartTotal} session={session} profile={profile} eftDetails={eftDetails} onStockChanged={loadProducts}
          onDone={(order) => { setLastOrderNumber(order?.order_number || null); clearCart(); loadProducts(); setSubview("confirm"); }} onBack={shopGoBack} showToast={showToast} c={c} />
      )}

      {subview === "confirm" && (
        <div className="pt-10 text-center">
          <CheckCircle2 size={40} style={{ color: c.greenText }} className="mx-auto mb-3" />
          <div className="font-extrabold tracking-tight text-2xl mb-1.5">Order placed</div>
          {lastOrderNumber && (
            <div className="inline-block rounded-xl px-4 py-2 mb-3 border" style={{ background: c.surface, borderColor: c.border }}>
              <div className="font-body text-xs" style={{ color: c.textFaint }}>Your order number</div>
              <div className="font-mono text-xl font-bold tracking-wide" style={{ color: SHOP_GOLD }}>{lastOrderNumber}</div>
            </div>
          )}
          <p className="font-body text-sm mb-6 max-w-xs mx-auto" style={{ color: c.textDim }}>
            Keep this number. Use it with your phone number or email to track the order{session ? ", or open My orders" : ""}.
          </p>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <button onClick={() => setSubview("track")} className="font-body text-sm font-semibold px-4 py-2 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200" }}>Track order</button>
            <button onClick={() => setSubview("browse")} className="font-body text-sm font-semibold px-4 py-2 rounded-full" style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}>Keep browsing</button>
            {session && (
              <button onClick={() => { setSubview("my-orders"); loadMyOrders(); }} className="font-body text-sm font-semibold px-4 py-2 rounded-full" style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}>My orders</button>
            )}
          </div>
        </div>
      )}

      {subview === "track" && <TrackOrder initialNumber={lastOrderNumber || ""} c={c} />}

      {subview === "my-orders" && <MyOrders orders={myOrders} c={c} />}

      {subview === "admin-products" && isAdmin && (
        <AdminProducts products={products} departments={departments || []} categories={categories || []} onReload={loadProducts} onReloadDepartments={loadDepartments} onReloadCategories={loadCategories} showToast={showToast} onOpenOrders={() => setSubview("admin-orders")} requestConfirm={requestConfirm} c={c} />
      )}
      {subview === "admin-orders" && isAdmin && (
        <AdminOrders session={session} showToast={showToast} onReloadProducts={loadProducts} onOpenProducts={() => setSubview("admin-products")} eftDetails={eftDetails} onEftSaved={loadSettings} c={c} />
      )}

      {activeProduct && (
        <ProductModal product={activeProduct} onClose={shopGoBack} onAdd={(qty, variant) => { addToCart(activeProduct, qty, variant); shopGoBack(); }} onShare={() => shareProduct(activeProduct)}
          session={session} profile={profile} isAdmin={isAdmin} onRequireAuth={onRequireAuth} showToast={showToast} onRatingsChanged={loadProducts} c={c} />
      )}

      {subview === "browse" && cartCount > 0 && (
        <button onClick={() => setSubview("cart")}
          className="fixed bottom-20 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:w-full sm:max-w-sm flex items-center justify-between gap-3 px-4 py-3 rounded-full shadow-lg z-40"
          style={{ background: SHOP_GOLD, color: "#1a1200" }}>
          <span className="flex items-center gap-2 font-body text-sm font-semibold">
            <ShoppingCart size={16} /> {cartCount} item{cartCount === 1 ? "" : "s"}
          </span>
          <span className="font-mono text-sm font-bold">View cart · {formatMoney(cartTotal)}</span>
        </button>
      )}

      <ConfirmStepModal flow={confirmFlow} onCancel={cancelConfirm} onAdvance={advanceConfirm} c={c} />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full font-body text-sm font-medium shadow-lg z-50 max-w-[90vw] text-center" style={{ background: c.toastBg, color: c.toastText }}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// BROWSE
// ════════════════════════════════════════════════════════════════════

// Categories nest arbitrarily deep under a department — a category's
// parent_category_id points at another category, or is null at the top
// level. No depth is special-cased; these helpers just walk the flat
// array however far the tree actually goes.
function categoryChildren(categories, parentId) {
  return categories.filter((cat) => (cat.parent_category_id || null) === parentId).sort((a, b) => a.position - b.position);
}
function categoryDescendantIds(categories, catId) {
  const result = [];
  const stack = categoryChildren(categories, catId);
  while (stack.length) {
    const cat = stack.pop();
    result.push(cat.id);
    stack.push(...categoryChildren(categories, cat.id));
  }
  return result;
}
function categoryPathName(categories, catId) {
  const byId = new Map(categories.map((cat) => [cat.id, cat]));
  const parts = [];
  let cur = byId.get(catId);
  while (cur) { parts.unshift(cur.name); cur = cur.parent_category_id ? byId.get(cur.parent_category_id) : null; }
  return parts.join(" › ");
}
// Depth-first flatten of a department's category tree, each entry tagged
// with its depth — used to render an indented <select> in the product form.
function flattenCategoryTree(categories, parentId = null, depth = 0) {
  return categoryChildren(categories, parentId).flatMap((cat) => [{ ...cat, depth }, ...flattenCategoryTree(categories, cat.id, depth + 1)]);
}

// A department-store-style browse experience:
//  - a "store directory" of tappable department tiles when nothing's
//    filtered yet, each showing a representative photo and item count
//  - a sticky row of chips (with counts) so switching aisles doesn't
//    require scrolling back to the top
//  - search that narrows within whichever department is selected
//  - "All" groups products into a section per department, like walking
//    the floor; a specific department (or a search) shows just its grid
function DepartmentBrowser({ products, departments, categories, loading, selected, setSelected, catPath, setCatPath, onOpen, onQuickAdd, c }) {
  const [catFilter, setCatFilter] = useState("all"); // "all" | "direct" — within the current tree level
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("default");
  const [inStockOnly, setInStockOnly] = useState(false);

  // catFilter is a sub-filter within whichever level selected/catPath already
  // point at (not itself a drill-down layer worth a back-navigation step),
  // so it just resets whenever the actual level changes — including when
  // that change comes from a swipe-back restoring a shallower level.
  useEffect(() => { setCatFilter("all"); }, [selected, catPath]);

  // Picking a department always resets whatever category drill-down was
  // active in the previously-selected department — categories don't carry
  // across departments.
  const selectDept = (id) => { setSelected(id); setCatPath([]); };
  const goToCatDepth = (depth) => { setCatPath((p) => p.slice(0, depth)); };
  const drillInto = (catId) => { setCatPath((p) => [...p, catId]); };

  if (loading) return <Spinner c={c} />;
  if (products.length === 0) {
    return (
      <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
        No products yet — check back soon.
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  let searchable = q ? products.filter((p) => p.name.toLowerCase().includes(q) || (p.description || "").toLowerCase().includes(q)) : products;
  if (inStockOnly) searchable = searchable.filter((p) => p.stock_qty !== 0);
  if (sort === "price_asc") searchable = [...searchable].sort((a, b) => a.price - b.price);
  else if (sort === "price_desc") searchable = [...searchable].sort((a, b) => b.price - a.price);
  else if (sort === "name") searchable = [...searchable].sort((a, b) => a.name.localeCompare(b.name));

  const deptIds = new Set(departments.map((d) => d.id));
  // "Dept 01", "Dept 02"... — numbered from the full (unsearched) product
  // list, so a department keeps its number and colour while filtering.
  const deptNum = new Map(
    departments.filter((d) => products.some((p) => productDepts(p).includes(d.id))).map((d, i) => [d.id, String(i + 1).padStart(2, "0")])
  );
  const grouped = departments
    .map((d) => ({ dept: d, items: searchable.filter((p) => productDepts(p).includes(d.id)) }))
    .filter((g) => g.items.length > 0);
  const uncategorized = searchable.filter((p) => !productDepts(p).some((id) => deptIds.has(id)));
  // Chips (and directory tiles) only ever show departments that actually
  // have something in them right now — no dead-end aisles.
  const chips = [
    { id: "all", name: departments.length > 0 ? "All departments" : "All", count: searchable.length },
    ...grouped.map(({ dept, items }) => ({ id: dept.id, name: dept.name, count: items.length })),
    ...(uncategorized.length > 0 ? [{ id: "uncategorized", name: "Other", count: uncategorized.length }] : []),
  ];

  // When a real department is selected, walk however deep the category tree
  // at the current breadcrumb position goes. currentCatId is the category
  // we're "inside" (null = department root, not inside any category yet).
  const deptItems = searchable.filter((p) => productDepts(p).includes(selected));
  const deptCategories = categories.filter((cat) => cat.department_id === selected);
  const currentCatId = catPath.length ? catPath[catPath.length - 1] : null;
  const itemsForCat = (catId) => {
    const ids = new Set([catId, ...categoryDescendantIds(deptCategories, catId)]);
    return deptItems.filter((p) => productCats(p).some((id) => ids.has(id)));
  };
  const deptCatIds = new Set(deptCategories.map((cat) => cat.id));
  const directItems = deptItems.filter((p) => {
    const here = productCats(p).filter((id) => deptCatIds.has(id));
    return currentCatId === null ? here.length === 0 : here.includes(currentCatId);
  });
  const childCats = categoryChildren(deptCategories, currentCatId);
  // "All" is just the default state (nothing to tap for it), so the only
  // real filter chip left once subcategories get their own tiles below is
  // "Other" — items filed directly in this category rather than in one of
  // its subcategories.
  const showDirectFilter = childCats.length > 0 && directItems.length > 0;

  const currentItems = selected === "all" ? searchable
    : selected === "uncategorized" ? uncategorized
    : catFilter === "direct" ? directItems
    : currentCatId === null ? deptItems
    : itemsForCat(currentCatId);

  return (
    <div>
      {/* The same big banner as the login page, on top of the shop home. */}
      {selected === "all" && !query.trim() && (
        <div className="-mt-1 mb-5">
          <ShopHeroBanner c={c} cta="Start shopping"
            onOpen={() => document.getElementById("shop-search")?.scrollIntoView({ behavior: "smooth", block: "center" })} />
        </div>
      )}
      {/* Search leads: it is the fastest way to a product. */}
      <div className="relative mb-5">
        <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input id="shop-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products" aria-label="Search products"
          className="w-full border rounded-xl pl-10 pr-10 py-3 font-body text-sm outline-none focus:ring-2" style={{ background: c.surface, borderColor: c.border, color: c.text, "--tw-ring-color": SHOP_GOLD }} />
        {query && (
          <button onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full" style={{ color: c.textFaint }}>
            <X size={14} />
          </button>
        )}
      </div>

      {selected === "all" && !q && grouped.length > 0 && (
        <DepartmentStrip groups={grouped} onSelect={selectDept} deptNum={deptNum} c={c} />
      )}
      {selected === "all" && !q && sort === "default" && !inStockOnly && searchable.length >= 6 && (
        <NewArrivals products={searchable.slice(0, 8)} onOpen={onOpen} onQuickAdd={onQuickAdd} c={c} />
      )}

      {selected !== "all" && selected !== "uncategorized" && departments.some((d) => d.id === selected) && (() => {
        const dept = departments.find((d) => d.id === selected);
        const num = deptNum.get(dept.id);
        const tint = DEPT_TINTS[((parseInt(num, 10) || 1) - 1) % DEPT_TINTS.length];
        const all = products.filter((p) => productDepts(p).includes(dept.id));
        const photos = [...new Set(all.map((it) => toProxiedUrl(it.image_url)).filter(Boolean))].slice(0, 4);
        const from = deptFromPrice(all);
        return (
          <div className="relative rounded-2xl overflow-hidden mb-4 min-h-[170px] flex flex-col justify-end p-4" style={{ background: tint }}>
            {photos.length > 0 && <DeptTileCollage photos={photos} />}
            <div className="absolute inset-0" style={{ background: photos.length > 0 ? "linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.4) 55%, rgba(0,0,0,0.1) 100%)" : "linear-gradient(to top, rgba(0,0,0,0.3), rgba(0,0,0,0.05))" }} />
            <button onClick={() => selectDept("all")} className="absolute top-3 left-3 font-mono text-[10px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}>
              ‹ All departments
            </button>
            <div className="relative">
              <div className="text-white font-extrabold tracking-tight text-4xl leading-[1]" style={{ textShadow: "0 2px 8px rgba(0,0,0,0.6)" }}>{dept.name}</div>
              <div className="text-white/90 font-body text-sm mt-1.5">
                {deptItems.length} item{deptItems.length === 1 ? "" : "s"}{deptCategories.length > 0 ? `, ${deptCategories.length} categor${deptCategories.length === 1 ? "y" : "ies"}` : ""}{from != null ? `, from ${formatMoney(from)}` : ""}
              </div>
            </div>
          </div>
        );
      })()}

      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto no-scrollbar">
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="shrink-0 font-body text-xs font-semibold pl-3 pr-2 py-2 rounded-full outline-none" style={{ background: c.surface, color: c.textDim, border: `1px solid ${c.border}` }}>
          <option value="default">Sort: Newest</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
          <option value="name">Name: A to Z</option>
        </select>
        <button onClick={() => setInStockOnly((v) => !v)} aria-pressed={inStockOnly} className="shrink-0 font-body text-xs font-semibold px-3.5 py-2 rounded-full"
          style={inStockOnly ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim, border: `1px solid ${c.border}` }}>
          In stock only
        </button>
      </div>

      {departments.length > 0 && (selected !== "all" || q) && (
        <div className="sticky top-0 z-10 -mx-4 px-4 pb-2 pt-1" style={{ background: c.bg }}>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {chips.map((d) => (
              <button key={d.id} onClick={() => selectDept(d.id)} aria-pressed={selected === d.id} className="shrink-0 font-body text-xs font-semibold px-3.5 py-2 rounded-full flex items-center gap-1.5"
                style={selected === d.id ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim, border: `1px solid ${c.border}` }}>
                {d.name} <span style={{ opacity: 0.6 }}>{d.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {catPath.length > 0 && (
        <div className="flex items-center gap-1 mb-2 flex-wrap font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>
          <button onClick={() => goToCatDepth(0)} className="underline underline-offset-2">{departments.find((d) => d.id === selected)?.name}</button>
          {catPath.map((id, i) => {
            const cat = categories.find((cc) => cc.id === id);
            const isLast = i === catPath.length - 1;
            return (
              <span key={id} className="flex items-center gap-1">
                <span style={{ opacity: 0.5 }}>›</span>
                {isLast ? <span style={{ color: c.textDim }}>{cat?.name}</span>
                  : <button onClick={() => goToCatDepth(i + 1)} className="underline underline-offset-2">{cat?.name}</button>}
              </span>
            );
          })}
        </div>
      )}

      {childCats.length > 0 && selected !== "all" && selected !== "uncategorized" && (
        <div className="font-body text-sm font-semibold mb-2" style={{ color: c.textDim }}>
          Categories in {currentCatId ? categories.find((cc) => cc.id === currentCatId)?.name : departments.find((d) => d.id === selected)?.name}
        </div>
      )}
      {childCats.length > 0 && (
        <CategoryShowcase categories={childCats} allCategories={deptCategories} itemsForCat={itemsForCat} onSelect={drillInto} c={c} />
      )}

      {showDirectFilter && (
        <div className="flex gap-1.5 mb-4">
          <button onClick={() => setCatFilter("all")}
            className="shrink-0 font-mono text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase"
            style={catFilter === "all" ? { background: SHOP_GOLD, color: "#1a1200" } : { background: "transparent", color: c.textFaint, border: `1px solid ${c.border}` }}>
            All <span style={{ opacity: 0.7 }}>{itemsForCat(currentCatId).length}</span>
          </button>
          <button onClick={() => setCatFilter("direct")}
            className="shrink-0 font-mono text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase"
            style={catFilter === "direct" ? { background: SHOP_GOLD, color: "#1a1200" } : { background: "transparent", color: c.textFaint, border: `1px solid ${c.border}` }}>
            Other <span style={{ opacity: 0.7 }}>{directItems.length}</span>
          </button>
        </div>
      )}

      {currentItems.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body mt-2" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          {q ? `Nothing matching "${query}".` : "Nothing here yet."}
        </div>
      ) : selected === "all" ? (
        <div className="space-y-6 mt-1">
          {grouped.map(({ dept, items }) => (
            <div key={dept.id}>
              {departments.length > 0 && (
                <div className="flex items-baseline gap-2 mb-3">
                  <h2 className="font-extrabold tracking-tight text-xl leading-none" style={{ color: c.text }}>{dept.name}</h2>
                  <span className="font-body text-xs" style={{ color: c.textFaint }}>{items.length} item{items.length === 1 ? "" : "s"}</span>
                  <button onClick={() => selectDept(dept.id)} className="ml-auto shrink-0 font-body text-sm font-semibold flex items-center gap-0.5" style={{ color: SHOP_GOLD }}>See all <ChevronRight size={15} /></button>
                </div>
              )}
              <ProductGrid products={items} loading={false} onOpen={onOpen} onQuickAdd={onQuickAdd} c={c} />
            </div>
          ))}
          {uncategorized.length > 0 && (
            <div>
              {departments.length > 0 && (
                <div className="font-extrabold tracking-tight text-xl leading-none mb-3 flex items-baseline gap-2" style={{ color: c.text }}>
                  Other items <span className="font-body text-xs font-normal" style={{ color: c.textFaint }}>{uncategorized.length} item{uncategorized.length === 1 ? "" : "s"}</span>
                </div>
              )}
              <ProductGrid products={uncategorized} loading={false} onOpen={onOpen} onQuickAdd={onQuickAdd} c={c} />
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2"><ProductGrid products={currentItems} loading={false} onOpen={onOpen} onQuickAdd={onQuickAdd} c={c} /></div>
      )}
    </div>
  );
}

// "Shop by department": one horizontal row of photo cards instead of a wall
// of full-width tiles, so the catalogue starts within the first screen. Each
// card uses a photo from that department, or its tint when it has none.
function DepartmentStrip({ groups, onSelect, deptNum, c }) {
  // Drifts slowly to the right, pauses at the end, then drifts back, so it is
  // obvious the row can be scrolled. Stops the moment someone touches, drags,
  // scrolls or tabs into it and picks up again a few seconds after they let go.
  const stripRef = useRef(null);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const SPEED = 16; // px per second
    let raf = 0, last = 0, x = el.scrollLeft, dir = 1, resumeAt = performance.now() + 1500, holdUntil = 0;
    const pause = (ms) => { resumeAt = performance.now() + ms; el.style.scrollSnapType = ""; };
    const onUser = () => pause(6000);
    const tick = (t) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
      last = t;
      const max = el.scrollWidth - el.clientWidth;
      if (max > 4 && t >= resumeAt && t >= holdUntil) {
        el.style.scrollSnapType = "none";
        if (Math.abs(el.scrollLeft - x) > 2) x = el.scrollLeft;
        x += dir * SPEED * dt;
        if (x >= max) { x = max; dir = -1; holdUntil = t + 1800; }
        else if (x <= 0) { x = 0; dir = 1; holdUntil = t + 1800; }
        el.scrollLeft = x;
      }
      raf = requestAnimationFrame(tick);
    };
    const evs = ["pointerdown", "touchstart", "wheel", "keydown", "focusin"];
    evs.forEach((e) => el.addEventListener(e, onUser, { passive: true }));
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); evs.forEach((e) => el.removeEventListener(e, onUser)); el.style.scrollSnapType = ""; };
  }, [groups.length]);
  return (
    <section className="mb-6" aria-label="Shop by department">
      <h2 className="font-extrabold tracking-tight text-xl leading-none mb-3">Shop by department</h2>
      <div ref={stripRef} className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1 snap-x" style={{ scrollPaddingLeft: 16 }}>
        {groups.map(({ dept, items }) => {
          const photo = items.find((it) => it.image_url)?.image_url;
          const tint = DEPT_TINTS[((parseInt(deptNum.get(dept.id), 10) || 1) - 1) % DEPT_TINTS.length];
          return (
            <button key={dept.id} onClick={() => onSelect(dept.id)} className="shrink-0 w-[104px] text-left snap-start" aria-label={`${dept.name}, ${items.length} items`}>
              <span className="block w-[104px] h-[104px] rounded-2xl overflow-hidden relative" style={{ background: tint }}>
                {photo && <img src={toProxiedUrl(photo)} alt="" loading="lazy" className="w-full h-full object-cover" />}
              </span>
              <span className="block font-body text-[13px] font-semibold leading-tight mt-2 line-clamp-2" style={{ color: c.text }}>{dept.name}</span>
              <span className="block font-body text-xs mt-0.5" style={{ color: c.textFaint }}>{items.length} item{items.length === 1 ? "" : "s"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// Newest products across every department, as a swipeable row.
function NewArrivals({ products, onOpen, onQuickAdd, c }) {
  return (
    <section className="mb-7" aria-label="New arrivals">
      <h2 className="font-extrabold tracking-tight text-xl leading-none mb-3">New arrivals</h2>
      <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-1 snap-x" style={{ scrollPaddingLeft: 16 }}>
        {products.map((p) => {
          const canQuickAdd = onQuickAdd && p.active && p.stock_qty !== 0;
          return (
            <div key={p.id} role="button" tabIndex={0} onClick={() => onOpen(p)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen(p)}
              className="shrink-0 w-[150px] snap-start rounded-xl overflow-hidden border cursor-pointer" style={{ background: c.surface, borderColor: c.border }}>
              <div className="aspect-square relative" style={{ background: c.surfaceHover }}>
                {p.image_url && <img src={toProxiedUrl(p.image_url)} alt={p.name} loading="lazy" className="w-full h-full object-cover" />}
                {canQuickAdd && (
                  <button onClick={(e) => { e.stopPropagation(); onQuickAdd(p); }} aria-label={`Add ${p.name} to cart`}
                    className="absolute bottom-2 right-2 w-9 h-9 rounded-full flex items-center justify-center shadow-md" style={{ background: SHOP_GOLD, color: "#1a1200" }}>
                    <Plus size={18} />
                  </button>
                )}
              </div>
              <div className="p-3">
                <div className="font-body text-sm leading-snug line-clamp-2 min-h-[2.5rem]" style={{ color: c.text }}>{p.name}</div>
                <div className="font-body text-base font-extrabold mt-1" style={{ color: c.text }}>{formatMoney(p.price)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// A small, curated set of accent gradients cycled across department tiles —
// gives each "aisle" its own identity at a glance (handy once there are
// enough departments that they'd otherwise blur together), and doubles as
// a full-tile background for any department whose products don't have a
// photo yet, so the store directory never shows an empty gray box.
const DEPT_TINTS = [
  "linear-gradient(135deg,#D4A017,#7A5A00)",
  "linear-gradient(135deg,#2D6A4F,#0E2A1C)",
  "linear-gradient(135deg,#7B3FA0,#341047)",
  "linear-gradient(135deg,#1B6C8F,#0A2A38)",
  "linear-gradient(135deg,#C4293A,#4A0F17)",
  "linear-gradient(135deg,#B8860B,#3A2600)",
  "linear-gradient(135deg,#3F6B4A,#12261A)",
  "linear-gradient(135deg,#5B4B8A,#211A3A)",
];

// Rotating call-to-action verbs, one per department (by its number), so the
// directory reads like signage: "Visit Sports", "Check out Tactical Shop"...
const DEPT_VERBS = ["Visit", "Check out", "Explore", "Step into", "Discover", "Shop"];
const deptVerb = (num) => DEPT_VERBS[((parseInt(num, 10) || 1) - 1) % DEPT_VERBS.length];
const deptFromPrice = (items) => {
  const prices = items.map((it) => Number(it.price)).filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min(...prices) : null;
};

// The store directory — the first thing a shopper sees when they open the
// shop. Big tappable department tiles (photo where one exists, an accent
// gradient where it doesn't) so picking an aisle is a glance-and-tap, not a
// hunt through a small chip row. "Other" gets its own tile too, styled as
// the catch-all it is rather than pretending to be a real department.
function DepartmentShowcase({ groups, uncategorizedCount, onSelect, deptNum, c }) {
  const tileCount = groups.length + (uncategorizedCount > 0 ? 1 : 0);
  if (tileCount < 2) return null; // one aisle isn't a directory — skip straight to the grid
  return (
    <div className="mb-6">
      <div className="mb-3">
        <div className="flex items-center gap-1.5">
          <LayoutGrid size={15} style={{ color: SHOP_GOLD }} />
          <span className="font-extrabold uppercase tracking-tight text-base" style={{ color: c.text }}>Departments</span>
          <span className="font-mono text-[11px]" style={{ color: c.textFaint }}>· {groups.length}</span>
        </div>
        <div className="font-body text-xs mt-0.5" style={{ color: c.textDim }}>Step onto the floor — pick a department and dive in.</div>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        {groups.map(({ dept, items }, idx) => {
          const num = deptNum.get(dept.id);
          // The first department gets a full-width hero tile once there are
          // enough of them for it to feel like a feature, not a gap.
          const hero = idx === 0 && groups.length >= 3;
          // Distinct products' photos (not the same item repeated) — up to 4,
          // arranged as a collage so the tile itself shows what's actually
          // on the shelves before anyone taps in.
          const photos = [...new Set(items.map((it) => toProxiedUrl(it.image_url)).filter(Boolean))].slice(0, 4);
          const from = deptFromPrice(items);
          return (
            <button key={dept.id} onClick={() => onSelect(dept.id)}
              className={`group text-left rounded-2xl overflow-hidden relative active:scale-[0.98] transition-transform ${hero ? "col-span-2 aspect-[16/9]" : "aspect-[4/3]"}`}
              style={{ background: DEPT_TINTS[((parseInt(num, 10) || 1) - 1) % DEPT_TINTS.length] }}>
              {photos.length > 0 && (
                <div className="absolute inset-0 transition-transform duration-700 ease-out group-hover:scale-110 group-active:scale-105">
                  <DeptTileCollage photos={photos} />
                </div>
              )}
              <div className="absolute inset-0" style={{ background: photos.length > 0 ? "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 38%, rgba(0,0,0,0.02) 100%)" : "linear-gradient(to top, rgba(0,0,0,0.35), rgba(0,0,0,0.05))" }} />
              <span className="absolute top-2 left-2 font-mono text-[9px] font-bold px-1.5 py-0.5 rounded tracking-[0.15em]" style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}>DEPT {num}</span>
              <span className="absolute top-2 right-2 font-mono text-[10px] font-bold px-2 py-1 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200" }}>Enter ›</span>
              <div className="absolute bottom-0 left-0 right-0 p-3">
                <div className="text-white/90 font-mono text-[10px] uppercase tracking-[0.2em]" style={{ textShadow: "0 1px 3px rgba(0,0,0,0.6)" }}>{deptVerb(num)}</div>
                <div className={`text-white font-extrabold uppercase tracking-tight leading-[0.95] line-clamp-2 ${hero ? "text-3xl" : "text-xl"}`} style={{ textShadow: "0 2px 6px rgba(0,0,0,0.6)" }}>{dept.name}</div>
                <div className="text-white/90 font-mono text-[10px] mt-1.5">
                  {items.length} item{items.length === 1 ? "" : "s"}{from != null ? ` · from ${formatMoney(from)}` : ""}
                </div>
              </div>
            </button>
          );
        })}
        {uncategorizedCount > 0 && (
          <button onClick={() => onSelect("uncategorized")}
            className="text-left rounded-2xl overflow-hidden relative aspect-[4/3] flex flex-col justify-end p-3 active:scale-[0.98] transition-transform border border-dashed"
            style={{ background: c.surface, borderColor: c.borderStrong }}>
            <LayoutGrid size={16} className="mb-auto mt-0.5" style={{ color: c.textFaint }} />
            <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>More to find</div>
            <div className="font-extrabold uppercase tracking-tight text-lg leading-tight" style={{ color: c.text }}>Other items</div>
            <div className="font-mono text-[10px] mt-0.5" style={{ color: c.textFaint }}>{uncategorizedCount} item{uncategorizedCount === 1 ? "" : "s"}</div>
          </button>
        )}
      </div>
    </div>
  );
}

// The collage behind a department tile — 1 photo fills the whole tile same
// as before, but 2+ distinct products' photos split the tile between them
// (a big lead shot plus smaller stacked ones) so the directory itself shows
// a spread of what's inside rather than a single item standing in for the
// whole aisle.
function DeptTileCollage({ photos }) {
  if (photos.length === 1) {
    return <img src={photos[0]} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />;
  }
  if (photos.length === 2) {
    return (
      <div className="absolute inset-0 grid grid-cols-2 gap-[1.5px]">
        {photos.map((src, i) => <img key={i} src={src} alt="" loading="lazy" className="w-full h-full object-cover" />)}
      </div>
    );
  }
  if (photos.length === 3) {
    return (
      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-[1.5px]">
        <img src={photos[0]} alt="" loading="lazy" className="w-full h-full object-cover row-span-2" />
        <img src={photos[1]} alt="" loading="lazy" className="w-full h-full object-cover" />
        <img src={photos[2]} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
    );
  }
  return (
    <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-[1.5px]">
      {photos.map((src, i) => <img key={i} src={src} alt="" loading="lazy" className="w-full h-full object-cover" />)}
    </div>
  );
}

// Same idea as DepartmentShowcase, one level (or several) further in — each
// subcategory gets its own photo-collage tile instead of a plain text chip,
// so drilling into a category still shows a spread of what's actually
// inside before tapping. Reused at every depth of the tree: a subcategory's
// own children look exactly the same way when you drill in again. Slightly
// smaller and quieter (bordered surface, not a colored gradient) than the
// top-level department tiles, so the hierarchy still reads at a glance.
function CategoryShowcase({ categories, allCategories, itemsForCat, onSelect, c }) {
  if (categories.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-2 mb-4">
      {categories.map((cat) => {
        const items = itemsForCat(cat.id);
        const photos = [...new Set(items.map((it) => toProxiedUrl(it.image_url)).filter(Boolean))].slice(0, 4);
        const hasChildren = categoryChildren(allCategories, cat.id).length > 0;
        return (
          <button key={cat.id} onClick={() => onSelect(cat.id)}
            className="text-left rounded-xl overflow-hidden relative aspect-[16/10] active:scale-[0.98] transition-transform border"
            style={{ background: c.surface, borderColor: c.border }}>
            {photos.length > 0 ? <DeptTileCollage photos={photos} /> : (
              <div className="absolute inset-0 flex items-center justify-center" style={{ background: c.surfaceHover }}>
                <LayoutGrid size={16} style={{ color: c.textFaint }} />
              </div>
            )}
            <div className="absolute inset-0" style={{ background: photos.length > 0 ? "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.1) 55%, rgba(0,0,0,0) 100%)" : "transparent" }} />
            {hasChildren && (
              <span className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center font-mono text-[10px]"
                style={{ background: "rgba(0,0,0,0.45)", color: "#fff" }}>›</span>
            )}
            <div className="absolute bottom-0 left-0 right-0 p-2.5">
              <div className="font-extrabold uppercase tracking-tight text-[12px] leading-tight truncate"
                style={{ color: photos.length > 0 ? "#fff" : c.text, textShadow: photos.length > 0 ? "0 1px 3px rgba(0,0,0,0.4)" : "none" }}>{cat.name}</div>
              <div className="font-mono text-[9px] mt-0.5" style={{ color: photos.length > 0 ? "rgba(255,255,255,0.85)" : c.textFaint }}>
                {items.length} item{items.length === 1 ? "" : "s"}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ProductGrid({ products, loading, onOpen, onQuickAdd, c }) {
  if (loading) return <Spinner c={c} />;
  if (products.length === 0) {
    return (
      <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
        No products yet — check back soon.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      {products.map((p) => {
        const canQuickAdd = onQuickAdd && p.active && p.stock_qty !== 0;
        return (
          <div key={p.id} role="button" tabIndex={0} onClick={() => onOpen(p)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen(p)}
            className="text-left rounded-xl overflow-hidden border cursor-pointer" style={{ background: c.surface, borderColor: c.border, opacity: p.active ? 1 : 0.5 }}>
            <div className="aspect-square relative flex items-center justify-center" style={{ background: c.surfaceHover }}>
              {p.image_url ? <img src={toProxiedUrl(p.image_url)} alt={p.name} loading="lazy" className="w-full h-full object-cover" /> : <ImageIcon size={28} style={{ color: c.textFaint }} />}
              {canQuickAdd && (
                <button onClick={(e) => { e.stopPropagation(); onQuickAdd(p); }} aria-label={`Add ${p.name} to cart`}
                  className="absolute bottom-2 right-2 w-9 h-9 rounded-full flex items-center justify-center shadow-md" style={{ background: SHOP_GOLD, color: "#1a1200" }}>
                  <Plus size={18} />
                </button>
              )}
            </div>
            <div className="p-3">
              <div className="font-body text-sm leading-snug line-clamp-2 min-h-[2.5rem]" style={{ color: c.text }}>{p.name}</div>
              <div className="font-body text-base font-extrabold mt-1" style={{ color: c.text }}>
                {(() => { const vp = activeVariants(p).map((v) => Number(v.price ?? p.price)); const lo = vp.length ? Math.min(...vp) : Number(p.price);
                  return <>{vp.length && Math.max(...vp) > lo ? "From " : ""}{formatMoney(lo)}{p.compare_at_price > lo && <span className="ml-1.5 text-xs font-semibold line-through" style={{ color: c.textFaint }}>{formatMoney(p.compare_at_price)}</span>}</>; })()}
              </div>
              {p.rating_count > 0 && (
                <div className="flex items-center gap-1 mt-0.5" data-testid="card-rating">
                  <StarRow value={p.rating_avg} size={11} />
                  <span className="font-body text-[11px]" style={{ color: c.textFaint }}>{p.rating_avg.toFixed(1)} ({p.rating_count})</span>
                </div>
              )}
              {(p.breaks || []).length > 0 && <div className="font-body text-xs mt-0.5" style={{ color: SHOP_GOLD }}>Buy more, pay less</div>}
              {!p.active && <div className="font-body text-xs mt-1" style={{ color: c.textFaint }}>Hidden from shoppers</div>}
              {p.active && p.stock_qty === 0 && <div className="font-body text-xs font-semibold mt-1" style={{ color: c.red }}>Out of stock</div>}
              {p.active && p.stock_qty > 0 && p.stock_qty <= 5 && <div className="font-body text-xs font-semibold mt-1" style={{ color: SHOP_GOLD }}>Only {p.stock_qty} left</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProductModal({ product, onClose, onAdd, onShare, session, profile, isAdmin, onRequireAuth, showToast, onRatingsChanged, c }) {
  const [qty, setQty] = useState(1);
  const variants = activeVariants(product);
  const [variantId, setVariantId] = useState(null);
  const [photoIdx, setPhotoIdx] = useState(0);
  const variant = variants.find((v) => v.id === variantId) || null;
  const photos = productPhotos(product);
  const stock = variants.length ? (variant ? variant.stock_qty : null) : (product.stock_qty ?? 0);
  const outOfStock = (product.stock_qty ?? 0) === 0;
  const unit = unitPriceFor(product, variantId, qty);
  const listUnit = Number(variant?.price ?? product.price);
  const breaks = (product.breaks || []).slice().sort((a, b) => a.min_qty - b.min_qty);
  const cap = stock ?? 99;
  const pick = (v) => { setVariantId(v.id); setQty((q) => Math.min(q, Math.max(1, v.stock_qty))); };
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl overflow-hidden max-h-[85vh] overflow-y-auto" style={{ background: c.bg }} onClick={(e) => e.stopPropagation()}>
        <div className="aspect-square relative flex items-center justify-center" style={{ background: c.surfaceHover }}>
          {photos[photoIdx] ? <img src={toProxiedUrl(photos[photoIdx])} alt={product.name} className="w-full h-full object-cover" /> : <ImageIcon size={40} style={{ color: c.textFaint }} />}
          <button onClick={onShare} aria-label="Share this product" title="Share this product" className="absolute top-3 left-3 w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}><Share2 size={15} /></button>
          <button onClick={onClose} className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}><X size={16} /></button>
        </div>
        {photos.length > 1 && (
          <div className="flex gap-2 px-4 pt-3 overflow-x-auto" data-testid="gallery">
            {photos.map((u, i) => (
              <button key={u} onClick={() => setPhotoIdx(i)} aria-label={`Photo ${i + 1}`} className="w-14 h-14 rounded-lg overflow-hidden shrink-0 border-2" style={{ borderColor: i === photoIdx ? SHOP_GOLD : "transparent" }}>
                <img src={toProxiedUrl(u)} alt="" loading="lazy" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
        <div className="p-4">
          <div className="font-extrabold uppercase tracking-tight text-lg leading-tight">{product.name}</div>
          <div className="font-mono text-sm font-semibold mt-1" style={{ color: SHOP_GOLD }}>
            {formatMoney(unit)}
            {unit < listUnit && <span className="ml-2 line-through" style={{ color: c.textFaint }}>{formatMoney(listUnit)}</span>}
            {unit >= listUnit && product.compare_at_price > listUnit && <span className="ml-2 line-through" style={{ color: c.textFaint }}>{formatMoney(product.compare_at_price)}</span>}
          </div>
          {product.description && <p className="font-body text-sm mt-2.5" style={{ color: c.textDim }}>{product.description}</p>}
          {/^https:\/\//i.test(product.facebook_url || "") && (
            <a href={product.facebook_url} target="_blank" rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 font-body text-xs font-semibold px-3.5 py-2 rounded-full" style={{ background: "#1877F2", color: "#fff" }}>
              <Facebook size={14} /> See this on Facebook
            </a>
          )}

          {variants.length > 0 && (
            <div className="mt-3.5" data-testid="variants">
              <div className="font-body text-xs font-semibold mb-1.5" style={{ color: c.textDim }}>Choose an option</div>
              <div className="flex flex-wrap gap-2">
                {variants.map((v) => {
                  const sold = v.stock_qty <= 0; const on = v.id === variantId;
                  return (
                    <button key={v.id} disabled={sold} onClick={() => pick(v)} aria-pressed={on}
                      className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border"
                      style={{ background: on ? SHOP_GOLD : c.surface, color: on ? "#1a1200" : c.text, borderColor: on ? SHOP_GOLD : c.border, opacity: sold ? 0.4 : 1, textDecoration: sold ? "line-through" : "none" }}>
                      {v.name}{v.price != null && Number(v.price) !== Number(product.price) ? ` · ${formatMoney(v.price)}` : ""}
                    </button>
                  );
                })}
              </div>
              {variant && variant.stock_qty <= 5 && <div className="font-body text-xs font-semibold mt-1.5" style={{ color: SHOP_GOLD }}>Only {variant.stock_qty} left</div>}
            </div>
          )}

          {breaks.length > 0 && (
            <div className="mt-3.5 rounded-lg p-2.5 font-body text-xs" style={{ background: c.surface, color: c.textDim }} data-testid="breaks">
              <div className="font-semibold mb-1" style={{ color: c.text }}>Buy more, pay less</div>
              {breaks.map((b) => <div key={b.id || b.min_qty}>{b.min_qty}+ items: {formatMoney(b.unit_price)} each</div>)}
            </div>
          )}

          {outOfStock ? (
            <div className="mt-4 font-body text-sm text-center py-2.5 rounded-full" style={{ background: c.surface, color: c.textDim }}>Out of stock</div>
          ) : (
            <>
              <div className="flex items-center justify-center gap-4 mt-4">
                <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surface, color: c.text }}><Minus size={14} /></button>
                <span className="font-mono font-bold text-base w-6 text-center">{qty}</span>
                <button onClick={() => setQty((q) => Math.min(cap || 99, q + 1))} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surface, color: c.text }}><Plus size={14} /></button>
              </div>
              <button onClick={() => onAdd(qty, variant)} disabled={variants.length > 0 && !variant}
                className="w-full mt-4 font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: variants.length > 0 && !variant ? 0.5 : 1 }}>
                {variants.length > 0 && !variant ? "Choose an option" : `Add to cart · ${formatMoney(unit * qty)}`}
              </button>
            </>
          )}

          <ProductReviews product={product} session={session} profile={profile} isAdmin={isAdmin} onRequireAuth={onRequireAuth}
            showToast={showToast} onRatingsChanged={onRatingsChanged} c={c} />
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// CART
// ════════════════════════════════════════════════════════════════════

function CartView({ cart, onUpdateQty, onRemove, onCheckout, onContinue, c }) {
  const total = cart.reduce((sum, it) => sum + it.qty * it.price, 0);
  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <ShoppingCart size={20} style={{ color: SHOP_GOLD }} />
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Your cart</h1>
      </div>
      {cart.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          Your cart is empty.
          <div className="mt-3"><button onClick={onContinue} className="font-body text-sm font-semibold px-4 py-2 rounded-full" style={{ background: c.accent, color: c.accentText }}>Browse the shop</button></div>
        </div>
      ) : (
        <>
          <div className="space-y-2 mb-5">
            {cart.map((it) => (
              <div key={it.key} className="flex items-center gap-3 rounded-xl p-2.5 border" style={{ background: c.surface, borderColor: c.border }}>
                <div className="w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center shrink-0" style={{ background: c.surfaceHover }}>
                  {it.image_url ? <img src={toProxiedUrl(it.image_url)} alt="" loading="lazy" className="w-full h-full object-cover" /> : <ImageIcon size={16} style={{ color: c.textFaint }} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-body text-xs font-semibold truncate">{it.name}</div>
                  <div className="font-mono text-xs" style={{ color: SHOP_GOLD }}>{formatMoney(it.price)}{it.price < it.listPrice && <span className="ml-1.5 line-through" style={{ color: c.textFaint }}>{formatMoney(it.listPrice)}</span>}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => onUpdateQty(it.key, it.qty - 1)} className="w-6 h-6 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><Minus size={11} /></button>
                  <span className="font-mono text-xs font-bold w-4 text-center">{it.qty}</span>
                  <button onClick={() => onUpdateQty(it.key, it.qty + 1)} className="w-6 h-6 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><Plus size={11} /></button>
                  <button onClick={() => onRemove(it.key)} className="w-6 h-6 rounded-full flex items-center justify-center ml-1" style={{ color: c.red }}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mb-4 px-1">
            <span className="font-body text-sm font-semibold" style={{ color: c.textDim }}>Total</span>
            <span className="font-mono text-lg font-bold">{formatMoney(total)}</span>
          </div>
          <button onClick={onCheckout} className="w-full font-body text-sm font-semibold py-3 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200" }}>Check out</button>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// CHECKOUT — three methods, buyer picks one
// ════════════════════════════════════════════════════════════════════

function CheckoutView({ cart, total, session, profile, eftDetails, onStockChanged, onDone, onBack, showToast, c }) {
  const [method, setMethod] = useState(SHOP_IKHOKHA_LINK ? "ikhokha" : (SHOP_WHATSAPP_NUMBER ? "whatsapp" : "manual_proof"));
  const [submitting, setSubmitting] = useState(false);
  const [proofFile, setProofFile] = useState(null);
  const [note, setNote] = useState("");
  const [contactPhone, setContactPhone] = useState(profile?.phone || "");
  const [email, setEmail] = useState(session?.user?.email || "");
  const [guestName, setGuestName] = useState("");
  // Delivery: options are priced by the server for this exact cart. An empty
  // list means no delivery method is switched on, so the step is skipped.
  const [deliveryOptions, setDeliveryOptions] = useState(null); // null = loading
  const [deliveryMethod, setDeliveryMethod] = useState("");
  const [addr, setAddr] = useState({ street: "", suburb: "", city: "", province: "", postal_code: "" });
  const [point, setPoint] = useState("");

  const cartKey = cart.map((it) => `${it.productId}:${it.variantId || ""}:${it.qty}`).join(",");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("shop_delivery_options", { p_items: cart.map((it) => ({ product_id: it.productId, variant_id: it.variantId || null, qty: it.qty })) });
      if (cancelled) return;
      const list = !error && Array.isArray(data) ? data : [];
      setDeliveryOptions(list);
      setDeliveryMethod((cur) => (list.some((o) => o.method === cur && o.available) ? cur : (list.find((o) => o.available)?.method || "")));
    })();
    return () => { cancelled = true; };
  }, [cartKey]);

  const chosenOption = (deliveryOptions || []).find((o) => o.method === deliveryMethod && o.available) || null;
  const deliveryFee = chosenOption ? Number(chosenOption.fee) || 0 : 0;
  const grandTotal = total + deliveryFee;
  const deliveryRequired = (deliveryOptions || []).length > 0;

  const buyerUsername = profile?.efootball_username || session?.user?.email || guestName.trim() || "Shopper";
  // Anonymous shoppers don't have an auth-issued id, so proof uploads for
  // guest orders go into their own folder rather than a user's storage path.
  const guestFolderId = useRef(null);
  if (!session && !guestFolderId.current) {
    guestFolderId.current = (crypto.randomUUID ? crypto.randomUUID() : `guest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  const orderLines = () => cart.map((it) => `${it.qty}x ${it.name} — ${formatMoney(it.qty * it.price)}`).join("\n");

  const missingGuestName = !session && !guestName.trim();
  // Guests need some way to find their order again: a phone number or email.
  const missingContact = !contactPhone.trim() && !email.trim();

  // Orders are created on the server (place_shop_order): it re-checks prices
  // and stock, saves the order and reserves the stock in one step. Returns
  // { order } or { error }.
  const placeOrder = async (checkoutMethod, proofPath) => {
    const { data, error } = await supabase.rpc("place_shop_order", {
      p_items: cart.map((it) => ({ product_id: it.productId, variant_id: it.variantId || null, qty: it.qty })),
      p_method: checkoutMethod,
      p_buyer_name: buyerUsername,
      p_phone: contactPhone.trim() || null,
      p_email: email.trim() || null,
      p_note: note.trim() || null,
      p_proof_path: proofPath || null,
      p_delivery: deliveryRequired ? { method: deliveryMethod, address: deliveryMethod === "courier" ? addr : null, point: point.trim() || null } : null,
    });
    if (error) {
      onStockChanged && onStockChanged(); // stock may have changed under the shopper
      return { error: error.message };
    }
    return { order: data };
  };

  const precheck = () => {
    if (deliveryOptions === null) { showToast("Checking delivery options, one moment."); return false; }
    if (deliveryRequired) {
      if (!chosenOption) { showToast("Choose how you want to receive your order."); return false; }
      if (deliveryMethod === "courier" && (!addr.street.trim() || !addr.city.trim() || !addr.postal_code.trim())) { showToast("Enter your street address, city and postal code."); return false; }
      if ((deliveryMethod === "pudo" || deliveryMethod === "paxi") && !point.trim()) { showToast(deliveryMethod === "pudo" ? "Enter the Pudo locker you want to collect from." : "Enter the PAXI point you want to collect from."); return false; }
    }
    if (missingGuestName) { showToast("Let us know your name before ordering."); return false; }
    if (missingContact) { showToast("Add a phone number or email so we can reach you and you can track the order."); return false; }
    return true;
  };

  const submitWhatsapp = async () => {
    if (!SHOP_WHATSAPP_NUMBER) { showToast("WhatsApp ordering isn't set up yet."); return; }
    if (!precheck()) return;
    setSubmitting(true);
    const { order, error } = await placeOrder("whatsapp");
    setSubmitting(false);
    if (error) { showToast(error); return; }
    const delivLine = chosenOption ? `\nDelivery: ${chosenOption.label}${deliveryMethod === "courier" ? ` to ${[addr.street, addr.suburb, addr.city, addr.postal_code].filter(Boolean).join(", ")}` : (point.trim() ? ` (${point.trim()})` : "")} — ${Number(order.delivery_fee) ? formatMoney(order.delivery_fee) : "free"}` : "";
    const msg = `Hi, I'd like to order from WeAfrica Shop:\n\nOrder ${order.order_number}\n${orderLines()}${delivLine}\n\nTotal: ${formatMoney(order.total ?? order.subtotal)}\n\nName: ${buyerUsername}`;
    window.open(waLink(SHOP_WHATSAPP_NUMBER, msg), "_blank", "noopener,noreferrer");
    onDone(order);
  };

  const submitManualProof = async () => {
    if (!precheck()) return;
    if (!proofFile) { showToast("Attach your proof of payment before submitting."); return; }
    setSubmitting(true);
    const compressedProof = await compressImage(proofFile, { maxDimension: 1600, quality: 0.85 });
    const ext = (compressedProof.name.split(".").pop() || "dat").toLowerCase();
    const path = `${session?.user?.id || `guest-${guestFolderId.current}`}/order-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("shop-payment-proofs").upload(path, compressedProof, { cacheControl: "31536000" });
    if (uploadErr) { setSubmitting(false); showToast(`Couldn't upload proof: ${uploadErr.message}`); return; }
    const { order, error } = await placeOrder("manual_proof", path);
    setSubmitting(false);
    if (error) { showToast(error); return; }
    showToast("Order submitted. We'll check your payment shortly.");
    onDone(order);
  };

  const submitIkhokha = async () => {
    if (!SHOP_IKHOKHA_LINK) { showToast("Card payments aren't set up yet."); return; }
    if (!precheck()) return;
    setSubmitting(true);
    const { order, error } = await placeOrder("ikhokha_link");
    setSubmitting(false);
    if (error) { showToast(error); return; }
    window.open(SHOP_IKHOKHA_LINK, "_blank", "noopener,noreferrer");
    showToast(`Order ${order.order_number} saved. Pay ${formatMoney(order.total ?? order.subtotal)} on the card page and use ${order.order_number} as the reference.`);
    onDone(order);
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <CreditCard size={20} style={{ color: SHOP_GOLD }} />
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Checkout</h1>
      </div>

      <div className="flex items-center justify-between mb-4 px-1">
        <span className="font-body text-sm font-semibold" style={{ color: c.textDim }}>{cart.reduce((s, it) => s + it.qty, 0)} item(s)</span>
        <span className="font-mono text-lg font-bold">{formatMoney(total)}</span>
      </div>
      {deliveryFee > 0 && (
        <div className="flex items-center justify-between mb-1 px-1 font-body text-sm" style={{ color: c.textDim }}>
          <span>Delivery</span><span className="font-mono">{formatMoney(deliveryFee)}</span>
        </div>
      )}
      {deliveryRequired && (
        <div className="flex items-center justify-between mb-4 px-1 pt-1 border-t" style={{ borderColor: c.border }}>
          <span className="font-body text-sm font-semibold">Total to pay</span>
          <span className="font-mono text-lg font-bold" style={{ color: SHOP_GOLD }}>{formatMoney(grandTotal)}</span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-1.5 mb-5 p-1 rounded-full" style={{ background: c.surface }}>
        <button onClick={() => SHOP_IKHOKHA_LINK && setMethod("ikhokha")} disabled={!SHOP_IKHOKHA_LINK}
          className="font-body text-[11px] font-semibold py-2 rounded-full flex flex-col items-center gap-0.5"
          style={method === "ikhokha" ? { background: c.text, color: c.bg } : { color: c.textDim, opacity: SHOP_IKHOKHA_LINK ? 1 : 0.4 }}>
          {SHOP_IKHOKHA_LINK ? <CreditCard size={13} /> : <Lock size={13} />} Card
        </button>
        <button onClick={() => setMethod("whatsapp")} disabled={!SHOP_WHATSAPP_NUMBER}
          className="font-body text-[11px] font-semibold py-2 rounded-full flex flex-col items-center gap-0.5"
          style={method === "whatsapp" ? { background: c.text, color: c.bg } : { color: c.textDim, opacity: SHOP_WHATSAPP_NUMBER ? 1 : 0.4 }}>
          <MessageCircle size={13} /> WhatsApp
        </button>
        <button onClick={() => setMethod("manual_proof")}
          className="font-body text-[11px] font-semibold py-2 rounded-full flex flex-col items-center gap-0.5"
          style={method === "manual_proof" ? { background: c.text, color: c.bg } : { color: c.textDim }}>
          <Upload size={13} /> EFT proof
        </button>
      </div>

      {!session && (
        <div className="mb-4">
          <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Your name</label>
          <input value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="So we know who the order is from"
            className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        </div>
      )}

      <div className="mb-3">
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Phone number</label>
        <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Where can we reach you about this order?" inputMode="tel" autoComplete="tel"
          className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>
      <div className="mb-4">
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Email (optional if you gave a phone number)</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="For your order receipt" inputMode="email" autoComplete="email" type="email"
          className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      {deliveryRequired && (
        <fieldset className="mb-5">
          <legend className="font-body text-sm font-semibold mb-2" style={{ color: c.text }}>How do you want to receive it?</legend>
          <div className="space-y-2">
            {deliveryOptions.map((o) => {
              const selected = deliveryMethod === o.method;
              return (
                <label key={o.method} className="flex items-start gap-3 rounded-xl border p-3 cursor-pointer"
                  style={{ background: c.surface, borderColor: selected ? SHOP_GOLD : c.border, opacity: o.available ? 1 : 0.5 }}>
                  <input type="radio" name="delivery" className="mt-1" checked={selected} disabled={!o.available} onChange={() => setDeliveryMethod(o.method)} />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-body text-sm font-semibold">{o.label}</span>
                      <span className="font-mono text-sm font-bold">{!o.available ? "" : Number(o.fee) > 0 ? formatMoney(o.fee) : "Free"}</span>
                    </span>
                    {o.available && o.days && <span className="block font-body text-xs" style={{ color: c.textFaint }}>{o.days}</span>}
                    {o.note && <span className="block font-body text-xs whitespace-pre-line" style={{ color: o.available ? c.textDim : c.red }}>{o.note}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          {deliveryMethod === "courier" && (
            <div className="grid grid-cols-2 gap-2 mt-3">
              {[["street", "Street address", 2], ["suburb", "Suburb", 1], ["city", "City", 1], ["province", "Province", 1], ["postal_code", "Postal code", 1]].map(([k, label, span]) => (
                <input key={k} value={addr[k]} onChange={(e) => setAddr((a) => ({ ...a, [k]: e.target.value }))} placeholder={label} aria-label={label}
                  autoComplete={k === "postal_code" ? "postal-code" : k === "street" ? "street-address" : undefined} inputMode={k === "postal_code" ? "numeric" : undefined}
                  className={`border rounded-lg px-3 py-2.5 font-body text-sm outline-none ${span === 2 ? "col-span-2" : ""}`} style={{ background: c.surface, borderColor: c.border, color: c.text }} />
              ))}
            </div>
          )}
          {(deliveryMethod === "pudo" || deliveryMethod === "paxi") && (
            <div className="mt-3">
              <input value={point} onChange={(e) => setPoint(e.target.value)} aria-label={deliveryMethod === "pudo" ? "Pudo locker" : "PAXI point"}
                placeholder={deliveryMethod === "pudo" ? "Pudo locker name or code, and town" : "PEP store (PAXI point) name or code, and town"}
                className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
              <p className="font-body text-xs mt-1" style={{ color: c.textFaint }}>
                {deliveryMethod === "pudo" ? "Pick a locker near you on the Pudo website or app and type its name here." : "Find a PAXI point at paxi.co.za and type the store name here."}
              </p>
            </div>
          )}
        </fieldset>
      )}

      {method === "whatsapp" && (
        <div className="space-y-3">
          <p className="font-body text-sm" style={{ color: c.textDim }}>
            Your order summary will be sent to us on WhatsApp, and we'll confirm payment and delivery with you directly there.
          </p>
          <button onClick={submitWhatsapp} disabled={submitting || missingGuestName}
            className="w-full font-body text-sm font-semibold py-3 rounded-full flex items-center justify-center gap-2" style={{ background: "#25D366", color: "#fff", opacity: (submitting || missingGuestName) ? 0.6 : 1 }}>
            <MessageCircle size={15} /> {submitting ? "Sending..." : "Order on WhatsApp"}
          </button>
        </div>
      )}

      {method === "manual_proof" && (
        <div className="space-y-3">
          {eftDetails && (
            <div className="rounded-xl p-3 border font-mono text-xs whitespace-pre-line" style={{ background: c.surface, borderColor: c.border, color: c.textDim }}>
              <img src="/capitec-logo.png" alt="Capitec Bank" className="h-4 w-auto object-contain mb-2" />
              {eftDetails}
            </div>
          )}
          <div className="rounded-xl p-3 border font-mono text-xs whitespace-pre-line" style={{ background: c.surface, borderColor: c.border, color: c.textDim }}>
            <img src="/mukuru-logo.png" alt="Mukuru" className="h-4 w-auto object-contain mb-2" />
            {SHOP_MUKURU_DETAILS}
          </div>
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Delivery or collection note (optional)</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything we should know, such as gate codes or a preferred time"
              className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none resize-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          </div>
          <label className="flex items-center gap-2 border border-dashed rounded-lg px-3 py-3 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: proofFile ? c.text : c.textDim }}>
            <Upload size={15} />
            {proofFile ? proofFile.name : "Attach proof of payment"}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setProofFile(e.target.files?.[0] || null)} />
          </label>
          <button onClick={submitManualProof} disabled={submitting || missingGuestName}
            className="w-full font-body text-sm font-semibold py-3 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: (submitting || missingGuestName) ? 0.6 : 1 }}>
            {submitting ? "Submitting..." : "Submit order"}
          </button>
        </div>
      )}

      {method === "ikhokha" && SHOP_IKHOKHA_LINK && (
        <div className="space-y-3">
          <p className="font-body text-sm" style={{ color: c.textDim }}>
            You'll be taken to a secure card checkout page to pay {formatMoney(grandTotal)}. Once you've paid, come back here — we'll confirm your order shortly after.
          </p>
          <CardBrandsBadge c={c} />
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Delivery or collection note (optional)</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything we should know, such as gate codes or a preferred time"
              className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none resize-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          </div>
          <button onClick={submitIkhokha} disabled={submitting || missingGuestName}
            className="w-full font-body text-sm font-semibold py-3 rounded-full flex items-center justify-center gap-2" style={{ background: c.accent, color: c.accentText, opacity: (submitting || missingGuestName) ? 0.6 : 1 }}>
            <CreditCard size={15} /> {submitting ? "Submitting..." : `Pay ${formatMoney(grandTotal)}`}
          </button>
        </div>
      )}

      <button onClick={onBack} className="w-full mt-3 font-body text-xs" style={{ color: c.textFaint }}>Back to cart</button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// MY ORDERS
// ════════════════════════════════════════════════════════════════════

function TrackOrder({ initialNumber, c }) {
  const [number, setNumber] = useState(initialNumber || "");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(undefined); // undefined = not searched, null = not found
  const find = async (e) => {
    e && e.preventDefault();
    if (!number.trim() || !contact.trim()) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("lookup_shop_order", { p_order_number: number, p_contact: contact });
    setBusy(false);
    setResult(error ? null : data);
  };
  const inputCls = "w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none";
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Truck size={20} style={{ color: SHOP_GOLD }} />
        <h1 className="text-2xl font-extrabold tracking-tight leading-none">Track an order</h1>
      </div>
      <p className="font-body text-sm mb-5" style={{ color: c.textDim }}>Enter your order number and the phone number or email you used at checkout.</p>
      <form onSubmit={find} className="space-y-3 mb-5">
        <div>
          <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Order number</label>
          <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="WA-10001" autoCapitalize="characters" className={inputCls} style={inputStyle} />
        </div>
        <div>
          <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Phone number or email</label>
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="The one you gave when ordering" className={inputCls} style={inputStyle} />
        </div>
        <button type="submit" disabled={busy || !number.trim() || !contact.trim()} className="w-full font-body text-sm font-semibold py-3 rounded-full"
          style={{ background: SHOP_GOLD, color: "#1a1200", opacity: (busy || !number.trim() || !contact.trim()) ? 0.6 : 1 }}>
          {busy ? "Looking..." : "Find my order"}
        </button>
      </form>
      {result === null && (
        <div className="border border-dashed rounded-xl p-5 text-center font-body text-sm" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          We couldn't find that order. Check the order number and use the same phone number or email you gave at checkout.
        </div>
      )}
      {result && (
        <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-base font-bold" style={{ color: SHOP_GOLD }}>{result.order_number}</span>
            <StatusBadge status={result.status} c={c} />
          </div>
          <div className="font-body text-xs mb-3" style={{ color: c.textFaint }}>Placed {new Date(result.created_at).toLocaleDateString()}</div>
          {(result.items || []).map((it, i) => (
            <div key={i} className="font-body text-sm flex items-center justify-between" style={{ color: c.textDim }}>
              <span>{it.qty}x {it.product_name}</span>
              <span>{formatMoney(it.qty * it.unit_price)}</span>
            </div>
          ))}
          {Number(result.delivery_fee) > 0 && (
            <div className="font-body text-sm flex items-center justify-between" style={{ color: c.textDim }}>
              <span>Delivery</span><span>{formatMoney(result.delivery_fee)}</span>
            </div>
          )}
          <div className="flex items-center justify-between mt-2 pt-2 border-t" style={{ borderColor: c.border }}>
            <span className="font-body text-sm font-semibold">Total</span>
            <span className="font-mono text-base font-bold">{formatMoney(Number(result.subtotal) + Number(result.delivery_fee || 0))}</span>
          </div>
          {result.delivery_method && (
            <div className="font-body text-xs mt-3" style={{ color: c.textDim }}>
              {DELIVERY_LABELS[result.delivery_method]}{result.delivery_point ? `: ${result.delivery_point}` : ""}
            </div>
          )}
          {result.tracking_number && (
            <div className="rounded-lg px-3 py-2 mt-3 font-body text-sm" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
              <span style={{ color: c.textFaint }}>{result.courier_name ? `${result.courier_name} tracking number` : "Tracking number"}</span>
              <div className="font-mono font-bold select-all">{result.tracking_number}</div>
            </div>
          )}
          {(result.history || []).length > 0 && (
            <ol className="mt-4 space-y-1.5">
              {result.history.map((h, i) => (
                <li key={i} className="flex items-center justify-between font-body text-xs" style={{ color: c.textDim }}>
                  <span>{(STATUS_META[h.status]?.label) || h.status}</span>
                  <span style={{ color: c.textFaint }}>{new Date(h.at).toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function MyOrders({ orders, c }) {
  if (orders === null) return <Spinner c={c} />;
  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <ClipboardList size={20} style={{ color: SHOP_GOLD }} />
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">My orders</h1>
      </div>
      {orders.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No orders yet.</div>
      ) : (
        <div className="space-y-2.5">
          {orders.map((o) => (
            <div key={o.id} className="rounded-xl p-3 border" style={{ background: c.surface, borderColor: c.border }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-body text-xs" style={{ color: c.textFaint }}><span className="font-mono font-bold" style={{ color: c.text }}>{o.order_number}</span> · {new Date(o.created_at).toLocaleDateString()}</span>
                <StatusBadge status={o.status} c={c} />
              </div>
              {(o.shop_order_items || []).map((it) => (
                <div key={it.id} className="font-body text-xs flex items-center justify-between" style={{ color: c.textDim }}>
                  <span>{it.qty}x {it.product_name}</span>
                  <span>{formatMoney(it.qty * it.unit_price)}</span>
                </div>
              ))}
              {Number(o.delivery_fee) > 0 && (
                <div className="font-body text-xs flex items-center justify-between" style={{ color: c.textDim }}><span>Delivery</span><span>{formatMoney(o.delivery_fee)}</span></div>
              )}
              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t" style={{ borderColor: c.border }}>
                <span className="font-body text-xs font-semibold">Total</span>
                <span className="font-mono text-sm font-bold">{formatMoney(Number(o.subtotal) + Number(o.delivery_fee || 0))}</span>
              </div>
              {o.delivery_method && <div className="font-body text-xs mt-1.5" style={{ color: c.textFaint }}>{deliverySummary(o)}</div>}
              {o.tracking_number && <div className="font-body text-xs mt-1" style={{ color: c.textDim }}>{o.courier_name ? `${o.courier_name}: ` : "Tracking: "}<span className="font-mono font-bold select-all">{o.tracking_number}</span></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ADMIN — PRODUCTS
// ════════════════════════════════════════════════════════════════════

// The category saved in the legacy single column: prefer one inside the main department.
function mainCategory(catIds, mainDeptId, categories) {
  const inMain = catIds.find((id) => categories.find((cat) => cat.id === id)?.department_id === mainDeptId);
  return inMain || catIds[0] || null;
}

function AdminProducts({ products, departments, categories, onReload, onReloadDepartments, onReloadCategories, showToast, onOpenOrders, requestConfirm, c }) {
  const [editing, setEditing] = useState(null); // product being edited, or {} for new
  const [managingDepts, setManagingDepts] = useState(false);
  const [query, setQuery] = useState("");

  if (products === null) return <Spinner c={c} />;
  const q = query.trim().toLowerCase();
  const filtered = q ? products.filter((p) => p.name.toLowerCase().includes(q)) : products;
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const catById = new Map(categories.map((cat) => [cat.id, cat]));

  const saveProduct = async (form, rawFile, extras = {}) => {
    let image_url = editing?.image_url || null;
    if (rawFile) {
      // A photo cut out by the background remover is a PNG with transparency:
      // keep it PNG, a JPEG would turn the clear areas black.
      const file = await compressImage(rawFile, { maxDimension: 1000, quality: 0.85, mimeType: rawFile.name.startsWith("nobg-") ? "image/png" : "image/jpeg" });
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${Date.now()}.${ext}`;
      let publicUrl;
      try {
        publicUrl = await uploadToR2("shop-photos", path, file);
      } catch (err) {
        showToast(`Couldn't upload image: ${err.message}`);
        return false;
      }
      image_url = publicUrl;
    }
    const hasVariants = (extras.variants || []).length > 0;
    const payload = { name: form.name, description: form.description || null, price: Number(form.price) || 0, compare_at_price: numOrNull(form.compare_at_price), facebook_url: /^https:\/\//i.test((form.facebook_url || "").trim()) ? form.facebook_url.trim() : null, ...(hasVariants ? {} : { stock_qty: Number(form.stock_qty) || 0 }), active: form.active, image_url, department_id: (extras.departmentIds || [])[0] || null, category_id: mainCategory(extras.categoryIds || [], (extras.departmentIds || [])[0], categories),
      weight_kg: numOrNull(form.weight_kg), length_cm: numOrNull(form.length_cm), width_cm: numOrNull(form.width_cm), height_cm: numOrNull(form.height_cm) };
    let productId = editing?.id;
    let error;
    if (productId) {
      ({ error } = await supabase.from("shop_products").update(payload).eq("id", productId));
    } else {
      const res = await supabase.from("shop_products").insert(hasVariants ? { ...payload, stock_qty: 0 } : payload).select("id").single();
      error = res.error; productId = res.data?.id;
    }
    if (error) { showToast(`Couldn't save product: ${error.message}`); return false; }

    // Every department and category the product is listed under.
    const deptRows = (extras.departmentIds || []).map((id) => ({ product_id: productId, department_id: id }));
    const catRows = (extras.categoryIds || []).map((id) => ({ product_id: productId, category_id: id }));
    for (const [table, rows] of [["shop_product_departments", deptRows], ["shop_product_categories", catRows]]) {
      const { error: e1 } = await supabase.from(table).delete().eq("product_id", productId);
      if (e1) { showToast(`Product saved, but updating where it is listed failed: ${e1.message}`); return false; }
      if (rows.length) {
        const { error: e2 } = await supabase.from(table).insert(rows);
        if (e2) { showToast(`Product saved, but updating where it is listed failed: ${e2.message}`); return false; }
      }
    }

    // Options, quantity prices and extra photos.
    const fail = (what, e) => { showToast(`Product saved, but ${what} failed: ${e.message}`); return false; };
    const keepVar = (extras.variants || []).filter((v) => v.id).map((v) => v.id);
    const oldVar = (editing?.variants || []).map((v) => v.id).filter((id) => !keepVar.includes(id));
    if (oldVar.length) { const { error: e } = await supabase.from("shop_product_variants").delete().in("id", oldVar); if (e) return fail("removing options", e); }
    let pos = 0;
    for (const v of extras.variants || []) {
      const row = { product_id: productId, name: v.name.trim(), price: numOrNull(v.price), stock_qty: Math.max(0, Number(v.stock_qty) || 0), active: v.active !== false, position: pos++ };
      const { error: e } = v.id ? await supabase.from("shop_product_variants").update(row).eq("id", v.id) : await supabase.from("shop_product_variants").insert(row);
      if (e) return fail("saving options", e);
    }
    if (editing?.id) { const { error: e } = await supabase.from("shop_price_breaks").delete().eq("product_id", productId); if (e) return fail("quantity prices", e); }
    const breakRows = (extras.breaks || []).filter((b) => Number(b.min_qty) >= 2 && b.unit_price !== "" && b.unit_price != null)
      .map((b) => ({ product_id: productId, min_qty: Math.floor(Number(b.min_qty)), unit_price: Number(b.unit_price) }));
    if (breakRows.length) { const { error: e } = await supabase.from("shop_price_breaks").insert(breakRows); if (e) return fail("quantity prices", e); }
    const keepImg = (extras.keptImages || []).map((i) => i.id);
    const oldImg = (editing?.images || []).map((i) => i.id).filter((id) => !keepImg.includes(id));
    if (oldImg.length) { const { error: e } = await supabase.from("shop_product_images").delete().in("id", oldImg); if (e) return fail("removing photos", e); }
    let ipos = keepImg.length;
    for (const raw of extras.newImages || []) {
      try {
        const file2 = await compressImage(raw, { maxDimension: 1000, quality: 0.85 });
        const ext2 = (file2.name.split(".").pop() || "jpg").toLowerCase();
        const url = await uploadToR2("shop-photos", `${Date.now()}-${ipos}.${ext2}`, file2);
        const { error: e } = await supabase.from("shop_product_images").insert({ product_id: productId, url, position: ipos++ });
        if (e) return fail("saving photos", e);
      } catch (err) { return fail("uploading photos", err); }
    }
    showToast(editing?.id ? "Product updated." : "Product added.");
    await onReload();
    return true;
  };

  const deleteProduct = (product) => {
    requestConfirm([
      `Delete "${product.name}"? This can't be undone.`,
      `Are you sure? It will be permanently removed from the shop.`,
      `Final check — click to permanently delete "${product.name}".`,
    ], async () => {
      const { error } = await supabase.from("shop_products").delete().eq("id", product.id);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      showToast("Product deleted.");
      await onReload();
    });
  };

  if (managingDepts) {
    return <AdminDepartments departments={departments} categories={categories} products={products} onReload={onReloadDepartments} onReloadCategories={onReloadCategories} showToast={showToast} requestConfirm={requestConfirm} onBack={() => setManagingDepts(false)} c={c} />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <Package size={20} style={{ color: SHOP_GOLD }} />
          <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Products</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setManagingDepts(true)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.surface, color: c.textDim }}>
            <LayoutGrid size={12} /> Departments
          </button>
          <button onClick={onOpenOrders} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surface, color: c.textDim }}>Orders</button>
        </div>
      </div>

      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products..."
          className="w-full border rounded-lg pl-9 pr-4 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      <button onClick={() => setEditing({})} className="w-full mb-4 font-body text-sm font-semibold py-2.5 rounded-full flex items-center justify-center gap-1.5" style={{ background: SHOP_GOLD, color: "#1a1200" }}>
        <Plus size={15} /> Add product
      </button>

      <div className="space-y-1.5">
        {filtered.map((p) => (
          <div key={p.id} className="flex items-center gap-2.5 rounded-xl p-2.5 border" style={{ background: c.surface, borderColor: c.border }}>
            <div className="w-10 h-10 rounded-lg overflow-hidden flex items-center justify-center shrink-0" style={{ background: c.surfaceHover }}>
              {p.image_url ? <img src={toProxiedUrl(p.image_url)} alt="" className="w-full h-full object-cover" /> : <ImageIcon size={14} style={{ color: c.textFaint }} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-body text-xs font-semibold truncate">{p.name}</div>
              <div className="font-mono text-[10px]" style={{ color: c.textDim }}>
                {formatMoney(p.price)} · {p.stock_qty} in stock {!p.active && "· hidden"}
                {(() => {
                  const ds = productDepts(p).filter((id) => deptById.has(id));
                  const cs = productCats(p).filter((id) => catById.has(id));
                  return <>
                    {ds.length > 0 && ` · ${deptById.get(ds[0]).name}${ds.length > 1 ? ` +${ds.length - 1}` : ""}`}
                    {cs.length > 0 && ` › ${categoryPathName(categories, cs[0])}${cs.length > 1 ? ` +${cs.length - 1}` : ""}`}
                  </>;
                })()}
              </div>
            </div>
            <button onClick={() => setEditing(p)} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.text }}>Edit</button>
            <button onClick={() => deleteProduct(p)} className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.red }}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      {editing && <ProductFormModal product={editing} departments={departments} categories={categories} onClose={() => setEditing(null)} onSave={saveProduct} c={c} />}
    </div>
  );
}

function ProductFormModal({ product, departments, categories, onClose, onSave, c }) {
  const [name, setName] = useState(product.name || "");
  const [description, setDescription] = useState(product.description || "");
  const [price, setPrice] = useState(product.price ?? "");
  const [stockQty, setStockQty] = useState(product.stock_qty ?? 0);
  const [active, setActive] = useState(product.active ?? true);
  const [deptIds, setDeptIds] = useState(productDepts(product));
  const [catIds, setCatIds] = useState(productCats(product));
  const [removerSource, setRemoverSource] = useState(null); // { kind: "main" | number (index in newImages), source }
  const [weightKg, setWeightKg] = useState(product.weight_kg ?? "");
  const [lengthCm, setLengthCm] = useState(product.length_cm ?? "");
  const [widthCm, setWidthCm] = useState(product.width_cm ?? "");
  const [heightCm, setHeightCm] = useState(product.height_cm ?? "");
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [compareAt, setCompareAt] = useState(product.compare_at_price ?? "");
  const [facebookUrl, setFacebookUrl] = useState(product.facebook_url || "");
  const [variants, setVariants] = useState((product.variants || []).map((v) => ({ id: v.id, name: v.name, price: v.price ?? "", stock_qty: v.stock_qty, active: v.active })));
  const [breaks, setBreaks] = useState((product.breaks || []).map((b) => ({ min_qty: b.min_qty, unit_price: b.unit_price })));
  const [keptImages, setKeptImages] = useState(product.images || []);
  const [newImages, setNewImages] = useState([]);
  const setVar = (i, patch) => setVariants((vs) => vs.map((v, j) => j === i ? { ...v, ...patch } : v));
  const setBrk = (i, patch) => setBreaks((bs) => bs.map((b, j) => j === i ? { ...b, ...patch } : b));
  const hasVariants = variants.length > 0;
  const varStockTotal = variants.filter((v) => v.active).reduce((n, v) => n + (Number(v.stock_qty) || 0), 0);
  const inputCls = "w-full border rounded-lg px-2.5 py-2 font-body text-sm outline-none";
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };

  // Categories belong to a department. A product can be in several
  // departments, and in categories of each; un-ticking a department drops
  // the categories that belonged to it. Each department's category tree is
  // flattened with indentation (it can go arbitrarily deep).
  const toggleDept = (id) => setDeptIds((ids) => {
    if (!ids.includes(id)) return [...ids, id];
    setCatIds((cs) => cs.filter((cid) => categories.find((cat) => cat.id === cid)?.department_id !== id));
    return ids.filter((d) => d !== id);
  });
  const toggleCat = (id) => setCatIds((cs) => (cs.includes(id) ? cs.filter((x) => x !== id) : [...cs, id]));

  const submit = async () => {
    if (!name.trim() || !price) return;
    if (variants.some((v) => !v.name.trim())) return;
    setSaving(true);
    const ok = await onSave({ name: name.trim(), description, price, compare_at_price: compareAt, facebook_url: facebookUrl, stock_qty: stockQty, active,
      weight_kg: weightKg, length_cm: lengthCm, width_cm: widthCm, height_cm: heightCm }, file, { variants, breaks, keptImages, newImages, departmentIds: deptIds, categoryIds: catIds });
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl p-4 max-h-[85vh] overflow-y-auto" style={{ background: c.bg }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="font-extrabold uppercase tracking-tight text-lg">{product.id ? "Edit product" : "Add product"}</div>
          <button onClick={onClose}><X size={18} style={{ color: c.textDim }} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          </div>
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none resize-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Price ({CURRENCY_PREFIX})</label>
              <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
            </div>
            <div>
              <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Stock</label>
              {hasVariants
                ? <div className="w-full border rounded-lg px-3 py-2.5 font-body text-sm" style={{ background: c.surface, borderColor: c.border, color: c.textDim }}>{varStockTotal} (from options)</div>
                : <input type="number" min="0" value={stockQty} onChange={(e) => setStockQty(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />}
            </div>
          </div>
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Old price ({CURRENCY_PREFIX}) — shown crossed out</label>
            <input type="number" min="0" step="0.01" value={compareAt} onChange={(e) => setCompareAt(e.target.value)} placeholder="Leave blank if not on sale" className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          </div>
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Facebook link for this product</label>
            <input type="url" value={facebookUrl} onChange={(e) => setFacebookUrl(e.target.value)} placeholder="https://www.facebook.com/..." className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
            <p className="font-body text-xs mt-1" style={{ color: c.textFaint }}>Link to this product's post on your Facebook page. Shoppers get a Facebook button that opens it. Blank hides the button.</p>
          </div>
          <div data-testid="variant-editor">
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Options (size, colour...)</label>
            <div className="space-y-2">
              {variants.map((v, i) => (
                <div key={v.id || `n${i}`} className="grid grid-cols-[1fr_4.5rem_4rem_auto] gap-1.5 items-center">
                  <input value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} placeholder="e.g. Large / Black" aria-label="Option name" className={inputCls} style={inputStyle} />
                  <input type="number" min="0" step="0.01" value={v.price} onChange={(e) => setVar(i, { price: e.target.value })} placeholder="Price" aria-label="Option price" className={inputCls} style={inputStyle} />
                  <input type="number" min="0" value={v.stock_qty} onChange={(e) => setVar(i, { stock_qty: e.target.value })} placeholder="Stock" aria-label="Option stock" className={inputCls} style={inputStyle} />
                  <button type="button" onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))} aria-label="Remove option" className="w-7 h-7 flex items-center justify-center" style={{ color: c.red }}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setVariants((vs) => [...vs, { name: "", price: "", stock_qty: 0, active: true }])} className="mt-2 font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1" style={{ background: c.surface, color: c.textDim }}><Plus size={12} /> Add option</button>
            <p className="font-body text-xs mt-1" style={{ color: c.textFaint }}>Each option has its own stock. Price is optional; blank uses the product price.</p>
          </div>
          <div data-testid="break-editor">
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Quantity prices</label>
            <div className="space-y-2">
              {breaks.map((b, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-center">
                  <input type="number" min="2" value={b.min_qty} onChange={(e) => setBrk(i, { min_qty: e.target.value })} placeholder="Buy at least" aria-label="Minimum quantity" className={inputCls} style={inputStyle} />
                  <input type="number" min="0" step="0.01" value={b.unit_price} onChange={(e) => setBrk(i, { unit_price: e.target.value })} placeholder={`Each (${CURRENCY_PREFIX})`} aria-label="Price each" className={inputCls} style={inputStyle} />
                  <button type="button" onClick={() => setBreaks((bs) => bs.filter((_, j) => j !== i))} aria-label="Remove quantity price" className="w-7 h-7 flex items-center justify-center" style={{ color: c.red }}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <button type="button" onClick={() => setBreaks((bs) => [...bs, { min_qty: "", unit_price: "" }])} className="mt-2 font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1" style={{ background: c.surface, color: c.textDim }}><Plus size={12} /> Add quantity price</button>
            <p className="font-body text-xs mt-1" style={{ color: c.textFaint }}>Example: buy at least 3, R90 each. Counts all options of this product together.</p>
          </div>
          <div data-testid="dept-picker">
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Departments (pick all that apply)</label>
            <div className="flex flex-wrap gap-2">
              {departments.map((d) => {
                const on = deptIds.includes(d.id);
                return (
                  <button key={d.id} type="button" onClick={() => toggleDept(d.id)} aria-pressed={on}
                    className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border"
                    style={{ background: on ? SHOP_GOLD : c.surface, color: on ? "#1a1200" : c.text, borderColor: on ? SHOP_GOLD : c.border }}>{d.name}</button>
                );
              })}
              {departments.length === 0 && <span className="font-body text-xs" style={{ color: c.textFaint }}>No departments yet — the product will show under “Other”.</span>}
            </div>
            {deptIds.length > 1 && <p className="font-body text-xs mt-1" style={{ color: c.textFaint }}>The first one you picked is its main department.</p>}
          </div>
          {deptIds.map((did) => {
            const dept = departments.find((d) => d.id === did);
            const tree = flattenCategoryTree(categories.filter((cat) => cat.department_id === did));
            if (!dept || tree.length === 0) return null;
            return (
              <div key={did} data-testid="cat-picker">
                <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Categories in {dept.name}</label>
                <div className="rounded-lg border p-2 space-y-1" style={{ background: c.surface, borderColor: c.border }}>
                  {tree.map((cat) => (
                    <label key={cat.id} className="flex items-center gap-2 cursor-pointer font-body text-sm" style={{ paddingLeft: cat.depth * 16 }}>
                      <input type="checkbox" checked={catIds.includes(cat.id)} onChange={() => toggleCat(cat.id)} />
                      <span>{cat.depth > 0 ? "↳ " : ""}{cat.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Parcel weight and size (for delivery)</label>
            <div className="grid grid-cols-4 gap-2">
              {[["kg", weightKg, setWeightKg, "0.1"], ["L cm", lengthCm, setLengthCm, "1"], ["W cm", widthCm, setWidthCm, "1"], ["H cm", heightCm, setHeightCm, "1"]].map(([ph, val, set, step]) => (
                <input key={ph} type="number" min="0" step={step} value={val} onChange={(e) => set(e.target.value)} placeholder={ph} aria-label={ph}
                  className="w-full border rounded-lg px-2 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
              ))}
            </div>
            <p className="font-body text-xs mt-1" style={{ color: c.textFaint }}>Used to price delivery and to check the parcel fits a PAXI bag. Leave blank to use the default weight.</p>
          </div>
          <label className="flex items-center gap-2 border border-dashed rounded-lg px-3 py-3 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
            <Upload size={15} /> {file ? file.name : "Product photo"}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          {(file || product.image_url) && (
            <button type="button" onClick={() => setRemoverSource({ kind: "main", source: file || product.image_url })}
              className="font-body text-xs font-semibold px-3 py-2 rounded-full flex items-center gap-1.5" style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}>
              <Wand2 size={13} /> Remove background from photo
            </button>
          )}
          <div data-testid="photo-editor">
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>More photos</label>
            <div className="flex flex-wrap gap-2">
              {keptImages.map((im) => (
                <div key={im.id} className="relative w-14 h-14 rounded-lg overflow-hidden">
                  <img src={toProxiedUrl(im.url)} alt="" className="w-full h-full object-cover" />
                  <button type="button" onClick={() => setKeptImages((l) => l.filter((x) => x.id !== im.id))} aria-label="Remove photo" className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}><X size={11} /></button>
                </div>
              ))}
              {newImages.map((f2, i) => (
                <div key={i} className="relative w-14 h-14 rounded-lg flex items-center justify-center font-body text-[10px] text-center px-1 overflow-hidden" style={{ background: c.surface, color: c.textDim }}>
                  {f2.name.slice(0, 14)}
                  <button type="button" onClick={() => setRemoverSource({ kind: i, source: f2 })} aria-label="Remove background" className="absolute bottom-0.5 left-0.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}><Wand2 size={11} /></button>
                  <button type="button" onClick={() => setNewImages((l) => l.filter((_, j) => j !== i))} aria-label="Remove photo" className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}><X size={11} /></button>
                </div>
              ))}
              <label className="w-14 h-14 rounded-lg border border-dashed flex items-center justify-center cursor-pointer" style={{ borderColor: c.borderStrong, color: c.textDim }} aria-label="Add photos">
                <Plus size={18} />
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) setNewImages((l) => [...l, ...fs]); e.target.value = ""; }} />
              </label>
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="relative w-4 h-4 shrink-0 rounded flex items-center justify-center" style={{ background: active ? c.accent : "transparent", border: `1px solid ${active ? c.accent : c.borderStrong}` }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="absolute inset-0 opacity-0 cursor-pointer" />
              {active && <CheckCircle2 size={11} color={c.accentText} strokeWidth={3} />}
            </span>
            <span className="font-body text-xs" style={{ color: c.textDim }}>Visible in the shop</span>
          </label>
          <button onClick={submit} disabled={saving || !name.trim() || !price} className="w-full font-body text-sm font-semibold py-3 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving..." : "Save product"}
          </button>
        </div>
      </div>
      {removerSource && (
        <div onClick={(e) => e.stopPropagation()}>
          <BackgroundRemover source={removerSource.source} c={c} onClose={() => setRemoverSource(null)}
            onDone={(f) => {
              if (removerSource.kind === "main") setFile(f);
              else setNewImages((l) => l.map((x, j) => (j === removerSource.kind ? f : x)));
              setRemoverSource(null);
            }} />
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ADMIN — DEPARTMENTS
// ════════════════════════════════════════════════════════════════════

function AdminDepartments({ departments, categories, products, onReload, onReloadCategories, showToast, requestConfirm, onBack, c }) {
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [managingCatsFor, setManagingCatsFor] = useState(null); // department object, or null

  const countFor = (deptId) => products.filter((p) => productDepts(p).includes(deptId)).length;
  const catCountFor = (deptId) => categories.filter((cat) => cat.department_id === deptId).length;

  const addDepartment = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    const nextPosition = departments.length > 0 ? Math.max(...departments.map((d) => d.position)) + 1 : 0;
    const { error } = await supabase.from("shop_departments").insert({ name: newName.trim(), position: nextPosition });
    setAdding(false);
    if (error) { showToast(`Couldn't add department: ${error.message}`); return; }
    setNewName("");
    await onReload();
  };

  const renameDepartment = async (dept) => {
    if (!renameValue.trim() || renameValue.trim() === dept.name) { setRenamingId(null); return; }
    const { error } = await supabase.from("shop_departments").update({ name: renameValue.trim() }).eq("id", dept.id);
    setRenamingId(null);
    if (error) { showToast(`Couldn't rename: ${error.message}`); return; }
    await onReload();
  };

  const deleteDepartment = (dept) => {
    const affected = countFor(dept.id);
    const affectedCats = catCountFor(dept.id);
    requestConfirm([
      `Delete "${dept.name}"? ${affected > 0 ? `${affected} product${affected === 1 ? "" : "s"} will move to "Other".` : "This can't be undone."}`,
      `Are you sure? ${affectedCats > 0 ? `Its ${affectedCats} categor${affectedCats === 1 ? "y" : "ies"} will be deleted too.` : "This department will be gone for good."}`,
      `Final check — click to permanently delete "${dept.name}".`,
    ], async () => {
      const { error } = await supabase.from("shop_departments").delete().eq("id", dept.id);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      showToast(affected > 0 ? `Deleted — ${affected} product${affected === 1 ? "" : "s"} moved to "Other".` : "Department deleted.");
      await onReload();
      if (affectedCats > 0) await onReloadCategories(); // its categories cascade-delete with it
    });
  };

  // Swaps position with the neighbour above/below — reordering is just a
  // two-row position swap, no drag-and-drop library needed.
  const move = async (dept, direction) => {
    const idx = departments.findIndex((d) => d.id === dept.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= departments.length) return;
    const other = departments[swapIdx];
    await supabase.from("shop_departments").update({ position: other.position }).eq("id", dept.id);
    await supabase.from("shop_departments").update({ position: dept.position }).eq("id", other.id);
    await onReload();
  };

  if (managingCatsFor) {
    return (
      <AdminCategories department={managingCatsFor} categories={categories} products={products}
        onReload={onReloadCategories} showToast={showToast} requestConfirm={requestConfirm} onBack={() => setManagingCatsFor(null)} c={c} />
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><ArrowLeft size={14} /></button>
        <LayoutGrid size={20} style={{ color: SHOP_GOLD }} />
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Departments</h1>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New department name..."
          onKeyDown={(e) => e.key === "Enter" && addDepartment()}
          className="flex-1 border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button onClick={addDepartment} disabled={!newName.trim() || adding} className="font-body text-sm font-semibold px-4 py-2.5 rounded-full shrink-0" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: newName.trim() ? 1 : 0.5 }}>
          Add
        </button>
      </div>

      {departments.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          No departments yet — everything shows under "Other" until you add one.
        </div>
      ) : (
        <div className="space-y-1.5">
          {departments.map((d, i) => (
            <div key={d.id} className="flex items-center gap-2 rounded-xl p-2.5 border" style={{ background: c.surface, borderColor: c.border }}>
              <div className="flex flex-col shrink-0">
                <button onClick={() => move(d, -1)} disabled={i === 0} className="w-6 h-4 flex items-center justify-center" style={{ color: c.textDim, opacity: i === 0 ? 0.3 : 1 }}><ChevronUp size={13} /></button>
                <button onClick={() => move(d, 1)} disabled={i === departments.length - 1} className="w-6 h-4 flex items-center justify-center" style={{ color: c.textDim, opacity: i === departments.length - 1 ? 0.3 : 1 }}><ChevronDown size={13} /></button>
              </div>
              {renamingId === d.id ? (
                <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && renameDepartment(d)} onBlur={() => renameDepartment(d)}
                  className="flex-1 border rounded-lg px-2 py-1.5 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.borderStrong, color: c.text }} />
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="font-body text-sm font-semibold truncate">{d.name}</div>
                  <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>
                    {countFor(d.id)} product{countFor(d.id) === 1 ? "" : "s"} · {catCountFor(d.id)} categor{catCountFor(d.id) === 1 ? "y" : "ies"}
                  </div>
                </div>
              )}
              {renamingId !== d.id && (
                <button onClick={() => setManagingCatsFor(d)} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.text }}>Categories</button>
              )}
              {renamingId !== d.id && (
                <button onClick={() => { setRenamingId(d.id); setRenameValue(d.name); }} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.text }}>Rename</button>
              )}
              <button onClick={() => deleteDepartment(d)} className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.red }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ADMIN — CATEGORIES (scoped to one department)
// ════════════════════════════════════════════════════════════════════

// The category level(s) of the browse hierarchy: every category belongs to
// exactly one department, and can itself have subcategories, which can have
// their own subcategories, and so on — there's no cap on how deep this goes.
// Top-level add mirrors AdminDepartments' add/rename/reorder/delete pattern;
// CategoryRow below recurses to render (and let you extend) the rest of the tree.
function AdminCategories({ department, categories, products, onReload, showToast, requestConfirm, onBack, c }) {
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [addingUnder, setAddingUnder] = useState(null); // id of the category currently showing an "add subcategory" input
  const [subName, setSubName] = useState("");
  const [addingSub, setAddingSub] = useState(false);

  const deptCategories = categories.filter((cat) => cat.department_id === department.id);
  const topLevel = categoryChildren(deptCategories, null);
  const countFor = (catId) => products.filter((p) => productCats(p).includes(catId)).length;

  const addCategory = async (parentId, name) => {
    if (!name.trim()) return false;
    const siblings = categoryChildren(deptCategories, parentId);
    const nextPosition = siblings.length > 0 ? Math.max(...siblings.map((cat) => cat.position)) + 1 : 0;
    const { error } = await supabase.from("shop_categories").insert({ name: name.trim(), department_id: department.id, parent_category_id: parentId, position: nextPosition });
    if (error) { showToast(`Couldn't add category: ${error.message}`); return false; }
    await onReload();
    return true;
  };

  const addTopLevel = async () => {
    setAdding(true);
    const ok = await addCategory(null, newName);
    setAdding(false);
    if (ok) setNewName("");
  };

  const addSub = async (parentId) => {
    setAddingSub(true);
    const ok = await addCategory(parentId, subName);
    setAddingSub(false);
    if (ok) { setSubName(""); setAddingUnder(null); }
  };

  const renameCategory = async (cat) => {
    if (!renameValue.trim() || renameValue.trim() === cat.name) { setRenamingId(null); return; }
    const { error } = await supabase.from("shop_categories").update({ name: renameValue.trim() }).eq("id", cat.id);
    setRenamingId(null);
    if (error) { showToast(`Couldn't rename: ${error.message}`); return; }
    await onReload();
  };

  const deleteCategory = (cat) => {
    const descendants = categoryDescendantIds(deptCategories, cat.id);
    const affected = countFor(cat.id) + descendants.reduce((sum, id) => sum + countFor(id), 0);
    const subNote = descendants.length > 0 ? ` (and ${descendants.length} subcategor${descendants.length === 1 ? "y" : "ies"})` : "";
    requestConfirm([
      `Delete "${cat.name}"${subNote}? ${affected > 0 ? `${affected} product${affected === 1 ? "" : "s"} will move to "Other".` : "This can't be undone."}`,
      `Are you sure you want to remove "${cat.name}"${subNote}?`,
      `Final check — click to permanently delete "${cat.name}".`,
    ], async () => {
      const { error } = await supabase.from("shop_categories").delete().eq("id", cat.id);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      showToast(affected > 0 ? `Deleted${subNote} — ${affected} product${affected === 1 ? "" : "s"} moved to "Other".` : `Category deleted${subNote}.`);
      await onReload();
    });
  };

  // Reordering swaps position with a neighbour among the same parent's
  // children only — siblings at every depth reorder independently.
  const move = async (cat, direction) => {
    const siblings = categoryChildren(deptCategories, cat.parent_category_id || null);
    const idx = siblings.findIndex((c2) => c2.id === cat.id);
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const other = siblings[swapIdx];
    await supabase.from("shop_categories").update({ position: other.position }).eq("id", cat.id);
    await supabase.from("shop_categories").update({ position: cat.position }).eq("id", other.id);
    await onReload();
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><ArrowLeft size={14} /></button>
        <LayoutGrid size={20} style={{ color: SHOP_GOLD }} />
        <div>
          <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Categories</h1>
          <div className="font-mono text-[10px] mt-0.5" style={{ color: c.textFaint }}>in {department.name}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New top-level category name..."
          onKeyDown={(e) => e.key === "Enter" && addTopLevel()}
          className="flex-1 border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <button onClick={addTopLevel} disabled={!newName.trim() || adding} className="font-body text-sm font-semibold px-4 py-2.5 rounded-full shrink-0" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: newName.trim() ? 1 : 0.5 }}>
          Add
        </button>
      </div>

      {topLevel.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          No categories in "{department.name}" yet — everything in it shows under "Other" until you add one.
        </div>
      ) : (
        <div className="space-y-1.5">
          {topLevel.map((cat) => (
            <CategoryRow key={cat.id} cat={cat} depth={0} deptCategories={deptCategories} countFor={countFor}
              renamingId={renamingId} renameValue={renameValue} setRenamingId={setRenamingId} setRenameValue={setRenameValue}
              renameCategory={renameCategory} deleteCategory={deleteCategory} move={move}
              addingUnder={addingUnder} setAddingUnder={setAddingUnder} subName={subName} setSubName={setSubName}
              addSub={addSub} addingSub={addingSub} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

// One row of the category tree, recursing into its own children — this is
// what lets nesting go arbitrarily deep instead of stopping at one level.
function CategoryRow({ cat, depth, deptCategories, countFor, renamingId, renameValue, setRenamingId, setRenameValue, renameCategory, deleteCategory, move, addingUnder, setAddingUnder, subName, setSubName, addSub, addingSub, c }) {
  const kids = categoryChildren(deptCategories, cat.id);
  const siblings = categoryChildren(deptCategories, cat.parent_category_id || null);
  const idx = siblings.findIndex((s) => s.id === cat.id);
  const isRenaming = renamingId === cat.id;
  const isAddingSub = addingUnder === cat.id;

  return (
    <div>
      <div className="flex items-center gap-2 rounded-xl p-2.5 border" style={{ background: c.surface, borderColor: c.border, marginLeft: depth * 18 }}>
        <div className="flex flex-col shrink-0">
          <button onClick={() => move(cat, -1)} disabled={idx === 0} className="w-6 h-4 flex items-center justify-center" style={{ color: c.textDim, opacity: idx === 0 ? 0.3 : 1 }}><ChevronUp size={13} /></button>
          <button onClick={() => move(cat, 1)} disabled={idx === siblings.length - 1} className="w-6 h-4 flex items-center justify-center" style={{ color: c.textDim, opacity: idx === siblings.length - 1 ? 0.3 : 1 }}><ChevronDown size={13} /></button>
        </div>
        {isRenaming ? (
          <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && renameCategory(cat)} onBlur={() => renameCategory(cat)}
            className="flex-1 border rounded-lg px-2 py-1.5 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.borderStrong, color: c.text }} />
        ) : (
          <div className="min-w-0 flex-1">
            <div className="font-body text-sm font-semibold truncate">{cat.name}</div>
            <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>
              {countFor(cat.id)} product{countFor(cat.id) === 1 ? "" : "s"}
              {kids.length > 0 && ` · ${kids.length} subcategor${kids.length === 1 ? "y" : "ies"}`}
            </div>
          </div>
        )}
        {!isRenaming && (
          <button onClick={() => { setAddingUnder(isAddingSub ? null : cat.id); setSubName(""); }} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.text }}>+ Sub</button>
        )}
        {!isRenaming && (
          <button onClick={() => { setRenamingId(cat.id); setRenameValue(cat.name); }} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.text }}>Rename</button>
        )}
        <button onClick={() => deleteCategory(cat)} className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.red }}><Trash2 size={13} /></button>
      </div>

      {isAddingSub && (
        <div className="flex items-center gap-2 mt-1.5 mb-1.5" style={{ marginLeft: (depth + 1) * 18 }}>
          <input autoFocus value={subName} onChange={(e) => setSubName(e.target.value)} placeholder={`New category under "${cat.name}"...`}
            onKeyDown={(e) => e.key === "Enter" && addSub(cat.id)}
            className="flex-1 border rounded-lg px-3 py-2 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          <button onClick={() => addSub(cat.id)} disabled={!subName.trim() || addingSub} className="font-body text-xs font-semibold px-3 py-2 rounded-full shrink-0" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: subName.trim() ? 1 : 0.5 }}>
            Add
          </button>
        </div>
      )}

      {kids.length > 0 && (
        <div className="space-y-1.5 mt-1.5">
          {kids.map((child) => (
            <CategoryRow key={child.id} cat={child} depth={depth + 1} deptCategories={deptCategories} countFor={countFor}
              renamingId={renamingId} renameValue={renameValue} setRenamingId={setRenamingId} setRenameValue={setRenameValue}
              renameCategory={renameCategory} deleteCategory={deleteCategory} move={move}
              addingUnder={addingUnder} setAddingUnder={setAddingUnder} subName={subName} setSubName={setSubName}
              addSub={addSub} addingSub={addingSub} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ADMIN — ORDERS
// ════════════════════════════════════════════════════════════════════

// Courier name + tracking number for an order, saved straight on the order.
// Shoppers see them on the track page.
function TrackingEditor({ order, showToast, onSaved, c }) {
  const [courier, setCourier] = useState(order.courier_name || (order.delivery_method === "paxi" ? "PAXI" : order.delivery_method === "pudo" ? "Pudo" : order.delivery_method === "courier" ? "The Courier Guy" : ""));
  const [tracking, setTracking] = useState(order.tracking_number || "");
  const [saving, setSaving] = useState(false);
  const dirty = (courier.trim() || null) !== (order.courier_name || null) || (tracking.trim() || null) !== (order.tracking_number || null);
  const save = async () => {
    setSaving(true);
    const { error } = await supabase.from("shop_orders").update({ courier_name: courier.trim() || null, tracking_number: tracking.trim() || null }).eq("id", order.id);
    setSaving(false);
    if (error) { showToast(`Couldn't save tracking: ${error.message}`); return; }
    showToast("Tracking saved.");
    onSaved && onSaved();
  };
  return (
    <div className="grid grid-cols-[1fr_1.4fr_auto] gap-1.5 mt-2.5">
      <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="Courier" aria-label="Courier"
        className="border rounded-lg px-2.5 py-2 font-body text-xs outline-none min-w-0" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
      <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Tracking number" aria-label="Tracking number"
        className="border rounded-lg px-2.5 py-2 font-body text-xs outline-none min-w-0" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
      <button onClick={save} disabled={!dirty || saving} className="font-body text-xs font-semibold px-3 rounded-lg" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: (!dirty || saving) ? 0.5 : 1 }}>{saving ? "..." : "Save"}</button>
    </div>
  );
}

const DEFAULT_DELIVERY_CONFIG = {
  default_weight_kg: 0.5, free_over: 0,
  collection: { enabled: false, address: "", hours: "" },
  courier: { enabled: false, fee: 0, days: "2 to 4 working days" },
  pudo: { enabled: false, fee: 0, days: "2 to 4 working days" },
  paxi: { enabled: false, standard_fee: 109.95, large_fee: 139.95, days: "3 to 5 working days" },
};

// Module-level on purpose: defining these inside DeliverySettings would give
// them a new identity on every render and drop input focus on each keystroke.
function DField({ label, c, children }) {
  return <label className="block"><span className="font-body text-xs" style={{ color: c.textDim }}>{label}</span>{children}</label>;
}
function DToggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 font-body text-sm font-semibold cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

// Admin: which delivery methods are on and what they cost. Stored as JSON in
// shop_settings ("delivery_config"); the server prices every order from it.
function DeliverySettings({ showToast, c }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open || cfg) return;
    (async () => {
      const { data } = await supabase.from("shop_settings").select("value").eq("key", "delivery_config").maybeSingle();
      let parsed = {};
      try { parsed = data?.value ? JSON.parse(data.value) : {}; } catch { parsed = {}; }
      const merged = { ...DEFAULT_DELIVERY_CONFIG, ...parsed };
      for (const k of ["collection", "courier", "pudo", "paxi"]) merged[k] = { ...DEFAULT_DELIVERY_CONFIG[k], ...(parsed[k] || {}) };
      setCfg(merged);
    })();
  }, [open]);
  const setMethod = (m, patch) => setCfg((x) => ({ ...x, [m]: { ...x[m], ...patch } }));
  const save = async () => {
    setSaving(true);
    const clean = { ...cfg, default_weight_kg: Number(cfg.default_weight_kg) || 0.5, free_over: Number(cfg.free_over) || 0,
      courier: { ...cfg.courier, fee: Number(cfg.courier.fee) || 0 }, pudo: { ...cfg.pudo, fee: Number(cfg.pudo.fee) || 0 },
      paxi: { ...cfg.paxi, standard_fee: Number(cfg.paxi.standard_fee) || 0, large_fee: Number(cfg.paxi.large_fee) || 0 } };
    const { error } = await supabase.from("shop_settings").upsert({ key: "delivery_config", value: JSON.stringify(clean), updated_at: new Date().toISOString() });
    setSaving(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    showToast("Delivery settings saved.");
  };
  const inputCls = "w-full border rounded-lg px-2.5 py-2 font-body text-sm outline-none";
  const inputStyle = { background: c.bg, borderColor: c.border, color: c.text };
  return (
    <div className="rounded-xl border mb-4" style={{ background: c.surface, borderColor: c.border }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2.5 font-body text-sm font-semibold" aria-expanded={open}>
        <span>Delivery methods and prices</span>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && !cfg && <div className="px-3 pb-3"><Spinner c={c} /></div>}
      {open && cfg && (
        <div className="px-3 pb-3 space-y-4">
          <p className="font-body text-xs" style={{ color: c.textFaint }}>Switch on the methods you offer. With none switched on, checkout has no delivery step. These are fixed prices you set; they are not live courier quotes.</p>
          <div className="grid grid-cols-2 gap-2">
            <DField c={c} label="Free delivery above (R, 0 = never)"><input type="number" min="0" value={cfg.free_over} onChange={(e) => setCfg((x) => ({ ...x, free_over: e.target.value }))} className={inputCls} style={inputStyle} /></DField>
            <DField c={c} label="Weight if a product has none (kg)"><input type="number" min="0" step="0.1" value={cfg.default_weight_kg} onChange={(e) => setCfg((x) => ({ ...x, default_weight_kg: e.target.value }))} className={inputCls} style={inputStyle} /></DField>
          </div>

          <div className="space-y-2">
            <DToggle checked={!!cfg.collection.enabled} onChange={(v) => setMethod("collection", { enabled: v })} label="Collect from us" />
            {cfg.collection.enabled && (<>
              <DField c={c} label="Collection address"><input value={cfg.collection.address} onChange={(e) => setMethod("collection", { address: e.target.value })} className={inputCls} style={inputStyle} /></DField>
              <DField c={c} label="Collection hours"><input value={cfg.collection.hours} onChange={(e) => setMethod("collection", { hours: e.target.value })} placeholder="Mon to Fri, 9am to 5pm" className={inputCls} style={inputStyle} /></DField>
            </>)}
          </div>

          {[["courier", "Courier to the door (The Courier Guy)"], ["pudo", "Pudo locker"]].map(([m, label]) => (
            <div key={m} className="space-y-2">
              <DToggle checked={!!cfg[m].enabled} onChange={(v) => setMethod(m, { enabled: v })} label={label} />
              {cfg[m].enabled && (
                <div className="grid grid-cols-2 gap-2">
                  <DField c={c} label="Fee (R)"><input type="number" min="0" step="0.01" value={cfg[m].fee} onChange={(e) => setMethod(m, { fee: e.target.value })} className={inputCls} style={inputStyle} /></DField>
                  <DField c={c} label="Time shown to shopper"><input value={cfg[m].days} onChange={(e) => setMethod(m, { days: e.target.value })} className={inputCls} style={inputStyle} /></DField>
                </div>
              )}
            </div>
          ))}

          <div className="space-y-2">
            <DToggle checked={!!cfg.paxi.enabled} onChange={(v) => setMethod("paxi", { enabled: v })} label="PAXI at a PEP store" />
            {cfg.paxi.enabled && (
              <div className="grid grid-cols-2 gap-2">
                <DField c={c} label="Standard bag fee (R, up to 5 kg)"><input type="number" min="0" step="0.01" value={cfg.paxi.standard_fee} onChange={(e) => setMethod("paxi", { standard_fee: e.target.value })} className={inputCls} style={inputStyle} /></DField>
                <DField c={c} label="Large bag fee (R, up to 10 kg)"><input type="number" min="0" step="0.01" value={cfg.paxi.large_fee} onChange={(e) => setMethod("paxi", { large_fee: e.target.value })} className={inputCls} style={inputStyle} /></DField>
                <div className="col-span-2"><DField c={c} label="Time shown to shopper"><input value={cfg.paxi.days} onChange={(e) => setMethod("paxi", { days: e.target.value })} className={inputCls} style={inputStyle} /></DField></div>
                <p className="col-span-2 font-body text-xs" style={{ color: c.textFaint }}>Check current prices with PAXI; they change. Parcels over 10 kg or longer than 60 cm are not offered PAXI.</p>
              </div>
            )}
          </div>

          <button onClick={save} disabled={saving} className="font-body text-xs font-semibold px-4 py-2 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving..." : "Save delivery settings"}</button>
        </div>
      )}
    </div>
  );
}

const ADMIN_OPEN_STATUSES = ["pending_review", "whatsapp_sent", "paid", "packed", "shipped"];
const ADMIN_FILTERS = [
  ["open", "To handle"], ["pending_review", "Pending review"], ["whatsapp_sent", "WhatsApp"], ["paid", "Paid"],
  ["packed", "Packed"], ["shipped", "Shipped"], ["delivered", "Delivered"], ["cancelled", "Cancelled"], ["rejected", "Rejected"], ["all", "All"],
];

function AdminOrders({ session, showToast, onReloadProducts, onOpenProducts, eftDetails, onEftSaved, c }) {
  const [orders, setOrders] = useState(null);
  const [filter, setFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [proofUrls, setProofUrls] = useState({});
  const [bankOpen, setBankOpen] = useState(false);
  const [bankDraft, setBankDraft] = useState(eftDetails || "");
  const [savingBank, setSavingBank] = useState(false);

  const load = async () => {
    const { data, error } = await supabase.from("shop_orders").select(SHOP_ORDER_SELECT).order("created_at", { ascending: false });
    if (!error) setOrders(data || []);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { setBankDraft(eftDetails || ""); }, [eftDetails]);

  const viewProof = async (order) => {
    if (!order.payment_proof_path) return;
    const { data, error } = await supabase.storage.from("shop-payment-proofs").createSignedUrl(order.payment_proof_path, 120);
    if (error || !data) { showToast("Couldn't generate a link to the proof."); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  // Status changes go through the server: it also puts stock back when an
  // order is rejected, cancelled or refunded (and reserves it for old orders
  // that never did), so stock can't drift out of sync with orders.
  const setStatus = async (order, status) => {
    if ((status === "cancelled" || status === "rejected") && !window.confirm(`Mark ${order.order_number} as ${status}? Its items go back into stock.`)) return;
    const { error } = await supabase.rpc("admin_set_shop_order_status", { p_order_id: order.id, p_status: status });
    if (error) { showToast(`Couldn't update order: ${error.message}`); return; }
    showToast(`${order.order_number} marked ${STATUS_META[status]?.label.toLowerCase() || status}.`);
    onReloadProducts && onReloadProducts();
    await load();
  };

  const saveBank = async () => {
    setSavingBank(true);
    const { error } = await supabase.from("shop_settings").upsert({ key: "eft_details", value: bankDraft.trim(), updated_at: new Date().toISOString() });
    setSavingBank(false);
    if (error) { showToast(`Couldn't save: ${error.message}`); return; }
    showToast(bankDraft.trim() ? "Bank details saved." : "Bank details cleared. They won't show at checkout.");
    onEftSaved && onEftSaved();
  };

  if (orders === null) return <Spinner c={c} />;
  const q = search.trim().toLowerCase();
  const byFilter = filter === "all" ? orders : filter === "open" ? orders.filter((o) => ADMIN_OPEN_STATUSES.includes(o.status)) : orders.filter((o) => o.status === filter);
  const filtered = q ? byFilter.filter((o) => [o.order_number, o.buyer_username, o.contact_phone].some((v) => (v || "").toLowerCase().includes(q))) : byFilter;
  const countFor = (f) => f === "all" ? orders.length : f === "open" ? orders.filter((o) => ADMIN_OPEN_STATUSES.includes(o.status)).length : orders.filter((o) => o.status === f).length;

  // What can happen next to an order, in the order a parcel moves.
  const actionsFor = (o) => {
    switch (o.status) {
      case "pending_review": return [["paid", "Approve payment", "good"], ["rejected", "Reject", "bad"]];
      case "whatsapp_sent": return [["paid", "Mark paid", "good"], ["cancelled", "Cancel", "bad"]];
      case "paid": return [["packed", "Mark packed", "good"], ["cancelled", "Cancel", "bad"]];
      case "packed": return [["shipped", "Mark shipped", "good"], ["cancelled", "Cancel", "bad"]];
      case "shipped": return [["delivered", "Mark delivered", "good"]];
      default: return [];
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ClipboardList size={20} style={{ color: SHOP_GOLD }} />
          <h1 className="text-2xl font-extrabold tracking-tight leading-none">Orders</h1>
        </div>
        <button onClick={onOpenProducts} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surface, color: c.textDim }}>Products</button>
      </div>

      <div className="rounded-xl border mb-4" style={{ background: c.surface, borderColor: c.border }}>
        <button onClick={() => setBankOpen((v) => !v)} className="w-full flex items-center justify-between px-3 py-2.5 font-body text-sm font-semibold" aria-expanded={bankOpen}>
          <span>Bank details shown at checkout {!eftDetails && <span className="font-normal" style={{ color: c.red }}>(not set, hidden from shoppers)</span>}</span>
          {bankOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
        {bankOpen && (
          <div className="px-3 pb-3 space-y-2">
            <textarea value={bankDraft} onChange={(e) => setBankDraft(e.target.value)} rows={6}
              placeholder={"Bank: ...\nAccount name: ...\nAccount number: ...\nBranch code: ...\nReference: your order number"}
              className="w-full border rounded-lg px-3 py-2.5 font-mono text-xs outline-none" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
            <button onClick={saveBank} disabled={savingBank} className="font-body text-xs font-semibold px-4 py-2 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: savingBank ? 0.6 : 1 }}>
              {savingBank ? "Saving..." : "Save bank details"}
            </button>
          </div>
        )}
      </div>

      <DeliverySettings showToast={showToast} c={c} />

      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by order number, name or phone" aria-label="Search orders"
          className="w-full border rounded-lg pl-9 pr-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      <div className="flex gap-1.5 mb-4 overflow-x-auto no-scrollbar">
        {ADMIN_FILTERS.map(([f, label]) => (
          <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f} className="shrink-0 font-body text-xs font-semibold px-3 py-1.5 rounded-full"
            style={filter === f ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim, border: `1px solid ${c.border}` }}>
            {label} <span style={{ opacity: 0.6 }}>{countFor(f)}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No orders here.</div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((o) => (
            <div key={o.id} className="rounded-xl p-3 border" style={{ background: c.surface, borderColor: c.border }}>
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-sm font-bold" style={{ color: SHOP_GOLD }}>{o.order_number}</span>
                <StatusBadge status={o.status} c={c} />
              </div>
              <div className="font-body text-sm font-semibold">{o.buyer_username}</div>
              <div className="font-body text-xs mb-1.5" style={{ color: c.textFaint }}>
                {new Date(o.created_at).toLocaleString()} · {o.checkout_method.replace("_", " ")}
                {o.contact_phone && ` · ${o.contact_phone}`}
              </div>
              {(o.shop_order_items || []).map((it) => (
                <div key={it.id} className="font-body text-xs flex items-center justify-between" style={{ color: c.textDim }}>
                  <span>{it.qty}x {it.product_name}</span>
                  <span>{formatMoney(it.qty * it.unit_price)}</span>
                </div>
              ))}
              {o.delivery_note && <div className="font-body text-xs mt-1" style={{ color: c.textFaint }}>Note: {o.delivery_note}</div>}
              {o.delivery_method && (
                <div className="font-body text-xs mt-1.5 rounded-lg px-2.5 py-1.5" style={{ background: c.bg, color: c.textDim }}>
                  {deliverySummary(o)}{Number(o.delivery_fee) > 0 ? ` · ${formatMoney(o.delivery_fee)}` : " · free"}
                </div>
              )}
              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t" style={{ borderColor: c.border }}>
                <span className="font-body text-xs font-semibold">Total{Number(o.delivery_fee) > 0 ? " (with delivery)" : ""}</span>
                <span className="font-mono text-sm font-bold">{formatMoney(Number(o.subtotal) + Number(o.delivery_fee || 0))}</span>
              </div>
              {["packed", "shipped", "delivered"].includes(o.status) && o.delivery_method && o.delivery_method !== "collection" && (
                <TrackingEditor order={o} showToast={showToast} onSaved={load} c={c} />
              )}

              <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                {o.payment_proof_path && (
                  <button onClick={() => viewProof(o)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surfaceHover, color: c.text }}>View proof</button>
                )}
                {actionsFor(o).map(([status, label, tone]) => (
                  <button key={status} onClick={() => setStatus(o, status)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full"
                    style={tone === "good" ? { background: c.greenSoft, color: c.greenText } : { background: c.redSoft, color: c.red }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
