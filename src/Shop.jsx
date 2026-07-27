import React, { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";
import {
  ArrowLeft, X, Plus, Minus, Trash2, Upload, CheckCircle2, XCircle, Clock,
  Package, Settings2, MessageCircle, CreditCard, Lock, ShoppingCart, ShoppingBag,
  Search, ClipboardList, Image as ImageIcon, Truck, LayoutGrid, ChevronUp, ChevronDown, Share2,
} from "lucide-react";

// ════════════════════════════════════════════════════════════════════
// SHOP CONFIGURATION — edit these as the real store comes together.
// Nothing below this block needs to change for that.
// ════════════════════════════════════════════════════════════════════

// WhatsApp number orders get sent to for the "Order on WhatsApp" checkout
// option. Digits only, with country code, no spaces or symbols — e.g. a
// South African number would be "27821234567". Leave blank to hide that
// checkout option entirely.
export const SHOP_WHATSAPP_NUMBER = "";

// Shown to buyers who choose manual EFT/bank-transfer checkout. Replace
// with your real banking details before going live.
export const SHOP_BANK_DETAILS = `Bank: <your bank>
Account name: <your account name>
Account number: <your account number>
Branch code: <your branch code>
Reference: your order number (shown after you submit)`;

// Flip to true once a real payment gateway (Paystack, Flutterwave, Yoco,
// etc.) is wired up in payWithGateway() below. Until then the card option
// is visible but disabled, so nothing breaks in production.
export const SHOP_GATEWAY_ENABLED = false;

const SHOP_GOLD = "#D4A017";
const CURRENCY_PREFIX = "R"; // South African Rand — change if selling elsewhere
const formatMoney = (n) => `${CURRENCY_PREFIX}${Number(n).toLocaleString("en-ZA")}`;

const CART_KEY = "efootball-shop-cart-v1";

function waLink(phone, text) {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

// Shared product links use a clean path — weafrica.co.za/shop/<id> — rather
// than a query string, so they read like a real page and not like a param
// dump. Requires the SPA fallback rewrite in vercel.json so any /shop/<id>
// path still serves index.html.
function buildProductLink(product) {
  return `${window.location.origin}/shop/${product.id}`;
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
  cancelled: { label: "Cancelled", icon: XCircle, color: "#888" },
};

function StatusBadge({ status, c }) {
  const meta = STATUS_META[status] || { label: status, icon: Clock, color: c.textDim };
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold px-2 py-1 rounded-full" style={{ background: `${meta.color}22`, color: meta.color }}>
      <Icon size={11} /> {meta.label}
    </span>
  );
}

// ════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════════════════════════

export default function ShopPage({ c, session, profile, isAdmin, onBack, onRequireAuth, initialProductId }) {
  const [subview, setSubview] = useState("browse");
  const [products, setProducts] = useState(null);
  const [departments, setDepartments] = useState(null);
  const [cart, setCart] = useState(loadCart);
  const [activeProduct, setActiveProduct] = useState(null);
  const [myOrders, setMyOrders] = useState(null);
  const [toast, setToast] = useState(null);
  const [sharedLinkHandled, setSharedLinkHandled] = useState(false);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast((t) => (t === msg ? null : t)), 3000); };

  useEffect(() => { persistCart(cart); }, [cart]);

  // Real browser-history navigation inside the shop itself: browsing → cart
  // → checkout, and opening/closing a product modal, are all real history
  // entries layered on top of whichever entry the parent (App or
  // PublicHome) already pushed for "entering the shop". That way swiping
  // back inside the shop steps back through cart/checkout/product screens
  // one at a time, and only leaves the shop once you're back at its root.
  const shopBaseStateRef = useRef(null);
  useEffect(() => {
    shopBaseStateRef.current = window.history.state || {};
  }, []);
  const shopNavFirstRef = useRef(true);
  useEffect(() => {
    const productId = activeProduct?.id ?? null;
    const state = { ...(shopBaseStateRef.current || {}), shopNav: true, shopSubview: subview, shopProductId: productId };
    const cur = window.history.state;
    if (cur && cur.shopNav && cur.shopSubview === subview && (cur.shopProductId ?? null) === productId) return;
    if (shopNavFirstRef.current) { shopNavFirstRef.current = false; window.history.replaceState(state, ""); return; }
    window.history.pushState(state, "");
  }, [subview, activeProduct]);

  useEffect(() => {
    const onPopState = (e) => {
      const state = e.state;
      if (!state || !state.shopNav) return; // popped past our own entries — the parent's own listener handles leaving the shop
      setSubview(state.shopSubview || "browse");
      if (state.shopProductId && products) {
        const found = products.find((p) => String(p.id) === String(state.shopProductId));
        setActiveProduct(found || null);
      } else {
        setActiveProduct(null);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [products]);

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
    const { data, error } = await supabase.from("shop_products").select("*").order("created_at", { ascending: false });
    if (!error) setProducts(data || []);
  };
  useEffect(() => { loadProducts(); }, []);

  const loadDepartments = async () => {
    const { data, error } = await supabase.from("shop_departments").select("*").order("position", { ascending: true });
    if (!error) setDepartments(data || []);
  };
  useEffect(() => { loadDepartments(); }, []);

  const loadMyOrders = async () => {
    if (!session) return;
    const { data, error } = await supabase.from("shop_orders").select("*, shop_order_items(*)")
      .eq("user_id", session.user.id).order("created_at", { ascending: false });
    if (!error) setMyOrders(data || []);
  };

  const visibleProducts = isAdmin ? (products || []) : (products || []).filter((p) => p.active);

  const addToCart = (product, qty) => {
    setCart((prev) => {
      const existing = prev.find((it) => it.productId === product.id);
      const cap = product.stock_qty ?? 99;
      if (existing) return prev.map((it) => it.productId === product.id ? { ...it, qty: Math.min(it.qty + qty, cap) } : it);
      return [...prev, { productId: product.id, name: product.name, price: product.price, image_url: product.image_url, qty: Math.min(qty, cap) }];
    });
    showToast(`Added ${product.name} to cart.`);
  };
  const updateQty = (productId, qty) => {
    setCart((prev) => qty <= 0 ? prev.filter((it) => it.productId !== productId) : prev.map((it) => it.productId === productId ? { ...it, qty } : it));
  };
  const removeFromCart = (productId) => setCart((prev) => prev.filter((it) => it.productId !== productId));
  const clearCart = () => setCart([]);

  const cartCount = cart.reduce((sum, it) => sum + it.qty, 0);
  const cartTotal = cart.reduce((sum, it) => sum + it.qty * it.price, 0);

  const goCheckout = () => {
    if (!session) { onRequireAuth ? onRequireAuth("Sign in to check out.") : showToast("Sign in to check out."); return; }
    if (cart.length === 0) { showToast("Your cart is empty."); return; }
    setSubview("checkout");
  };

  return (
    <div className={`pt-8 ${subview === "browse" && cartCount > 0 ? "pb-24" : "pb-10"}`}>
      <div className="flex items-center justify-between mb-5">
        <button onClick={subview === "browse" ? onBack : () => setSubview("browse")} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}>
          <ArrowLeft size={15} /> {subview === "browse" ? "Back" : "Shop"}
        </button>
        <div className="flex items-center gap-2">
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
          <div className="flex items-center gap-2 mb-5">
            <ShoppingBag size={20} style={{ color: SHOP_GOLD }} />
            <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">WeAfrica Shop</h1>
          </div>
          <DepartmentBrowser products={visibleProducts} departments={departments || []} loading={products === null} onOpen={setActiveProduct} onQuickAdd={(p) => addToCart(p, 1)} c={c} />
        </>
      )}

      {subview === "cart" && (
        <CartView cart={cart} onUpdateQty={updateQty} onRemove={removeFromCart} onCheckout={goCheckout} onContinue={() => setSubview("browse")} c={c} />
      )}

      {subview === "checkout" && (
        <CheckoutView cart={cart} total={cartTotal} session={session} profile={profile}
          onDone={() => { clearCart(); setSubview("confirm"); }} onBack={() => setSubview("cart")} showToast={showToast} c={c} />
      )}

      {subview === "confirm" && (
        <div className="pt-10 text-center">
          <CheckCircle2 size={40} style={{ color: c.greenText }} className="mx-auto mb-3" />
          <div className="font-extrabold uppercase tracking-tight text-xl mb-1.5">Order placed</div>
          <p className="font-body text-sm mb-6" style={{ color: c.textDim }}>We've got it — check "My orders" for status updates.</p>
          <div className="flex items-center justify-center gap-2">
            <button onClick={() => setSubview("browse")} className="font-body text-sm font-semibold px-4 py-2 rounded-full" style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}>Keep browsing</button>
            <button onClick={() => { setSubview("my-orders"); loadMyOrders(); }} className="font-body text-sm font-semibold px-4 py-2 rounded-full" style={{ background: c.accent, color: c.accentText }}>My orders</button>
          </div>
        </div>
      )}

      {subview === "my-orders" && <MyOrders orders={myOrders} c={c} />}

      {subview === "admin-products" && isAdmin && (
        <AdminProducts products={products} departments={departments || []} onReload={loadProducts} onReloadDepartments={loadDepartments} showToast={showToast} onOpenOrders={() => setSubview("admin-orders")} c={c} />
      )}
      {subview === "admin-orders" && isAdmin && (
        <AdminOrders session={session} showToast={showToast} onReloadProducts={loadProducts} onOpenProducts={() => setSubview("admin-products")} c={c} />
      )}

      {activeProduct && (
        <ProductModal product={activeProduct} onClose={() => setActiveProduct(null)} onAdd={(qty) => { addToCart(activeProduct, qty); setActiveProduct(null); }} onShare={() => shareProduct(activeProduct)} c={c} />
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

// A department-store-style browse experience:
//  - a "store directory" of tappable department tiles when nothing's
//    filtered yet, each showing a representative photo and item count
//  - a sticky row of chips (with counts) so switching aisles doesn't
//    require scrolling back to the top
//  - search that narrows within whichever department is selected
//  - "All" groups products into a section per department, like walking
//    the floor; a specific department (or a search) shows just its grid
function DepartmentBrowser({ products, departments, loading, onOpen, onQuickAdd, c }) {
  const [selected, setSelected] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("default");
  const [inStockOnly, setInStockOnly] = useState(false);

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
  const grouped = departments
    .map((d) => ({ dept: d, items: searchable.filter((p) => p.department_id === d.id) }))
    .filter((g) => g.items.length > 0);
  const uncategorized = searchable.filter((p) => !p.department_id || !deptIds.has(p.department_id));
  // Chips (and directory tiles) only ever show departments that actually
  // have something in them right now — no dead-end aisles.
  const chips = [
    { id: "all", name: "All", count: searchable.length },
    ...grouped.map(({ dept, items }) => ({ id: dept.id, name: dept.name, count: items.length })),
    ...(uncategorized.length > 0 ? [{ id: "uncategorized", name: "Other", count: uncategorized.length }] : []),
  ];

  const currentItems = selected === "all" ? searchable
    : selected === "uncategorized" ? uncategorized
    : searchable.filter((p) => p.department_id === selected);

  return (
    <div>
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the shop..."
          className="w-full border rounded-lg pl-9 pr-9 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        {query && (
          <button onClick={() => setQuery("")} aria-label="Clear search" className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full" style={{ color: c.textFaint }}>
            <X size={13} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto no-scrollbar">
        <select value={sort} onChange={(e) => setSort(e.target.value)} className="shrink-0 font-mono text-[11px] font-semibold pl-2.5 pr-1.5 py-1.5 rounded-full outline-none" style={{ background: c.surface, color: c.textDim, border: `1px solid ${c.border}` }}>
          <option value="default">Sort: Featured</option>
          <option value="price_asc">Price: Low to High</option>
          <option value="price_desc">Price: High to Low</option>
          <option value="name">Name: A–Z</option>
        </select>
        <button onClick={() => setInStockOnly((v) => !v)} className="shrink-0 font-mono text-[11px] font-semibold px-3 py-1.5 rounded-full uppercase"
          style={inStockOnly ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
          In stock only
        </button>
      </div>

      {departments.length > 0 && (
        <div className="sticky top-0 z-10 -mx-4 px-4 pb-1 pt-1" style={{ background: c.bg }}>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {chips.map((d) => (
              <button key={d.id} onClick={() => setSelected(d.id)} className="shrink-0 font-mono text-[11px] font-semibold px-3 py-1.5 rounded-full uppercase flex items-center gap-1.5"
                style={selected === d.id ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
                {d.name} <span style={{ opacity: 0.6 }}>{d.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selected === "all" && !q && departments.length > 1 && (
        <DepartmentDirectory groups={grouped} onSelect={setSelected} c={c} />
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
                <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2.5 flex items-baseline gap-1.5" style={{ color: c.textFaint }}>
                  {dept.name} <span style={{ opacity: 0.6 }}>({items.length})</span>
                </div>
              )}
              <ProductGrid products={items} loading={false} onOpen={onOpen} onQuickAdd={onQuickAdd} c={c} />
            </div>
          ))}
          {uncategorized.length > 0 && (
            <div>
              {departments.length > 0 && (
                <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2.5 flex items-baseline gap-1.5" style={{ color: c.textFaint }}>
                  Other <span style={{ opacity: 0.6 }}>({uncategorized.length})</span>
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

// The "store directory" — big tappable department tiles shown when
// browsing everything, so picking an aisle doesn't depend on spotting the
// right small chip. Uses each department's first product photo as a
// representative image.
function DepartmentDirectory({ groups, onSelect, c }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 mb-6">
      {groups.map(({ dept, items }) => (
        <button key={dept.id} onClick={() => onSelect(dept.id)} className="text-left rounded-xl overflow-hidden border relative" style={{ background: c.surface, borderColor: c.border }}>
          <div className="aspect-[16/9] flex items-center justify-center" style={{ background: c.surfaceHover }}>
            {items[0]?.image_url ? <img src={items[0].image_url} alt="" className="w-full h-full object-cover" /> : <LayoutGrid size={22} style={{ color: c.textFaint }} />}
          </div>
          <div className="p-2.5">
            <div className="font-body text-sm font-semibold truncate">{dept.name}</div>
            <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{items.length} item{items.length === 1 ? "" : "s"}</div>
          </div>
        </button>
      ))}
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
              {p.image_url ? <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" /> : <ImageIcon size={28} style={{ color: c.textFaint }} />}
              {canQuickAdd && (
                <button onClick={(e) => { e.stopPropagation(); onQuickAdd(p); }} aria-label={`Add ${p.name} to cart`}
                  className="absolute bottom-2 right-2 w-7 h-7 rounded-full flex items-center justify-center shadow-md" style={{ background: SHOP_GOLD, color: "#1a1200" }}>
                  <Plus size={14} />
                </button>
              )}
            </div>
            <div className="p-2.5">
              <div className="font-body text-xs font-semibold truncate">{p.name}</div>
              <div className="font-mono text-xs mt-0.5" style={{ color: SHOP_GOLD }}>{formatMoney(p.price)}</div>
              {!p.active && <div className="font-mono text-[9px] uppercase mt-1" style={{ color: c.textFaint }}>Hidden</div>}
              {p.active && p.stock_qty === 0 && <div className="font-mono text-[9px] uppercase mt-1" style={{ color: c.red }}>Out of stock</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProductModal({ product, onClose, onAdd, onShare, c }) {
  const [qty, setQty] = useState(1);
  const outOfStock = (product.stock_qty ?? 0) === 0;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl overflow-hidden max-h-[85vh] overflow-y-auto" style={{ background: c.bg }} onClick={(e) => e.stopPropagation()}>
        <div className="aspect-square relative flex items-center justify-center" style={{ background: c.surfaceHover }}>
          {product.image_url ? <img src={product.image_url} alt={product.name} className="w-full h-full object-cover" /> : <ImageIcon size={40} style={{ color: c.textFaint }} />}
          <button onClick={onShare} aria-label="Share this product" title="Share this product" className="absolute top-3 left-3 w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}><Share2 size={15} /></button>
          <button onClick={onClose} className="absolute top-3 right-3 w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)", color: "#fff" }}><X size={16} /></button>
        </div>
        <div className="p-4">
          <div className="font-extrabold uppercase tracking-tight text-lg leading-tight">{product.name}</div>
          <div className="font-mono text-sm font-semibold mt-1" style={{ color: SHOP_GOLD }}>{formatMoney(product.price)}</div>
          {product.description && <p className="font-body text-sm mt-2.5" style={{ color: c.textDim }}>{product.description}</p>}

          {outOfStock ? (
            <div className="mt-4 font-body text-sm text-center py-2.5 rounded-full" style={{ background: c.surface, color: c.textDim }}>Out of stock</div>
          ) : (
            <>
              <div className="flex items-center justify-center gap-4 mt-4">
                <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surface, color: c.text }}><Minus size={14} /></button>
                <span className="font-mono font-bold text-base w-6 text-center">{qty}</span>
                <button onClick={() => setQty((q) => Math.min(product.stock_qty || 99, q + 1))} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: c.surface, color: c.text }}><Plus size={14} /></button>
              </div>
              <button onClick={() => onAdd(qty)} className="w-full mt-4 font-body text-sm font-semibold py-2.5 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200" }}>Add to cart</button>
            </>
          )}
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
              <div key={it.productId} className="flex items-center gap-3 rounded-xl p-2.5 border" style={{ background: c.surface, borderColor: c.border }}>
                <div className="w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center shrink-0" style={{ background: c.surfaceHover }}>
                  {it.image_url ? <img src={it.image_url} alt="" className="w-full h-full object-cover" /> : <ImageIcon size={16} style={{ color: c.textFaint }} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-body text-xs font-semibold truncate">{it.name}</div>
                  <div className="font-mono text-xs" style={{ color: SHOP_GOLD }}>{formatMoney(it.price)}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => onUpdateQty(it.productId, it.qty - 1)} className="w-6 h-6 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><Minus size={11} /></button>
                  <span className="font-mono text-xs font-bold w-4 text-center">{it.qty}</span>
                  <button onClick={() => onUpdateQty(it.productId, it.qty + 1)} className="w-6 h-6 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.text }}><Plus size={11} /></button>
                  <button onClick={() => onRemove(it.productId)} className="w-6 h-6 rounded-full flex items-center justify-center ml-1" style={{ color: c.red }}><Trash2 size={13} /></button>
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

function CheckoutView({ cart, total, session, profile, onDone, onBack, showToast, c }) {
  const [method, setMethod] = useState(SHOP_WHATSAPP_NUMBER ? "whatsapp" : "manual_proof");
  const [submitting, setSubmitting] = useState(false);
  const [proofFile, setProofFile] = useState(null);
  const [note, setNote] = useState("");
  const [contactPhone, setContactPhone] = useState(profile?.phone || "");

  const buyerUsername = profile?.efootball_username || session?.user?.email || "Shopper";

  const orderLines = () => cart.map((it) => `${it.qty}x ${it.name} — ${formatMoney(it.qty * it.price)}`).join("\n");

  const submitWhatsapp = async () => {
    if (!SHOP_WHATSAPP_NUMBER) { showToast("WhatsApp ordering isn't set up yet."); return; }
    setSubmitting(true);
    const { error: orderErr } = await supabase.from("shop_orders").insert({
      user_id: session.user.id, buyer_username: buyerUsername, buyer_phone: contactPhone || null,
      checkout_method: "whatsapp", status: "whatsapp_sent", subtotal: total, contact_phone: contactPhone || null, delivery_note: note || null,
    }).select().single().then(async ({ data, error }) => {
      if (error || !data) return { error };
      const items = cart.map((it) => ({ order_id: data.id, product_id: it.productId, product_name: it.name, unit_price: it.price, qty: it.qty }));
      const { error: itemsErr } = await supabase.from("shop_order_items").insert(items);
      return { error: itemsErr };
    });
    setSubmitting(false);
    if (orderErr) { showToast(`Couldn't submit order: ${orderErr.message}`); return; }
    const msg = `Hi, I'd like to order from WeAfrica Shop:\n\n${orderLines()}\n\nTotal: ${formatMoney(total)}\n\nName: ${buyerUsername}`;
    window.open(waLink(SHOP_WHATSAPP_NUMBER, msg), "_blank", "noopener,noreferrer");
    onDone();
  };

  const submitManualProof = async () => {
    if (!proofFile) { showToast("Attach your proof of payment before submitting."); return; }
    setSubmitting(true);
    const ext = (proofFile.name.split(".").pop() || "dat").toLowerCase();
    const path = `${session.user.id}/order-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("shop-payment-proofs").upload(path, proofFile);
    if (uploadErr) { setSubmitting(false); showToast(`Couldn't upload proof: ${uploadErr.message}`); return; }

    const { data: order, error: orderErr } = await supabase.from("shop_orders").insert({
      user_id: session.user.id, buyer_username: buyerUsername, buyer_phone: contactPhone || null,
      checkout_method: "manual_proof", status: "pending_review", subtotal: total,
      contact_phone: contactPhone || null, delivery_note: note || null, payment_proof_path: path,
    }).select().single();
    if (orderErr || !order) { setSubmitting(false); showToast(`Couldn't submit order: ${orderErr?.message || "unknown error"}`); return; }

    const items = cart.map((it) => ({ order_id: order.id, product_id: it.productId, product_name: it.name, unit_price: it.price, qty: it.qty }));
    const { error: itemsErr } = await supabase.from("shop_order_items").insert(items);
    setSubmitting(false);
    if (itemsErr) { showToast(`Couldn't save order items: ${itemsErr.message}`); return; }
    showToast("Order submitted — pending payment review.");
    onDone();
  };

  const submitGateway = async () => {
    setSubmitting(true);
    const result = await payWithGateway();
    setSubmitting(false);
    if (!result.success) { showToast("Card payments aren't set up yet."); return; }
    // Once payWithGateway() is real, insert the order here the same way
    // submitManualProof does, with checkout_method: "gateway", status: "paid",
    // gateway_reference: result.reference.
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

      <div className="grid grid-cols-3 gap-1.5 mb-5 p-1 rounded-full" style={{ background: c.surface }}>
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
        <button onClick={() => SHOP_GATEWAY_ENABLED && setMethod("gateway")} disabled={!SHOP_GATEWAY_ENABLED}
          className="font-body text-[11px] font-semibold py-2 rounded-full flex flex-col items-center gap-0.5"
          style={method === "gateway" ? { background: c.text, color: c.bg } : { color: c.textDim, opacity: SHOP_GATEWAY_ENABLED ? 1 : 0.4 }}>
          {SHOP_GATEWAY_ENABLED ? <CreditCard size={13} /> : <Lock size={13} />} Card
        </button>
      </div>

      <div className="mb-4">
        <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Contact number</label>
        <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Where can we reach you about this order?"
          className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      {method === "whatsapp" && (
        <div className="space-y-3">
          <p className="font-body text-sm" style={{ color: c.textDim }}>
            Your order summary will be sent to us on WhatsApp, and we'll confirm payment and delivery with you directly there.
          </p>
          <button onClick={submitWhatsapp} disabled={submitting}
            className="w-full font-body text-sm font-semibold py-3 rounded-full flex items-center justify-center gap-2" style={{ background: "#25D366", color: "#fff", opacity: submitting ? 0.6 : 1 }}>
            <MessageCircle size={15} /> {submitting ? "Sending..." : "Order on WhatsApp"}
          </button>
        </div>
      )}

      {method === "manual_proof" && (
        <div className="space-y-3">
          <div className="rounded-xl p-3 border font-mono text-xs whitespace-pre-line" style={{ background: c.surface, borderColor: c.border, color: c.textDim }}>
            {SHOP_BANK_DETAILS}
          </div>
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Delivery / pickup note (optional)</label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Address, or pickup preference..."
              className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none resize-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
          </div>
          <label className="flex items-center gap-2 border border-dashed rounded-lg px-3 py-3 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: proofFile ? c.text : c.textDim }}>
            <Upload size={15} />
            {proofFile ? proofFile.name : "Attach proof of payment"}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setProofFile(e.target.files?.[0] || null)} />
          </label>
          <button onClick={submitManualProof} disabled={submitting}
            className="w-full font-body text-sm font-semibold py-3 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200", opacity: submitting ? 0.6 : 1 }}>
            {submitting ? "Submitting..." : "Submit order"}
          </button>
        </div>
      )}

      {method === "gateway" && SHOP_GATEWAY_ENABLED && (
        <button onClick={submitGateway} disabled={submitting} className="w-full font-body text-sm font-semibold py-3 rounded-full" style={{ background: c.accent, color: c.accentText }}>
          Pay {formatMoney(total)}
        </button>
      )}

      <button onClick={onBack} className="w-full mt-3 font-body text-xs" style={{ color: c.textFaint }}>Back to cart</button>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// MY ORDERS
// ════════════════════════════════════════════════════════════════════

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
                <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{new Date(o.created_at).toLocaleDateString()}</span>
                <StatusBadge status={o.status} c={c} />
              </div>
              {(o.shop_order_items || []).map((it) => (
                <div key={it.id} className="font-body text-xs flex items-center justify-between" style={{ color: c.textDim }}>
                  <span>{it.qty}x {it.product_name}</span>
                  <span>{formatMoney(it.qty * it.unit_price)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t" style={{ borderColor: c.border }}>
                <span className="font-body text-xs font-semibold">Total</span>
                <span className="font-mono text-sm font-bold">{formatMoney(o.subtotal)}</span>
              </div>
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

function AdminProducts({ products, departments, onReload, onReloadDepartments, showToast, onOpenOrders, c }) {
  const [editing, setEditing] = useState(null); // product being edited, or {} for new
  const [managingDepts, setManagingDepts] = useState(false);
  const [query, setQuery] = useState("");

  if (products === null) return <Spinner c={c} />;
  const q = query.trim().toLowerCase();
  const filtered = q ? products.filter((p) => p.name.toLowerCase().includes(q)) : products;
  const deptById = new Map(departments.map((d) => [d.id, d]));

  const saveProduct = async (form, file) => {
    let image_url = editing?.image_url || null;
    if (file) {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("shop-photos").upload(path, file, { upsert: true });
      if (uploadErr) { showToast(`Couldn't upload image: ${uploadErr.message}`); return false; }
      const { data: pub } = supabase.storage.from("shop-photos").getPublicUrl(path);
      image_url = pub.publicUrl;
    }
    const payload = { name: form.name, description: form.description || null, price: Number(form.price) || 0, stock_qty: Number(form.stock_qty) || 0, active: form.active, image_url, department_id: form.department_id || null };
    const { error } = editing?.id
      ? await supabase.from("shop_products").update(payload).eq("id", editing.id)
      : await supabase.from("shop_products").insert(payload);
    if (error) { showToast(`Couldn't save product: ${error.message}`); return false; }
    showToast(editing?.id ? "Product updated." : "Product added.");
    await onReload();
    return true;
  };

  const deleteProduct = async (product) => {
    const { error } = await supabase.from("shop_products").delete().eq("id", product.id);
    if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
    showToast("Product deleted.");
    await onReload();
  };

  if (managingDepts) {
    return <AdminDepartments departments={departments} products={products} onReload={onReloadDepartments} showToast={showToast} onBack={() => setManagingDepts(false)} c={c} />;
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
              {p.image_url ? <img src={p.image_url} alt="" className="w-full h-full object-cover" /> : <ImageIcon size={14} style={{ color: c.textFaint }} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-body text-xs font-semibold truncate">{p.name}</div>
              <div className="font-mono text-[10px]" style={{ color: c.textDim }}>
                {formatMoney(p.price)} · {p.stock_qty} in stock {!p.active && "· hidden"}
                {p.department_id && deptById.has(p.department_id) && ` · ${deptById.get(p.department_id).name}`}
              </div>
            </div>
            <button onClick={() => setEditing(p)} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.text }}>Edit</button>
            <button onClick={() => deleteProduct(p)} className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.red }}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      {editing && <ProductFormModal product={editing} departments={departments} onClose={() => setEditing(null)} onSave={saveProduct} c={c} />}
    </div>
  );
}

function ProductFormModal({ product, departments, onClose, onSave, c }) {
  const [name, setName] = useState(product.name || "");
  const [description, setDescription] = useState(product.description || "");
  const [price, setPrice] = useState(product.price ?? "");
  const [stockQty, setStockQty] = useState(product.stock_qty ?? 0);
  const [active, setActive] = useState(product.active ?? true);
  const [departmentId, setDepartmentId] = useState(product.department_id || "");
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim() || !price) return;
    setSaving(true);
    const ok = await onSave({ name: name.trim(), description, price, stock_qty: stockQty, active, department_id: departmentId || null }, file);
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
              <input type="number" min="0" value={stockQty} onChange={(e) => setStockQty(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
            </div>
          </div>
          <div>
            <label className="font-body text-xs font-semibold block mb-1.5" style={{ color: c.textDim }}>Department</label>
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }}>
              <option value="">Uncategorized</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 border border-dashed rounded-lg px-3 py-3 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
            <Upload size={15} /> {file ? file.name : "Product photo"}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
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
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// ADMIN — DEPARTMENTS
// ════════════════════════════════════════════════════════════════════

function AdminDepartments({ departments, products, onReload, showToast, onBack, c }) {
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const countFor = (deptId) => products.filter((p) => p.department_id === deptId).length;

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

  const deleteDepartment = async (dept) => {
    const affected = countFor(dept.id);
    const { error } = await supabase.from("shop_departments").delete().eq("id", dept.id);
    if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
    showToast(affected > 0 ? `Deleted — ${affected} product${affected === 1 ? "" : "s"} moved to "Other".` : "Department deleted.");
    await onReload();
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
                  <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{countFor(d.id)} product{countFor(d.id) === 1 ? "" : "s"}</div>
                </div>
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
// ADMIN — ORDERS
// ════════════════════════════════════════════════════════════════════

function AdminOrders({ session, showToast, onReloadProducts, onOpenProducts, c }) {
  const [orders, setOrders] = useState(null);
  const [filter, setFilter] = useState("pending_review");
  const [proofUrls, setProofUrls] = useState({});

  const load = async () => {
    const { data, error } = await supabase.from("shop_orders").select("*, shop_order_items(*)").order("created_at", { ascending: false });
    if (!error) setOrders(data || []);
  };
  useEffect(() => { load(); }, []);

  const viewProof = async (order) => {
    if (!order.payment_proof_path) return;
    const { data, error } = await supabase.storage.from("shop-payment-proofs").createSignedUrl(order.payment_proof_path, 120);
    if (error || !data) { showToast("Couldn't generate a link to the proof."); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const decrementStock = async (order) => {
    for (const item of order.shop_order_items || []) {
      if (!item.product_id) continue;
      const { data: prod } = await supabase.from("shop_products").select("stock_qty").eq("id", item.product_id).maybeSingle();
      if (prod) await supabase.from("shop_products").update({ stock_qty: Math.max(0, prod.stock_qty - item.qty) }).eq("id", item.product_id);
    }
    onReloadProducts && onReloadProducts();
  };

  const review = async (order, status) => {
    const { error } = await supabase.from("shop_orders").update({
      status, admin_reviewed_by: session.user.id, admin_reviewed_at: new Date().toISOString(),
    }).eq("id", order.id);
    if (error) { showToast(`Couldn't update order: ${error.message}`); return; }
    if (status === "paid") await decrementStock(order);
    showToast(status === "paid" ? "Order approved." : `Order marked ${status}.`);
    await load();
  };

  if (orders === null) return <Spinner c={c} />;
  const filtered = filter === "all" ? orders : orders.filter((o) => o.status === filter);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <ClipboardList size={20} style={{ color: SHOP_GOLD }} />
          <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Orders</h1>
        </div>
        <button onClick={onOpenProducts} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surface, color: c.textDim }}>Products</button>
      </div>

      <div className="flex gap-1.5 mb-4 overflow-x-auto">
        {["pending_review", "paid", "whatsapp_sent", "fulfilled", "rejected", "all"].map((f) => (
          <button key={f} onClick={() => setFilter(f)} className="shrink-0 font-mono text-[10px] font-semibold px-2.5 py-1.5 rounded-full uppercase"
            style={filter === f ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
            {f.replace("_", " ")}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No orders here.</div>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((o) => (
            <div key={o.id} className="rounded-xl p-3 border" style={{ background: c.surface, borderColor: c.border }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="font-body text-xs font-semibold">{o.buyer_username}</span>
                <StatusBadge status={o.status} c={c} />
              </div>
              <div className="font-mono text-[10px] mb-1.5" style={{ color: c.textFaint }}>
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
              <div className="flex items-center justify-between mt-1.5 pt-1.5 border-t" style={{ borderColor: c.border }}>
                <span className="font-body text-xs font-semibold">Total</span>
                <span className="font-mono text-sm font-bold">{formatMoney(o.subtotal)}</span>
              </div>

              <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                {o.payment_proof_path && (
                  <button onClick={() => viewProof(o)} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full" style={{ background: c.surfaceHover, color: c.text }}>View proof</button>
                )}
                {o.status === "pending_review" && (
                  <>
                    <button onClick={() => review(o, "paid")} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full flex items-center gap-1" style={{ background: c.greenSoft, color: c.greenText }}><CheckCircle2 size={11} /> Approve</button>
                    <button onClick={() => review(o, "rejected")} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full flex items-center gap-1" style={{ background: c.redSoft, color: c.red }}><XCircle size={11} /> Reject</button>
                  </>
                )}
                {(o.status === "paid" || o.status === "whatsapp_sent") && (
                  <button onClick={() => review(o, "fulfilled")} className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full flex items-center gap-1" style={{ background: c.surfaceHover, color: c.text }}><Truck size={11} /> Mark fulfilled</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
