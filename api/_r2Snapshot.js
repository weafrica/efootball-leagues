// Postgres egress fix (postgres-egress-fix-plan.md Step 6) — a small,
// shared read/write helper so the cached endpoints (guest-data.js,
// ladder-league-results.js, kit-room-listings.js) can fall through to a
// snapshot on Cloudflare R2 before ever reaching Postgres, on top of
// Vercel's own CDN caching.
//
// Why this exists on top of the CDN cache those files already have:
// Vercel's Cache-Control headers handle the common case (repeat requests
// for the same URL within the TTL window), but a low-traffic route's cache
// entry can still get evicted early, or a fresh serverless region/edge
// node can get a cold cache — either way, that specific request would
// otherwise go straight to Postgres. Checking R2 first catches exactly
// that gap: if a fresh-enough snapshot is sitting there, this skips
// Postgres entirely and serves that instead.
//
// Deliberately built as plain S3 SDK calls against the SAME R2 bucket and
// credentials api/r2-upload.js already uses (R2_ACCOUNT_ID/
// R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME) — no new
// credentials to provision. Snapshots live under their own "_cache-
// snapshots/" prefix, kept separate from every user-upload prefix
// (avatars/, shop-photos/, etc.) in that same file's ALLOWED_PREFIXES —
// this module talks to R2 directly via the SDK, not through that
// presigned-upload flow, so those prefixes don't apply here, but a
// distinct prefix keeps the bucket's contents easy to reason about.
//
// Each snapshot is a plain JSON object wrapping { savedAt, data } —
// savedAt is checked against the caller's own maxAgeMs on read, so
// freshness is self-contained in the object rather than relying on
// parsing R2's LastModified metadata.
//
// Every function here is best-effort and NEVER throws: a caller's own
// Postgres fetch is always the real source of truth, and a failure
// reading or writing this fallback layer should never turn into a
// user-facing error, only a slightly less warm cache.
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const SNAPSHOT_PREFIX = "_cache-snapshots/";

function makeClient() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // Same reasoning as api/r2-upload.js's identical setting — harmless
    // here (this module never uses presigned URLs, only direct SDK calls),
    // kept for consistency with the rest of this project's R2 config.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

async function streamToString(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

// Returns the snapshot's `data` if one exists under `key` and is younger
// than maxAgeMs, otherwise null (missing key, stale, or any failure —
// all treated the same by the caller: fall through to Postgres).
export async function readR2Snapshot(key, maxAgeMs) {
  const bucketName = process.env.R2_BUCKET_NAME;
  const client = makeClient();
  if (!client || !bucketName) return null;

  try {
    const result = await client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: `${SNAPSHOT_PREFIX}${key}.json`,
    }));
    const text = await streamToString(result.Body);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > maxAgeMs) return null; // stale
    return parsed.data;
  } catch {
    // Expected on first-ever call (NoSuchKey) and on any transient R2
    // issue — either way, the caller just falls through to Postgres.
    return null;
  }
}

// Fire-and-forget from the caller's point of view, but awaited internally
// so a Vercel function doesn't get frozen/terminated mid-write right after
// sending its response — see each caller's usage for why this is awaited
// there before the response is sent, not left dangling.
export async function writeR2Snapshot(key, data) {
  const bucketName = process.env.R2_BUCKET_NAME;
  const client = makeClient();
  if (!client || !bucketName) return;

  try {
    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: `${SNAPSHOT_PREFIX}${key}.json`,
      Body: JSON.stringify({ savedAt: Date.now(), data }),
      ContentType: "application/json",
    }));
  } catch {
    // Never let a failed write-through affect the response the caller
    // already has ready to send — this is pure insurance, not the
    // source of truth.
  }
}
