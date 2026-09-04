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

self.addEventListener("notificationclick", (event) => {
  const action = event.action || "enter"; // tapping the body (no action) behaves like "enter"
  const lobbyId = event.notification?.data?.lobbyId ?? null;
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        client.postMessage({ type: "rapid-cup-alarm-action", action, lobbyId });
      }
      // Bring an existing tab to the front rather than opening a new one,
      // same "don't fragment the session" spirit as the rest of this app.
      if (clients.length) return clients[0].focus();
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
