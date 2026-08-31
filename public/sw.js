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
