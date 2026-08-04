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
