/* eslint-disable no-restricted-globals */
// Ludo's service worker. NOT served from here: scripts/vite-plugin-ludo-pwa.js
// fills in the two placeholders below at build time and emits the result as
// /ludo/sw.js. Scope is /ludo/ only — it never touches Matchday's own worker
// (/sw.js, scope /).
//
// What it does:
//   * Precaches the app shell (HTML + this app's JS/CSS chunks) so Ludo opens
//     and plays with no connection once it's been loaded once.
//   * Navigations: network first, but if the network takes longer than a few
//     seconds (very common on mobile data) it serves the cached shell instead
//     of making the player stare at a spinner.
//   * Hashed /assets/* files: cache first (their names change when content does).
//   * Google Fonts: stale-while-revalidate, so the right fonts survive offline.
//   * Deliberately NOT handled: Supabase / any cross-origin API (always live),
//     /api/*, and /ludo-audio/* (the page's own audio loader caches those —
//     letting both cache them would just store the same files twice).

const VERSION = "__LUDO_VERSION__";
const PRECACHE = __LUDO_PRECACHE__;

const SHELL_PREFIX = "ludo-shell-";
const SHELL_CACHE = SHELL_PREFIX + VERSION;
const RUNTIME_CACHE = "ludo-runtime-v1";
const FONT_CACHE = "ludo-fonts-v1";
const META_KEY = "/__ludo-meta";
const SHELL_URL = "/ludo/";
const NAV_TIMEOUT_MS = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One at a time, each allowed to fail: a single flaky file must not abort
    // the whole install and leave the player with no offline support at all.
    await Promise.all(PRECACHE.map(async (url) => {
      try { await cache.add(new Request(url, { cache: "reload" })); } catch (e) { /* skip this one */ }
    }));
    await cache.put(META_KEY, new Response(String(Date.now())));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only ever touch Ludo's own shell caches — never another feature's
    // (stories audio, Matchday's shell, ...). Keep the newest OLD shell as
    // well as the current one: someone with Ludo open during a deploy still
    // has the previous build's chunks to lazy-load, and those files are gone
    // from the server by then.
    const olds = [];
    for (const k of keys) {
      if (!k.startsWith(SHELL_PREFIX) || k === SHELL_CACHE) continue;
      let stamp = 0;
      try {
        const hit = await (await caches.open(k)).match(META_KEY);
        stamp = hit ? Number(await hit.text()) || 0 : 0;
      } catch (e) { /* treat as oldest */ }
      olds.push({ k, stamp });
    }
    olds.sort((a, b) => b.stamp - a.stamp);
    await Promise.all(olds.slice(1).map((o) => caches.delete(o.k)));
    await self.clients.claim();
  })());
});

function cacheable(response, request) {
  if (!response || !response.ok) return false;
  // A missing hashed file can come back as index.html with a 200 (SPA
  // rewrite). Never store that as if it were a script or stylesheet.
  const type = response.headers.get("content-type") || "";
  if ((request.destination === "script" || request.destination === "style") && /text\/html/i.test(type)) return false;
  return true;
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res, request)) {
    const copy = res.clone();
    caches.open(RUNTIME_CACHE).then((c) => c.put(request, copy)).catch(() => {});
  }
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request).then((res) => {
    // fonts come back opaque (status 0) from another origin — that's fine to keep
    if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

function navigate(request) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; resolve(res); } };
    const cachedShell = () => caches.match(SHELL_URL, { ignoreSearch: true });

    const timer = setTimeout(async () => {
      const c = await cachedShell();
      if (c) done(c); // slow network + we have the shell: don't make them wait
    }, NAV_TIMEOUT_MS);

    fetch(request).then(async (res) => {
      clearTimeout(timer);
      done(res);
      // keep the cached shell fresh whenever the network does answer
      try {
        if (res.ok && new URL(request.url).pathname === SHELL_URL) {
          (await caches.open(SHELL_CACHE)).put(SHELL_URL, res.clone());
        }
      } catch (e) { /* best effort */ }
    }).catch(async () => {
      clearTimeout(timer);
      done((await cachedShell()) || Response.error());
    });
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
    return;
  }
  if (url.origin !== self.location.origin) return; // Supabase etc. — always live

  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/ludo-audio/")) return;

  if (request.mode === "navigate") {
    if (p === "/ludo" || p.startsWith("/ludo/")) event.respondWith(navigate(request));
    return; // never answer a navigation outside our own scope
  }
  if (p.startsWith("/assets/")) { event.respondWith(cacheFirst(request)); return; }
  if (p.startsWith("/ludo/")) { event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE)); return; }
});
