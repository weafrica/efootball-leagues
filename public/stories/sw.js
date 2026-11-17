// Service worker for the standalone Stories app (scope: /stories/).
//
// Registered from src/stories-main.jsx at /stories/sw.js, so its scope is
// /stories/ and it is more specific than the main app's /sw.js — pages
// under /stories/ are controlled by this one, not the Matchday worker
// (whose offline fallback is the league app's shell).
//
// Deliberately network-first with no precached JS/CSS bundles: deploys are
// frequent and a stale cached bundle would strand people on an old build.
// The only thing kept is the bare shell page, so opening the installed app
// with no connectivity shows the Stories loading screen instead of a browser
// error. Supabase/API requests are never cached (they're cross-origin or
// /api/ and fall straight through to the network).
const CACHE_NAME = "stories-app-shell-v1";
const SHELL_URL = "/stories/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME && k.startsWith("stories-app-shell-")).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Only page navigations get the offline fallback; everything else is
  // plain network.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(SHELL_URL).then((r) => r || Response.error()))
    );
  }
});

// Note: downloaded story narration lives in a separate cache managed by
// Stories.jsx. This worker only ever deletes its own "stories-app-shell-*"
// caches (see the activate handler above), so offline narration is untouched.
