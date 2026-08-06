// Handles requests to /shop/<id> (see vercel.json's rewrite for that path).
//
// Chat apps and social platforms (WhatsApp, Facebook, Twitter/X, Slack,
// Telegram, Discord, LinkedIn...) don't run JavaScript when they "unfurl" a
// shared link — they just fetch the URL and read a handful of <meta> tags
// out of the raw HTML. Our app is a client-rendered SPA, so a normal visit
// works fine (the browser runs the JS and shows the product), but a crawler
// fetching the same URL would only ever see an empty <div id="root">.
//
// So: detect known crawler user-agents and hand THEM a tiny, dependency-free
// HTML page with proper Open Graph / Twitter Card tags (title, price,
// description, and the product photo) pulled straight from Supabase. Every
// other visitor — i.e. real people tapping the link — gets the actual built
// app, fetched from this same deployment's own /index.html, completely
// untouched. The client-side router in App.jsx then opens the right product
// once it loads, exactly as it did before this function existed.
const BOT_UA_PATTERN =
  /facebookexternalhit|Facebot|WhatsApp|Twitterbot|Slackbot|TelegramBot|LinkedInBot|Discordbot|Pinterest|vkShare|SkypeUriPreview|Googlebot|Applebot|redditbot|Embedly|W3C_Validator|Iframely|Bitly|SnapchatAds/i;

// Buckets api/image.js will actually proxy — kept in sync with that file's
// ALLOWED_BUCKETS and mediaUrl.js's PROXIED_BUCKETS.
const PROXIED_BUCKETS = new Set(["avatars", "league-photos", "comment-photos", "shop-photos", "comment-voice-notes"]);

// Turns whatever's in product.image_url into an ABSOLUTE, proxied URL, so
// this page's og:image/twitter:image tags are something every crawler can
// actually fetch.
//
// Two cases land here, and both need fixing the same way:
//  - A raw Supabase public-storage URL (products uploaded before the proxy
//    existed) — every unfurl (WhatsApp, Facebook, Twitter, Slack...) would
//    otherwise fetch that image straight from Supabase, spending Cached
//    Egress on crawler traffic that has nothing to do with real visitors.
//  - An already-proxied but RELATIVE path (products uploaded after the
//    fix, e.g. "/api/image?bucket=..."), which technically isn't valid in
//    an og:image tag at all — crawlers expect a full absolute URL.
// Either way, the fix is the same: resolve to this same bucket/path pair
// and build `${proto}://${host}/api/image?...` — an absolute URL that
// still resolves through Vercel's cache, not Supabase.
function absoluteProxiedImage(imageUrl, supabaseUrl, proto, host) {
  if (!imageUrl) return null;
  const origin = `${proto}://${host}`;
  if (imageUrl.startsWith("/api/image?")) return `${origin}${imageUrl}`;
  if (imageUrl.startsWith(origin)) return imageUrl; // already absolute-proxied somehow
  if (supabaseUrl) {
    const prefix = `${supabaseUrl}/storage/v1/object/public/`;
    if (imageUrl.startsWith(prefix)) {
      const rest = imageUrl.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash !== -1) {
        const bucket = rest.slice(0, slash);
        const path = rest.slice(slash + 1);
        if (PROXIED_BUCKETS.has(bucket)) {
          return `${origin}/api/image?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
        }
      }
    }
  }
  return imageUrl; // unrecognized shape — leave alone rather than guess
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRand(amount) {
  return `R${Number(amount).toLocaleString("en-ZA")}`;
}

export default async function handler(req, res) {
  const id = req.query?.id;
  const host = req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const pageUrl = `${proto}://${host}/shop/${encodeURIComponent(id || "")}`;
  const userAgent = req.headers["user-agent"] || "";
  const isCrawler = BOT_UA_PATTERN.test(userAgent);

  // A real person opening the link — serve the actual app, unmodified, so
  // everything (styling, hashed asset filenames, etc.) works exactly as it
  // does for any other page on the site.
  if (!isCrawler) {
    try {
      const appRes = await fetch(`${proto}://${host}/index.html`);
      const html = await appRes.text();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(html);
    } catch {
      // If the self-fetch ever fails for some reason, don't leave the
      // visitor stuck — send them to the homepage instead of an error page.
      res.writeHead(302, { Location: "/" });
      res.end();
    }
    return;
  }

  // A crawler — look up just enough about the product to build a rich
  // preview. Falls back to generic shop branding if the id is missing,
  // the product's gone, or Supabase is unreachable.
  let product = null;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (id && supabaseUrl && supabaseAnonKey) {
    try {
      const query = `${supabaseUrl}/rest/v1/shop_products?id=eq.${encodeURIComponent(id)}&select=name,price,description,image_url`;
      const dataRes = await fetch(query, {
        headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
      });
      if (dataRes.ok) {
        const rows = await dataRes.json();
        product = Array.isArray(rows) ? rows[0] || null : null;
      }
    } catch {
      // Network hiccup talking to Supabase — fall through to the generic preview below.
    }
  }

  const title = product?.name || "WeAfrica Shop";
  const priceText = product?.price != null ? formatRand(product.price) : "";
  const description = product
    ? (product.description ? product.description : `${priceText} — available now on WeAfrica Shop.`)
    : "Browse the WeAfrica Shop.";
  const fullTitle = product && priceText ? `${title} — ${priceText}` : title;
  const image = absoluteProxiedImage(product?.image_url, supabaseUrl, proto, host) || `${proto}://${host}/hero-emblem.png`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description)}" />

<meta property="og:type" content="product" />
<meta property="og:title" content="${escapeHtml(fullTitle)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta property="og:url" content="${escapeHtml(pageUrl)}" />
<meta property="og:site_name" content="WeAfrica Shop" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(fullTitle)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />
</head>
<body>
<a href="${escapeHtml(pageUrl)}">${escapeHtml(fullTitle)}</a>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
