// Ludo — read-aloud for the battle log (bot banter and player comments).
//
// Same reasoning chessVoice.js already documented for itself: App.jsx's
// `commentSpeech` is the real, shared, live-speechSynthesis read-aloud
// pattern used everywhere else in this app (league comments, notifications).
// But App.jsx lazy-loads this screen the same way it lazy-loads Chess, so
// importing back from here into App.jsx risks the same circular-module
// problem chessVoice.js called out — hence this is a self-contained copy of
// that exact pattern, not an import. Deliberately left out: chessVoiceHD's
// downloadable neural voice engine (Kokoro/Piper, tens of MB) — a nice
// touch for chess's dramatized piece narration, real overkill for reading
// out one-line dice banter in a casual board game. The free browser voice
// this falls back to is the same one chess itself uses 95% of the time.

import { useState, useEffect } from "react";
import { pickBestVoice } from "./utils/pickBestVoice";

const isMobileDevice = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

let ludoVoicesCache = [];
function refreshLudoVoices() {
  if (typeof window !== "undefined" && window.speechSynthesis) ludoVoicesCache = window.speechSynthesis.getVoices();
}
if (typeof window !== "undefined" && window.speechSynthesis) {
  refreshLudoVoices();
  window.speechSynthesis.addEventListener("voiceschanged", refreshLudoVoices);
  let attempts = 0;
  const poll = setInterval(() => {
    attempts += 1;
    refreshLudoVoices();
    if (ludoVoicesCache.length || attempts > 10) clearInterval(poll);
  }, 300);
}

// A little pitch/rate variety per color so four "voices" reading banter
// back to back don't all sound identical — same trick chess uses per
// piece type (BROWSER_VOICE_PARAMS_BY_PIECE), applied to colors instead.
export const LUDO_VOICE_PARAMS = {
  red: { pitch: 0.85, rate: 1.15 },   // hot-headed, quick
  green: { pitch: 1.05, rate: 0.95 }, // sly, unhurried
  yellow: { pitch: 1.3, rate: 1.2 },  // chaotic, hyper
  blue: { pitch: 0.95, rate: 1.0 },   // calm, calculating
};

export const ludoSpeech = {
  speakingId: null,
  watchdog: null,
  listeners: new Set(),
  // Pending {id, text, color} entries waiting their turn — nothing here
  // ever cancels something already playing; it just waits in line. Only
  // an explicit stop (re-tapping the line that's currently speaking, or
  // leaving the page) clears this out.
  queue: [],
  notify() { this.listeners.forEach((fn) => fn(this.speakingId)); },
  clearWatchdog() { if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; } },
  stop() {
    this.queue = [];
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    this.clearWatchdog();
    this.speakingId = null;
    this.notify();
  },
  // Actually speaks one entry. Only ever called when nothing else is
  // currently playing — either the first request in, or the next one in
  // line once the previous utterance's onend fires.
  speakNow(id, text, color) {
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickBestVoice(ludoVoicesCache);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang || "en-US";
    const params = LUDO_VOICE_PARAMS[color] || { pitch: 1, rate: 1.05 };
    utter.pitch = params.pitch;
    utter.rate = params.rate;
    utter.onend = () => this.advance();
    utter.onerror = () => this.advance();
    this.speakingId = id;
    this.notify();
    window.speechSynthesis.speak(utter);
    // Same desktop Chrome/Edge "goes silent after ~15s" workaround chess
    // and Rules both already carry.
    if (!isMobileDevice) {
      this.watchdog = setInterval(() => {
        if (!window.speechSynthesis.speaking) { this.clearWatchdog(); return; }
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 5000);
    }
  },
  // Called when one line finishes (naturally or on error) — clears the
  // watchdog for the line that just ended, then starts the next queued
  // one, if any. This is what makes lines play strictly one at a time
  // even when several get pushed in quick succession (a fast AI turn,
  // someone tapping around the log while a bot's mid-sentence, etc).
  advance() {
    this.clearWatchdog();
    const next = this.queue.shift();
    if (!next) { this.speakingId = null; this.notify(); return; }
    this.speakNow(next.id, next.text, next.color);
  },
  // Tapping the line that's currently playing stops everything (and
  // drops anything still queued) — same convention as commentSpeech's
  // speaker-icon toggle elsewhere in this app. Tapping a line that's
  // waiting in the queue pulls it back out instead of starting it early.
  // Any other tap joins the back of the queue rather than interrupting
  // whatever's already talking.
  speak(id, text, color) {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    if (this.speakingId === id) { this.stop(); return; }
    const queuedIdx = this.queue.findIndex((q) => q.id === id);
    if (queuedIdx !== -1) { this.queue.splice(queuedIdx, 1); this.notify(); return; }
    if (this.speakingId == null) { this.speakNow(id, text, color); return; }
    this.queue.push({ id, text, color });
    this.notify();
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};

// Mirrors App.jsx's useCommentSpeakingId — which log line (if any) is
// currently being read aloud, kept in sync across every speaker-icon tap.
export function useLudoSpeakingId() {
  const [id, setId] = useState(ludoSpeech.speakingId);
  useEffect(() => ludoSpeech.subscribe(setId), []);
  return id;
}
