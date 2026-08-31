// Uploads a file straight from the browser to Cloudflare R2 — the
// replacement for uploadToBlob (blobUpload.js) on every NEW upload, now
// that Vercel Blob's Data Transfer quota was the bottleneck (R2 has no
// egress fee). Everything already on Blob keeps being served from there
// unchanged — this only affects uploads made from here on.
//
// Same two-step "ask the server for a token, then upload directly"
// shape as the old Blob flow, just with a presigned S3-style PUT URL
// instead of Blob's own client-upload token (see api/r2-upload.js).
// File bytes still never pass through a Vercel function.
import { logActivity } from "../activityLog";
import { withTimeout } from "./withTimeout";

// Must match api/r2-upload.js's ALLOWED_PREFIXES exactly (minus the
// trailing slash) — this is the client-side half of that allow-list.
// Same bucket names as blobUpload.js's KNOWN_BUCKETS so this is a
// drop-in replacement at every call site — just swap uploadToBlob for
// uploadToR2, same (bucket, path, file, contentType) signature.
const KNOWN_BUCKETS = new Set([
  "avatars",
  "league-photos",
  "comment-photos",
  "shop-photos",
  "comment-voice-notes",
  "result-proofs",
  "team-sale-photos",
]);

// Same rationale as blobUpload.js's UPLOAD_TIMEOUT_MS — see that file's
// header for why 55s (slow-but-real mobile uploads, not just stalled
// ones). Two legs now (mint the URL, then PUT the bytes) share this one
// timeout via withTimeout wrapping the whole thing, not each leg
// separately — minting is near-instant, so in practice the timeout is
// almost entirely budget for the PUT.
const UPLOAD_TIMEOUT_MS = 55000;

async function uploadToR2Inner(bucket, path, file, contentType) {
  const pathname = `${bucket}/${path}`;
  const resolvedContentType = contentType || file.type || "application/octet-stream";

  const tokenRes = await fetch("/api/r2-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pathname, contentType: resolvedContentType }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.json().catch(() => ({}));
    throw new Error(body.error || "Couldn't authorize the upload.");
  }
  const { url, publicUrl } = await tokenRes.json();

  const putRes = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": resolvedContentType },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Upload failed (${putRes.status}).`);
  }
  return publicUrl;
}

export async function uploadToR2(bucket, path, file, contentType) {
  if (!KNOWN_BUCKETS.has(bucket)) {
    throw new Error(`uploadToR2: unknown bucket "${bucket}"`);
  }
  const publicUrl = await withTimeout(
    uploadToR2Inner(bucket, path, file, contentType),
    UPLOAD_TIMEOUT_MS,
    "Upload timed out — check your connection and try again."
  );
  // Same activity log every Blob upload already wrote, so usage
  // reporting doesn't lose visibility just because the backend changed.
  logActivity("blob_upload", {
    bucket,
    bytes: file.size ?? null,
    content_type: contentType || file.type || null,
    backend: "r2",
  });
  return publicUrl;
}
