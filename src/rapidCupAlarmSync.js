import { supabase } from "./supabaseClient";

// Rapid Cup Push Alarm — Step 6 (see RAPID-CUP-PUSH-ALARM-BUILD-PLAN.md,
// Section 8). sw.js has no Supabase session of its own, and localStorage/
// sessionStorage (where the app's session normally lives) aren't reachable
// from a service worker at all — only IndexedDB is shared between the two.
// This module is the bridge: the page writes its current lobby + access
// token here right as the alarm starts ringing, so that if the player taps
// "Stop" on the phone notification with ZERO tabs open, sw.js can still
// read these back and make an authenticated call to the right stop-alarm
// RPC itself (see the write-through logic in sw.js's notificationclick
// handler) — not just postMessage a tab that might not exist.
//
// GENERALIZED for Rapid League reuse: also stores which RPC name to call
// (stopRpc), since Rapid Cup and Rapid League each stop their own alarm
// through a different function on a different table. Defaults to Rapid
// Cup's own RPC so a caller that omits it needs no changes.
//
// This file was accidentally reverted back to Rapid-Cup-only at some
// point — see RapidCupEpicExtras.jsx's own comment on that same
// regression for the full explanation of what broke because of it.

const DB_NAME = "rapid-cup-alarm-sync";
const STORE_NAME = "credentials";
const KEY = "current";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Called right before showLeagueStartNotification (RapidCupEpicExtras.jsx)
// so the credentials sw.js might need are as fresh as possible at the
// moment a notification could actually be tapped. Best-effort — IndexedDB
// being unavailable (rare, e.g. some private-browsing modes) must never
// block the alarm itself from ringing.
export async function saveAlarmSyncCredentials(lobbyId, stopRpc = "stop_rapid_cup_alarm") {
  if (typeof indexedDB === "undefined" || lobbyId == null) return;
  try {
    const { data: { session } = {} } = await supabase.auth.getSession();
    const accessToken = session?.access_token;
    const userId = session?.user?.id;
    if (!accessToken || !userId) return;

    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ lobbyId, userId, accessToken, stopRpc }, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Same "purely additive" reasoning as the rest of the alarm feature —
    // worst case, a zero-tab Stop tap falls back to opening the app instead.
  }
}

// Clears the stored credentials once this device's own alarm has actually
// stopped ringing — a stale access token sitting in IndexedDB indefinitely
// isn't useful for anything and there's no reason to keep it past the
// moment it might be needed.
export async function clearAlarmSyncCredentials() {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Nothing to fall back to — same as elsewhere in this file.
  }
}
