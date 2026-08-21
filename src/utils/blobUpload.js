// Uploads a file straight from the browser to Vercel Blob, replacing the
// old `supabase.storage.from(bucket).upload(...)` + proxiedMediaUrl(...)
// two-step. This is the single call site every upload flow in the app
// should use going forward for the five public buckets Blob now owns.
//
// The returned URL is already a permanent, globally-cached Blob CDN URL
// (https://<store>.public.blob.vercel-storage.com/...) — no proxy needed,
// unlike the old api/image.js rewrite. Save it straight into the DB the
// same way the old publicUrl was saved.
import { upload } from "@vercel/blob/client";
import { logActivity } from "../activityLog";

// Must match api/blob-upload.js's ALLOWED_PREFIXES exactly (minus the
// trailing slash) — this is the client-side half of that allow-list.
const KNOWN_BUCKETS = new Set([
  "avatars",
  "league-photos",
  "comment-photos",
  "shop-photos",
  "comment-voice-notes",
  "result-proofs",
  "team-sale-photos",
]);

// bucket: one of KNOWN_BUCKETS above (kept as the same name used everywhere
//   else in the app — profiles, leagues, comments, etc. — so this is a
//   drop-in replacement, not a rename).
// path: the same relative path the app already builds for Supabase, e.g.
//   `${session.user.id}-${Date.now()}.${ext}`.
// file: a File or Blob.
// contentType: optional; inferred from the file when omitted.
export async function uploadToBlob(bucket, path, file, contentType) {
  if (!KNOWN_BUCKETS.has(bucket)) {
    throw new Error(`uploadToBlob: unknown bucket "${bucket}"`);
  }
  const pathname = `${bucket}/${path}`;
  const blob = await upload(pathname, file, {
    access: "public",
    handleUploadUrl: "/api/blob-upload",
    contentType: contentType || file.type || undefined,
  });
  // Every upload flow in the app funnels through here, so this is the one
  // place that can log Blob writes for all of them without having to touch
  // each call site (and stays accurate for any new call site added later).
  // bytes is the size actually PUT to Blob — i.e. post-compression for
  // images that went through compressImage first — since that's what
  // counts against Blob storage/bandwidth, not the original camera file.
  logActivity("blob_upload", {
    bucket,
    bytes: file.size ?? null,
    content_type: contentType || file.type || null,
  });
  return blob.url;
}
