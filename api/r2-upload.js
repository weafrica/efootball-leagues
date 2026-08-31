// Authorizes direct browser-to-Cloudflare-R2 uploads.
//
// R2 is S3-compatible but has no client-upload helper like @vercel/blob's
// handleUpload — the equivalent here is a short-lived presigned PUT URL,
// minted with the AWS SDK (pointed at R2's S3-compatible endpoint) using
// R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY, which stay server-side. The
// browser then PUTs the file bytes straight to that URL, so — same
// property as the old Blob flow — file bytes never pass through a Vercel
// function.
//
// Pairs with src/utils/r2Upload.js on the client. New uploads only; every
// file already on Vercel Blob keeps being served from there — this route
// doesn't touch those.

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Same bucket-prefix allow-list purpose as blob-upload.js's
// ALLOWED_PREFIXES — every object this route will ever authorize lives
// under one of these folders, so a caller can't mint a token for an
// arbitrary path. Kept as its own list (not shared with blobUpload.js)
// since the two storage backends can diverge over time — e.g. a bucket
// added here doesn't need to ever exist on Blob.
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
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_CONTENT_TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg"]);

// Size isn't enforced server-side here the way blob-upload.js's
// maximumSizeInBytes does — a plain presigned PUT has no built-in size
// cap without POST-policy conditions, which is more setup than this
// warrants right now. Every image call site already runs compressImage
// first, so this stays as a soft/documented limit rather than a hard
// server-side one for now.

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  // Newer @aws-sdk/client-s3 versions (v3.729+) turn on default request
  // checksums, which bakes an x-amz-checksum-crc32 requirement into
  // presigned URLs. R2 honors that in the signature, but a plain
  // browser fetch() PUT never sends that header, so the signature
  // check fails with a 403 (which the browser then also reports as a
  // CORS error, since R2's error response omits CORS headers). Setting
  // this to "WHEN_REQUIRED" restores the old behavior so presigned PUT
  // URLs work with a bare fetch again.
  requestChecksumCalculation: "WHEN_REQUIRED",
});

// Public URL — R2's own free "r2.dev" public-bucket subdomain (no custom
// domain / DNS setup needed). Cloudflare assigns this per-bucket once you
// flip "Allow Access" on for it (Bucket → Settings → Public Access →
// R2.dev subdomain) — it looks like https://pub-xxxxxxxx.r2.dev and isn't
// predictable in advance, so it's read from an env var rather than
// hardcoded. No fallback on purpose: serving a wrong/missing base URL
// would silently produce broken image links, which is worse than this
// route failing loudly if the env var was never set.
const PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const { pathname, contentType } = req.body || {};
    if (!pathname || typeof pathname !== "string") {
      res.status(400).json({ error: "Missing pathname" });
      return;
    }
    const prefix = ALLOWED_PREFIXES.find((p) => pathname.startsWith(p));
    if (!prefix) {
      res.status(400).json({ error: "Upload path not allowed" });
      return;
    }
    const allowedTypes = IMAGE_PREFIXES.has(prefix) ? IMAGE_CONTENT_TYPES : AUDIO_CONTENT_TYPES;
    if (!contentType || !allowedTypes.has(contentType)) {
      res.status(400).json({ error: "Content type not allowed for this upload" });
      return;
    }

    if (!PUBLIC_BASE_URL) {
      res.status(500).json({ error: "R2_PUBLIC_BASE_URL is not set" });
      return;
    }

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: pathname,
      ContentType: contentType,
    });
    // 60s to actually perform the PUT after minting — plenty for a
    // compressed photo/voice clip; the URL is single-use in practice
    // since every pathname is already unique (Date.now()-based).
    const url = await getSignedUrl(r2, command, { expiresIn: 60 });

    res.status(200).json({ url, publicUrl: `${PUBLIC_BASE_URL}/${pathname}` });
  } catch (err) {
    res.status(400).json({ error: err.message || "Upload authorization failed" });
  }
}
