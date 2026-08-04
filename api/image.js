// Proxies public Supabase Storage files (images/audio) through Vercel's
// own edge network instead of serving them straight from Supabase.
//
// Why: Supabase's free plan caps "Cached Egress" (Storage bandwidth) at
// 5GB/month. Vercel's Hobby plan includes ~100GB/month of edge bandwidth,
// and once this response is cached at Vercel's edge (see the Cache-Control
// header below), repeat views are served from there and never touch
// Supabase's egress meter at all.
//
// Deliberately gradual, not a backfill: this is only wired up for BRAND
// NEW uploads (see src/utils/mediaUrl.js). Rows already in the database
// still hold direct Supabase public URLs and are left completely alone —
// they keep working exactly as before (and already got a 1yr Supabase-side
// cache header from the earlier fix). Nothing existing gets rewritten, so
// there's no migration risk; the app just phases onto this proxy naturally
// as new avatars/photos/voice notes get created.

const ALLOWED_BUCKETS = new Set([
  "avatars",
  "league-photos",
  "comment-photos",
  "shop-photos",
  "comment-voice-notes",
]);

export default async function handler(req, res) {
  const { bucket, path } = req.query;
  const cleanPath = Array.isArray(path) ? path.join("/") : path;

  if (!bucket || !cleanPath || !ALLOWED_BUCKETS.has(bucket)) {
    res.status(400).send("Invalid bucket or path");
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) {
    res.status(500).send("Server misconfigured");
    return;
  }

  const upstream = `${supabaseUrl}/storage/v1/object/public/${bucket}/${cleanPath}`;

  try {
    const upstreamRes = await fetch(upstream);
    if (!upstreamRes.ok) {
      res.status(upstreamRes.status).send("Not found");
      return;
    }

    const contentType = upstreamRes.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    // Immutable: every path here already carries a Date.now()-based unique
    // filename upstream, so this exact URL's content can never change —
    // safe to cache forever in both the browser and Vercel's edge (s-maxage).
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    res.status(200).send(buffer);
  } catch {
    res.status(502).send("Upstream fetch failed");
  }
}
