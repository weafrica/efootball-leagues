import React, { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, RotateCcw, Lock, Trophy, Wind, Lightbulb, BookOpen, Star, Volume2, VolumeX, Sparkles, Zap, Loader2 } from "lucide-react";
import PlayerCharacter from "./PlayerCharacter.jsx";
import { pickBestVoice } from "./utils/pickBestVoice";
import { isHdVoiceEnabled, setHdVoiceEnabled, loadNeuralVoice } from "./chessVoiceHD.js";

// Nkhono voices every reading in this game. Kokoro's Queen voice
// (af_heart) is the model's own best-quality voice, and we lean the rate
// slower for a warm, storytelling pace rather than a brisk chess-move
// read - fitting for an elder telling a story, not calling out moves.
const NARRATOR_VOICE_KEY = "q";

// ---------------------------------------------------------------------
// Sound — every effect is synthesized live with the Web Audio API, not a
// sound file. Real Candy Crush audio is copyrighted and can't be used
// here anyway; this keeps the "free and low-data" promise (zero bytes
// downloaded) while still giving matches a satisfying pop/chime/fanfare.
// ---------------------------------------------------------------------
let _audioCtx = null;
function getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!_audioCtx) _audioCtx = new AC();
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  return _audioCtx;
}
function tone(freq, duration, type = "sine", delay = 0, peak = 0.16) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + delay;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}
const SFX = {
  select: () => tone(520, 0.05, "sine", 0, 0.06),
  pop: (comboStep = 0) => tone(700 + comboStep * 90, 0.12, "triangle", 0, 0.14),
  special: () => { tone(660, 0.09, "square", 0, 0.12); tone(990, 0.11, "square", 0.07, 0.12); },
  boom: () => { tone(150, 0.28, "sawtooth", 0, 0.18); tone(1300, 0.16, "sine", 0.05, 0.1); },
  win: () => { tone(523, 0.13, "triangle", 0); tone(659, 0.13, "triangle", 0.13); tone(784, 0.24, "triangle", 0.26); },
  lose: () => { tone(300, 0.2, "sine", 0); tone(220, 0.32, "sine", 0.18); },
  // A page settling into place — swoosh (frequency sweep) plus a soft
  // sparkle chime, for the "recovered page" popup.
  pageFlip: () => {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    const t0 = ctx.currentTime;
    osc.frequency.setValueAtTime(900, t0);
    osc.frequency.exponentialRampToValueAtTime(220, t0 + 0.35);
    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.linearRampToValueAtTime(0.12, t0 + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.42);
    tone(1500, 0.14, "sine", 0.3, 0.09);
    tone(1900, 0.12, "sine", 0.38, 0.06);
  },
};
function loadSoundPref() { try { return localStorage.getItem("sesothoMatch:sound") !== "off"; } catch { return true; } }
function saveSoundPref(on) { try { localStorage.setItem("sesothoMatch:sound", on ? "on" : "off"); } catch { /* fine, just won't persist */ } }

// ---------------------------------------------------------------------
// Read-aloud — free tier is live browser speechSynthesis + the app's
// shared best-voice picker (same one Chess's free tier uses). HD tier is
// Chess's actual neural voice engine (Kokoro/Piper) - a real one-time
// download (20-86MB), so it only ever runs if the player has explicitly
// turned "HD Voice" on (shared setting with Chess: turning it on in
// either game unlocks it in both, and costs nothing twice).
// ---------------------------------------------------------------------
let _wordVoices = [];
function refreshWordVoices() { if (typeof window !== "undefined" && window.speechSynthesis) _wordVoices = window.speechSynthesis.getVoices(); }
if (typeof window !== "undefined" && window.speechSynthesis) {
  refreshWordVoices();
  window.speechSynthesis.addEventListener("voiceschanged", refreshWordVoices);
}
let _hdAudio = null;
const wordSpeech = {
  async speak(text, { onHdProgress } = {}) {
    try { wordSpeech.stop(); } catch { /* never let a stop failure block a new speak */ }
    try {
      if (isHdVoiceEnabled()) {
        try {
          const engine = await loadNeuralVoice(onHdProgress);
          onHdProgress?.(null); // download finished (or was already cached) - hide any progress UI
          const { blob, playbackRate } = await engine.speak(text, NARRATOR_VOICE_KEY);
          const audio = new Audio(URL.createObjectURL(blob));
          audio.playbackRate = playbackRate || 1;
          _hdAudio = audio;
          audio.play();
          return;
        } catch {
          // HD failed to load/generate (offline, unsupported device, a PWA
          // sandbox restricting the download, etc.) - fall through to the
          // always-available free voice below rather than going silent.
          onHdProgress?.(null);
        }
      }
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      const utter = new SpeechSynthesisUtterance(text);
      const voice = pickBestVoice(_wordVoices);
      if (voice) utter.voice = voice;
      utter.lang = voice?.lang || "en-US";
      utter.rate = 0.82;  // slow, storytelling pace
      utter.pitch = 0.9;  // warm and a little lower, not the voice's default brightness
      window.speechSynthesis.speak(utter);
    } catch {
      // Narration is a nice-to-have, never something that should be able
      // to break gameplay - swallow anything unexpected here.
    }
  },
  stop() {
    try { if (_hdAudio) { _hdAudio.pause(); _hdAudio = null; } } catch { /* ignore */ }
    try { if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* ignore */ }
  },
};

// Glow keyframes shared by selected/hint/special tiles - defined once as
// real CSS since inline React styles can't declare @keyframes themselves.
function GameStyles() {
  return (
    <style>{`
      @keyframes candyPulseGlow {
        0%, 100% { filter: drop-shadow(0 0 2px rgba(255,255,255,0.55)); }
        50% { filter: drop-shadow(0 0 10px rgba(255,255,255,0.95)); }
      }
      @keyframes candySelectGlow {
        0%, 100% { filter: drop-shadow(0 0 4px var(--glow, gold)); }
        50% { filter: drop-shadow(0 0 14px var(--glow, gold)); }
      }
      .candy-special { animation: candyPulseGlow 1.1s ease-in-out infinite; }
      .candy-selected { animation: candySelectGlow 0.9s ease-in-out infinite; }
      @keyframes pageSettleIn {
        0% { transform: scale(0.6) rotate(-10deg); opacity: 0; }
        70% { transform: scale(1.04) rotate(1deg); opacity: 1; }
        100% { transform: scale(1) rotate(-1deg); opacity: 1; }
      }
      @keyframes lineRise {
        from { transform: translateY(10px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      @keyframes tapPulse {
        0%, 100% { opacity: 0.55; }
        50% { opacity: 1; }
      }
      .page-card { animation: pageSettleIn 0.45s cubic-bezier(0.2,0.8,0.3,1.1) both; }
      .page-line { animation: lineRise 0.35s ease both; }
      .page-tap-hint { animation: tapPulse 1.6s ease-in-out infinite; }
    `}</style>
  );
}

// Classic candy-crush-style palette - one fixed color per word position
// (0-5) within a level, so e.g. the number "one" is always the same red
// wherever it appears, and the six tiles in a level read apart at a
// glance instead of all sharing one category tint.
// Nkhono — Sesotho for "grandmother" (confirmed in the book's own
// glossary: nkhono -> grandmother, plural bo-nkhono). Built entirely from
// shapes, same paper-cutout style as PlayerCharacter, just a distinct
// figure: a doek headwrap, a striped blanket over her shoulders (a nod to
// the region's iconic woven blankets, kept generic rather than copying
// any specific real pattern), round glasses, and a slight stoop.
function Nkhono({ size = 100 }) {
  return (
    <svg viewBox="0 0 140 180" width={size} height={size * (180 / 140)} style={{ overflow: "visible" }}>
      {/* cane */}
      <line x1="100" y1="120" x2="104" y2="176" stroke="#6b4a2a" strokeWidth="4" strokeLinecap="round" />
      <path d="M96 120 q10 -6 12 4" fill="none" stroke="#6b4a2a" strokeWidth="4" strokeLinecap="round" />
      {/* skirt */}
      <path d="M48 118 Q70 108 92 118 L102 176 Q70 186 38 176 Z" fill="#5B4636" />
      <path d="M48 118 Q70 108 92 118 L96 130 Q70 122 44 130 Z" fill="#6E5744" />
      {/* torso, slightly hunched */}
      <path d="M50 74 Q46 100 52 122 L88 122 Q94 100 90 74 Q70 64 50 74Z" fill="#7A6248" />
      {/* blanket / shawl with simple stripe pattern */}
      <path d="M42 70 Q70 58 98 70 L94 108 Q70 98 46 108 Z" fill="#B23A2E" />
      <path d="M46 82 L94 82 L92 90 L48 90 Z" fill="#E8D023" />
      <path d="M47 96 L93 96 L91 103 L49 103 Z" fill="#2F4C3B" />
      {/* arm resting on cane */}
      <path d="M88 84 Q100 96 98 116" fill="none" stroke="#7A6248" strokeWidth="10" strokeLinecap="round" />
      <circle cx="98" cy="118" r="6" fill="#C89B6E" />
      {/* other arm, gesturing as if telling a story */}
      <path d="M52 84 Q36 90 34 78" fill="none" stroke="#7A6248" strokeWidth="10" strokeLinecap="round" />
      <circle cx="34" cy="76" r="6" fill="#C89B6E" />
      {/* neck + head */}
      <rect x="62" y="56" width="16" height="14" fill="#C89B6E" />
      <circle cx="70" cy="42" r="24" fill="#C89B6E" />
      {/* doek headwrap */}
      <path d="M44 34 Q70 8 96 34 Q94 20 70 16 Q46 20 44 34Z" fill="#3B7FE0" />
      <path d="M44 34 Q70 44 96 34 Q94 26 70 24 Q46 26 44 34Z" fill="#2F5FB0" />
      <path d="M88 22 Q100 26 96 38" fill="none" stroke="#2F5FB0" strokeWidth="5" strokeLinecap="round" />
      {/* ears */}
      <circle cx="47" cy="44" r="4" fill="#C89B6E" />
      <circle cx="93" cy="44" r="4" fill="#C89B6E" />
      {/* glasses */}
      <circle cx="61" cy="43" r="8" fill="none" stroke="#3a3a3a" strokeWidth="2.5" />
      <circle cx="79" cy="43" r="8" fill="none" stroke="#3a3a3a" strokeWidth="2.5" />
      <line x1="69" y1="43" x2="71" y2="43" stroke="#3a3a3a" strokeWidth="2.5" />
      {/* eyes, smile lines, warm smile */}
      <circle cx="61" cy="43" r="2" fill="#2b2b2b" />
      <circle cx="79" cy="43" r="2" fill="#2b2b2b" />
      <path d="M50 50 Q54 54 58 51" fill="none" stroke="#8a6a4a" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M90 50 Q86 54 82 51" fill="none" stroke="#8a6a4a" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M60 56 Q70 63 80 56" fill="none" stroke="#5a3a20" strokeWidth="2.5" strokeLinecap="round" />
      {/* eyebrows, grey */}
      <path d="M55 36 Q61 33 66 36" fill="none" stroke="#cfcfcf" strokeWidth="2" strokeLinecap="round" />
      <path d="M74 36 Q79 33 85 36" fill="none" stroke="#cfcfcf" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const CANDY_PALETTE = ["#E0433D", "#E8942A", "#E8D023", "#4CAF50", "#3B7FE0", "#9B59B6"];

// Sesotho Match — a local, code-only match-3 (like Ludo/Chess: no Supabase,
// no Nets, no network cost beyond the page load). Every tile is plain SVG
// shapes and CSS — zero images, zero audio — so it's genuinely free and
// works offline once loaded.
//
// STORY (shown once, and replayable from the map's book button):
// Long ago every elder in the village could speak four tongues, and every
// word was kept safe in one great book. One stormy night, the Moya oa
// Lebala — the Wind of Forgetting — tore through the village and scattered
// every page across the land. Without its words, the village fell silent.
// Now it's up to you: match the tiles, recover each page, and outrun the
// Wind before it swallows the last word forever.
//
// Vocabulary is copied verbatim from the book's own chapters (greetings,
// numbers, glossary entries) — nothing invented or auto-translated.
//
// Borrowed, on purpose:
//  - Candy Crush: glossy candy-shell tiles, match-4 stripes a row/column,
//    match-5+ wraps a 3x3 blast, combo hype text, 1-3 star level rating.
//  - Duolingo: word-reveal toast on every match, mastery stars per "page".
//  - Ludo (already in this app): walk-the-path world map between levels.

const STORY_INTRO = [
  "Long ago, every elder in the village could speak four tongues, and every word was kept safe in one great book.",
  "One stormy night, the Moya oa Lebala — the Wind of Forgetting — tore through the village and scattered every page across the land.",
  "Without its words, the village fell silent...",
  "This is Nkhono — the village's oldest storyteller, and the only one who still remembers every word by heart.",
  "She'll guide you as you go. Match the tiles, recover each page, and outrun the Wind before it swallows the last word forever.",
];

const LEVELS = [
  {
    id: "numbers", title: "Numbers", target: 400, moves: 18,
    blurb: "The Wind scattered the counting-page first — the village can't even count its own children. Recover it.",
    words: [
      { id: "ngoe", sesotho: "ngoe", english: "one", shona: "potsi", isizulu: "kunye" },
      { id: "peli", sesotho: "peli", english: "two", shona: "piri", isizulu: "kubili" },
      { id: "tharo", sesotho: "tharo", english: "three", shona: "tatu", isizulu: "kuthathu" },
      { id: "ne", sesotho: "'ne", english: "four", shona: "ina", isizulu: "kune" },
      { id: "hlano", sesotho: "hlano", english: "five", shona: "shanu", isizulu: "kuhlanu" },
      { id: "tselela", sesotho: "tselela", english: "six", shona: "tanhatu", isizulu: "isithupha" },
    ],
  },
  {
    id: "greetings", title: "Greetings", target: 450, moves: 18,
    blurb: "Nobody in the village can even say hello anymore. This page has to come back.",
    words: [
      { id: "e", sesotho: "e", english: "yes", shona: "hongu", isizulu: "yebo" },
      { id: "che", sesotho: "che", english: "no", shona: "kwete", isizulu: "cha" },
      { id: "lumela", sesotho: "lumela", english: "hello", shona: "mhoro", isizulu: "sawubona" },
      { id: "kealeboha", sesotho: "kea leboha", english: "thank you", shona: "ndatenda", isizulu: "ngiyabonga" },
      { id: "hantle", sesotho: "hantle", english: "well/good", shona: "zvakanaka", isizulu: "kahle" },
      { id: "fonane", sesotho: "fonane", english: "good night", shona: "urare zvakanaka", isizulu: "lala kahle" },
    ],
  },
  {
    id: "animals", title: "Animals", target: 500, moves: 20,
    blurb: "The herders lost the names of their own animals. Chase this page down before the Wind buries it in the veld.",
    words: [
      { id: "ntja", sesotho: "ntja", english: "dog", shona: "imbwa", isizulu: "inja" },
      { id: "katse", sesotho: "katse", english: "cat", shona: "katsi", isizulu: "ikati" },
      { id: "khoho", sesotho: "khoho", english: "chicken", shona: "huku", isizulu: "inkukhu" },
      { id: "poli", sesotho: "poli", english: "goat", shona: "mbudzi", isizulu: "imbuzi" },
      { id: "nku", sesotho: "nku", english: "sheep", shona: "gwai", isizulu: "imvu" },
      { id: "nonyana", sesotho: "nonyana", english: "bird", shona: "shiri", isizulu: "inyoni" },
    ],
  },
  {
    id: "food", title: "Food & Drink", target: 500, moves: 20,
    blurb: "The cooking-page is gone, and dinner's getting cold. Bring it home.",
    words: [
      { id: "bohobe", sesotho: "bohobe", english: "bread", shona: "chingwa", isizulu: "isinkwa" },
      { id: "lebese", sesotho: "lebese", english: "milk", shona: "mukaka", isizulu: "ubisi" },
      { id: "lehe", sesotho: "lehe", english: "egg", shona: "zai", isizulu: "iqanda" },
      { id: "tee", sesotho: "tee", english: "tea", shona: "tii", isizulu: "itiye" },
      { id: "tsoekere", sesotho: "tsoekere", english: "sugar", shona: "shuga", isizulu: "ushukela" },
      { id: "tlhapi", sesotho: "tlhapi", english: "fish", shona: "hove", isizulu: "inhlanzi" },
    ],
  },
  {
    id: "family", title: "Family & Friends", target: 550, moves: 20,
    blurb: "Children in the village can't even name their own mother and father. This one matters most.",
    words: [
      { id: "me", sesotho: "'mè", english: "mother", shona: "mai", isizulu: "umama" },
      { id: "ntate", sesotho: "ntate", english: "father", shona: "baba", isizulu: "ubaba" },
      { id: "abuti", sesotho: "abuti", english: "brother", shona: "hama", isizulu: "umfowabo" },
      { id: "ausi", sesotho: "ausi", english: "sister", shona: "hanzvadzi", isizulu: "udadewabo" },
      { id: "ngoana", sesotho: "ngoana", english: "child", shona: "mwana", isizulu: "ingane" },
      { id: "motsoalle", sesotho: "motsoalle", english: "friend", shona: "shamwari", isizulu: "umngane" },
    ],
  },
  {
    id: "home", title: "Home & Things", target: 550, moves: 20,
    blurb: "Half the village can't name the door they're standing in front of. Bring this page back before dark.",
    words: [
      { id: "ntlo", sesotho: "ntlo", english: "house", shona: "imba", isizulu: "indlu" },
      { id: "lemati", sesotho: "lemati", english: "door", shona: "gonhi", isizulu: "umnyango" },
      { id: "setulo", sesotho: "setulo", english: "chair", shona: "chigaro", isizulu: "isihlalo" },
      { id: "tafole", sesotho: "tafole", english: "table", shona: "tafura", isizulu: "itafula" },
      { id: "buka", sesotho: "buka", english: "book", shona: "bhuku", isizulu: "incwadi" },
      { id: "chelete", sesotho: "chelete", english: "money", shona: "mari", isizulu: "imali" },
    ],
  },
  {
    id: "nature", title: "Nature & Time", target: 600, moves: 22,
    blurb: "The Wind is strongest out here — it took this page furthest. One more push.",
    words: [
      { id: "naleli", sesotho: "naleli", english: "star", shona: "nyeredzi", isizulu: "inkanyezi" },
      { id: "pula", sesotho: "pula", english: "rain", shona: "mvura", isizulu: "imvula" },
      { id: "sefate", sesotho: "sefate", english: "tree", shona: "muti", isizulu: "umuthi" },
      { id: "bosiu", sesotho: "bosiu", english: "night", shona: "usiku", isizulu: "ubusuku" },
      { id: "hoseng", sesotho: "hoseng", english: "morning", shona: "mangwanani", isizulu: "ekuseni" },
      { id: "hosasa", sesotho: "hosasa", english: "tomorrow", shona: "mangwana", isizulu: "kusasa" },
    ],
  },
  {
    id: "people", title: "People", target: 650, moves: 22,
    blurb: "The final page. Every role in the village — chief, teacher, healer — is nameless without it. Finish what you started.",
    words: [
      { id: "morena", sesotho: "morena", english: "chief", shona: "ishe", isizulu: "inkosi" },
      { id: "tichere", sesotho: "tichere", english: "teacher", shona: "mudzidzisi", isizulu: "uthisha" },
      { id: "ngaka", sesotho: "ngaka", english: "doctor", shona: "chiremba", isizulu: "udokotela" },
      { id: "mooki", sesotho: "mooki", english: "nurse", shona: "mukoti", isizulu: "umhlengikazi" },
      { id: "molemi", sesotho: "molemi", english: "farmer", shona: "murimi", isizulu: "umlimi" },
      { id: "moeti", sesotho: "moeti", english: "visitor", shona: "mushanyi", isizulu: "isivakashi" },
    ],
  },
];

// Real, verified facts pulled straight from the book's own chapters and
// glossary (plural forms, noun-class examples from Chapter 8), plus a
// small pool of well-known general facts about the language, so the
// "recovered page" popup doesn't repeat the same paragraph every time.
// One category-specific fact plus the general pool are combined and
// picked at random each time the popup actually shows.
const CATEGORY_LESSON = {
  numbers: [
    "Sesotho numbers 1\u20135 actually change form depending on what you're counting \u2014 the word for \u201cone\u201d isn't the same for people, sheep, or villages. It's one reason many Basotho count in English instead.",
    "Watch \u201cone\u201d shift shape: motho a le mong (one person), nku e le 'ngoe (one sheep), sefate se le seng (one tree) \u2014 three completely different-looking phrases, all just meaning \u201cone.\u201d",
    "Once you get past five, Sesotho numbers stop changing form \u2014 tselela (six) stays tselela no matter what you're counting.",
  ],
  greetings: [
    "\u201cKea leboha\u201d (thank you) literally starts with \u201cke\u201d \u2014 I. Many Sesotho phrases are built like tiny sentences, not fixed stock phrases.",
  ],
  animals: [
    "Notice the pattern: most animals here take \u201cli-\u201d to become plural \u2014 poli (goat) becomes lipoli, katse (cat) becomes likatse.",
  ],
  food: [
    "Tee and tsoekere don't even have a plural form in Sesotho \u2014 just like \u201ctea\u201d and \u201csugar\u201d in English, there's simply too much of them to count!",
  ],
  family: [
    "'m\u00e8, ntate, abuti and ausi all take their own special prefix, \u201cbo-\u201d, in the plural \u2014 a family word-shape all their own.",
  ],
  home: [
    "Most everyday objects here take \u201cli-\u201d in the plural too \u2014 the same pattern as the animals. Setulo (chair) becomes litulo.",
  ],
  nature: [
    "naleli, pula and sefate all take \u201cli-\u201d in the plural as well \u2014 linaleli, lipula, lifate.",
  ],
  people: [
    "Most role words here take \u201cba-\u201d in the plural \u2014 moeti (visitor) becomes baeti, molemi (farmer) becomes balemi.",
  ],
};
const GENERAL_FACTS = [
  "Sesotho is spoken by roughly 5 to 6 million people, mostly in Lesotho and South Africa, where it's an official language.",
  "Sesotho is a tonal language \u2014 the pitch a word is said with can change its meaning, not just the letters.",
  "Lesotho is the only country in the world that lies entirely above 1,000 metres in elevation \u2014 part of why it's nicknamed the Kingdom in the Sky.",
  "Sesotho belongs to the Bantu language family, which includes hundreds of related languages spoken across most of Southern and Central Africa.",
];
function randomLesson(levelId) {
  const pool = [...(CATEGORY_LESSON[levelId] || []), ...GENERAL_FACTS];
  return pool[Math.floor(Math.random() * pool.length)];
}
const PLURALS = {
  ntja: "lintja", katse: "likatse", khoho: "likhoho", poli: "lipoli", nku: "linku", nonyana: "linonyana",
  bohobe: "mahobe", lebese: "mabese", lehe: "mahe", tee: "no plural form", tsoekere: "no plural form", tlhapi: "litlhapi",
  me: "bo-'m\u00e8", ntate: "bo-ntate", abuti: "bo-abuti", ausi: "bo-ausi", ngoana: "bana", motsoalle: "metsoalle",
  ntlo: "matlo", lemati: "mamati", setulo: "litulo", tafole: "litafole", buka: "libuka", chelete: "lichelete",
  naleli: "linaleli", pula: "lipula", sefate: "lifate", bosiu: "masiu",
  morena: "marena", tichere: "litichere", ngaka: "lingaka", mooki: "baoki", molemi: "balemi", moeti: "baeti",
};
const DISCOVERED_KEY = "sesothoMatch:discovered:v1";
function loadDiscovered() { try { return new Set(JSON.parse(localStorage.getItem(DISCOVERED_KEY) || "[]")); } catch { return new Set(); } }
function saveDiscovered(set) { try { localStorage.setItem(DISCOVERED_KEY, JSON.stringify(Array.from(set))); } catch { /* fine, just won't remember across sessions */ } }

const CAT_COLORS = {
  numbers: "#3B7FE0", greetings: "#E8B923", animals: "#2FA84F", food: "#E0743D",
  family: "#C6538C", home: "#7D5BA6", nature: "#2FA8A0", people: "#E0433D",
};

const COMBO_HYPE = ["Nice!", "Sweet!", "Great!", "Tasty!", "Awesome!", "Incredible!"];

const GRID = 7;
const PROGRESS_KEY = "sesothoMatch:progress:v2";
const STORY_SEEN_KEY = "sesothoMatch:storySeen:v1";

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { unlocked: 0, bestScore: {}, stars: {} };
    const p = JSON.parse(raw);
    return { unlocked: p.unlocked || 0, bestScore: p.bestScore || {}, stars: p.stars || {} };
  } catch { return { unlocked: 0, bestScore: {}, stars: {} }; }
}
function saveProgress(p) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch { /* storage unavailable — game still works, just won't remember progress */ }
}
function starsFor(score, target) {
  if (score >= target * 1.5) return 3;
  if (score >= target * 1.2) return 2;
  return 1;
}

// ---------------------------------------------------------------------
// Tile art — plain SVG shapes, procedurally composed so 48 words don't
// mean 48 hand-drawn pictures. Wrapped in a glossy "candy shell" so the
// board actually reads as a candy-style board, not flat icons on a grid.
// ---------------------------------------------------------------------

function Ears({ kind, color }) {
  if (kind === "point") return (<><polygon points="34,26 42,4 50,26" fill={color} /><polygon points="70,26 78,4 86,26" fill={color} /></>);
  if (kind === "round") return (<><circle cx="36" cy="20" r="12" fill={color} /><circle cx="84" cy="20" r="12" fill={color} /></>);
  if (kind === "floppy") return (<><ellipse cx="28" cy="34" rx="10" ry="18" fill={color} /><ellipse cx="92" cy="34" rx="10" ry="18" fill={color} /></>);
  return null;
}

function AnimalFace({ word, color }) {
  const earKind = { ntja: "floppy", katse: "point", khoho: "point", poli: "point", nku: "round", nonyana: "round" }[word] || "round";
  return (
    <>
      <Ears kind={earKind} color={color} />
      <circle cx="60" cy="52" r="34" fill={color} />
      {word === "khoho" && <polygon points="60,20 52,4 68,4" fill="#E0433D" />}
      {word === "poli" && <><rect x="50" y="8" width="5" height="16" rx="2" fill="#6b5a4a" /><rect x="65" y="8" width="5" height="16" rx="2" fill="#6b5a4a" /></>}
      <circle cx="48" cy="48" r="5" fill="#2b2b2b" />
      <circle cx="72" cy="48" r="5" fill="#2b2b2b" />
      {word === "nonyana" ? (
        <polygon points="55,62 65,62 60,74" fill="#E8B923" />
      ) : (
        <ellipse cx="60" cy="66" rx="10" ry="7" fill="rgba(0,0,0,0.15)" />
      )}
      {word === "katse" && (
        <g stroke="#2b2b2b" strokeWidth="1.5">
          <line x1="20" y1="58" x2="42" y2="60" /><line x1="20" y1="66" x2="42" y2="66" />
          <line x1="78" y1="60" x2="100" y2="58" /><line x1="78" y1="66" x2="100" y2="66" />
        </g>
      )}
    </>
  );
}

function FoodIcon({ word, color }) {
  if (word === "bohobe") return (<><rect x="24" y="46" width="72" height="42" rx="20" fill={color} /><path d="M36 46 Q60 20 84 46" fill={color} /><path d="M40 58 v20 M60 55 v25 M80 58 v20" stroke="rgba(0,0,0,0.2)" strokeWidth="3" /></>);
  if (word === "lebese") return (<><path d="M42 30 h36 l6 58 a6 6 0 0 1-6 6 H42 a6 6 0 0 1-6-6 Z" fill="#fff" stroke={color} strokeWidth="6" /><rect x="42" y="46" width="36" height="34" fill={color} /></>);
  if (word === "lehe") return (<ellipse cx="60" cy="60" rx="26" ry="34" fill="#fdf6e3" stroke={color} strokeWidth="5" />);
  if (word === "tee") return (<><path d="M30 50 h50 v24 a25 25 0 0 1-25 25 a25 25 0 0 1-25-25 Z" fill={color} /><path d="M80 56 q18 4 10 20 q-6 12-18 8" fill="none" stroke={color} strokeWidth="6" /><path d="M40 44 q4-10 0-18 M55 44 q4-10 0-18 M70 44 q4-10 0-18" stroke="#bbb" strokeWidth="3" fill="none" /></>);
  if (word === "tsoekere") return (<><rect x="34" y="34" width="52" height="52" fill={color} /><rect x="44" y="44" width="8" height="8" fill="#fff" opacity="0.7" /><rect x="60" y="58" width="8" height="8" fill="#fff" opacity="0.7" /><rect x="70" y="40" width="8" height="8" fill="#fff" opacity="0.7" /></>);
  if (word === "tlhapi") return (<><ellipse cx="52" cy="60" rx="30" ry="18" fill={color} /><polygon points="80,60 100,44 100,76" fill={color} /><circle cx="34" cy="56" r="3" fill="#2b2b2b" /></>);
  return null;
}

function PersonBase({ skin = "#e8b98a", shirt, accessory }) {
  return (
    <>
      <circle cx="60" cy="30" r="17" fill={skin} />
      <rect x="42" y="50" width="36" height="44" rx="12" fill={shirt} />
      {accessory}
    </>
  );
}

function FamilyIcon({ word, color }) {
  if (word === "me") return <PersonBase shirt={color} accessory={<path d="M40 24 a20 14 0 0 1 40 0 v6 h-40 Z" fill="#7D5BA6" />} />;
  if (word === "ntate") return <PersonBase shirt={color} accessory={<rect x="38" y="10" width="44" height="8" rx="3" fill="#3a3a3a" />} />;
  if (word === "abuti") return <PersonBase skin="#e8b98a" shirt={color} accessory={null} />;
  if (word === "ausi") return <PersonBase shirt={color} accessory={<path d="M48 14 q12 -10 24 0" fill="none" stroke="#3a2a1a" strokeWidth="6" />} />;
  if (word === "ngoana") return (<><circle cx="60" cy="38" r="13" fill="#e8b98a" /><rect x="46" y="52" width="28" height="34" rx="10" fill={color} /></>);
  if (word === "motsoalle") return (<>
    <circle cx="42" cy="32" r="13" fill="#e8b98a" /><rect x="28" y="50" width="28" height="36" rx="10" fill={color} />
    <circle cx="78" cy="32" r="13" fill="#c98a5a" /><rect x="64" y="50" width="28" height="36" rx="10" fill="#3B7FE0" />
  </>);
  return null;
}

function HomeIcon({ word, color }) {
  if (word === "ntlo") return (<><polygon points="60,14 100,48 20,48" fill={color} /><rect x="30" y="48" width="60" height="42" fill="#f0e6d8" /><rect x="52" y="64" width="16" height="26" fill={color} /></>);
  if (word === "lemati") return (<><rect x="34" y="18" width="52" height="82" rx="4" fill={color} /><circle cx="72" cy="60" r="4" fill="#fff" /></>);
  if (word === "setulo") return (<><rect x="34" y="20" width="8" height="70" fill={color} /><rect x="34" y="20" width="52" height="8" fill={color} /><rect x="30" y="58" width="60" height="8" fill={color} /><rect x="34" y="66" width="8" height="30" fill={color} /><rect x="78" y="66" width="8" height="30" fill={color} /></>);
  if (word === "tafole") return (<><rect x="20" y="42" width="80" height="10" fill={color} /><rect x="26" y="52" width="8" height="36" fill={color} /><rect x="86" y="52" width="8" height="36" fill={color} /></>);
  if (word === "buka") return (<><rect x="26" y="20" width="68" height="80" rx="4" fill={color} /><rect x="26" y="20" width="10" height="80" fill="rgba(0,0,0,0.25)" /><rect x="44" y="36" width="40" height="4" fill="#fff" opacity="0.7" /><rect x="44" y="48" width="40" height="4" fill="#fff" opacity="0.7" /></>);
  if (word === "chelete") return (<><circle cx="60" cy="60" r="38" fill={color} /><circle cx="60" cy="60" r="30" fill="none" stroke="#fff" strokeWidth="3" opacity="0.6" /><text x="60" y="70" fontSize="26" textAnchor="middle" fill="#fff" fontWeight="bold">M</text></>);
  return null;
}

function NatureIcon({ word, color }) {
  if (word === "naleli") return (<polygon points="60,10 71,42 105,42 78,62 88,96 60,76 32,96 42,62 15,42 49,42" fill={color} />);
  if (word === "pula") return (<><path d="M24 46 a22 22 0 0 1 42-10 a18 18 0 0 1 20 26 H30 a20 20 0 0 1-6-16Z" fill={color} /><g stroke={color} strokeWidth="5" strokeLinecap="round"><line x1="40" y1="76" x2="34" y2="96" /><line x1="60" y1="76" x2="54" y2="96" /><line x1="80" y1="76" x2="74" y2="96" /></g></>);
  if (word === "sefate") return (<><rect x="52" y="60" width="16" height="40" fill="#7a5a3a" /><circle cx="60" cy="42" r="34" fill={color} /></>);
  if (word === "bosiu") return (<><rect x="10" y="10" width="100" height="100" rx="14" fill="#1c2540" /><path d="M75 30a26 26 0 1 0 12 46 30 30 0 0 1-12-46Z" fill="#F4D160" /><circle cx="42" cy="34" r="2.5" fill="#fff" /><circle cx="88" cy="70" r="2" fill="#fff" /><circle cx="30" cy="70" r="1.8" fill="#fff" /></>);
  if (word === "hoseng") return (<><rect x="10" y="10" width="100" height="100" rx="14" fill="#bfe3f0" /><circle cx="60" cy="70" r="24" fill="#F4A950" /><g stroke="#F4A950" strokeWidth="4"><line x1="60" y1="30" x2="60" y2="18" /><line x1="30" y1="46" x2="20" y2="38" /><line x1="90" y1="46" x2="100" y2="38" /></g></>);
  if (word === "hosasa") return (<><rect x="10" y="10" width="100" height="100" rx="14" fill="#dfeef7" /><circle cx="46" cy="60" r="20" fill="#F4A950" /><path d="M78 46 L96 60 L78 74 Z" fill={color} /></>);
  return null;
}

function PeopleIcon({ word, color }) {
  if (word === "morena") return <PersonBase shirt={color} accessory={<polygon points="40,10 60,-2 80,10 74,20 46,20" fill="#E8B923" />} />;
  if (word === "tichere") return <PersonBase shirt={color} accessory={<rect x="70" y="60" width="26" height="20" rx="2" fill="#fdf6e3" stroke="#7D5BA6" strokeWidth="2" />} />;
  if (word === "ngaka") return <PersonBase shirt="#fff" accessory={<g stroke={color} strokeWidth="6" strokeLinecap="round"><line x1="60" y1="60" x2="60" y2="80" /><line x1="50" y1="70" x2="70" y2="70" /></g>} />;
  if (word === "mooki") return <PersonBase shirt="#fff" accessory={<><rect x="50" y="14" width="20" height="20" rx="3" fill="#fff" stroke={color} strokeWidth="3" /><line x1="60" y1="18" x2="60" y2="30" stroke={color} strokeWidth="3" /><line x1="54" y1="24" x2="66" y2="24" stroke={color} strokeWidth="3" /></>} />;
  if (word === "molemi") return <PersonBase shirt={color} accessory={<ellipse cx="60" cy="14" rx="26" ry="8" fill="#C89B5C" />} />;
  if (word === "moeti") return <PersonBase shirt={color} accessory={<rect x="76" y="58" width="22" height="26" rx="4" fill="#7a5a3a" />} />;
  return null;
}

function GreetingIcon({ word, color }) {
  if (word === "e") return (<><circle cx="60" cy="60" r="46" fill={color} /><path d="M38 62 l16 16 30-34" stroke="#fff" strokeWidth="9" fill="none" strokeLinecap="round" strokeLinejoin="round" /></>);
  if (word === "che") return (<><circle cx="60" cy="60" r="46" fill={color} /><g stroke="#fff" strokeWidth="9" strokeLinecap="round"><line x1="42" y1="42" x2="78" y2="78" /><line x1="78" y1="42" x2="42" y2="78" /></g></>);
  if (word === "lumela") return (<><circle cx="54" cy="54" r="30" fill={color} /><g stroke={color} strokeWidth="10" strokeLinecap="round"><line x1="84" y1="30" x2="84" y2="8" /><line x1="94" y1="34" x2="100" y2="14" /><line x1="76" y1="30" x2="72" y2="10" /></g></>);
  if (word === "kealeboha") return (<path d="M60 96 C 20 66,20 30,48 26 C60 24,60 40,60 40 C60 40,60 24,72 26 C100 30,100 66,60 96 Z" fill={color} />);
  if (word === "hantle") return (<><circle cx="60" cy="66" r="30" fill={color} /><rect x="50" y="16" width="20" height="40" rx="10" fill={color} /><circle cx="60" cy="16" r="10" fill={color} /></>);
  if (word === "fonane") return (<><path d="M75 20a35 35 0 1 0 20 62 40 40 0 0 1-20-62Z" fill={color} /><text x="82" y="96" fontSize="16" fill={color} fontWeight="bold">z z Z</text></>);
  return null;
}

function TileIcon({ level, word, color }) {
  if (level === "numbers") {
    const n = { ngoe: 1, peli: 2, tharo: 3, ne: 4, hlano: 5, tselela: 6 }[word];
    return (<><circle cx="60" cy="60" r="46" fill={color} /><text x="60" y="78" fontSize="56" textAnchor="middle" fill="#fff" fontWeight="bold" fontFamily="sans-serif">{n}</text></>);
  }
  if (level === "greetings") return <GreetingIcon word={word} color={color} />;
  if (level === "animals") return <AnimalFace word={word} color={color} />;
  if (level === "food") return <FoodIcon word={word} color={color} />;
  if (level === "family") return <FamilyIcon word={word} color={color} />;
  if (level === "home") return <HomeIcon word={word} color={color} />;
  if (level === "nature") return <NatureIcon word={word} color={color} />;
  if (level === "people") return <PeopleIcon word={word} color={color} />;
  return null;
}

// The "candy shell" — a glossy rounded-square backdrop behind every icon,
// exactly the piece of visual language that makes a board read as
// "Candy Crush" rather than "icons in a grid": a saturated rounded square,
// a soft drop shadow, and a diagonal highlight streak for shine. Special
// candies (striped/wrapped, from 4- and 5-matches) get an extra marking.
function CandyTile({ level, word, colorIndex = 0, special, size = 44, dim = false, className = "" }) {
  const color = CANDY_PALETTE[colorIndex % CANDY_PALETTE.length];
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={className}
      style={{ overflow: "visible", opacity: dim ? 0.35 : 1, "--glow": color }}>
      <rect x="6" y="8" width="108" height="108" rx="26" fill="rgba(0,0,0,0.18)" />
      <rect x="4" y="4" width="108" height="108" rx="26" fill={color} opacity="0.22" />
      <rect x="4" y="4" width="108" height="108" rx="26" fill="none" stroke={color} strokeWidth="4" opacity="0.65" />
      <path d="M16 44 Q30 14 60 12 Q40 20 30 50 Z" fill="#fff" opacity="0.35" />
      <g transform="translate(14,14) scale(0.78)">
        <TileIcon level={level} word={word} color={color} />
      </g>
      {special === "stripedH" && <rect x="10" y="52" width="100" height="16" rx="8" fill="#fff" opacity="0.85" />}
      {special === "stripedV" && <rect x="52" y="10" width="16" height="100" rx="8" fill="#fff" opacity="0.85" />}
      {special === "wrapped" && <rect x="14" y="14" width="92" height="92" rx="20" fill="none" stroke="#fff" strokeWidth="6" strokeDasharray="10 8" opacity="0.9" />}
    </svg>
  );
}

// ---------------------------------------------------------------------
// Match-3 engine — cells are {type, special}. Tap-select + tap-adjacent
// to swap (no drag). Match 4 in a line creates a striped candy (clears
// the perpendicular row/column when it's later cleared); match 5+
// creates a wrapped candy (clears a surrounding 3x3 when cleared).
// ---------------------------------------------------------------------

function randType(n) { return Math.floor(Math.random() * n); }
function cell(type, special = null) { return { type, special }; }

function makeBoard(n) {
  let board;
  do {
    board = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => cell(randType(n))));
  } while (findRuns(board).length > 0);
  return board;
}

// All straight runs of length >= 3, both directions.
function findRuns(board) {
  const runs = [];
  for (let r = 0; r < GRID; r++) {
    let start = 0;
    for (let cc = 1; cc <= GRID; cc++) {
      if (cc < GRID && board[r][cc].type === board[r][start].type) continue;
      if (cc - start >= 3) {
        const cells = []; for (let k = start; k < cc; k++) cells.push({ r, c: k });
        runs.push({ cells, dir: "h", type: board[r][start].type });
      }
      start = cc;
    }
  }
  for (let cc = 0; cc < GRID; cc++) {
    let start = 0;
    for (let r = 1; r <= GRID; r++) {
      if (r < GRID && board[r][cc].type === board[start][cc].type) continue;
      if (r - start >= 3) {
        const cells = []; for (let k = start; k < r; k++) cells.push({ r: k, c: cc });
        runs.push({ cells, dir: "v", type: board[start][cc].type });
      }
      start = r;
    }
  }
  return runs;
}

function applyGravity(board, n) {
  const next = board.map((row) => row.slice());
  for (let cc = 0; cc < GRID; cc++) {
    let write = GRID - 1;
    for (let r = GRID - 1; r >= 0; r--) {
      if (next[r][cc] !== null) { next[write][cc] = next[r][cc]; if (write !== r) next[r][cc] = null; write--; }
    }
    for (let r = write; r >= 0; r--) next[r][cc] = cell(randType(n));
  }
  return next;
}

function areAdjacent(a, b) { return (a.r === b.r && Math.abs(a.c - b.c) === 1) || (a.c === b.c && Math.abs(a.r - b.r) === 1); }

// One full resolve pass: find runs -> decide specials -> clear (expanding
// for any special that gets swept up) -> gravity -> repeat until settled.
function resolveCascade(startBoard, n, swapOrigin) {
  let board = startBoard;
  let gained = 0;
  let firstMatchType = null;
  let bestRunLen = 0;
  let passes = 0;
  let createdSpecial = false;
  let detonated = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const runs = findRuns(board);
    if (runs.length === 0) break;
    passes += 1;
    const toClear = new Set();
    const upgrades = []; // {r,c,special}
    for (const run of runs) {
      bestRunLen = Math.max(bestRunLen, run.cells.length);
      if (firstMatchType === null) firstMatchType = run.type;
      run.cells.forEach(({ r, c: cc }) => toClear.add(`${r},${cc}`));
      if (run.cells.length >= 4) {
        // Special is born where the player's swap landed, if it's part of
        // this run; otherwise the middle of the run (matches Candy Crush's
        // own convention closely enough for our purposes).
        let origin = run.cells.find((p) => swapOrigin && p.r === swapOrigin.r && p.c === swapOrigin.c);
        if (!origin) origin = run.cells[Math.floor(run.cells.length / 2)];
        const special = run.cells.length >= 5 ? "wrapped" : (run.dir === "h" ? "stripedV" : "stripedH");
        upgrades.push({ r: origin.r, c: origin.c, special });
      }
    }
    // Detonate any special candy that's about to be cleared.
    let changed = true;
    while (changed) {
      changed = false;
      for (const key of Array.from(toClear)) {
        const [r, cc] = key.split(",").map(Number);
        const isUpgradeSite = upgrades.some((u) => u.r === r && u.c === cc);
        if (isUpgradeSite) continue; // this cell survives as the new special, not cleared
        const sp = board[r][cc]?.special;
        if (!sp) continue;
        let added = [];
        if (sp === "stripedH") added = Array.from({ length: GRID }, (_, k) => `${r},${k}`);
        else if (sp === "stripedV") added = Array.from({ length: GRID }, (_, k) => `${k},${cc}`);
        else if (sp === "wrapped") {
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = cc + dc;
            if (nr >= 0 && nr < GRID && nc >= 0 && nc < GRID) added.push(`${nr},${nc}`);
          }
        }
        for (const a of added) if (!toClear.has(a)) { toClear.add(a); changed = true; detonated = true; }
      }
    }
    if (upgrades.length > 0) createdSpecial = true;
    gained += toClear.size * 10 + Math.max(0, toClear.size - 3) * 15;
    const cleared = board.map((row) => row.slice());
    toClear.forEach((key) => {
      const [r, cc] = key.split(",").map(Number);
      const isUpgradeSite = upgrades.find((u) => u.r === r && u.c === cc);
      cleared[r][cc] = isUpgradeSite ? null : null; // clear now, re-place upgrades after gravity so they don't fall
    });
    board = applyGravity(cleared, n);
    // Re-place upgraded specials at their original spot (gravity already
    // pulled everything above them down by one, so this keeps the special
    // sitting where the match happened rather than getting shuffled away).
    upgrades.forEach((u) => { board[u.r][u.c] = cell(u.type ?? board[u.r][u.c].type, u.special); });
    swapOrigin = null; // only the very first pass gets the "landed here" bonus
  }
  return { board, gained, firstMatchType, bestRunLen, passes, createdSpecial, detonated };
}

function findHint(board, n) {
  for (let r = 0; r < GRID; r++) {
    for (let cc = 0; cc < GRID; cc++) {
      for (const [dr, dc] of [[0, 1], [1, 0]]) {
        const nr = r + dr, nc = cc + dc;
        if (nr >= GRID || nc >= GRID) continue;
        const test = board.map((row) => row.slice());
        const tmp = test[r][cc]; test[r][cc] = test[nr][nc]; test[nr][nc] = tmp;
        if (findRuns(test).length > 0) return [{ r, c: cc }, { r: nr, c: nc }];
      }
    }
  }
  return null;
}

export default function SesothoMatchPage({ onBack, c }) {
  const [soundOn, setSoundOn] = useState(loadSoundPref);
  const toggleSound = () => setSoundOn((v) => { saveSoundPref(!v); return !v; });
  const play = (fn, ...args) => { if (soundOn) fn(...args); };
  const [hdOn, setHdOn] = useState(isHdVoiceEnabled);
  const [hdLoading, setHdLoading] = useState(null); // null, or 0..1 progress while the model downloads
  const toggleHd = () => {
    if (!hdOn) {
      const ok = window.confirm("HD Voice sounds deeper and more natural, but downloads a one-time voice file (roughly 20\u201386MB depending on your device). It's cached after that. Turn it on?");
      if (!ok) return;
    }
    const next = !hdOn;
    setHdVoiceEnabled(next);
    setHdOn(next);
  };
  const [progress, setProgress] = useState(loadProgress);
  const [screen, setScreen] = useState(() => (localStorage.getItem(STORY_SEEN_KEY) ? "map" : "story"));
  const [storyStep, setStoryStep] = useState(0);
  const [levelIdx, setLevelIdx] = useState(0);
  const [board, setBoard] = useState(null);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [movesLeft, setMovesLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lessonWord, setLessonWord] = useState(null); // { word, level } while the "recovered page" popup is open
  const [discovered, setDiscovered] = useState(loadDiscovered);
  const matchCountRef = useRef(0);
  const lessonThresholdRef = useRef(3 + Math.floor(Math.random() * 2)); // 3 or 4
  const [hypeToast, setHypeToast] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [walkTo, setWalkTo] = useState(null);
  const [hint, setHint] = useState(null);
  const [preLevel, setPreLevel] = useState(null); // level index awaiting its "page" intro
  const hypeTimer = useRef(null);
  const hintTimer = useRef(null);

  useEffect(() => () => {
    wordSpeech.stop();
    if (hypeTimer.current) clearTimeout(hypeTimer.current);
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  const level = LEVELS[levelIdx];

  const finishStory = () => {
    wordSpeech.stop();
    try { localStorage.setItem(STORY_SEEN_KEY, "1"); } catch { /* fine, will just show again next time */ }
    setScreen("map");
  };

  const startLevel = (idx) => {
    const lv = LEVELS[idx];
    setLevelIdx(idx);
    setBoard(makeBoard(lv.words.length));
    setScore(0);
    setMovesLeft(lv.moves);
    setSelected(null);
    setOutcome(null);
    setBusy(false);
    setHint(null);
    setScreen("play");
  };

  const openLevel = (idx) => {
    if (idx > progress.unlocked) return;
    setPreLevel(idx); // show the "page" blurb first, for the suspense beat
  };

  const openLesson = (levelId, word) => {
    play(SFX.pageFlip);
    const isNew = !discovered.has(word.id);
    const lesson = randomLesson(levelId);
    setLessonWord({ levelId, word, isNew, lesson });
    if (isNew) {
      setDiscovered((prev) => {
        const next = new Set(prev); next.add(word.id);
        saveDiscovered(next);
        return next;
      });
    }
    if (soundOn) {
      // The Sesotho word itself is skipped in speech - an English TTS
      // voice mispronounces it badly enough to be actively unhelpful, so
      // it's shown on the card to read, not read aloud.
      const opener = isNew ? "New page recovered!" : "Page recovered!";
      wordSpeech.speak(`${opener} In English, this page's word means ${word.english}. ${lesson}`, { onHdProgress: setHdLoading });
    }
  };
  const replayLesson = () => {
    if (!lessonWord) return;
    wordSpeech.speak(`In English, this page's word means ${lessonWord.word.english}. ${lessonWord.lesson}`, { onHdProgress: setHdLoading });
  };
  const closeLesson = () => {
    setLessonWord(null);
    try { wordSpeech.stop(); } catch { /* the popup must always close, no matter what audio does */ }
  };
  const showHype = (text) => {
    setHypeToast(text);
    if (hypeTimer.current) clearTimeout(hypeTimer.current);
    hypeTimer.current = setTimeout(() => setHypeToast(null), 900);
  };

  const trySwap = (a, b) => {
    if (busy || movesLeft <= 0 || outcome || lessonWord) return;
    setHint(null);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    if (!areAdjacent(a, b)) { setSelected({ r: b.r, c: b.c }); return; }
    setBusy(true);
    const swapped = board.map((row) => row.slice());
    const tmp = swapped[a.r][a.c]; swapped[a.r][a.c] = swapped[b.r][b.c]; swapped[b.r][b.c] = tmp;
    const runs = findRuns(swapped);
    if (runs.length === 0) {
      // Invalid swap — snap back, no move spent (same forgiving feel Ludo
      // uses for a mistaken tap).
      setSelected(null);
      setBusy(false);
      return;
    }
    setBoard(swapped);
    setSelected(null);
    setMovesLeft((m) => m - 1);
    setTimeout(() => {
      const { board: finalBoard, gained, firstMatchType, bestRunLen, passes, createdSpecial, detonated } = resolveCascade(swapped, level.words.length, b);
      setBoard(finalBoard);
      setScore((s) => {
        const next = s + gained;
        if (next >= level.target && !outcome) setOutcome("won");
        return next;
      });
      if (firstMatchType != null) {
        const word = level.words[firstMatchType];
        const isFirstEver = !discovered.has(word.id);
        matchCountRef.current += 1;
        // Show the full "recovered page" popup for a genuinely new word
        // right away, but otherwise only every 3-4 matches - stopping to
        // read a full page on literally every single match got tedious
        // fast, so this keeps it a periodic highlight instead.
        if (isFirstEver || matchCountRef.current >= lessonThresholdRef.current) {
          matchCountRef.current = 0;
          lessonThresholdRef.current = 3 + Math.floor(Math.random() * 2);
          openLesson(level.id, word);
        }
      }
      const hypeIdx = Math.min(COMBO_HYPE.length - 1, (bestRunLen - 3) + (passes - 1) * 2);
      if (hypeIdx > 0 || passes > 1) showHype(COMBO_HYPE[Math.max(0, hypeIdx)]);
      // Layer the sound to match what actually happened - a plain match
      // gets a pop (pitched up slightly per cascade step), a 4/5-match
      // adds a chime, and an actual special detonation adds a boom.
      play(SFX.pop, Math.min(passes - 1, 4));
      if (createdSpecial) play(SFX.special);
      if (detonated) play(SFX.boom);
      setBusy(false);
    }, 220);
  };

  useEffect(() => {
    if (screen === "play" && !busy && movesLeft <= 0 && score < level.target && !outcome) {
      setOutcome("lost");
      play(SFX.lose);
    }
  }, [movesLeft, score, level, outcome, screen, busy]);

  useEffect(() => {
    if (outcome === "won") {
      play(SFX.win);
      const earned = starsFor(score, level.target);
      setProgress((prev) => {
        const next = {
          unlocked: Math.max(prev.unlocked, Math.min(levelIdx + 1, LEVELS.length - 1)),
          bestScore: { ...prev.bestScore, [level.id]: Math.max(prev.bestScore[level.id] || 0, score) },
          stars: { ...prev.stars, [level.id]: Math.max(prev.stars[level.id] || 0, earned) },
        };
        saveProgress(next);
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const onTapCell = (r, cIdx) => {
    if (lessonWord) return;
    if (!selected) { play(SFX.select); setSelected({ r, c: cIdx }); return; }
    if (selected.r === r && selected.c === cIdx) { setSelected(null); return; }
    trySwap(selected, { r, c: cIdx });
  };

  const useHint = () => {
    if (busy || outcome || lessonWord || !board) return;
    const found = findHint(board, level.words.length);
    setHint(found);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 2500);
  };

  const backToMap = () => {
    if (outcome === "won" && walkTo == null) setWalkTo(Math.min(levelIdx + 1, LEVELS.length - 1));
    setScreen("map");
  };

  useEffect(() => {
    if (screen === "map" && walkTo != null) {
      const t = setTimeout(() => setWalkTo(null), 900);
      return () => clearTimeout(t);
    }
  }, [screen, walkTo]);

  // Nkhono narrates each story step as it appears - the first line may be
  // silently blocked by browser autoplay rules (nothing has been tapped
  // yet), but reaching this screen via "The story" button, or tapping
  // Continue, is a real tap and reads fine.
  useEffect(() => {
    if (screen === "story" && soundOn) {
      wordSpeech.speak(STORY_INTRO[storyStep], { onHdProgress: setHdLoading });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, storyStep]);

  const tokenAt = walkTo != null ? walkTo : progress.unlocked;
  const dangerLevel = level ? 1 - movesLeft / level.moves : 0; // 0 = safe, 1 = Wind about to catch you

  // ---- Story screen ----
  if (screen === "story") {
    return (
      <div className="max-w-md mx-auto px-4 pt-10 pb-16 flex flex-col items-center text-center min-h-[70vh] justify-center">
        <GameStyles />
        <Nkhono size={110} />
        <div className="font-display text-2xl mt-3 mb-5" style={{ color: c.text }}>Nkhono's Story</div>
        <div className="font-body text-base leading-relaxed mb-8" style={{ color: c.textDim, minHeight: 110 }}>
          {STORY_INTRO[storyStep]}
        </div>
        <div className="flex gap-1.5 mb-8">
          {STORY_INTRO.map((_, i) => (
            <span key={i} style={{ width: 7, height: 7, borderRadius: 999, background: i === storyStep ? c.accent : c.border }} />
          ))}
        </div>
        <button
          onClick={() => (storyStep < STORY_INTRO.length - 1 ? setStoryStep((s) => s + 1) : finishStory())}
          className="rounded-xl px-8 py-3 font-display text-base w-full max-w-[220px]"
          style={{ background: c.accent, color: c.accentText || "#fff" }}>
          {storyStep < STORY_INTRO.length - 1 ? "Continue" : "Begin"}
        </button>
        {storyStep < STORY_INTRO.length - 1 && (
          <button onClick={finishStory} className="mt-3 font-body text-xs" style={{ color: c.textFaint }}>Skip</button>
        )}
      </div>
    );
  }

  // ---- Pre-level "page" intro (the suspense beat before each puzzle) ----
  if (preLevel != null) {
    const lv = LEVELS[preLevel];
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.72)" }}>
        <div className="rounded-2xl p-6 text-center max-w-xs w-full" style={{ background: c.surface, border: `2px solid ${CAT_COLORS[lv.id]}` }}>
          <Nkhono size={54} />
          <div className="font-body text-xs uppercase tracking-wide mt-2 mb-1" style={{ color: c.textFaint }}>Page {preLevel + 1} of {LEVELS.length}</div>
          <div className="font-display text-xl mb-3" style={{ color: c.text }}>{lv.title}</div>
          <div className="font-body text-sm mb-6" style={{ color: c.textDim }}>{lv.blurb}</div>
          <div className="flex flex-col gap-2">
            <button onClick={() => {
              // A real tap, right here, is what "unlocks" audio on most
              // browsers - reading the page's own blurb aloud from this
              // exact click means every later automatic read during play
              // (which fires from a timer, not a tap) reliably plays too.
              if (soundOn) wordSpeech.speak(`Page ${preLevel + 1}. ${lv.title}. ${lv.blurb}`, { onHdProgress: setHdLoading });
              setPreLevel(null); startLevel(preLevel);
            }} className="w-full rounded-xl py-3 font-display text-base" style={{ background: CAT_COLORS[lv.id], color: "#fff" }}>
              Chase the page
            </button>
            <button onClick={() => setPreLevel(null)} className="rounded-xl py-3 font-semibold" style={{ background: c.surfaceHover || c.surface, border: `1px solid ${c.border}` }}>
              Not yet
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Map screen ----
  if (screen === "map") {
    return (
      <div className="max-w-md mx-auto px-4 pt-6 pb-16">
        <GameStyles />
        <div className="flex items-center justify-between mb-5">
          <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}>
            <ArrowLeft size={15} /> Back
          </button>
          <div className="flex items-center gap-3">
            <button onClick={toggleHd} className="flex items-center gap-1" style={{ color: hdOn ? c.accent : c.textFaint }} aria-label="Toggle HD voice">
              <Zap size={14} fill={hdOn ? c.accent : "none"} />
              <span className="font-body text-[10px] font-bold">HD</span>
            </button>
            <button onClick={toggleSound} style={{ color: c.textFaint }} aria-label="Toggle sound">
              {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
            <button onClick={() => { setStoryStep(0); setScreen("story"); }} className="flex items-center gap-1.5 font-body text-xs" style={{ color: c.textFaint }}>
              <BookOpen size={13} /> The story
            </button>
          </div>
        </div>
        <div className="mb-1 font-display text-2xl" style={{ color: c.text }}>Sesotho Match</div>
        <div className="mb-6 font-body text-sm" style={{ color: c.textDim }}>
          Recover the scattered pages before the Wind of Forgetting does.
        </div>

        <div className="relative">
          {LEVELS.map((lv, i) => {
            const locked = i > progress.unlocked;
            const earnedStars = progress.stars[lv.id] || 0;
            const isToken = i === tokenAt;
            const align = i % 2 === 0 ? "flex-start" : "flex-end";
            return (
              <div key={lv.id} style={{ display: "flex", justifyContent: align, marginBottom: 18, position: "relative" }}>
                {i < LEVELS.length - 1 && (
                  <div style={{
                    position: "absolute", top: "100%", [i % 2 === 0 ? "left" : "right"]: 34,
                    width: 3, height: 26, background: c.border, zIndex: 0,
                  }} />
                )}
                <button
                  onClick={() => !locked && openLevel(i)}
                  disabled={locked}
                  style={{
                    position: "relative", width: 76, height: 76, borderRadius: 22,
                    background: locked ? c.surfaceHover : CAT_COLORS[lv.id] + "22",
                    border: `2px solid ${locked ? c.border : CAT_COLORS[lv.id]}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    opacity: locked ? 0.55 : 1, cursor: locked ? "default" : "pointer",
                  }}>
                  {locked ? <Lock size={22} style={{ color: c.textFaint }} /> : <CandyTile level={lv.id} word={lv.words[0].id} colorIndex={0} size={40} />}
                  {earnedStars > 0 && (
                    <div style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 1 }}>
                      {[0, 1, 2].map((s) => <Star key={s} size={11} fill={s < earnedStars ? "#E8B923" : "none"} color={s < earnedStars ? "#E8B923" : c.border} />)}
                    </div>
                  )}
                  {isToken && (
                    <div style={{ position: "absolute", bottom: -30, transition: "all 0.6s ease" }}>
                      <PlayerCharacter pose="idle" size={46} kitColor={c.accent} />
                    </div>
                  )}
                </button>
                <div style={{
                  position: "absolute", top: 82, [i % 2 === 0 ? "left" : "right"]: 0,
                  fontSize: 11, fontWeight: 700, color: c.textDim, width: 90, textAlign: i % 2 === 0 ? "left" : "right",
                }}>
                  {lv.title}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ---- Play screen ----
  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-16">
      <GameStyles />
      <div className="flex items-center justify-between mb-4">
        <button onClick={() => setScreen("map")} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}>
          <ArrowLeft size={15} /> Map
        </button>
        <div className="flex items-center gap-3">
          <button onClick={toggleHd} className="flex items-center gap-1" style={{ color: hdOn ? c.accent : c.textFaint }} aria-label="Toggle HD voice">
            <Zap size={14} fill={hdOn ? c.accent : "none"} />
            <span className="font-body text-[10px] font-bold">HD</span>
          </button>
          <button onClick={toggleSound} style={{ color: c.textFaint }} aria-label="Toggle sound">
            {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
        </div>
      </div>

      {hdLoading != null && (
        <div className="flex items-center gap-2 mb-3 font-body text-xs" style={{ color: c.textFaint }}>
          <Loader2 size={13} className="animate-spin" /> Downloading HD voice... {Math.round(hdLoading * 100)}%
        </div>
      )}

      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="font-display text-lg" style={{ color: c.text }}>{level.title}</div>
          <div className="font-body text-xs" style={{ color: c.textFaint }}>Target {level.target} pts</div>
        </div>
        <div className="text-right">
          <div className="font-display text-lg" style={{ color: CAT_COLORS[level.id] }}>{score}</div>
          <div className="font-body text-xs" style={{ color: c.textFaint }}>{movesLeft} moves left</div>
        </div>
      </div>

      <div className="w-full h-2 rounded-full mb-2 overflow-hidden" style={{ background: c.border }}>
        <div style={{ width: `${Math.min(100, (score / level.target) * 100)}%`, height: "100%", background: CAT_COLORS[level.id], transition: "width 0.3s" }} />
      </div>

      {/* The Wind of Forgetting closing in as moves run out — tension bar, not just a countdown. */}
      <div className="flex items-center gap-2 mb-4">
        <Wind size={13} style={{ color: dangerLevel > 0.6 ? "#E0433D" : c.textFaint }} />
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: c.border }}>
          <div style={{ width: `${dangerLevel * 100}%`, height: "100%", background: dangerLevel > 0.6 ? "#E0433D" : "#8a8a8a", transition: "width 0.3s" }} />
        </div>
        <button onClick={useHint} className="flex items-center gap-1 font-body text-xs" style={{ color: c.accent }}>
          <Lightbulb size={13} /> Hint
        </button>
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: `repeat(${GRID}, 1fr)`, gap: 4,
        background: c.surface, border: `1px solid ${c.border}`, borderRadius: 16, padding: 8,
      }}>
        {board && board.map((row, r) => row.map((t, cIdx) => {
          const isSel = selected && selected.r === r && selected.c === cIdx;
          const isHint = hint && hint.some((h) => h.r === r && h.c === cIdx);
          const w = level.words[t.type];
          const glowClass = isSel ? "candy-selected" : t.special ? "candy-special" : "";
          return (
            <button key={`${r}-${cIdx}`} onClick={() => onTapCell(r, cIdx)}
              style={{
                aspectRatio: "1", display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: 10,
                background: isSel ? CANDY_PALETTE[t.type] + "33" : isHint ? "#E8B92333" : "transparent",
                border: isSel ? `2px solid ${CANDY_PALETTE[t.type]}` : isHint ? "2px solid #E8B923" : "2px solid transparent",
                transition: "transform 0.15s", transform: isSel ? "scale(1.08)" : "scale(1)",
              }}>
              <CandyTile level={level.id} word={w.id} colorIndex={t.type} special={t.special} size={32} className={glowClass} />
            </button>
          );
        }))}
      </div>

      {lessonWord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(20,14,8,0.72)" }} onClick={closeLesson}>
          <div className="page-card rounded-2xl p-6 max-w-xs w-full relative" onClick={(e) => e.stopPropagation()}
            style={{
              background: "linear-gradient(155deg, #F6ECD2 0%, #EFDFB8 100%)",
              border: "2px solid #A9824F", boxShadow: "0 16px 40px rgba(0,0,0,0.45)", color: "#3C2E1A",
            }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div style={{ position: "relative", top: -6 }}><Nkhono size={30} /></div>
                <span className="font-body text-[10px] uppercase tracking-widest" style={{ color: "#8a6f42" }}>
                  Page recovered
                </span>
              </div>
              <button onClick={(e) => { e.stopPropagation(); replayLesson(); }} style={{ color: "#8a6f42" }} aria-label="Read aloud again">
                <Volume2 size={16} />
              </button>
            </div>

            {lessonWord.isNew && (
              <div className="page-line flex items-center gap-1.5 mb-2 font-body text-xs font-bold" style={{ color: CAT_COLORS[lessonWord.levelId], animationDelay: "0.05s" }}>
                <Sparkles size={13} /> First time recovering this word!
              </div>
            )}

            <div className="page-line font-display text-3xl mb-1" style={{ color: CAT_COLORS[lessonWord.levelId], animationDelay: "0.1s" }}>
              {lessonWord.word.sesotho}
            </div>
            {PLURALS[lessonWord.word.id] && (
              <div className="page-line font-body text-xs mb-3 italic" style={{ color: "#8a6f42", animationDelay: "0.15s" }}>
                plural: {PLURALS[lessonWord.word.id]}
              </div>
            )}

            <div className="page-line space-y-1 mb-4 font-body text-sm" style={{ animationDelay: "0.2s" }}>
              <div><span className="font-bold">English</span> — {lessonWord.word.english}</div>
              <div><span className="font-bold">Shona</span> — {lessonWord.word.shona}</div>
              <div><span className="font-bold">isiZulu</span> — {lessonWord.word.isizulu}</div>
            </div>

            <div className="page-line font-body text-xs leading-relaxed pt-3" style={{ borderTop: "1px dashed #A9824F", color: "#5a4a30", animationDelay: "0.3s" }}>
              {lessonWord.lesson}
            </div>

            <div className="page-tap-hint text-center font-body text-[11px] mt-4" style={{ color: "#8a6f42" }}>
              Tap anywhere to continue
            </div>
          </div>
        </div>
      )}

      {hypeToast && (
        <div className="fixed left-1/2 top-24 z-40 font-display text-2xl pointer-events-none"
          style={{ transform: "translateX(-50%)", color: CAT_COLORS[level.id], textShadow: "0 2px 8px rgba(0,0,0,0.35)" }}>
          {hypeToast}
        </div>
      )}

      {outcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="rounded-2xl p-6 text-center max-w-xs w-full" style={{ background: c.surface, border: `2px solid ${outcome === "won" ? "#2FA84F" : c.border}` }}>
            {outcome === "won" ? (
              <>
                <div className="flex justify-center gap-1 mb-2">
                  {[0, 1, 2].map((s) => <Star key={s} size={26} fill={s < starsFor(score, level.target) ? "#E8B923" : "none"} color={s < starsFor(score, level.target) ? "#E8B923" : c.border} />)}
                </div>
                <PlayerCharacter pose="celebrate" kitColor={CAT_COLORS[level.id]} size={90} />
                <div className="font-display text-xl mt-2 mb-1" style={{ color: c.text }}>Page recovered!</div>
                <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>{score} points</div>
              </>
            ) : (
              <>
                <Wind size={40} style={{ color: "#E0433D" }} className="mx-auto mb-2" />
                <div className="font-display text-xl mt-2 mb-1" style={{ color: c.text }}>The Wind got there first</div>
                <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>{score} / {level.target} points — try again?</div>
              </>
            )}
            <div className="flex flex-col gap-2">
              {outcome === "won" ? (
                <button onClick={backToMap} className="w-full flex items-center justify-center gap-2 rounded-xl py-3 font-display text-base" style={{ background: c.accent, color: c.accentText || "#fff" }}>
                  <Trophy size={16} /> Continue
                </button>
              ) : (
                <>
                  <button onClick={() => startLevel(levelIdx)} className="w-full flex items-center justify-center gap-2 rounded-xl py-3 font-display text-base" style={{ background: c.accent, color: c.accentText || "#fff" }}>
                    <RotateCcw size={16} /> Try again
                  </button>
                  <button onClick={backToMap} className="rounded-xl py-3 font-semibold" style={{ background: c.surfaceHover || c.surface, border: `1px solid ${c.border}` }}>
                    Back to map
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
