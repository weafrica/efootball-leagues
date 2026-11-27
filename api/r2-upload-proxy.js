// Fallback for api/r2-upload.js. When the browser can't PUT straight to the
// R2 presigned URL (CORS not set on the bucket, a blocking network or
// extension, flaky mobile data: all show up as "Failed to fetch"), the client
// sends the same file here instead, same-origin, and this route puts it into
// R2 server-side. Photos are compressed before upload, so they fit within
// Vercel's ~4.5MB request limit; larger files get a clear error.
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

export const config = { api: { bodyParser: false } };

const ALLOWED_PREFIXES = ["avatars/", "league-photos/", "comment-photos/", "shop-photos/", "comment-voice-notes/", "result-proofs/", "team-sale-photos/"];
const IMAGE_PREFIXES = new Set(["avatars/", "league-photos/", "comment-photos/", "shop-photos/", "result-proofs/", "team-sale-photos/"]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const AUDIO_TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/mpeg"]);
const MAX_BYTES = 4 * 1024 * 1024;

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: "WHEN_REQUIRED",
});

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) { const e = new Error("That photo is too large. Pick a smaller one and try again."); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const url = new URL(req.url, "http://x");
    const pathname = url.searchParams.get("pathname") || "";
    const contentType = url.searchParams.get("contentType") || "";
    const prefix = ALLOWED_PREFIXES.find((p) => pathname.startsWith(p));
    if (!prefix || pathname.includes("..")) { res.status(400).json({ error: "Upload path not allowed" }); return; }
    if (!(IMAGE_PREFIXES.has(prefix) ? IMAGE_TYPES : AUDIO_TYPES).has(contentType)) { res.status(400).json({ error: "Content type not allowed for this upload" }); return; }
    if (!process.env.R2_PUBLIC_BASE_URL) { res.status(500).json({ error: "R2_PUBLIC_BASE_URL is not set" }); return; }
    const body = await readBody(req);
    if (!body.length) { res.status(400).json({ error: "Empty file" }); return; }
    await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: pathname, ContentType: contentType, Body: body }));
    res.status(200).json({ publicUrl: `${process.env.R2_PUBLIC_BASE_URL}/${pathname}` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Upload failed" });
  }
}
