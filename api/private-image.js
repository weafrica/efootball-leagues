// Proxies an ALREADY-SIGNED Supabase Storage URL through Vercel's edge
// cache. Used only for the small number of places in the app where a
// signed URL is generated once and then reused long-term (e.g. a result
// photo that gets posted permanently into a league comment with a 5-year
// signed URL) — never for the short 120s single-click download links,
// since those get a fresh token every request and have nothing to cache.
//
// Security note: this does NOT grant any new access. The signed URL is
// already the bearer credential Supabase issued — anyone holding that
// URL string could already fetch the file directly from Supabase, whether
// this proxy exists or not. This function is only ever handed that exact
// pre-authorized URL by the app's own server logic; it doesn't accept a
// bucket/path and re-sign anything itself, and it validates the URL is a
// genuine Supabase signed-storage URL for this project before fetching,
// so it can't be used as an open relay to arbitrary sites.
export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || Array.isArray(url)) {
    res.status(400).send("Missing url");
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) {
    res.status(500).send("Server misconfigured");
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).send("Invalid url");
    return;
  }

  const expectedOrigin = new URL(supabaseUrl).origin;
  const isSignedStorageUrl = parsed.origin === expectedOrigin
    && /^\/storage\/v1\/object\/sign\//.test(parsed.pathname);

  if (!isSignedStorageUrl) {
    res.status(400).send("Not a recognized signed storage url");
    return;
  }

  try {
    const upstreamRes = await fetch(parsed.toString());
    if (!upstreamRes.ok) {
      res.status(upstreamRes.status).send("Not found");
      return;
    }

    const contentType = upstreamRes.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    // These specific signed URLs are minted with a 5-year expiry and never
    // regenerated once posted to a comment, so the content behind this
    // exact proxy URL never changes — safe to cache for a long time.
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    res.status(200).send(buffer);
  } catch {
    res.status(502).send("Upstream fetch failed");
  }
}
