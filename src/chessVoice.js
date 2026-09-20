// Chess Learning Mode — dramatized, spoken-aloud piece narration.
//
// Matchday already has two read-aloud systems: Stories.jsx plays
// PRE-RECORDED audio files (fixed story text, synthesized offline) —
// that can't work here, since every chess position is different every
// game, there's nothing to pre-record. App.jsx's `commentSpeech` is the
// one that actually fits: live browser speechSynthesis reading whatever
// text you hand it, right now. This file is a self-contained copy of
// that exact pattern (voice loading, the desktop watchdog bug workaround,
// tap-to-stop) rather than an import from App.jsx — App.jsx lazy-loads
// this screen, so importing back from here into App.jsx would fight that
// lazy-loading and risk a circular module graph. Small duplication, same
// precedent Rules.jsx already set by keeping its own independent copy
// too instead of sharing App.jsx's.

import { pickBestVoice } from "./utils/pickBestVoice";
import { isHdVoiceEnabled, loadNeuralVoice, BROWSER_VOICE_PARAMS_BY_PIECE } from "./chessVoiceHD.js";

const isMobileDevice = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

let chessVoicesCache = [];
function refreshChessVoices() {
  if (typeof window !== "undefined" && window.speechSynthesis) chessVoicesCache = window.speechSynthesis.getVoices();
}
if (typeof window !== "undefined" && window.speechSynthesis) {
  refreshChessVoices();
  window.speechSynthesis.addEventListener("voiceschanged", refreshChessVoices);
  let attempts = 0;
  const poll = setInterval(() => {
    attempts += 1;
    refreshChessVoices();
    if (chessVoicesCache.length || attempts > 10) clearInterval(poll);
  }, 300);
}

export const chessSpeech = {
  speakingId: null,
  watchdog: null,
  audioEl: null,
  listeners: new Set(),
  notify() { this.listeners.forEach((fn) => fn(this.speakingId)); },
  clearWatchdog() { if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; } },
  stop() {
    if (this.audioEl) { this.audioEl.pause(); this.audioEl.src = ""; this.audioEl = null; }
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    this.clearWatchdog();
    this.speakingId = null;
    this.notify();
  },
  // Tapping the same square again stops it, same convention as
  // commentSpeech's own speaker-icon toggle.
  async speak(id, text, pieceType) {
    if (this.speakingId === id) { this.stop(); return; }
    this.stop();
    this.speakingId = id;
    this.notify();

    if (isHdVoiceEnabled()) {
      try {
        const voiceEngine = await loadNeuralVoice();
        if (this.speakingId !== id) return; // stopped/superseded while the model was loading
        const { blob, playbackRate } = await voiceEngine.speak(text, pieceType);
        if (this.speakingId !== id) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        // Piper's per-piece "voice" — speed changes pitch too when
        // preservesPitch is off, same trick as a chipmunk/deep-voice
        // filter. Kokoro doesn't need this (playbackRate stays 1) since
        // it already has a real distinct voice per piece.
        audio.preservesPitch = false;
        audio.mozPreservesPitch = false;
        audio.webkitPreservesPitch = false;
        audio.playbackRate = playbackRate || 1;
        this.audioEl = audio;
        audio.onended = () => { URL.revokeObjectURL(url); if (this.speakingId === id) { this.speakingId = null; this.notify(); } };
        audio.onerror = () => { URL.revokeObjectURL(url); if (this.speakingId === id) { this.speakingId = null; this.notify(); } };
        await audio.play();
        return;
      } catch (err) {
        // HD engine failed to load or synthesize (offline, unsupported
        // browser, model download interrupted) — fall through to the
        // free browser voice below rather than staying silent.
        console.warn("Chess HD voice failed, falling back to the built-in voice:", err);
      }
    }

    if (typeof window === "undefined" || !window.speechSynthesis) { this.speakingId = null; this.notify(); return; }
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickBestVoice(chessVoicesCache);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang || "en-US";
    // Same single browser voice for everyone, but pitch/rate is a real,
    // universally-supported property — cheap way to give each piece its
    // own character without needing a second real voice.
    const params = BROWSER_VOICE_PARAMS_BY_PIECE[pieceType] || { pitch: 1, rate: 1.05 };
    utter.pitch = params.pitch;
    utter.rate = params.rate;
    utter.onend = () => { this.speakingId = null; this.clearWatchdog(); this.notify(); };
    utter.onerror = () => { this.speakingId = null; this.clearWatchdog(); this.notify(); };
    window.speechSynthesis.speak(utter);
    if (!isMobileDevice) {
      this.watchdog = setInterval(() => {
        if (!window.speechSynthesis.speaking) { this.clearWatchdog(); return; }
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 5000);
    }
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};

// ---------------------------------------------------------------------
// What each piece "says" about itself — in character, a few variants
// each so tapping the same piece twice doesn't repeat verbatim.
const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

const PIECE_INTRO = {
  p: [
    "A humble pawn — but never underestimate me. One square at a time, and I could become a queen!",
    "Just a foot soldier for now. Push me far enough and I'll be crowned.",
  ],
  n: [
    "The Knight! I leap in an L-shape, clean over anyone standing in my way!",
    "Nobody sees me coming — I'm the only piece that jumps right over the others!",
  ],
  b: [
    "The Bishop glides diagonally, forever — I own this one color of square for the whole game!",
    "Straight diagonal lines, any distance. That's my whole game, and it's a good one!",
  ],
  r: [
    "The Rook! Give me an open file or rank and nothing stands in my way!",
    "Straight lines, full power — horizontal or vertical, as far as I like!",
  ],
  q: [
    "Behold the Queen — rook and bishop combined! I am the single deadliest piece on this board!",
    "Any direction, any distance. When I move, the whole board has to pay attention!",
  ],
  k: [
    "I am the King. Only one square at a time — but if I fall, the whole game is over. Guard me well!",
    "Slow and careful — that's me. Lose me and you lose everything, so keep me safe!",
  ],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// describeAvailableMoves — the "what I can actually do right now" half,
// built fresh from the real legal moves on the board this instant, not
// a canned line. Captures and checks get called out specially since
// they're the dramatic ones.
function describeAvailableMoves(chess, square) {
  const moves = chess.moves({ square, verbose: true });
  if (moves.length === 0) return "But right now, I'm stuck — no legal moves at all.";
  const captures = moves.filter((m) => m.captured);
  const givesCheck = moves.some((m) => m.san.includes("+") || m.san.includes("#"));
  const parts = [];
  if (captures.length > 0) {
    const targets = [...new Set(captures.map((m) => PIECE_NAME[m.captured]))];
    parts.push(`right now I could strike down your ${targets.join(" or your ")}`);
  }
  if (givesCheck) parts.push("one of my moves would put your king in check");
  if (parts.length === 0) {
    parts.push(`I have ${moves.length} legal ${moves.length === 1 ? "move" : "moves"} to choose from`);
  }
  return parts.join(", and ") + "!";
}

// dramatizeSquare — the full spoken line for whatever piece was just
// tapped: in-character intro + what it can genuinely do this instant.
export function dramatizeSquare(chess, square) {
  const piece = chess.get(square);
  if (!piece) return null;
  const intro = pick(PIECE_INTRO[piece.type] || []);
  const moves = describeAvailableMoves(chess, square);
  return `${intro} ${moves}`;
}
