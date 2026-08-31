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
import { withTimeout } from "./withTimeout";

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
//
// Wrapped in withTimeout (see its own header) so every call site gets the
// "don't hang forever on a stalled mobile connection" protection by
// default, not just the one flow (App.jsx's claimLadderCupWalkover) that
// happened to wrap it manually — this is exactly the bug behind results
// "uploading fine on the website but just spinning in the installed app":
// the underlying request can go quiet with no error on a backgrounded/
// flaky mobile connection, and nothing here used to catch that. A caller
// that already wraps this in its own withTimeout (a shorter one, to pair
// with a custom message) is unaffected — Promise.race just resolves on
// whichever timeout is shorter.
// Raised from 30s -> 55s: on a slow/flaky mobile data connection (the
// common case for result-proof uploads specifically — a scoreboard photo
// taken and submitted right after a match, often on cellular), a
// compressed photo can genuinely take longer than 30s to leave the
// device even though the connection isn't actually dead. This was firing
// "Upload timed out" too eagerly for real-but-slow connections; 55s still
// catches a truly stalled request without punishing a merely slow one.
const UPLOAD_TIMEOUT_MS = 55000;

export async function uploadToBlob(bucket, path, file, contentType) {
  if (!KNOWN_BUCKETS.has(bucket)) {
    throw new Error(`uploadToBlob: unknown bucket "${bucket}"`);
  }
  const pathname = `${bucket}/${path}`;
  const blob = await withTimeout(
    upload(pathname, file, {
      access: "public",
      handleUploadUrl: "/api/blob-upload",
      contentType: contentType || file.type || undefined,
    }),
    UPLOAD_TIMEOUT_MS,
    "Upload timed out — check your connection and try again."
  );
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
