// Chess Learning Mode — optional HD neural voice, layered on top of the
// free built-in browser voice in chessVoice.js. Two real open-source
// engines, picked automatically by rough device capability:
//   - Kokoro (kokoro-js, Apache-2.0) — best quality, ~86MB voice model.
//   - Piper (@diffusionstudio/vits-web, MIT) — smaller, built for
//     weaker phones, ~20-60MB voice model.
// Both need a shared ONNX runtime underneath (~22MB, real-build-tested —
// see the wasmtest build) on top of whichever voice model, either way.
// NONE of this downloads a single byte until the player explicitly
// turns on "HD Voice" (see ChessGame.jsx) — these are real, meaningful
// downloads on someone's data plan, never automatic, never silent.

const TIER_OVERRIDE_KEY = "chess_voice_tier_override"; // "hd" | "lite" | absent = auto
const HD_ENABLED_KEY = "chess_voice_hd_enabled";

function autoDetectTier() {
  // navigator.deviceMemory (RAM in GB, rounded) is Chrome/Edge/Android
  // only — not available on iOS Safari or Firefox. Where it's missing,
  // assume a capable device (4GB+) and go with the best voice — most
  // phones that don't report this (notably every iPhone) are modern
  // enough to handle it fine.
  const mem = typeof navigator !== "undefined" ? navigator.deviceMemory : undefined;
  if (typeof mem === "number") return mem >= 4 ? "hd" : "lite";
  return "hd";
}

export function getVoiceTier() {
  const forced = typeof localStorage !== "undefined" ? localStorage.getItem(TIER_OVERRIDE_KEY) : null;
  if (forced === "hd" || forced === "lite") return forced;
  return autoDetectTier();
}

// tier: "auto" | "hd" | "lite" — lets a player override the automatic
// pick (e.g. they know their phone handles Kokoro fine despite a low
// deviceMemory reading, or they specifically want the smaller download).
export function setVoiceTierOverride(tier) {
  if (typeof localStorage === "undefined") return;
  if (tier === "auto") localStorage.removeItem(TIER_OVERRIDE_KEY);
  else localStorage.setItem(TIER_OVERRIDE_KEY, tier);
}

export function isHdVoiceEnabled() {
  return typeof localStorage !== "undefined" && localStorage.getItem(HD_ENABLED_KEY) === "1";
}
export function setHdVoiceEnabled(v) {
  if (typeof localStorage === "undefined") return;
  if (v) localStorage.setItem(HD_ENABLED_KEY, "1");
  else localStorage.removeItem(HD_ENABLED_KEY);
}

const PIPER_VOICE_ID = "en_US-hfc_female-medium";
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Kokoro ships 54 real, distinct trained voices — enough to give every
// piece its own actual voice rather than a trick. Picked for a spread of
// character (deep/authoritative for the King, quick for the Knight,
// etc.) while staying in Kokoro's better-graded voices (per the model's
// own voice quality table) rather than its weakest ones.
const KOKORO_VOICE_BY_PIECE = {
  k: "am_michael", // King — steady, authoritative male voice
  q: "af_heart",   // Queen — the model's own best-quality voice, fittingly
  r: "am_fenrir",  // Rook — solid, unmovable
  b: "af_nicole",  // Bishop
  n: "am_puck",    // Knight — quick, playful
  p: "af_bella",   // Pawn — plain, dependable
};

// Piper only has ONE downloaded voice (downloading a separate model per
// piece would multiply the download size six-fold — not worth it), so
// pieces are told apart with pitch/speed instead of a different voice —
// the same cheap trick games have used forever for "character voices"
// out of one recording. Small pieces read faster and higher, big pieces
// slower and deeper.
const PIPER_PLAYBACK_BY_PIECE = {
  p: 1.18, n: 1.08, b: 1.0, r: 0.92, q: 0.97, k: 0.8,
};
// Same idea for the free browser voice (chessVoice.js) — pitch is a real,
// universally-supported SpeechSynthesisUtterance property.
export const BROWSER_VOICE_PARAMS_BY_PIECE = {
  p: { pitch: 1.3, rate: 1.15 },
  n: { pitch: 1.15, rate: 1.08 },
  b: { pitch: 1.05, rate: 1.0 },
  r: { pitch: 0.9, rate: 0.95 },
  q: { pitch: 1.1, rate: 1.0 },
  k: { pitch: 0.72, rate: 0.85 },
};

let engine = null; // { tier, speak(text) -> Promise<Blob> }
let loadPromise = null;

// loadNeuralVoice — downloads (first time only; both libraries cache the
// model themselves after that — Piper via the browser's Origin Private
// File System, Kokoro via its own model cache) and resolves to
// { tier, speak(text) }. onProgress gets a best-effort 0..1 fraction.
export function loadNeuralVoice(onProgress) {
  if (engine) return Promise.resolve(engine);
  if (loadPromise) return loadPromise;

  const tier = getVoiceTier();
  loadPromise = (async () => {
    if (tier === "hd") {
      const { KokoroTTS } = await import("kokoro-js");
      const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: "q8",
        device: "wasm", // works everywhere; webgpu is faster where available but needs fp32 (bigger)
        progress_callback: (p) => {
          if (p && typeof p.progress === "number") onProgress?.(p.progress / 100);
        },
      });
      engine = {
        tier,
        async speak(text, pieceType) {
          const voice = KOKORO_VOICE_BY_PIECE[pieceType] || "af_heart";
          const raw = await tts.generate(text, { voice });
          return { blob: await raw.toBlob(), playbackRate: 1 };
        },
      };
    } else {
      const vits = await import("@diffusionstudio/vits-web");
      await vits.download(PIPER_VOICE_ID, (p) => {
        if (p && p.total) onProgress?.(p.loaded / p.total);
      });
      engine = {
        tier,
        async speak(text, pieceType) {
          const blob = await vits.predict({ text, voiceId: PIPER_VOICE_ID });
          return { blob, playbackRate: PIPER_PLAYBACK_BY_PIECE[pieceType] || 1 };
        },
      };
    }
    return engine;
  })();
  loadPromise.catch(() => { loadPromise = null; }); // let a failed load be retried, not stuck forever
  return loadPromise;
}

export function neuralVoiceReady() { return engine !== null; }
export function currentVoiceTier() { return engine?.tier ?? null; }
