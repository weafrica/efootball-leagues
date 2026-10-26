// Planet Earth — plays the pre-recorded voice lines (made on your own PC with Piper, exactly like the Stories feature).
// Files live in /planetearth-voice/ with a manifest.json. A line with no file simply stays silent: text-only is always a
// complete experience, the voice is an enhancement on top. Played files are kept in the browser's Cache Storage, so a
// line you have heard once also works offline and costs no more data.
export const BASE = '/planetearth-voice/';
const CACHE_NAME = 'planetearth-voice-cache-v1';
let env = {}, manifest = null, loading = null, current = null, muted = false, token = 0;
const get = (k) => (env[k] !== undefined ? env[k] : (typeof globalThis !== 'undefined' ? globalThis[k] : undefined));
export function configureVoice(e) { env = e || {}; manifest = null; loading = null; current = null; }   // (used by the tests)
export function setVoiceMuted(m) { muted = !!m; if (muted) stopVoice(); }
export async function loadManifest() {
  if (manifest) return manifest;
  if (loading) return loading;
  loading = (async () => {
    try { const f = get('fetch'); const r = await f(BASE + 'manifest.json', { cache: 'no-cache' }); if (!r.ok) throw new Error('no manifest'); const j = await r.json(); manifest = j && j.lines ? j : { lines: {} }; }
    catch { manifest = { lines: {} }; }     // not recorded yet (or offline): silent, text-only
    return manifest;
  })();
  return loading;
}
export const hasVoice = (key) => !!(manifest && manifest.lines && manifest.lines[key]);
export const voiceUrl = (key) => { const e = manifest && manifest.lines && manifest.lines[key]; return e ? `${BASE}${key}.${e.ext}${e.h ? '?v=' + e.h : ''}` : null; };
async function cachedUrl(url) {
  const caches = get('caches'), URLo = get('URL'); if (!caches) return url;
  try {
    const cache = await caches.open(CACHE_NAME); let r = await cache.match(url);
    if (!r) { const fresh = await get('fetch')(url); if (!fresh.ok) return url; await cache.put(url, fresh.clone()); r = fresh; }
    return URLo.createObjectURL(await r.blob());
  } catch { return url; }
}
export function stopVoice() { token++; if (current) { const c = current; current = null; try { c.a.onended = null; c.a.onerror = null; c.a.pause(); } catch { /* */ } c.resolve(false); } }
// Plays one line. Resolves with true when it played to the end, false if there was nothing to play (or it was cut off).
export async function playLine(key, volume = 1) {
  stopVoice(); const my = token;
  if (muted) return false;
  await loadManifest(); if (my !== token) return false;
  const url = voiceUrl(key); if (!url) return false;
  const playable = await cachedUrl(url); if (my !== token) return false;
  const A = get('Audio'); if (!A) return false;
  return new Promise((resolve) => {
    const a = new A(playable); a.volume = volume; const me = { a, resolve }; current = me;
    a.onended = () => { if (current === me) current = null; resolve(my === token); };
    a.onerror = () => { if (current === me) current = null; resolve(false); };
    const p = a.play(); if (p && p.catch) p.catch(() => { if (current === me) current = null; resolve(false); });
  });
}
// Warm the cache for lines coming up next, so they start instantly.
export async function preload(keys) { await loadManifest(); for (const k of keys) { const u = voiceUrl(k); const caches = get('caches'); if (!u || !caches) continue; try { const cache = await caches.open(CACHE_NAME); if (!(await cache.match(u))) { const r = await get('fetch')(u); if (r.ok) await cache.put(u, r.clone()); } } catch { /* best effort */ } } }
