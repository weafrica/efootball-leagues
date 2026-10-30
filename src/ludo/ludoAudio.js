// Pre-rendered Ludo audio: announcer calls (Piper) + layered sound effects,
// built offline by scripts/ludo-audio/make_ludo_audio.py and shipped as
// small static MP3s in public/ludo-audio/ (~0.6 MB for the whole kit).
//
// Same approach as the Stories narration: the files are fetched once, kept in
// the browser's Cache Storage, and after that play with no network at all.
// Everything here is OPTIONAL — if a file is missing, still loading, or the
// player is on Data Saver, play() just returns false and the caller falls
// back to the original synthesized sound (ludoSound.js). The game never
// depends on these files existing.

// Bump this when the audio is re-rendered, so players' cached copies refresh.
const AUDIO_VERSION = "1";
const CACHE_PREFIX = "ludo-audio-cache-";
const CACHE_NAME = `${CACHE_PREFIX}${AUDIO_VERSION}`;

// Put the files somewhere else (e.g. a Supabase Storage bucket, like story
// audio) by setting VITE_LUDO_AUDIO_BASE; defaults to the app's own /public.
const BASE = ((typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_LUDO_AUDIO_BASE) || "/ludo-audio").replace(/\/$/, "");

export const SAMPLE_NAMES = [
  // sound effects
  "click", "step", "roll", "safe", "whoosh", "exit", "home",
  "capture_1", "capture_2", "capture_3", "imprison", "buyback",
  "ransom_alert", "six_banked", "forfeit", "pass", "win", "crowd",
  // announcer calls
  "say_first_blood", "say_prisoner_taken", "say_double_kill", "say_triple_kill",
  "say_ultra_kill", "say_rampage", "say_killing_spree", "say_dominating",
  "say_unstoppable", "say_godlike", "say_beyond_godlike", "say_ransom_paid",
  "say_six_to_play", "say_forfeit", "say_victory",
];

const buffers = new Map(); // name -> decoded AudioBuffer
let ctx = null;
let master = null;
let loading = null;

// Called by ludoSound.js when it creates the shared AudioContext, so samples
// and synth sounds go through the same master volume.
export function bindContext(c, m) {
  ctx = c;
  master = m;
}

function dataSaverOn() {
  try {
    const c = navigator.connection;
    return !!(c && c.saveData);
  } catch {
    return false;
  }
}

async function fetchBytes(url) {
  const useCache = typeof caches !== "undefined";
  if (useCache) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
      const fresh = await fetch(url);
      if (!fresh.ok) throw new Error("missing");
      // A dev server / SPA rewrite can answer a missing file with index.html
      // and a 200 — never cache that as if it were audio.
      const type = fresh.headers.get("content-type") || "";
      if (!/audio|mpeg|octet-stream/i.test(type)) throw new Error("not audio");
      await cache.put(url, fresh.clone());
      return await fresh.arrayBuffer();
    } catch (e) {
      if (e && (e.message === "missing" || e.message === "not audio")) throw e;
      // Cache Storage itself failed — fall through to a plain fetch.
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("missing");
  return await res.arrayBuffer();
}

function decode(bytes) {
  // Callback form: the promise form isn't available on older iOS Safari.
  return new Promise((resolve, reject) => ctx.decodeAudioData(bytes, resolve, reject));
}

async function dropOldCaches() {
  try {
    if (typeof caches === "undefined") return;
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE_NAME).map((n) => caches.delete(n)));
  } catch {
    // best-effort housekeeping only
  }
}

// Fetches + decodes the whole kit once (idempotent). Safe to call repeatedly;
// call it from a user gesture so the AudioContext is allowed to exist.
export function preload() {
  if (loading) return loading;
  if (!ctx || dataSaverOn()) return Promise.resolve();
  loading = (async () => {
    dropOldCaches();
    await Promise.all(
      SAMPLE_NAMES.map(async (name) => {
        try {
          const bytes = await fetchBytes(`${BASE}/${name}.mp3`);
          buffers.set(name, await decode(bytes));
        } catch {
          // this one sound is just unavailable — its caller falls back
        }
      })
    );
  })();
  return loading;
}

export function has(name) {
  return buffers.has(name);
}

// Plays a sample. Returns true if it actually started, false if the sample
// isn't loaded (caller should then use its synthesized fallback).
//   volume  — linear gain
//   delay   — seconds from now
//   jitter  — random +/- pitch/speed variation, so a sound heard fifty times
//             in a match doesn't sound machine-identical every time
export function play(name, { volume = 1, delay = 0, jitter = 0.035 } = {}) {
  const buf = buffers.get(name);
  if (!buf || !ctx || !master) return false;
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * 2 * jitter;
    const g = ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(master);
    src.start(ctx.currentTime + Math.max(0, delay));
    return true;
  } catch {
    return false;
  }
}
