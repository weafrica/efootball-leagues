#!/usr/bin/env node
// One-time migration: copies every file in the app's 5 PUBLIC Supabase
// Storage buckets into Vercel Blob, then rewrites every DB row that
// pointed at the old file to point at the new Blob URL instead.
//
// This is what actually stops Cached Egress from creeping back up — the
// app-code changes (see api/blob-upload.js, src/utils/blobUpload.js) only
// cover uploads made AFTER this migration ships. Every row already in the
// database still points straight at Supabase (or at the interim
// /api/image proxy) until this script runs.
//
// Private buckets (result-proofs, payment-proofs) are intentionally NOT
// touched — they're low-traffic, access-controlled via short-lived signed
// URLs, and aren't what's driving the egress overage. See MIGRATION.md.
//
// USAGE
//   1. npm install
//   2. Set these env vars (locally, e.g. in .env.backfill — do NOT commit it):
//        VITE_SUPABASE_URL              (same value as in Vercel)
//        SUPABASE_SERVICE_ROLE_KEY      (Supabase dashboard → Settings → API
//                                         — NOT the anon key; needed to list
//                                         and read storage objects that RLS
//                                         would otherwise block)
//        BLOB_READ_WRITE_TOKEN          (Vercel dashboard → Storage → your
//                                         Blob store → .env.local tab)
//   3. Dry run first:      node scripts/backfill-to-blob.mjs --dry-run
//   4. Then for real:      node scripts/backfill-to-blob.mjs
//
// The script is safe to re-run: it skips any DB row whose URL already
// points at Blob (blob.vercel-storage.com), so an interrupted run can
// just be started again.

import { createClient } from "@supabase/supabase-js";
import { put } from "@vercel/blob";

const DRY_RUN = process.argv.includes("--dry-run");

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !BLOB_TOKEN) {
  console.error(
    "Missing env vars. Need VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and BLOB_READ_WRITE_TOKEN."
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Each entry describes one public bucket: which DB table/column(s) hold a
// URL pointing at files in that bucket, and how to find the matching row(s)
// for a given storage path once the file's been copied to Blob.
//
// `urlColumns` lists every {table, column} pair that can hold a URL for
// this bucket — comment-voice-notes, for example, is written into three
// different comment tables (see src/App.jsx: postBoardComment,
// postLadderComment, postComment).
const BUCKETS = [
  {
    bucket: "avatars",
    urlColumns: [{ table: "profiles", column: "avatar_url" }],
  },
  {
    bucket: "league-photos",
    urlColumns: [{ table: "leagues", column: "photo_url" }],
  },
  {
    bucket: "comment-photos",
    urlColumns: [{ table: "comments", column: "photo_url" }],
  },
  {
    bucket: "shop-photos",
    urlColumns: [{ table: "shop_products", column: "image_url" }],
  },
  {
    bucket: "comment-voice-notes",
    urlColumns: [
      { table: "comments", column: "voice_url" },
      { table: "challenge_board_comments", column: "voice_url" },
      { table: "ladder_comments", column: "voice_url" },
    ],
  },
];

// A stored URL for a given (bucket, path) file can currently be in one of
// three shapes, depending on when it was uploaded:
//   1. Direct Supabase:  `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
//   2. Interim proxy:    `/api/image?bucket=${bucket}&path=${path}`
//   3. Already Blob:     contains "blob.vercel-storage.com" (skip — already done)
function candidateUrls(bucket, path) {
  return [
    `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`,
    `/api/image?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`,
  ];
}

async function listAllFiles(bucket) {
  // Supabase Storage's list() is paginated and only lists one "folder"
  // level at a time; walk it recursively so buckets like comment-photos
  // (paths like `${user_id}/${timestamp}.jpg`) get fully covered.
  const files = [];
  async function walk(prefix) {
    let offset = 0;
    const limit = 1000;
    for (;;) {
      const { data, error } = await supabase.storage.from(bucket).list(prefix, {
        limit,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`list(${bucket}/${prefix}) failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const entry of data) {
        const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.id === null) {
          // No id + no metadata = this entry is a "folder" placeholder.
          await walk(fullPath);
        } else {
          files.push(fullPath);
        }
      }
      if (data.length < limit) break;
      offset += limit;
    }
  }
  await walk("");
  return files;
}

async function migrateFile(bucket, path) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) throw new Error(`download(${bucket}/${path}) failed: ${error.message}`);
  const arrayBuffer = await data.arrayBuffer();

  if (DRY_RUN) {
    return `https://dry-run.example/${bucket}/${path}`;
  }

  const blob = await put(`${bucket}/${path}`, Buffer.from(arrayBuffer), {
    access: "public",
    addRandomSuffix: false,
    contentType: data.type || undefined,
    token: BLOB_TOKEN,
  });
  return blob.url;
}

async function updateReferencingRows(urlColumns, oldUrls, newUrl) {
  let updated = 0;
  for (const { table, column } of urlColumns) {
    for (const oldUrl of oldUrls) {
      if (DRY_RUN) continue;
      const { data, error } = await supabase
        .from(table)
        .update({ [column]: newUrl })
        .eq(column, oldUrl)
        .select("id");
      if (error) throw new Error(`update ${table}.${column} failed: ${error.message}`);
      updated += data?.length || 0;
    }
  }
  return updated;
}

async function main() {
  console.log(DRY_RUN ? "DRY RUN — no files copied, no DB rows changed.\n" : "LIVE RUN.\n");

  let totalFiles = 0;
  let totalRowsUpdated = 0;
  let totalSkipped = 0;

  for (const { bucket, urlColumns } of BUCKETS) {
    console.log(`\n=== ${bucket} ===`);
    const paths = await listAllFiles(bucket);
    console.log(`Found ${paths.length} file(s).`);

    for (const path of paths) {
      const oldUrls = candidateUrls(bucket, path);

      // Skip files nothing in the DB references anymore (deleted rows,
      // orphaned uploads) — cheap to check, saves needless Blob writes.
      let referenced = false;
      for (const { table, column } of urlColumns) {
        for (const oldUrl of oldUrls) {
          const { count, error } = await supabase
            .from(table)
            .select("id", { count: "exact", head: true })
            .eq(column, oldUrl);
          if (error) throw new Error(`check ${table}.${column} failed: ${error.message}`);
          if (count > 0) referenced = true;
        }
      }
      if (!referenced) {
        totalSkipped++;
        continue;
      }

      try {
        const newUrl = await migrateFile(bucket, path);
        const rowsUpdated = await updateReferencingRows(urlColumns, oldUrls, newUrl);
        totalFiles++;
        totalRowsUpdated += rowsUpdated;
        console.log(`  ${path} -> ${newUrl} (${rowsUpdated} row(s))`);
      } catch (err) {
        console.error(`  FAILED ${bucket}/${path}: ${err.message}`);
      }
    }
  }

  console.log(
    `\nDone. ${totalFiles} file(s) migrated, ${totalRowsUpdated} DB row(s) updated, ${totalSkipped} orphaned file(s) skipped.`
  );
  if (DRY_RUN) console.log("Re-run without --dry-run to apply.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
