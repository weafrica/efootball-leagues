// Sitemap for the shop (served at /shop-sitemap.xml, see vercel.json and
// public/robots.txt). Lists the shop front page and every live product page so
// search engines can find them all. Products set to "price on request" are
// included too: they have a page worth finding even without a price.
function esc(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function buildSitemap(ids, origin) {
  const urls = [`${origin}/shop`, ...ids.map((id) => `${origin}/shop/${encodeURIComponent(id)}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n")}\n</urlset>\n`;
}

export default async function handler(req, res) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !key) { res.status(500).send("Sitemap isn't configured."); return; }
  const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/shop_products?active=eq.true&select=id&order=created_at.desc&limit=5000`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(String(r.status));
    const rows = await r.json();
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).send(buildSitemap(rows.map((p) => p.id), origin));
  } catch {
    res.status(502).send("Couldn't build the sitemap right now.");
  }
}
