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
const UPLOAD_TIMEOUT_MS = 110000; // covers up to MAX_TRIES attempts

const FRIENDLY = "Couldn't upload the photo. Check your connection and try again.";
const TRY_TIMEOUT_MS = 25000; // per request: a stalled connection fails fast and gets retried
const MAX_TRIES = 3;

// fetch that gives up after TRY_TIMEOUT_MS instead of hanging on a bad signal.
async function timedFetch(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRY_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); } finally { clearTimeout(timer); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An error worth another go: the request never completed (network/timeout) or
// the server had a hiccup. Validation errors (wrong type, too big) are not.
class RetryableError extends Error {}

// Same-origin fallback: send the bytes to our own server, which puts them in
// R2. Used when the direct browser-to-R2 request fails to even connect.
async function uploadViaServer(pathname, file, contentType) {
  let res;
  try {
    res = await timedFetch(`/api/r2-upload-proxy?pathname=${encodeURIComponent(pathname)}&contentType=${encodeURIComponent(contentType)}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file,
    });
  } catch (e) { throw new RetryableError(FRIENDLY); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 413) throw new Error("That photo is too large. Pick a smaller one and try again.");
    if (res.status >= 500 || res.status === 429) throw new RetryableError(body.error || FRIENDLY);
    throw new Error(body.error || FRIENDLY);
  }
  return body.publicUrl;
}

async function attemptUpload(pathname, file, contentType) {
  let url, publicUrl;
  try {
    const tokenRes = await timedFetch("/api/r2-upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pathname, contentType }) });
    if (!tokenRes.ok) {
      const body = await tokenRes.json().catch(() => ({}));
      const err = new Error(body.error || "Couldn't authorize the upload.");
      if (tokenRes.status >= 500 || tokenRes.status === 429) throw new RetryableError(err.message);
      throw err;
    }
    ({ url, publicUrl } = await tokenRes.json());
  } catch (e) {
    if (e instanceof RetryableError || !(e instanceof TypeError || e.name === "AbortError")) throw e;
    return uploadViaServer(pathname, file, contentType); // couldn't reach the mint route: try the server upload
  }
  try {
    const putRes = await timedFetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
    if (putRes.ok) return publicUrl;
  } catch (e) { /* "Failed to fetch" / timeout: CORS or network. Fall through to the server route. */ }
  return uploadViaServer(pathname, file, contentType);
}

async function uploadToR2Inner(bucket, path, file, contentType) {
  const pathname = `${bucket}/${path}`;
  const resolvedContentType = contentType || file.type || "application/octet-stream";
  let lastErr;
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      return await attemptUpload(pathname, file, resolvedContentType);
    } catch (e) {
      lastErr = e;
      if (!(e instanceof RetryableError)) break;
      await sleep(800 * (i + 1));
    }
  }
  throw new Error(/failed to fetch|networkerror|aborted/i.test(lastErr?.message || "") ? FRIENDLY : (lastErr?.message || FRIENDLY));
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
