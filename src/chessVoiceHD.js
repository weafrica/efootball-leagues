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
  // fall back to a simple "is this a phone" guess: phones get the
  // lighter voice, anything else (desktop, most tablets) gets Kokoro.
  const mem = typeof navigator !== "undefined" ? navigator.deviceMemory : undefined;
  if (typeof mem === "number") return mem >= 4 ? "hd" : "lite";
  const isPhone = typeof navigator !== "undefined" && /Android|iPhone|iPod/i.test(navigator.userAgent);
  return isPhone ? "lite" : "hd";
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
const KOKORO_VOICE = "af_heart";

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
        async speak(text) {
          const raw = await tts.generate(text, { voice: KOKORO_VOICE });
          return raw.toBlob();
        },
      };
    } else {
      const vits = await import("@diffusionstudio/vits-web");
      await vits.download(PIPER_VOICE_ID, (p) => {
        if (p && p.total) onProgress?.(p.loaded / p.total);
      });
      engine = {
        tier,
        async speak(text) {
          return vits.predict({ text, voiceId: PIPER_VOICE_ID });
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
