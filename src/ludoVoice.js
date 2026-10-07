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

// ---- what makes browser voices sound robotic, and what we do about it ------
// 1. Emoji. "💥 Red captured Green!" gets read as "collision symbol Red..."
//    — strip them (and other symbols) before speaking.
// 2. Extreme pitch. The old chipmunk/growl settings (pitch 0.85 - 1.3) are
//    the biggest giveaway. Now only a gentle nudge per colour.
// 3. Same voice for everyone, same rate every time. Each colour now gets its
//    own natural-sounding voice where the device has several, and every line
//    gets a tiny random pitch/rate wobble, like a person would.
// 4. Flat delivery. Lines ending in "!" are said a touch higher and quicker.
export function speakable(text) {
  return String(text || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([!?.,])/g, "$1")
    .trim();
}

const NATURAL_HINTS = [/natural/i, /neural/i, /online/i, /premium/i, /enhanced/i, /google/i];
const KNOWN_GOOD = /samantha|ava\b|allison|susan|zoe|nicky|jenny|aria|guy|davis|jane|tony|sara|libby|ryan|sonia|daniel|karen|moira|serena/i;

function naturalEnglishVoices(voices) {
  const en = (voices || []).filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
  const score = (v) => {
    let sc = 0;
    NATURAL_HINTS.forEach((re, i) => { if (re.test(v.name)) sc += 10 - i; });
    if (KNOWN_GOOD.test(v.name)) sc += 3;
    if (/^en[-_]us/i.test(v.lang)) sc += 2;
    if (/compact|espeak|robot|fred|zarvox|trinoids|whisper|bad news|bubbles/i.test(v.name)) sc -= 20;
    return sc;
  };
  return en.map((v) => ({ v, sc: score(v) })).sort((a, b) => b.sc - a.sc).map((x) => x.v);
}

const COLOR_SLOT = { red: 0, green: 1, yellow: 2, blue: 3 };
function voiceForColor(color) {
  const ranked = naturalEnglishVoices(ludoVoicesCache);
  if (!ranked.length) return pickBestVoice(ludoVoicesCache);
  // Only rotate between voices that are actually good; if the device has a
  // single natural voice, everyone shares it (and pitch does the rest).
  const top = ranked[0] ? ranked.filter((v) => NATURAL_HINTS.some((re) => re.test(v.name)) || KNOWN_GOOD.test(v.name)) : [];
  const pool = top.length ? top.slice(0, 4) : ranked.slice(0, 1);
  return pool[(COLOR_SLOT[color] ?? 0) % pool.length];
}

// Gentle per-colour character (no more chipmunk / monster voices).
export const LUDO_VOICE_PARAMS = {
  red: { pitch: 0.96, rate: 1.08 },    // hot-headed, quick
  green: { pitch: 1.02, rate: 0.98 },  // sly, unhurried
  yellow: { pitch: 1.1, rate: 1.1 },   // chaotic, bubbly
  blue: { pitch: 1.0, rate: 1.02 },    // calm, calculating
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
    const clean = speakable(text);
    if (!clean) { this.advance(); return; }
    const utter = new SpeechSynthesisUtterance(clean);
    const voice = voiceForColor(color);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang || "en-US";
    const params = LUDO_VOICE_PARAMS[color] || { pitch: 1, rate: 1.05 };
    const wobble = () => (Math.random() - 0.5) * 0.04;
    const excited = /!\s*$/.test(clean);
    utter.pitch = Math.min(1.25, Math.max(0.8, params.pitch + wobble() + (excited ? 0.025 : 0)));
    utter.rate = Math.min(1.22, Math.max(0.9, params.rate + wobble() + (excited ? 0.02 : 0)));
    utter.volume = 1;
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
    // A short natural gap before the next line — zero pause between
    // back-to-back utterances is what makes a queue of short lines sound
    // like a teleprompter rather than someone actually talking.
    setTimeout(() => this.speakNow(next.id, next.text, next.color), 180);
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
    // Short lines + fast turns can pile up; drop the oldest waiting lines so
    // the voice never falls far behind the game.
    while (this.queue.length > 2) this.queue.shift();
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
