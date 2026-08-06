// Builds a same-origin URL that routes through the Vercel proxy
// (api/image.js) instead of a direct Supabase Storage public URL.
//
// Use this ONLY when generating the URL for a file you just uploaded.
// Existing photo_url / avatar_url values already sitting in the database
// are direct Supabase URLs and are left as-is — see api/image.js's top
// comment for why that's deliberate.
export function proxiedMediaUrl(bucket, path) {
  return `/api/image?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
}

// Same idea, for a private-bucket file that's already been signed (e.g. a
// long-lived signed URL that gets posted permanently into a comment). The
// signed URL itself is already the access credential — wrapping it here
// doesn't change who can view it, it just lets Vercel's edge cache hold a
// copy so repeat views of that comment don't re-hit Supabase every time.
// Only ever use this with a URL that's meant to be long-lived/reused, not
// one of the short 120s single-click download links.
export function proxiedSignedUrl(signedUrl) {
  return `/api/private-image?url=${encodeURIComponent(signedUrl)}`;
}

// Supabase project's storage origin, read from Vite's env so this matches
// whatever project this build is actually pointed at — same env var
// api/image.js resolves server-side.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";

// Buckets api/image.js will actually proxy — must match its ALLOWED_BUCKETS
// list. Kept in sync manually; if a new public bucket is ever added to the
// proxy, add it here too, or old direct-URL rows in that bucket will just
// pass through this function untouched (safe, just not fixed).
const PROXIED_BUCKETS = new Set(["avatars", "league-photos", "comment-photos", "shop-photos", "comment-voice-notes"]);

// Rewrites a direct Supabase Storage public URL — the kind stored in the
// database for anything uploaded before the proxy existed, or for rows the
// upload-time fix (proxiedMediaUrl) hasn't touched — into the same
// /api/image proxy path new uploads already use. This is what actually
// stops Cached Egress from still creeping up: proxiedMediaUrl only covers
// files uploaded going forward, but every row already in the database
// still points straight at Supabase until something rewrites it — and
// nothing does, on its own. Wrapping the *rendering* side with this
// function (rather than migrating the database) fixes old and new rows the
// same way, the moment this ships, with nothing to backfill.
//
// Anything that isn't a recognizable direct public-storage URL for one of
// the proxied buckets — an already-proxied path, an external URL, a signed
// URL (those live under /object/sign/, not /object/public/), or
// null/undefined — is returned completely unchanged, so this is safe to
// wrap around any image field without first checking what kind of value it
// holds.
export function toProxiedUrl(url) {
  if (!url || !SUPABASE_URL) return url;
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/`;
  if (!url.startsWith(prefix)) return url;
  const rest = url.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return url;
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (!PROXIED_BUCKETS.has(bucket)) return url;
  return proxiedMediaUrl(bucket, path);
}
