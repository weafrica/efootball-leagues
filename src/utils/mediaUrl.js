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
