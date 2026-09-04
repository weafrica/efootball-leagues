// Minimal service worker — its main job is just to exist, since Chrome/
// Android requires a registered service worker before it will offer the
// "Install app" prompt. Deliberately network-first with no long-lived
// precached app shell: this is a fast-moving SPA (new Vercel deploys
// often), so aggressively caching JS/CSS bundles risks stranding users on
// a stale build. All it caches is the bare shell needed to avoid a blank
// white screen on the rare case of opening the installed app with zero
// connectivity.
const CACHE_NAME = "matchday-shell-v1";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/splash.jpg"];

// Rapid Cup league-start alarm — locally-shown notifications only (no
// push subscription, no server; that's the "Option 2" build). The page
// itself calls registration.showNotification() while it's still open
// (even backgrounded) the moment a lobby it's tracking starts ringing;
// this listener just handles what happens when the person taps the
// notification or one of its action buttons, since that has to happen
// here in the service worker, not in the page.
// Rapid Cup Push Alarm — Step 2: browsers occasionally rotate a
// subscription's endpoint on their own (expiry, key rotation, etc.). This
// service worker has no Supabase session to save the new one with directly
// — it re-subscribes here, then hands the result to whichever tab is open
// to actually persist it (src/rapidCupPush.js's listenForPushResubscribe).
// If no tab happens to be open when this fires, the new subscription is
// lost until the next time one opens and this fires again naturally on a
// future rotation — acceptable given how rarely this event occurs.
self.addEventListener("pushsubscriptionchange", (event) => {
  const oldEndpoint = event.oldSubscription?.endpoint || null;
  const applicationServerKey = event.oldSubscription?.options?.applicationServerKey;

  event.waitUntil(
    self.registration.pushManager
      .subscribe(applicationServerKey ? { userVisibleOnly: true, applicationServerKey } : { userVisibleOnly: true })
      .then((newSub) =>
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
          for (const client of clients) {
            client.postMessage({
              type: "rapid-cup-push-resubscribed",
              subscription: newSub.toJSON(),
              oldEndpoint,
            });
          }
        })
      )
      .catch(() => {})
  );
});

// Rapid Cup Push Alarm — Step 5: handles an actual server-sent push
// arriving while nothing else may be running. send-rapid-cup-push (Step 3)
// sends { title, body, data: { lobbyId } } — same shape the already-shipped
// local notification uses (RapidCupEpicExtras.jsx showLeagueStartNotification),
// same `tag`/`actions`/`requireInteraction`, so a push and a local
// notification for the same lobby collapse into one instead of stacking,
// and the existing notificationclick handler below already handles taps
// on either kind with no changes needed.
const PUSH_NOTIFICATION_ACTIONS = [
  { action: "enter", title: "Enter Rapid Cup" },
  { action: "stop", title: "Stop alarm" },
];

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Not JSON (shouldn't happen — send-rapid-cup-push and send-match-push
    // always send JSON) — fall back to a bare notification rather than
    // dropping the push silently.
  }

  // "Next match set" — League Ladder, regular leagues, and random matches
  // (send-match-push). Deliberately the opposite of the Rapid Cup alarm
  // below: one quiet ping, no sound, nothing requiring interaction, no
  // Stop/Enter actions. send-match-push always stamps this kind itself
  // (see that function's header) so a caller can never fall through to the
  // alarm shape by omitting it.
  if (payload.data?.kind === "next_match") {
    const title = payload.title || "⚡ Next match set";
    const body = payload.body || "Your next match is ready.";
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        silent: true,
        requireInteraction: false,
        data: payload.data,
      })
    );
    return;
  }

  const title = payload.title || "⚡ Rapid Cup";
  const body = payload.body || "Your league has started — tap to enter!";
  const lobbyId = payload.data?.lobbyId ?? null;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: lobbyId ? `rapid-cup-alarm-${lobbyId}` : "rapid-cup-alarm",
      requireInteraction: true,
      actions: PUSH_NOTIFICATION_ACTIONS,
      data: { lobbyId },
    })
  );
});

// Rapid Cup Push Alarm — Step 6 (see RAPID-CUP-PUSH-ALARM-BUILD-PLAN.md,
// Section 8). Same DB/store/key as src/rapidCupAlarmSync.js's page-side
// half — a service worker can't import that ES module directly (this file
// is served as-is from /public, not bundled by Vite), so the read side is
// duplicated here, minimally, just enough to read what that module wrote.
const ALARM_SYNC_DB_NAME = "rapid-cup-alarm-sync";
const ALARM_SYNC_STORE_NAME = "credentials";
const ALARM_SYNC_KEY = "current";

// Public by design (same values already committed in .env.example) — the
// anon key can't do anything on its own; every write it makes is still
// gated by RLS and by the caller's own access token in the Authorization
// header below.
const SUPABASE_URL = "https://jobgzxljuczzqljwavyq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_rDBySczYcgWx7TT9NbNNLg_jdWRctAZ";

function readAlarmSyncCredentials() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(ALARM_SYNC_DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(ALARM_SYNC_STORE_NAME); };
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction(ALARM_SYNC_STORE_NAME, "readonly");
          const getReq = tx.objectStore(ALARM_SYNC_STORE_NAME).get(ALARM_SYNC_KEY);
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// The actual zero-open-tab case Step 6 exists for: a player has the app
// ringing on a laptop tab, gets the push on their phone with the app fully
// closed there, and taps "Stop" on the phone notification. There's no open
// tab on the phone to postMessage, so this calls stop_rapid_cup_alarm
// directly — same RPC the page-side stopAlarm() calls, using the access
// token saved by saveAlarmSyncCredentials right as the alarm started
// ringing. The laptop tab picks up the resulting row change over Realtime
// (RapidCupEpicExtras.jsx's useLeagueStartAlarm) and stops itself too.
async function stopAlarmDirectly(lobbyId) {
  const creds = await readAlarmSyncCredentials();
  if (!creds || !creds.accessToken || creds.lobbyId !== lobbyId) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/stop_rapid_cup_alarm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify({ p_lobby_id: lobbyId }),
    });
  } catch {
    // Nothing to fall back to from inside the service worker — worst case
    // this device's own notification is already closed (below) even though
    // the DB write didn't go through, and the player can still stop it from
    // whichever tab they open next.
  }
}

self.addEventListener("notificationclick", (event) => {
  if (event.notification?.data?.kind === "next_match") {
    event.notification.close();
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        if (clients.length) return clients[0].focus();
        return self.clients.openWindow("/");
      })
    );
    return;
  }

  const action = event.action || "enter"; // tapping the body (no action) behaves like "enter"
  const lobbyId = event.notification?.data?.lobbyId ?? null;
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: "rapid-cup-alarm-action", action, lobbyId });
      }
      if (clients.length) {
        // An open tab got the postMessage above and will stop itself (and
        // write the DB row) on its own — bring it to the front rather than
        // opening a new one, same "don't fragment the session" spirit as
        // the rest of this app.
        return clients[0].focus();
      }
      if (action === "stop") {
        // No open tab to relay through — write the stop straight to the
        // database ourselves instead of opening the app just to silence a
        // sound (that would defeat the point of a one-tap Stop).
        return stopAlarmDirectly(lobbyId);
      }
      return self.clients.openWindow("/");
    })
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only handle same-origin GET navigations/assets — never intercept
  // Supabase/API/Vercel Blob calls, which must always hit the network live.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
  );
});
