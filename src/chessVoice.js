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

let chessVoicesCache = [];
let voiceWaiters = []; // resolved once a real voice list shows up
function refreshChessVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const list = window.speechSynthesis.getVoices();
  if (list.length > 0) {
    chessVoicesCache = list;
    voiceWaiters.forEach((resolve) => resolve());
    voiceWaiters = [];
  }
}
// Some Android browsers silently do nothing (no error, no sound) if
// speak() is called before the voice list has actually loaded — instead
// of guessing timing, we just wait for a real voice list (or give up
// after 1.5s and try anyway) before ever calling speak().
function waitForVoices() {
  if (chessVoicesCache.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    voiceWaiters.push(resolve);
    setTimeout(resolve, 1500);
  });
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
  speakingStartedAt: 0,
  audioEl: null,
  queue: [], // [{id, text, pieceType}] — waits its turn instead of cutting off what's already playing
  listeners: new Set(),
  notify() { this.listeners.forEach((fn) => fn(this.speakingId)); },
  // Full stop — clears anything queued too, not just what's playing right
  // now. Used when leaving the screen, or when the player explicitly
  // taps the same thing again to silence it.
  stop() {
    this.queue = [];
    if (this.audioEl) { this.audioEl.pause(); this.audioEl.src = ""; this.audioEl = null; }
    // Pausing a clip doesn't fire "ended", so without this the pipelined
    // player below would sit waiting on a clip that will never finish.
    if (this._releaseClip) { const r = this._releaseClip; this._releaseClip = null; r(); }
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    this.speakingId = null;
    this.notify();
  },
  // Called when whatever was playing genuinely finished (or failed) —
  // moves on to the next queued line, if any, rather than just going quiet.
  _advance() {
    this.speakingId = null;
    this.notify();
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this._playNow(next.id, next.text, next.pieceType, next.prefetched);
    }
  },
  // Tapping the same thing again stops it outright — a direct request to
  // silence it beats waiting politely. BUT: a single real tap can fire
  // its click handler twice on some mobile browsers (a known ghost-tap
  // quirk), which would otherwise stop a sentence half a second after
  // it started with no second tap actually happening — so a repeat of
  // the same id within 400ms of starting is treated as that same
  // duplicate event and ignored, not as a deliberate stop.
  speak(id, text, pieceType) {
    if (this.speakingId === id) {
      if (Date.now() - this.speakingStartedAt < 400) return; // almost certainly a duplicate event, not a real second tap
      this.stop();
      return;
    }
    if (this.speakingId !== null) {
      // Keep the queue short — a pile of ten-move-old commentary queued
      // up isn't useful, it's just noise arriving late.
      this.queue = [...this.queue.filter((q) => q.id !== id).slice(-2), { id, text, pieceType }];
      if (this._onLastClip) this._prefetchNext();
      return;
    }
    this._playNow(id, text, pieceType);
  },
  async _playNow(id, text, pieceType, prefetched) {
    this.speakingId = id;
    this.speakingStartedAt = Date.now();
    this._onLastClip = false;
    this.notify();

    if (isHdVoiceEnabled()) {
      try {
        const voiceEngine = await loadNeuralVoice();
        if (this.speakingId !== id) return; // stopped/superseded while the model was loading
        // Pipelined, not all-at-once: the old way synthesized the WHOLE
        // line before playing a single word, so the pause before speech
        // started grew with how much there was to say. Now it's split
        // into short sentences — the first one starts playing as soon as
        // IT is ready, and the next sentence is already being generated
        // while the current one plays, so there's (ideally) no gap
        // between them and the wait before the first word is only as
        // long as one short sentence takes, not the whole thing.
        const chunks = splitIntoSpeechChunks(text);
        const result = await this._playChunksPipelined(id, chunks, pieceType, voiceEngine, prefetched);
        if (result.failedAt === undefined) {
          if (result.finished && this.speakingId === id) this._advance();
          return;
        }
        // Part-way failure: speak just the unspoken remainder with the
        // built-in voice below.
        text = chunks.slice(result.failedAt).join(" ");
      } catch (err) {
        // HD engine failed to load or synthesize (offline, unsupported
        // browser, model download interrupted) — fall through to the
        // free browser voice below rather than staying silent.
        console.warn("Chess HD voice failed, falling back to the built-in voice:", err);
      }
    }

    if (typeof window === "undefined" || !window.speechSynthesis) { this._advance(); return; }
    await waitForVoices();
    if (this.speakingId !== id) return; // stopped/superseded while we were waiting on voices
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickBestVoice(chessVoicesCache);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang || "en-US";
    // Same single browser voice for everyone, but pitch/rate is a real,
    // universally-supported property — cheap way to give each piece its
    // own character without needing a second real voice.
    const params = BROWSER_VOICE_PARAMS_BY_PIECE[pieceType] || { pitch: 0.9, rate: 1.0 };
    utter.pitch = params.pitch;
    utter.rate = params.rate;
    let started = false;
    utter.onstart = () => { started = true; };
    utter.onend = () => { if (this.speakingId === id) this._advance(); };
    utter.onerror = (e) => {
      console.warn("Chess voice: speechSynthesis error", e.error);
      if (this.speakingId === id) this._advance();
    };
    window.speechSynthesis.speak(utter);
    // Some browsers (mostly Android WebViews) accept the utterance and
    // then just never speak it, with no onerror — no exception, no
    // sound. If onstart hasn't fired within 2s, treat it as a silent
    // failure so it's visible in the console rather than a mystery.
    setTimeout(() => {
      if (!started && this.speakingId === id) {
        console.warn("Chess voice: speech never started — this browser may not support speechSynthesis reliably.");
        this._advance();
      }
    }, 2000);
    // NOTE: earlier versions of this file paused/resumed speechSynthesis
    // every 5s on desktop to dodge a known Chrome bug where very long
    // utterances (30s+) get cut off. Chess commentary is always a
    // sentence or two — nowhere near long enough to hit that bug — and
    // pause()/resume() is flaky enough across browsers that it looked
    // like a plausible cause of sentences cutting off with nothing
    // tapped, so it's removed rather than guessed at.
  },
  // Starts generating the first sentence of whatever's queued next (once,
  // and only while a line is playing) so there's no dead air between two
  // back-to-back lines — e.g. your move's analysis, then the bot's reply.
  _prefetchNext() {
    const next = this.queue[0];
    if (!next || next.prefetched || !this._engine) return;
    const first = splitIntoSpeechChunks(next.text)[0];
    if (!first) return;
    const promise = this._engine.speak(first, next.pieceType);
    promise.catch(() => {}); // a failure resurfaces when the line actually plays and awaits it
    next.prefetched = { text: first, promise };
  },
  // Plays one synthesized audio clip start to finish; resolves when it
  // ends (or fails — a broken clip shouldn't hang the whole line).
  // Piper's per-piece "voice" is its playbackRate — speed changes pitch
  // too when preservesPitch is off, same chipmunk/deep-voice trick as
  // before. Kokoro leaves it at 1 since it has a real voice per piece.
  _playOneClip(blob, playbackRate) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preservesPitch = false;
      audio.mozPreservesPitch = false;
      audio.webkitPreservesPitch = false;
      audio.playbackRate = playbackRate || 1;
      this.audioEl = audio;
      const done = () => { URL.revokeObjectURL(url); this._releaseClip = null; resolve(); };
      this._releaseClip = done;
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });
  },
  // Synthesize chunk i, start playing it, and kick off chunk i+1's
  // synthesis the moment chunk i's audio exists — NOT after it finishes
  // playing — so the next clip is usually ready (or nearly) by the time
  // the current one ends. Returns true if it played through to the end,
  // false if it was stopped/superseded partway (so the caller doesn't
  // double-advance the queue).
  async _playChunksPipelined(id, chunks, pieceType, voiceEngine, prefetched) {
    if (chunks.length === 0) return { finished: true };
    this._engine = voiceEngine;
    // If this line's first sentence was already generated while the
    // previous line was still playing, use that instead of starting over.
    let pending = (prefetched && prefetched.text === chunks[0])
      ? prefetched.promise
      : voiceEngine.speak(chunks[0], pieceType);
    for (let i = 0; i < chunks.length; i++) {
      if (this.speakingId !== id) return { finished: false };
      let clip;
      try {
        clip = await pending;
      } catch (err) {
        // This chunk failed to generate. Hand back which one, so the
        // caller falls back to the built-in voice for only what hasn't
        // been spoken yet instead of re-reading from the top.
        console.warn("Chess HD voice chunk failed:", err);
        return { finished: false, failedAt: i };
      }
      if (this.speakingId !== id) return { finished: false };
      if (i + 1 < chunks.length) {
        pending = voiceEngine.speak(chunks[i + 1], pieceType);
        pending.catch(() => {}); // the real error is handled when this is awaited next loop
      }
      if (i === chunks.length - 1) {
        // Final clip of this line is about to play — everything else for
        // this line is generated, so the engine is free. Start on the
        // NEXT queued line's first sentence now, so it's ready the
        // moment this clip ends instead of being generated after.
        this._onLastClip = true;
        this._prefetchNext();
      }
      await this._playOneClip(clip.blob, clip.playbackRate);
    }
    return { finished: this.speakingId === id };
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};

// splitIntoSpeechChunks — breaks a line into short sentences so the
// first can start playing before the rest are generated. Fragments too
// short to be worth their own synthesis call (a stray "cp." or "Ouch.")
// get folded onto the previous chunk instead of becoming a near-empty
// clip with its own startup cost.
function splitIntoSpeechChunks(text) {
  if (!text) return [];
  // Deliberately NOT a lookbehind split (/(?<=[.!?])\s+/) — that syntax
  // is a parse-time error on iOS before 16.4, which would stop this
  // whole file (and with it the Chess screen) from loading at all.
  const raw = (text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text]).map((s) => s.trim()).filter(Boolean);
  const chunks = [];
  for (const part of raw) {
    if (chunks.length > 0 && part.length < 12) chunks[chunks.length - 1] += " " + part;
    else chunks.push(part);
  }
  return chunks.length > 0 ? chunks : [text];
}

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
