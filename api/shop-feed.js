// Product feed for the Facebook / Instagram catalogue (Meta Commerce Manager).
//
// Served at /shop-feed.xml (see vercel.json). In Commerce Manager choose
// Catalogue > Data sources > "Data feed" > "Scheduled feed" and paste this URL;
// Meta re-reads it on the schedule you pick, so new products, price changes
// and stock changes flow through on their own. It uses the standard RSS 2.0
// product format (g: namespace) that Meta accepts.
//
// Rules we follow: only active products; one item per option (size/colour)
// when a product has options, tied together with item_group_id; absolute
// https links and image URLs; "99.00 ZAR" price format.
const PROXIED_BUCKETS = new Set(["avatars", "league-photos", "comment-photos", "shop-photos", "comment-voice-notes"]);

function absoluteImage(imageUrl, supabaseUrl, origin) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith("/api/image?")) return `${origin}${imageUrl}`;
  if (imageUrl.startsWith("/")) return `${origin}${imageUrl}`;
  if (supabaseUrl) {
    const prefix = `${supabaseUrl}/storage/v1/object/public/`;
    if (imageUrl.startsWith(prefix)) {
      const rest = imageUrl.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash !== -1 && PROXIED_BUCKETS.has(rest.slice(0, slash))) {
        return `${origin}/api/image?bucket=${encodeURIComponent(rest.slice(0, slash))}&path=${encodeURIComponent(rest.slice(slash + 1))}`;
      }
    }
  }
  return /^https:\/\//i.test(imageUrl) ? imageUrl : null;
}

// Removes characters that are illegal in XML 1.0, then escapes the rest.
export function xmlText(value) {
  return String(value ?? "")
    .replace(/[^\u0009\u000A\u000D -퟿-�]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const money = (n) => `${(Math.round(Number(n || 0) * 100) / 100).toFixed(2)} ZAR`;

export function buildFeed({ products, variants, images, departments, productDepts, origin, supabaseUrl, brand = "WeAfrica" }) {
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const deptsOf = new Map();
  productDepts.forEach((pd) => { if (!deptsOf.has(pd.product_id)) deptsOf.set(pd.product_id, []); deptsOf.get(pd.product_id).push(pd.department_id); });
  const varsOf = new Map();
  variants.forEach((v) => { if (!varsOf.has(v.product_id)) varsOf.set(v.product_id, []); varsOf.get(v.product_id).push(v); });
  const imgsOf = new Map();
  images.forEach((im) => { if (!imgsOf.has(im.product_id)) imgsOf.set(im.product_id, []); imgsOf.get(im.product_id).push(im); });

  const items = [];
  let skipped = 0;
  for (const p of products) {
    const main = absoluteImage(p.image_url, supabaseUrl, origin);
    const extra = (imgsOf.get(p.id) || []).slice().sort((a, b) => a.position - b.position)
      .map((im) => absoluteImage(im.url, supabaseUrl, origin)).filter(Boolean);
    const all = [...new Set([main, ...extra].filter(Boolean))];
    if (all.length === 0) { skipped += 1; continue; } // Meta rejects items with no image
    const dIds = deptsOf.get(p.id) || (p.department_id ? [p.department_id] : []);
    const type = dIds.map((id) => deptName.get(id)).filter(Boolean)[0] || "";
    const desc = (String(p.description || "").trim() || p.name).slice(0, 5000);
    const vs = (varsOf.get(p.id) || []).sort((a, b) => (a.position || 0) - (b.position || 0));
    const rows = vs.length
      ? vs.map((v) => ({ id: `${p.id}-${v.id}`, title: `${p.name} (${v.name})`, price: v.price ?? p.price, stock: v.stock_qty, group: p.id, option: v.name }))
      : [{ id: p.id, title: p.name, price: p.price, stock: p.stock_qty, group: null, option: null }];
    for (const r of rows) {
      const list = Number(p.compare_at_price) > Number(r.price) ? Number(p.compare_at_price) : null;
      const lines = [
        `<g:id>${xmlText(r.id)}</g:id>`,
        `<g:title>${xmlText(r.title.slice(0, 150))}</g:title>`,
        `<g:description>${xmlText(desc)}</g:description>`,
        `<g:link>${xmlText(`${origin}/shop/${p.id}`)}</g:link>`,
        `<g:image_link>${xmlText(all[0])}</g:image_link>`,
        ...all.slice(1, 11).map((u) => `<g:additional_image_link>${xmlText(u)}</g:additional_image_link>`),
        `<g:availability>${Number(r.stock) > 0 ? "in stock" : "out of stock"}</g:availability>`,
        `<g:condition>new</g:condition>`,
        `<g:price>${money(list ?? r.price)}</g:price>`,
        ...(list ? [`<g:sale_price>${money(r.price)}</g:sale_price>`] : []),
        `<g:brand>${xmlText(brand)}</g:brand>`,
        ...(type ? [`<g:product_type>${xmlText(type)}</g:product_type>`] : []),
        ...(r.group ? [`<g:item_group_id>${xmlText(r.group)}</g:item_group_id>`] : []),
      ];
      items.push(`    <item>\n      ${lines.join("\n      ")}\n    </item>`);
    }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss xmlns:g="http://base.google.com/ns/1.0" version="2.0">\n  <channel>\n    <title>${xmlText(brand)} Shop</title>\n    <link>${xmlText(`${origin}/shop`)}</link>\n    <description>${xmlText(brand)} shop product feed</description>\n${items.join("\n")}\n  </channel>\n</rss>\n`;
  return { xml, count: items.length, skipped };
}

export default async function handler(req, res) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !key) { res.status(500).send("Shop feed isn't configured."); return; }
  const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
  const get = async (path) => {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}`);
    return r.json();
  };
  try {
    const [products, variants, images, departments, productDepts] = await Promise.all([
      get("shop_products?active=eq.true&exclude_from_catalogue=eq.false&quote_only=eq.false&select=id,name,description,price,compare_at_price,stock_qty,image_url,department_id&order=created_at.desc&limit=5000"),
      get("shop_product_variants?active=eq.true&select=id,product_id,name,price,stock_qty,position&limit=10000"),
      get("shop_product_images?select=product_id,url,position&limit=20000"),
      get("shop_departments?select=id,name"),
      get("shop_product_departments?select=product_id,department_id"),
    ]);
    const { xml } = buildFeed({ products, variants, images, departments, productDepts, origin, supabaseUrl });
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
    res.status(200).send(xml);
  } catch {
    res.status(502).send("Couldn't build the feed right now.");
  }
}
