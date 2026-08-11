# Moving public media off Supabase Storage, onto Vercel Blob

## Why

Supabase's Free plan caps **Cached Egress** (Storage bandwidth) at 5GB/month.
The org has been going over that (grace period ends **03 Sep 2026**, then
Fair Use restrictions apply — storage requests start returning 402s).

The interim fix (`api/image.js`, still in this repo) proxies public images
through Vercel's edge cache, which helps but doesn't remove Supabase from
the path. This migration moves the five **public** buckets to Vercel Blob
outright — Blob's Hobby plan includes 100GB/month data transfer and 5GB
storage, and this app's actual usage (~13.6GB/month projected, ~51MB total
storage) sits comfortably inside that.

**Only public buckets move.** `result-proofs` and `payment-proofs` stay on
Supabase — they're access-controlled via short-lived signed URLs, low
traffic, and not what's driving the overage.

| Bucket | Was | Now |
|---|---|---|
| `avatars` | Supabase Storage | Vercel Blob |
| `league-photos` | Supabase Storage | Vercel Blob |
| `comment-photos` | Supabase Storage | Vercel Blob |
| `shop-photos` | Supabase Storage | Vercel Blob |
| `comment-voice-notes` | Supabase Storage | Vercel Blob |
| `result-proofs` | Supabase Storage | **unchanged** |
| `payment-proofs` | Supabase Storage | **unchanged** |

## What changed in the code

- **`api/blob-upload.js`** (new) — server route that authorizes direct
  browser-to-Blob uploads. Never touches file bytes; just hands out a
  short-lived token, same "no serverless middleman" property the old
  direct-to-Supabase uploads had.
- **`src/utils/blobUpload.js`** (new) — `uploadToBlob(bucket, path, file)`,
  the drop-in replacement for `supabase.storage.from(bucket).upload(...)`.
  Returns a permanent Blob CDN URL directly — no proxy needed.
- **`src/App.jsx`, `src/Shop.jsx`** — every upload call site for the 5
  public buckets (profile photo, league photo, comment photo, shop product
  photo, voice notes) now calls `uploadToBlob` instead of Supabase Storage.
  The private buckets (`result-proofs`, `payment-proofs`) are untouched.
- **`src/utils/mediaUrl.js`** — `proxiedMediaUrl` (the upload-time helper)
  is gone, since Blob URLs don't need proxying. `toProxiedUrl` (the
  rendering-time helper) and `proxiedSignedUrl` stay, so any row still
  holding an old Supabase URL keeps rendering correctly (edge-cached via
  `api/image.js`) until the backfill below runs.
- **`scripts/backfill-to-blob.mjs`** (new) — one-time script to migrate
  existing files and rewrite the DB rows that point at them. Not run
  automatically; see below.

## Setup

1. **Create a Blob store**: Vercel dashboard → your project → Storage →
   Create Database → Blob. Connect it to this project (Production,
   Preview, and Development environments).
2. This automatically sets `BLOB_READ_WRITE_TOKEN` in your Vercel project's
   env vars — nothing to copy by hand for the deployed app.
3. `npm install` (pulls in the new `@vercel/blob` dependency).
4. Deploy. New uploads for the 5 public buckets now go straight to Blob.

At this point the app is fully working: new uploads use Blob, old rows
still render fine via the existing proxy. The backfill is what actually
brings Cached Egress down, since old rows keep hitting Supabase until then.

## Running the backfill

This rewrites existing files + DB rows, so run it once, deliberately, not
as part of a normal deploy.

```bash
export VITE_SUPABASE_URL=...              # same value as in Vercel
export SUPABASE_SERVICE_ROLE_KEY=...      # Supabase dashboard → Settings → API
                                           # (NOT the anon key — needed to list/
                                           # read storage objects RLS would block)
export BLOB_READ_WRITE_TOKEN=...          # Vercel dashboard → Storage → your
                                           # Blob store → .env.local tab

node scripts/backfill-to-blob.mjs --dry-run   # review what it would do
node scripts/backfill-to-blob.mjs             # then run for real
```

It's safe to re-run — already-migrated rows (URL contains
`blob.vercel-storage.com`) are left alone, so an interrupted run can just
be restarted.

**Do not** commit these env vars anywhere. Run this from your own machine,
not as a Vercel Function (it needs the service role key, which must never
ship to a client-reachable environment).

## After the backfill

- Confirm in Supabase's dashboard that Cached Egress trends down over the
  following days.
- Once you're confident nothing is still resolving to the old buckets, you
  can optionally empty the 5 migrated Supabase buckets to reclaim Storage
  Size quota too (not urgent — Storage Size was only at 8% of quota).
- `api/image.js`, `api/private-image.js`, and `toProxiedUrl` /
  `proxiedSignedUrl` in `mediaUrl.js` can stay indefinitely — `api/image.js`
  is a harmless no-op once no row points at a direct Supabase public URL
  anymore, and `private-image.js` / `proxiedSignedUrl` are still actively
  used for the two private buckets, which were never part of this move.

## Verify

- Vercel dashboard → your project → Observability → Blob, after a few
  days of real traffic, to confirm usage matches the ~14GB/month estimate.
- Supabase dashboard → Usage → Cached Egress, to confirm it's dropping
  back under the 5GB cap.
