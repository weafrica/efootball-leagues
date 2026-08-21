// Authorizes direct browser-to-Vercel-Blob uploads ("client uploads").
//
// Why this exists: BLOB_READ_WRITE_TOKEN must never reach the browser, so
// the browser can't call Vercel Blob directly the way it calls Supabase
// Storage with the (public-safe) anon key. Instead the browser asks THIS
// route for a short-lived, single-upload token, then uploads straight to
// Blob's servers with that token — the file bytes never pass through a
// Vercel function, same "no serverless middleman" property the old
// Supabase direct-upload flow had.
//
// This route only ever hands out a token; it never receives file bytes
// itself, so it stays fast and cheap regardless of file size.
//
// Pairs with src/utils/blobUpload.js on the client.

import { handleUpload } from "@vercel/blob/client";

// Mirrors the bucket names the app used to pass to Supabase Storage.
// Kept as a prefix allow-list so an attacker can't mint a token for an
// arbitrary path — every blob this route will ever authorize lives under
// one of these folders. result-proofs was added when that bucket moved
// from Supabase (private, signed-URL) to Blob (public) — see MIGRATION.md;
// short version is that result-proof photos already end up posted publicly
// to league comments with a ~5-year signed URL once reviewed, so Blob's
// permanent public URL isn't a meaningfully different exposure. payment-
// proofs is NOT here — those stay private on Supabase, since they're
// financial documents that are never posted publicly by the app.
const ALLOWED_PREFIXES = [
  "avatars/",
  "league-photos/",
  "comment-photos/",
  "shop-photos/",
  "comment-voice-notes/",
  "result-proofs/",
  "team-sale-photos/",
];

const IMAGE_PREFIXES = new Set(["avatars/", "league-photos/", "comment-photos/", "shop-photos/", "result-proofs/", "team-sale-photos/"]);

export default async function handler(req, res) {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const prefix = ALLOWED_PREFIXES.find((p) => pathname.startsWith(p));
        if (!prefix) {
          throw new Error("Upload path not allowed");
        }
        return {
          // Every path already has a Date.now()-based (or similarly unique)
          // filename baked in by the client before it gets here — same
          // uniqueness guarantee the old Supabase paths relied on for
          // immutable, cache-forever URLs. No need for Blob's own random
          // suffix on top of that.
          addRandomSuffix: false,
          allowedContentTypes: IMAGE_PREFIXES.has(prefix)
            ? ["image/jpeg", "image/png", "image/webp", "image/gif"]
            : ["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg"],
          maximumSizeInBytes: IMAGE_PREFIXES.has(prefix) ? 10 * 1024 * 1024 : 15 * 1024 * 1024,
        };
      },
      // No onUploadCompleted DB write here: the app already follows an
      // "upload, get the URL back, then write the DB row myself" pattern
      // for every caller (see updateProfilePhoto, updateLeaguePhoto,
      // postComment, etc. in src/App.jsx and saveProduct in src/Shop.jsx).
      // Keeping that pattern means this route doesn't need to know which
      // table/column a given upload belongs to.
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message || "Upload authorization failed" });
  }
}
