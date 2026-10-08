import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ArrowLeft, Trophy, RotateCcw, Dice1, Dice2, Dice3, Dice4, Dice5, Dice6,
  HelpCircle, X, Search, Bot, User, Skull, Shield, Zap, Combine,
  Volume2, VolumeX, Send, Flame, Rocket, Music, Lock, Unlock,
} from "lucide-react";
import { ludoSpeech, useLudoSpeakingId } from "./ludoVoice.js";
import { sfx } from "./ludoSound.js";
import { supabase } from "./supabaseClient.js";
import {
  pick, CAPTURE_LINES, EXIT_LINES, FINISH_LINES, COMBINE_LINES, SAFE_LINES, PLAIN_LINES,
  FORCED_LINES, NO_MOVE_LINES, JUMP_LINES, FORFEIT_LINES, CAPTURE_LABELS, MULTI_CAPTURE_LABEL,
} from "./ludoBanter.js";

// ---------------------------------------------------------------------------
// BOARD GEOMETRY. TRACK is a hand-verified, rotationally-symmetric 52-cell
// closed loop: one 13-cell quadrant per color, each the 90°-rotation of the
// last (rot(r,c) = (c, 14-r) — the same rotation the STRETCH arrays below
// already use). Every consecutive pair, including the wraparound, is a real
// orthogonal step — EXCEPT at 4 intentional "corner cuts" near the center,
// one per quadrant, where the path bends without a token ever landing on
// the actual corner cell of the center 3x3 block. Those 4 cells are
// excluded from TRACK on purpose: no color's step count ever reaches them,
// so a move never stops there — they fall through to the plain decorative
// center-hub styling instead, same as the middle trophy cell. Because the
// quadrants are true rotations of each other, all 4 starting squares land
// exactly 13 cells apart (12 squares between one start and the next),
// evenly all the way around. Moves render as a jump to the new square
// (matching the dice) rather than an animated walk, so the one place this
// isn't pixel-adjacent — a color's last shared square before its own home
// column — never actually shows.
const TRACK = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],  // corner cut: skips [6, 6]
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7], [0, 8],
  [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],  // corner cut: skips [6, 8]
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], [7, 14], [8, 14],
  [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],  // corner cut: skips [8, 8]
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7], [14, 6],
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],  // corner cut: skips [8, 6]
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0], [7, 0], [6, 0],
];
const TRACK_LEN = TRACK.length; // 52
const START_INDEX = { red: 0, green: 13, yellow: 26, blue: 39 };
// Only the 4 starting squares are safe — one per color, at each color's own
// entry point onto the shared track. (Ludo traditionally also marks 4 extra
// "star" squares safe; those are removed here on purpose.) Since these are
// absolute track positions, this makes a color's start square safe for
// EVERYONE's tokens, not just its own — the same as the traditional rule.
const SAFE_INDICES = new Set(Object.values(START_INDEX));
const STRETCH = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
};
const STRETCH_LEN = 6;
const HOME_STEP = TRACK_LEN + STRETCH_LEN - 1;
const YARD_ORIGIN = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };
const COLORS = {
  red: { name: "Red", hex: "#E0433D", dim: "#E0433D33" },
  green: { name: "Green", hex: "#2FA84F", dim: "#2FA84F33" },
  yellow: { name: "Yellow", hex: "#E8B923", dim: "#E8B92333" },
  blue: { name: "Blue", hex: "#3B7FE0", dim: "#3B7FE033" },
};
const COLOR_ORDER = ["red", "green", "yellow", "blue"];
const DICE_ICONS = [Dice1, Dice2, Dice3, Dice4, Dice5, Dice6];

function absCellForStep(color, step) {
  if (step < TRACK_LEN) return TRACK[(START_INDEX[color] + step) % TRACK_LEN];
  return STRETCH[color][step - TRACK_LEN];
}
function isSafeStep(color, step) {
  if (step >= TRACK_LEN) return true;
  return SAFE_INDICES.has((START_INDEX[color] + step) % TRACK_LEN);
}
function freshTokens() { return [0, 1, 2, 3].map((i) => ({ id: i, step: -1 })); }
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const rollOne = () => 1 + Math.floor(Math.random() * 6);

// ---- pure game-logic helpers, shared by the human UI and the AI loop -----

// Every legal thing the current player could do with their current dice.
// kind: 'exit' (single die, needs an actual 6 — no house-rule substitutes) |
// 'move' (single die) | 'combine' (both dice unused, sum moves one token,
// never used to exit the yard).
function computeActions(color, dice, diceUsed, tokensByColor) {
  const list = tokensByColor[color] || [];
  const actions = [];
  [0, 1].forEach((i) => {
    if (diceUsed[i]) return;
    const v = dice[i];
    list.forEach((tk) => {
      if (tk.step === -1) {
        if (v === 6 && !tk.heldBy) actions.push({ kind: "exit", die: i, tokenId: tk.id, fromStep: -1, resultStep: 0, dist: v });
      } else if (tk.step < HOME_STEP) {
        const ns = tk.step + v;
        if (ns <= HOME_STEP) actions.push({ kind: "move", die: i, tokenId: tk.id, fromStep: tk.step, resultStep: ns, dist: v });
      }
    });
  });
  // No real reason to block combining a double (2+2, 5+5, etc) — it's
  // just as valid a move as combining two different values, and the old
  // "dice[0] !== dice[1]" restriction here was the actual cause of the
  // "combine sometimes doesn't respond" bug: the UI showed the combine
  // total whenever both dice were selected regardless of this check, so
  // on a double it displayed a total that led nowhere and no token
  // highlighted for it. Removed.
  if (!diceUsed[0] && !diceUsed[1]) {
    const sum = dice[0] + dice[1];
    list.forEach((tk) => {
      if (tk.step >= 0 && tk.step < HOME_STEP) {
        const ns = tk.step + sum;
        if (ns <= HOME_STEP) actions.push({ kind: "combine", tokenId: tk.id, fromStep: tk.step, resultStep: ns, dist: sum });
      }
    });
  }
  return actions;
}

// Applies one action to a (shallow-copied) tokens-by-color map. Never
// mutates its input — always returns a new map, safe for both a React
// state updater and the AI's own local working copy.
function applyAction(action, color, tokensByColor, active) {
  const next = { ...tokensByColor };
  next[color] = (tokensByColor[color] || []).map((tk) => tk.id === action.tokenId ? { ...tk, step: action.resultStep, heldBy: null } : tk);
  let captured = false, capturedColor = null;
  if (action.resultStep >= 0 && action.resultStep < TRACK_LEN && !isSafeStep(color, action.resultStep)) {
    const [ar, ac] = absCellForStep(color, action.resultStep);
    active.filter((oc) => oc !== color).forEach((oc) => {
      next[oc] = (next[oc] || tokensByColor[oc] || []).map((ox) => {
        if (ox.step === -1 || ox.step >= TRACK_LEN) return ox;
        const [orr, occ] = absCellForStep(oc, ox.step);
        if (orr === ar && occ === ac) { captured = true; capturedColor = oc; return { ...ox, step: -1, heldBy: color }; }
        return ox;
      });
    });
  }
  const finished = action.resultStep === HOME_STEP;
  const diceUsedIdx = action.kind === "combine" ? [0, 1] : [action.die];
  return { tokens: next, captured, capturedColor, finished, diceUsedIdx };
}

function isDangerous(color, resultStep, tokensByColor, active) {
  if (resultStep < 0 || resultStep >= TRACK_LEN || isSafeStep(color, resultStep)) return false;
  const [ar, ac] = absCellForStep(color, resultStep);
  for (const oc of active) {
    if (oc === color) continue;
    for (const ox of (tokensByColor[oc] || [])) {
      if (ox.step === -1 || ox.step >= TRACK_LEN) continue;
      for (let d = 1; d <= 6; d++) {
        const s = ox.step + d;
        if (s >= TRACK_LEN) continue;
        const [orr, occ] = absCellForStep(oc, s);
        if (orr === ar && occ === ac) return true;
      }
    }
  }
  return false;
}

function scoreAction(action, color, tokensByColor, active) {
  const sim = applyAction(action, color, tokensByColor, active);
  let score = (action.dist || 6) * 1.5;
  const dangerBefore = action.fromStep >= 0 && isDangerous(color, action.fromStep, tokensByColor, active);
  const dangerAfter = isDangerous(color, action.resultStep, sim.tokens, active);
  const safeAfter = action.resultStep < TRACK_LEN && isSafeStep(color, action.resultStep);
  if (sim.captured) score += 1000;
  if (sim.finished) score += 500;
  if (action.kind === "exit") score += 70;
  if (safeAfter) score += 35;
  if (dangerAfter) score -= 55;
  if (dangerBefore) score += 15; // extra credit for escaping danger
  return { score, sim, dangerBefore, dangerAfter, safeAfter };
}

// ---- "obvious move" logic ---------------------------------------------
// When only ONE piece can move (tokens sitting in the yard count as one
// piece — they're identical), there is no decision to make, so the game
// plays it. Two things follow from that:
//  * The piece is forced to use BOTH dice, so it can't stop halfway to eat
//    something and carry on — it jumps clean over anyone it could have eaten
//    with one die, and only captures if it *ends* on them. That's exactly what
//    the combined move does, so we use it whenever it's available.
//  * If the two dice can't be combined (the total would overshoot home), it
//    plays whichever single die scores best.
// Returns a scored-entry shaped like the AI's own picks, or null when the
// player has a real choice.
function forcedAction(color, dice, actions, tokensByColor, active) {
  if (!actions.length) return null;
  if (new Set(actions.map((a) => a.fromStep)).size !== 1) return null;
  const scoredAll = actions.map((a) => ({ a, ...scoreAction(a, color, tokensByColor, active) }));
  const combo = scoredAll.find((x) => x.a.kind === "combine");
  const chosen = combo || scoredAll.sort((x, y) => y.score - x.score)[0];
  let jumped = null;
  if (chosen.a.kind === "combine") {
    // Would either die alone have landed on (and eaten) somebody? If so, this
    // move is a "jump" — worth a joke.
    [0, 1].forEach((i) => {
      if (jumped) return;
      const ns = chosen.a.fromStep + dice[i];
      if (ns > HOME_STEP) return;
      const single = { kind: "move", die: i, tokenId: chosen.a.tokenId, fromStep: chosen.a.fromStep, resultStep: ns, dist: dice[i] };
      const sim = applyAction(single, color, tokensByColor, active);
      if (sim.captured) jumped = sim.capturedColor;
    });
  }
  return { ...chosen, forced: true, jumped };
}

// Each color's a little personality, spliced onto the end of a spoken line
// now and then (rarely — the old 35% made the voice repeat itself).
const PERSONALITY_ASIDE = {
  red: ["🔥 Typical Red.", "🔥 No chill, as usual."],
  green: ["🐍 Sneaky as ever.", "🐍 Quietly menacing."],
  yellow: ["🌀 Pure chaos.", "🌀 Unhinged, honestly."],
  blue: ["🧊 Ice cold.", "🧊 Cold-blooded."],
};
function withAside(line, color) {
  if (Math.random() > 0.15) return line;
  return `${line} ${pick(PERSONALITY_ASIDE[color] || [""])}`.trim();
}

// The "why" — shown in the log for learners, but NOT read aloud (long
// sentences are the main reason the voice sounded like a robot).
const REASON_ESCAPE = [
  " Had to get out of there before it got ugly.",
  " Something was breathing down its neck — bailed just in time.",
  " That square was about to get very unsafe.",
];
const REASON_SAFE_PICK = [
  " Nothing touches it there.",
  " Small move, zero risk.",
];
const REASON_RISK = [
  " Risky, but it's the only real option on the table.",
  " Knows it's exposed. Doing it anyway.",
];
const REASON_PLAIN = [
  " Just building position for later.",
  " Nothing flashy, just progress.",
];

// Returns { text, spoken }: `text` goes in the battle log, `spoken` (the
// short funny line only) is what gets read aloud.
function explainAction(action, color, sim, dice, meta) {
  const name = COLORS[color].name;
  let line;
  if (sim.captured) line = pick(CAPTURE_LINES)(name, COLORS[sim.capturedColor].name);
  else if (sim.finished) line = pick(FINISH_LINES)(name);
  else if (meta?.jumped) line = pick(JUMP_LINES)(name, COLORS[meta.jumped].name);
  else if (action.kind === "exit") line = pick(EXIT_LINES)(name);
  else if (meta?.forced) line = pick(FORCED_LINES)(name);
  else if (action.kind === "combine") line = pick(COMBINE_LINES)(name, dice[0] + dice[1]);
  else if (meta?.safeAfter) line = pick(SAFE_LINES)(name);
  else line = pick(PLAIN_LINES)(name, action.dist);
  line = withAside(line, color);

  let text = line;
  if (!sim.captured && !sim.finished && !meta?.forced) {
    if (meta?.dangerBefore && !meta?.dangerAfter) text += pick(REASON_ESCAPE);
    else if (meta?.safeAfter && action.kind !== "exit") text += pick(REASON_SAFE_PICK);
    else if (meta?.dangerAfter) text += pick(REASON_RISK);
    else if (Math.random() < 0.4) text += pick(REASON_PLAIN);
  }
  return { text, spoken: line, quiet: !sim.captured && !sim.finished && action.kind !== "exit" && !meta?.jumped };
}

const SINGLE_CAPTURE_LABELS = CAPTURE_LABELS;

// Particle burst geometry for the big capture banner (computed once).
const BURST = Array.from({ length: 14 }, (_, i) => {
  const ang = (i / 14) * Math.PI * 2;
  const r = 95 + (i % 3) * 38;
  return { dx: Math.round(Math.cos(ang) * r), dy: Math.round(Math.sin(ang) * r), size: 18 + (i % 4) * 7, delay: (i % 3) * 45 };
});

// ---------------------------------------------------------------------------
// Help modal — same look as the real Rules panel (header/icon/title/X,
// a search box, mono-uppercase section headings, dotted bullet list) with
// the heavier bits (text-to-speech, cross-category search, recent-search
// history) left out — this is one game's rules, not the whole rulebook.
const LUDO_RULES_SECTIONS = [
  { heading: "Objective", items: ["Get all 4 of your tokens from your yard, around the board, and into your home column before anyone else does."] },
  { heading: "Setup", items: [
    "2 to 4 colors play. Tap a color to cycle it: off, Human, AI.",
    "Any mix of Human and AI is fine — even 4 AIs will play each other, if you just want to watch.",
    "New to Ludo? Turn on \"AI explains its moves\" before you start — every AI turn narrates why it played that move, which doubles as a running example of good play.",
  ]},
  { heading: "Rolling", items: [
    "You roll two dice every turn, not one.",
    "A token only leaves the yard on an actual 6, on either die — nothing else counts, no house rules.",
    "Tap one die to move a token by just that number, or tap both dice to combine them and move one token by the total (combining never brings a token out of the yard — only a lone 6 does that).",
    "You can't overshoot your home square — the exact number is needed to finish a token.",
  ]},
  { heading: "Capturing", items: [
    "Land exactly on a square an opponent occupies and their token is sent straight back to their yard.",
    "Only the 4 starting squares are safe — no captures ever happen there.",
    "A capture earns you another roll, on top of anything from 6-6.",
  ]},
  { heading: "Obvious moves", items: [
    "If only one piece can move, the game plays it for you — no tapping needed.",
    "A lone piece must use both dice, so it can't stop halfway to eat and carry on. It jumps over anyone it could have eaten with one die, and only captures if it lands on them at the very end.",
  ]},
  { heading: "Extra rolls & forfeits", items: [
    "Roll 6 and 6 together (12 total) and you get another roll after you finish using this pair — any other matching pair (2-2, 3-3, etc) does not.",
    "Three 6-6 rolls in a row forfeits your turn — no moves from that third pair.",
  ]},
  { heading: "Home stretch", items: [
    "Each color has its own private run-in near the center — opponents can never land there, and there's nothing to capture.",
  ]},
  { heading: "AI opponents", items: [
    "An AI color rolls and plays itself, no input needed.",
    "Turn explanations on/off (top of the board) controls whether the AI says why it played each move.",
    "The AI favors captures, finishing a token, and safety — it'll duck out of range of your tokens when it can.",
  ]},
];

function LudoHelpModal({ onClose, c }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const sections = q
    ? LUDO_RULES_SECTIONS.map((s) => ({ ...s, items: s.items.filter((it) => it.toLowerCase().includes(q)) })).filter((s) => s.items.length)
    : LUDO_RULES_SECTIONS;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl p-5 max-h-[85vh] flex flex-col" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-2">
            <Dice5 size={18} style={{ color: c.accent }} />
            <h2 className="text-xl font-extrabold uppercase tracking-tight" style={{ color: c.text }}>Ludo Rules</h2>
          </div>
          <button aria-label="Close" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>
        <div className="relative mb-4 shrink-0">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
          <input
            type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search rules — e.g. capture, safe, dice..."
            className="w-full font-body text-sm rounded-xl pl-9 pr-8 py-2.5 outline-none"
            style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}
          />
          {query && (
            <button onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full" style={{ color: c.textFaint }}>
              <X size={12} />
            </button>
          )}
        </div>
        <div className="space-y-5 overflow-y-auto">
          {sections.length ? sections.map((s) => (
            <div key={s.heading}>
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>{s.heading}</div>
              <ul className="space-y-1.5">
                {s.items.map((it, i) => (
                  <li key={i} className="font-body text-sm flex items-start gap-2 leading-snug" style={{ color: c.textDim }}>
                    <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: c.textFaint }} />
                    <span>{it}</span>
                  </li>
                ))}
              </ul>
            </div>
          )) : (
            <div className="font-body text-sm text-center py-8" style={{ color: c.textFaint }}>No rules match "{query}".</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LudoPage({ onBack, c, loggedIn, onRequireAuth, onFindOpponents }) {
  const [phase, setPhase] = useState("setup"); // setup | playing | won
  const [active, setActive] = useState([]);
  const [roles, setRoles] = useState({}); // color -> 'human' | 'ai'
  const [aiExplain, setAiExplain] = useState(true);
  const [readAloud, setReadAloud] = useState(false);
  const [sfxOn, setSfxOn] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  const [tokens, setTokens] = useState({});
  const [turnIdx, setTurnIdx] = useState(0);
  const turnIdxRef = useRef(0); // always-current mirror of turnIdx, so timer-driven callbacks can read the real value instead of a stale closure
  turnIdxRef.current = turnIdx;
  const [dice, setDice] = useState(null);
  const [diceUsed, setDiceUsed] = useState([false, false]);
  const [rolling, setRolling] = useState(false);
  const [selectedDice, setSelectedDice] = useState([]); // indices of dice the player has tapped, in tap order (max 2)
  const [rollAgainStreak, setRollAgainStreak] = useState(0);
  const [rerollTick, setRerollTick] = useState(0); // bumps on EVERY granted reroll (double-6 or capture) so effects keyed to "same player rolls again" always refire
  const [turnCaptures, setTurnCaptures] = useState(0);
  const [message, setMessage] = useState("");
  const [log, setLog] = useState([]); // {id, text, color, speak}[]
  const [celebrate, setCelebrate] = useState(null); // {text, sub, color, level, gold, key} — the big dramatic banner
  const [shaking, setShaking] = useState(false);
  const [stats, setStats] = useState({ captures: 0, finishes: 0 });
  const [commentText, setCommentText] = useState("");
  const [winner, setWinner] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

  const epochRef = useRef(0); // bumped every new turn; AI loop checks it to abort if stale
  const celebrateTimer = useRef(null);
  const shakeTimer = useRef(null);
  const logIdRef = useRef(0);
  const celebrateKeyRef = useRef(0);
  const turnCapsRef = useRef(0); // captures this turn — a ref, so logging never runs inside a state updater
  const rollCapturedRef = useRef(false); // did THIS roll (current pair of dice) land a capture? drives the capture-bonus reroll
  const [yardChoice, setYardChoice] = useState(null); // {dice, tokens: [...yard tokenIds]} — double-6 with 2+ tokens waiting, asking the human how many to bring out
  const [buybackChoice, setBuybackChoice] = useState(null); // {dice, die, captors: [color...], chosenCaptor} — a six is available and this color has a captive token to maybe ransom back
  const [bankedSix, setBankedSix] = useState({}); // { [color]: count } — a captor whose hostage just got ransomed away is owed a guaranteed 6 on their own next turn, as compensation
  const bankedSixRef = useRef({}); // synchronous source of truth for bankedSix — a buyback that spends the last die advances the turn in the very same tick, before React would have committed the state update
  const bumpBankedSix = (color, delta) => {
    const cur = bankedSixRef.current[color] || 0;
    bankedSixRef.current = { ...bankedSixRef.current, [color]: Math.max(0, cur + delta) };
    setBankedSix(bankedSixRef.current);
  };
  const pendingForcedSixRef = useRef(null); // color currently owed that forced 6 on their NEXT roll (cleared the instant it's used)
  const buybackDeclinedRef = useRef(new Set()); // keys of (dice pair + die index) the player already said "wait" to, so we don't re-nag them about the same six
  const [frozenTokenIds, setFrozenTokenIds] = useState(() => new Set()); // tokenIds that captured something THIS roll — locked out of acting again until the next roll, so a capture can't be chained into a second, unrelated move with the leftover die
  useEffect(() => () => { if (celebrateTimer.current) clearTimeout(celebrateTimer.current); if (shakeTimer.current) clearTimeout(shakeTimer.current); }, []);
  useEffect(() => { sfx.enabled = sfxOn; }, [sfxOn]);
  useEffect(() => () => ludoSpeech.stop(), []); // don't leave a voice talking after leaving the page
  const speakingId = useLudoSpeakingId();

  const turnColor = active[turnIdx];

  const shakeBoard = useCallback(() => {
    setShaking(true);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShaking(false), 550);
  }, []);

  // opts: { big, color, speak, spoken } — `big` is {text, sub, color, level,
  // gold} for the full-board banner; color/speak pick the read-aloud voice
  // and whether this line auto-reads when "Read moves aloud" is on; `spoken`
  // is the short version to actually say (defaults to the log text).
  const pushLog = useCallback((text, opts = {}) => {
    const id = ++logIdRef.current;
    setLog((l) => [{ id, text, color: opts.color || null }, ...l].slice(0, 10));
    if (opts.big) {
      celebrateKeyRef.current += 1;
      setCelebrate({ ...opts.big, key: celebrateKeyRef.current });
      if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
      celebrateTimer.current = setTimeout(() => setCelebrate(null), 2100);
    }
    if (readAloud && opts.speak) ludoSpeech.speak(`log-${id}`, opts.spoken || text, opts.color);
    return id;
  }, [readAloud]);

  const postComment = () => {
    const text = commentText.trim();
    if (!text) return;
    pushLog(`💬 ${text}`, {});
    setCommentText("");
  };

  // ---- setup ---------------------------------------------------------
  const cycleColor = (color) => {
    setRoles((r) => {
      const cur = r[color];
      const next = { ...r };
      if (!cur) { next[color] = "human"; }
      else if (cur === "human") { next[color] = "ai"; }
      else { delete next[color]; }
      return next;
    });
  };
  const anyAI = Object.values(roles).some((r) => r === "ai");

  const startGame = (rolesOverride) => {
    const useRoles = rolesOverride || roles;
    if (rolesOverride) setRoles(rolesOverride);
    const order = COLOR_ORDER.filter((c2) => useRoles[c2]);
    const t = {};
    order.forEach((c2) => { t[c2] = freshTokens(); });
    sfx.unlock();
    turnCapsRef.current = 0;
    bankedSixRef.current = {};
    setBankedSix({});
    pendingForcedSixRef.current = null;
    setFrozenTokenIds(new Set());
    setBuybackChoice(null);
    setYardChoice(null);
    epochRef.current += 1;
    setActive(order);
    setTokens(t);
    setTurnIdx(0);
    setDice(null);
    setDiceUsed([false, false]);
    setSelectedDice([]);
    setRollAgainStreak(0);
    setTurnCaptures(0);
    setCelebrate(null);
    setStats({ captures: 0, finishes: 0 });
    setWinner(null);
    setLog([]);
    setMessage(`${COLORS[order[0]].name}'s turn — roll the dice.`);
    setPhase("playing");
    // Usage tracking: one row per game started, reusing the app's existing
    // generic activity log rather than a new table. Best-effort only — a
    // signed-out guest has no insert policy for this table, and any other
    // failure here is silently swallowed, since a tracking hiccup should
    // never interrupt someone's game.
    (async () => {
      try {
        const { data: { user } = {} } = await supabase.auth.getUser();
        if (!user) return;
        await supabase.from("user_activity_log").insert({
          user_id: user.id,
          event_type: "ludo_game_started",
          metadata: {
            players: order.length,
            vs_bots: order.filter((c2) => useRoles[c2] === "ai").length,
          },
        });
      } catch {
        // tracking is non-essential — never let it affect the game
      }
    })();
  };

  // One tap, straight into a game: you're Red, everyone else is a bot.
  // The fastest way to actually see the AI banter/read-aloud in action.
  const quickPlayVsBots = () => startGame({ red: "human", green: "ai", yellow: "ai", blue: "ai" });
  const resetToSetup = () => {
    epochRef.current += 1;
    ludoSpeech.stop();
    setPhase("setup");
    setActive([]);
    setTokens({});
    setWinner(null);
    setAiBusy(false);
  };

  // ---- turn flow -------------------------------------------------------
  const reallyAdvanceTurn = useCallback(() => {
    epochRef.current += 1;
    setDice(null);
    setDiceUsed([false, false]);
    setSelectedDice([]);
    setRollAgainStreak(0);
    turnCapsRef.current = 0;
    setTurnCaptures(0);
    // Computed OUTSIDE the state updater on purpose: the banked-six payout
    // below logs, decrements a counter and sets a ref — none of which is
    // safe to repeat, and React may run an updater function twice.
    const next = (turnIdxRef.current + 1) % active.length;
    const nextColor = active[next];
    // Compensation for losing a hostage to a ransom while it was this
    // color's captive: their very next roll is guaranteed a 6 on one
    // die, flagged here and actually applied the moment that roll
    // happens (see rollDice and the AI's own fresh-roll branch).
    if ((bankedSixRef.current[nextColor] || 0) > 0) {
      pendingForcedSixRef.current = nextColor;
      bumpBankedSix(nextColor, -1);
      pushLog(`🎲 ${COLORS[nextColor].name} has a six to play — saved from that ransom!`, {
        big: { text: "YOU HAVE A SIX TO PLAY!", sub: `${COLORS[nextColor].name} gets a guaranteed 6`, color: nextColor, level: 0 },
        color: nextColor, speak: true, spoken: `${COLORS[nextColor].name} has a six to play!`,
      });
    }
    setMessage(`${COLORS[nextColor].name}'s turn — roll the dice.`);
    setTurnIdx(next);
  }, [active, pushLog]);

  // Only an actual 12 (which on two six-sided dice can only ever be 6+6)
  // earns another roll — not any other matching pair (2+2, 3+3, etc).
  const resolveEndOfDice = useCallback((finalDice) => {
    const d = finalDice;
    const rolledDouble6 = d[0] + d[1] === 12;
    // A capture earns another roll too, same as 6-6 — but it doesn't count
    // toward the "three 6-6 in a row" forfeit streak, since that streak is
    // specifically about doubles, not about being on a hot streak of kills.
    const capturedThisRoll = rollCapturedRef.current;
    if (rolledDouble6) {
      setRollAgainStreak((s) => {
        const next = s + 1;
        if (next >= 3) {
          pushLog(pick(FORFEIT_LINES)(COLORS[turnColor].name), { color: turnColor, speak: true });
          sfx.forfeit();
          setMessage("Three 6-6 rolls in a row — turn forfeited!");
          setTimeout(() => reallyAdvanceTurn(), 700);
          return 0;
        }
        setDice(null);
        setDiceUsed([false, false]);
        setSelectedDice([]);
        setRerollTick((t) => t + 1);
        setMessage(capturedThisRoll ? `6 and 6, plus a kill! ${COLORS[turnColor].name} rolls again.` : `6 and 6! ${COLORS[turnColor].name} rolls again.`);
        return next;
      });
    } else if (capturedThisRoll) {
      setDice(null);
      setDiceUsed([false, false]);
      setSelectedDice([]);
      setRerollTick((t) => t + 1);
      setMessage(`Capture bonus! ${COLORS[turnColor].name} rolls again.`);
    } else {
      reallyAdvanceTurn();
    }
  }, [turnColor, reallyAdvanceTurn, pushLog]);

  // Shared by the human tap-flow and the AI loop's final human-visible
  // commit — applies one action to real React state, logs it, and figures
  // out what happens next (more actions available? both dice spent?).
  const commitAction = useCallback((action, color, snapshotTokens, snapshotDice, snapshotUsed, explain) => {
    const { tokens: nextTokens, captured, capturedColor, finished, diceUsedIdx } = applyAction(action, color, snapshotTokens, active);
    setTokens(nextTokens);

    const me = COLORS[color].name;
    if (action.kind === "buyback") {
      const captorName = COLORS[action.captor].name;
      const line = explain?.text || `${me} pays the ransom — token back in the yard, needs a fresh 6 to get moving!`;
      pushLog(`🔓 ${line}`, {
        big: { text: "RANSOM PAID!", sub: `${me} frees a token from ${captorName} — needs another 6 to exit`, color, level: 0 },
        color, speak: true, spoken: explain?.spoken || `${me} buys their token back from ${captorName} — still needs a six to get out!`,
      });
      sfx.buyback();
      // The captor loses their hostage, but they're owed a guaranteed 6 on
      // their own next turn as compensation — banked here, paid out (and
      // announced) in reallyAdvanceTurn once it's actually their turn.
      if (active.includes(action.captor)) {
        bumpBankedSix(action.captor, 1);
      }
    } else if (captured) {
      shakeBoard();
      rollCapturedRef.current = true;
      // This token already got its kill — it sits out the rest of the
      // roll rather than chaining straight into a second, unrelated move
      // with whichever die is left.
      setFrozenTokenIds((s) => new Set(s).add(action.tokenId));
      setStats((s2) => ({ ...s2, captures: s2.captures + 1 }));
      turnCapsRef.current += 1;
      const n = turnCapsRef.current;
      setTurnCaptures(n);
      const opp = COLORS[capturedColor].name;
      const label = n === 1 ? pick(SINGLE_CAPTURE_LABELS) : (MULTI_CAPTURE_LABEL[n] || "RAMPAGE!");
      const line = explain?.text || pick(CAPTURE_LINES)(me, opp);
      const logId = pushLog(`💥 ${line}`, {
        big: { text: label, sub: `${me} ate ${opp} — held captive until bought back!`, color, level: n },
        color, speak: true, spoken: explain?.spoken || line,
      });
      sfx.whoosh();
      sfx.capture(n);
      // A Dota2-style announcer cry on a real streak (2+ captures in one
      // turn) — the short punchy label itself, queued right after the
      // normal banter line so it reads as "...and ATE GREEN! ...DOUBLE KILL!"
      if (n >= 2 && readAloud) ludoSpeech.speak(`announce-${logId}`, label, color);
    } else if (finished) {
      setStats((s2) => ({ ...s2, finishes: s2.finishes + 1 }));
      const line = explain?.text || pick(FINISH_LINES)(me);
      pushLog(`🏆 ${line}`, {
        big: { text: "HOME!", sub: `${me} gets a token home`, color, level: 0, gold: true },
        color, speak: true, spoken: explain?.spoken || line,
      });
      sfx.home();
    } else {
      // Quiet moves: a soft step sound; exits and safe squares get their own.
      if (action.kind === "exit") sfx.exit();
      else if (action.resultStep < TRACK_LEN && isSafeStep(color, action.resultStep)) sfx.safe();
      else sfx.step();
      const line = explain || (action.kind === "exit" ? (() => { const t = pick(EXIT_LINES)(me); return { text: t, spoken: t, quiet: false }; })() : null);
      // Plain moves are only read aloud some of the time so the voice doesn't
      // drone on; exits and jumps always are.
      if (line) pushLog(line.text, { color, speak: !line.quiet || Math.random() < 0.55, spoken: line.spoken });
    }

    const newUsed = [...snapshotUsed];
    diceUsedIdx.forEach((i) => { newUsed[i] = true; });

    const allHome = (nextTokens[color] || []).every((t) => t.step === HOME_STEP);
    if (allHome) {
      sfx.win();
      setWinner(color);
      setPhase("won");
      setDice(null);
      setSelectedDice([]);
      return { done: true, newUsed, nextTokens, captured, capturedTokenId: captured ? action.tokenId : null };
    }

    setDiceUsed(newUsed);
    setSelectedDice([]);

    let finalUsed = newUsed;
    if (newUsed[0] && newUsed[1]) {
      resolveEndOfDice(snapshotDice);
    } else {
      // The remaining die might have nothing to do at all -- if so, mark
      // it used right away instead of leaving the player stuck tapping a
      // dead die. This used to happen on a short delay, which could fire
      // at the same time as the AI's own turn loop separately noticing
      // the same dead die and ending the turn itself -- the turn could
      // get resolved twice, silently skipping the next player. Doing it
      // synchronously, right here, means it only ever happens once.
      const remaining = computeActions(color, snapshotDice, newUsed, nextTokens);
      if (remaining.length === 0) {
        finalUsed = [...newUsed];
        const idx = newUsed[0] ? 1 : 0;
        finalUsed[idx] = true;
        setDiceUsed(finalUsed);
        resolveEndOfDice(snapshotDice);
      }
    }
    return { done: false, newUsed: finalUsed, nextTokens, captured, capturedTokenId: captured ? action.tokenId : null };
  }, [active, resolveEndOfDice, pushLog, shakeBoard]);

  const rollDice = () => {
    if (rolling || dice != null || phase !== "playing" || aiBusy) return;
    rollCapturedRef.current = false;
    buybackDeclinedRef.current = new Set();
    setFrozenTokenIds(new Set());
    sfx.roll();
    setRolling(true);
    setMessage("");
    setCelebrate(null);
    let ticks = 0;
    const spin = setInterval(() => {
      setDice([rollOne(), rollOne()]);
      ticks++;
      if (ticks > 7) {
        clearInterval(spin);
        const d = [rollOne(), rollOne()];
        // A banked six (owed for losing a hostage to a ransom) pays out on
        // exactly this, the very first roll of this color's turn — not any
        // bonus reroll later in the same turn.
        if (pendingForcedSixRef.current === turnColor) {
          d[0] = 6;
          pendingForcedSixRef.current = null;
        }
        setDice(d);
        setRolling(false);
        setDiceUsed([false, false]);
        setSelectedDice([]);

        const actions = computeActions(turnColor, d, [false, false], tokens);
        if (actions.length === 0) {
          setMessage(`No moves for ${d[0]} & ${d[1]}.`);
          pushLog(pick(NO_MOVE_LINES)(COLORS[turnColor].name), { color: turnColor, speak: true });
          sfx.pass();
          setTimeout(() => resolveEndOfDice(d), 900);
        } else {
          setMessage(`${COLORS[turnColor].name} rolled ${d[0]} & ${d[1]} — tap a die, then a token.`);
        }
      }
    }, 65);
  };

  // ---- human interaction ----------------------------------------------
  const currentActions = useMemo(() => {
    if (dice == null || phase !== "playing") return [];
    const all = computeActions(turnColor, dice, diceUsed, tokens);
    if (!frozenTokenIds.size) return all;
    // A token that already captured once this roll sits out the rest of
    // it — no chaining a kill into an unrelated second move with the
    // leftover die. It's free to act again as soon as a new roll starts.
    return all.filter((a) => !frozenTokenIds.has(a.tokenId));
  }, [dice, diceUsed, tokens, turnColor, phase, frozenTokenIds]);

  // Selecting one die highlights the tokens that die alone can move.
  // Selecting both (tap the second die too) switches to combine mode —
  // one token moved by the total of both dice — the friendlier way to
  // reach combine than a separate button: just tap both dice.
  const armedActions = useMemo(() => {
    if (selectedDice.length === 1) {
      const i = selectedDice[0];
      return currentActions.filter((a) => (a.kind === "exit" || a.kind === "move") && a.die === i);
    }
    if (selectedDice.length === 2) {
      return currentActions.filter((a) => a.kind === "combine");
    }
    return [];
  }, [selectedDice, currentActions]);
  const movable = armedActions.map((a) => a.tokenId);

  const dieHasActions = (i) => currentActions.some((a) => (a.kind === "exit" || a.kind === "move") && a.die === i);
  const combineHasActions = currentActions.some((a) => a.kind === "combine");

  const tapDie = (i) => {
    if (roles[turnColor] === "ai" || diceUsed[i]) return;
    sfx.click();
    setSelectedDice((sel) => {
      if (sel.includes(i)) return sel.filter((x) => x !== i); // tap again to deselect
      if (sel.length >= 2) return [i]; // start a fresh selection rather than stack a 3rd
      const usableAlone = dieHasActions(i);
      const usableForCombo = combineHasActions && !diceUsed[1 - i];
      if (!usableAlone && !usableForCombo) return sel; // nothing this die can contribute
      return [...sel, i];
    });
  };

  // Tapping a token directly (no die pre-selected) auto-picks a die for it,
  // rather than forcing "tap a die, then tap a token" every time:
  //  - if a die is already selected, that explicit choice still wins
  //    (this is also how the two-dice "combine" mode keeps working)
  //  - otherwise, of the dice that can legally move THIS token, prefer
  //    whichever one shows a 6 (most valuable — getting a token out, or
  //    just using the best roll first); if neither is a 6, use the first
  //    die that can move it
  //  - releasing a second yard token afterward re-runs this same logic
  //    fresh, so it naturally picks up whichever die is left
  const onTokenTap = (tokenId) => {
    if (roles[turnColor] === "ai" || aiBusy) return;
    let action = armedActions.find((a) => a.tokenId === tokenId);
    if (!action && selectedDice.length === 0 && dice) {
      const options = currentActions.filter((a) => (a.kind === "exit" || a.kind === "move") && a.tokenId === tokenId);
      if (options.length) {
        const sixOption = options.find((a) => dice[a.die] === 6);
        action = sixOption || options[0];
      }
    }
    if (!action) return;
    // Tapping a yard token directly, with both dice still free and both
    // showing 6 and 2+ tokens waiting, is the same "release how many?"
    // decision as the double-6 auto-trigger below — route it to the same
    // prompt instead of silently exiting just the one that was tapped.
    if (action.kind === "exit" && dice && dice[0] === 6 && dice[1] === 6 && !diceUsed[0] && !diceUsed[1]) {
      const yardTokens = (tokens[turnColor] || []).filter((tk) => tk.step === -1);
      if (yardTokens.length >= 2) {
        const ids = [tokenId, ...yardTokens.map((tk) => tk.id).filter((id) => id !== tokenId)];
        setYardChoice({ dice, tokenIds: ids });
        return;
      }
    }
    commitAction(action, turnColor, tokens, dice, diceUsed, null);
  };

  // Auto-play the obvious move: when only ONE piece can move there's no real
  // decision, so just play it instead of making the player tap a die and
  // then a token. See forcedAction() above for the lone-piece "jump" rule.
  // Fires again after the move lands, in case the second die is now also
  // down to a single obvious option. Any turn with a real choice (2+ different
  // pieces) still waits for a tap.
  //
  // One exception: rolling double-6 with 2+ tokens still in the yard would
  // otherwise get silently swept up in this too — every yard token shares
  // the same "fromStep" (-1), so forcedAction() can't tell them apart from a
  // genuinely single piece. Since bringing tokens out is a real decision
  // (hold one back and safe in the yard, or release it into danger), we stop
  // and ask instead of deciding for the player.
  useEffect(() => {
    if (phase !== "playing" || !turnColor || roles[turnColor] === "ai" || aiBusy) return;
    if (dice == null || rolling || yardChoice || buybackChoice) return;
    const forced = forcedAction(turnColor, dice, currentActions, tokens, active);
    if (!forced) return;
    const isFreshDouble6 = dice[0] === 6 && dice[1] === 6 && !diceUsed[0] && !diceUsed[1];
    if (isFreshDouble6 && forced.a.kind === "exit") {
      const yardTokens = (tokens[turnColor] || []).filter((tk) => tk.step === -1);
      if (yardTokens.length >= 2) {
        setYardChoice({ dice, tokenIds: yardTokens.map((tk) => tk.id) });
        return;
      }
    }
    const t = setTimeout(() => {
      const explain = explainAction(forced.a, turnColor, forced.sim, dice, forced);
      commitAction(forced.a, turnColor, tokens, dice, diceUsed, explain);
    }, 650);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentActions, phase, turnColor, roles, aiBusy, rolling, yardChoice, buybackChoice, rerollTick]);

  // A rolled six, with one or more of this color's own tokens currently
  // held captive in an opponent's base — stop and offer the ransom instead
  // of silently using that die for anything else. Only for a human; the AI
  // decides this for itself inside its own turn loop below. The "declined"
  // ref means saying "wait" sticks for THIS exact die on THIS exact roll —
  // it doesn't nag again until a genuinely new six comes along.
  useEffect(() => {
    if (phase !== "playing" || !turnColor || roles[turnColor] === "ai" || aiBusy) return;
    if (dice == null || rolling || buybackChoice || yardChoice) return;
    const sixIdx = [0, 1].find((i) => !diceUsed[i] && dice[i] === 6);
    if (sixIdx === undefined) return;
    const key = `${dice[0]},${dice[1]}-${sixIdx}`;
    if (buybackDeclinedRef.current.has(key)) return;
    const captors = [...new Set((tokens[turnColor] || []).filter((tk) => tk.heldBy && active.includes(tk.heldBy)).map((tk) => tk.heldBy))];
    if (!captors.length) return;
    setBuybackChoice({ dice, die: sixIdx, key, captors, chosenCaptor: captors.length === 1 ? captors[0] : null });
    sfx.ransomAlert();
  }, [dice, diceUsed, phase, turnColor, roles, aiBusy, rolling, buybackChoice, yardChoice, tokens, active]);

  // Confirming the ransom: spends the six that triggered the prompt,
  // returns the chosen hostage straight into play at this color's own
  // start square (clearing `heldBy`), and logs/sounds/banners the moment.
  // Declining just remembers not to ask again for this exact die.
  const resolveBuyback = () => {
    if (!buybackChoice || !buybackChoice.chosenCaptor) return;
    const { dice: d, die, chosenCaptor, key } = buybackChoice;
    const hostageToken = (tokens[turnColor] || []).find((tk) => tk.heldBy === chosenCaptor);
    setBuybackChoice(null);
    if (!hostageToken) return;
    buybackDeclinedRef.current.add(key);
    // resultStep stays -1: buying back only RELEASES the token to this
    // color's own yard, same as a freshly captured token would have gone
    // to its own yard in standard Ludo. It still needs its own fresh six
    // later to actually exit onto the board — buying back isn't a free exit.
    const action = { kind: "buyback", die, tokenId: hostageToken.id, captor: chosenCaptor, fromStep: -1, resultStep: -1, dist: 6 };
    commitAction(action, turnColor, tokens, d, diceUsed, null);
  };
  const declineBuyback = () => {
    if (!buybackChoice) return;
    buybackDeclinedRef.current.add(buybackChoice.key);
    setBuybackChoice(null);
  };
  const pickBuybackCaptor = (captor) => setBuybackChoice((bc) => (bc ? { ...bc, chosenCaptor: captor } : bc));

  // Resolves the yard-choice prompt: exits either 1 or 2 tokens using the
  // double-6 that triggered it. Releasing 2 uses both dice (die 0 for the
  // first token, die 1 for the second) and ends the roll the normal way
  // (commitAction spots both dice spent and calls resolveEndOfDice itself).
  // Releasing 1 only spends die 0, leaving die 1 free for the player to use
  // however they like — including on the second yard token, if they change
  // their mind.
  const chooseYardRelease = (count) => {
    if (!yardChoice) return;
    const { dice: d, tokenIds } = yardChoice;
    setYardChoice(null);
    const exitAction = (die, tokenId) => ({ kind: "exit", die, tokenId, fromStep: -1, resultStep: 0, dist: 6 });
    const first = exitAction(0, tokenIds[0]);
    const r1 = commitAction(first, turnColor, tokens, d, [false, false]);
    if (r1.done || count < 2) return;
    const second = exitAction(1, tokenIds[1]);
    commitAction(second, turnColor, r1.nextTokens, d, r1.newUsed);
  };

  // ---- AI turn loop ------------------------------------------------------
  useEffect(() => {
    if (phase !== "playing" || !turnColor || roles[turnColor] !== "ai") return;
    const myEpoch = epochRef.current;
    let cancelled = false;

    (async () => {
      await wait(500);
      if (cancelled || epochRef.current !== myEpoch) return;
      setAiBusy(true);

      let workingTokens = tokens;
      let d = dice;
      let used = diceUsed;

      if (d == null) {
        rollCapturedRef.current = false;
        buybackDeclinedRef.current = new Set();
        setFrozenTokenIds(new Set());
        sfx.roll();
        setRolling(true);
        for (let i = 0; i < 6; i++) {
          if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
          setDice([rollOne(), rollOne()]);
          await wait(65);
        }
        d = [rollOne(), rollOne()];
        if (pendingForcedSixRef.current === turnColor) {
          d[0] = 6;
          pendingForcedSixRef.current = null;
        }
        if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
        setDice(d);
        setRolling(false);
        used = [false, false];
        setDiceUsed(used);
        await wait(250);
      }
      if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }

      // Resolve both dice, one decision at a time, so each move is
      // visible rather than the whole turn jumping at once. commitAction
      // already resolves the turn itself the moment both dice are spent
      // (see its own comment) -- alreadyResolved just tracks that so the
      // fallback call below doesn't fire a second time and silently
      // skip whoever's turn is next. It's only needed for the one case
      // commitAction never runs at all: the very first roll having zero
      // legal moves on either die.
      let alreadyResolved = false;
      // Mirrors frozenTokenIds for the human: a token that captures sits
      // out the rest of THIS roll rather than chaining into a second,
      // unrelated move with the leftover die. Local to this roll since the
      // AI loop works off its own workingTokens/used, not React state.
      let aiFrozenIds = new Set();
      while (!(used[0] && used[1])) {
        if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }

        // Automatic ransom: holding a captive token and rolled a six?
        // Always buy it back — a token back in play beats one sitting in
        // someone else's base, no real strategy needed, no prompt needed
        // (that's only for the human — see resolveBuyback above).
        const sixIdx = [0, 1].find((i) => !used[i] && d[i] === 6);
        if (sixIdx !== undefined) {
          const hostageToken = (workingTokens[turnColor] || []).find((tk) => tk.heldBy && active.includes(tk.heldBy));
          if (hostageToken) {
            await wait(550);
            if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
            const action = { kind: "buyback", die: sixIdx, tokenId: hostageToken.id, captor: hostageToken.heldBy, fromStep: -1, resultStep: -1, dist: 6 };
            const result = commitAction(action, turnColor, workingTokens, d, used, null);
            if (result.done) { setAiBusy(false); return; }
            workingTokens = result.nextTokens;
            used = result.newUsed;
            continue;
          }
        }

        const actions = computeActions(turnColor, d, used, workingTokens).filter((a) => !aiFrozenIds.has(a.tokenId));
        if (actions.length === 0) {
          if (aiExplain) pushLog(pick(NO_MOVE_LINES)(COLORS[turnColor].name), { color: turnColor, speak: true });
          sfx.pass();
          used = [true, true];
          break;
        }
        const scored = actions.map((a) => ({ a, ...scoreAction(a, turnColor, workingTokens, active) }));
        scored.sort((x, y) => y.score - x.score);
        // Same obvious-move rule as a human: one piece only means no choice.
        const best = forcedAction(turnColor, d, actions, workingTokens, active) || scored[0];
        const explanation = aiExplain ? explainAction(best.a, turnColor, best.sim, d, best) : null;

        await wait(550);
        if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
        const result = commitAction(best.a, turnColor, workingTokens, d, used, explanation);
        if (result.done) { setAiBusy(false); return; }
        workingTokens = result.nextTokens;
        used = result.newUsed;
        if (result.captured) aiFrozenIds = new Set(aiFrozenIds).add(result.capturedTokenId);
        if (used[0] && used[1]) alreadyResolved = true;
        await wait(250);
      }

      if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
      if (used[0] && used[1] && !alreadyResolved) resolveEndOfDice(d);
      setAiBusy(false);
    })();

    return () => { cancelled = true; };
    // rollAgainStreak is included so a 6-6 reroll re-triggers this effect:
    // resolveEndOfDice() clears the dice and bumps that counter but keeps
    // the same AI player's turn (turnColor doesn't change), so without this
    // dependency the AI would just sit there with no dice and never roll
    // again — a freeze on any double-6.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, turnColor, roles, rerollTick]);

  // ---- rendering ---------------------------------------------------------
  const occupants = useMemo(() => {
    const m = new Map();
    active.forEach((color) => {
      (tokens[color] || []).forEach((tk) => {
        if (tk.step === -1 || tk.step === HOME_STEP) return;
        const [r, cc] = absCellForStep(color, tk.step);
        const k = `${r},${cc}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push({ color, tokenId: tk.id });
      });
    });
    return m;
  }, [tokens, active]);

  const trackCellSet = useMemo(() => new Set(TRACK.map(([r, cc]) => `${r},${cc}`)), []);
  const stretchCellColor = useMemo(() => {
    const m = new Map();
    Object.entries(STRETCH).forEach(([color, cells]) => cells.forEach(([r, cc]) => m.set(`${r},${cc}`, color)));
    return m;
  }, []);
  const safeCellSet = useMemo(() => {
    const s = new Set();
    COLOR_ORDER.forEach((color) => { for (let i = 0; i < TRACK_LEN; i++) if (isSafeStep(color, i)) s.add(TRACK[(START_INDEX[color] + i) % TRACK_LEN].join(",")); });
    return s;
  }, []);
  const startCellColor = useMemo(() => {
    const m = new Map();
    COLOR_ORDER.forEach((color) => m.set(TRACK[START_INDEX[color]].join(","), color));
    return m;
  }, []);
  const finalCellColor = useMemo(() => {
    const m = new Map();
    Object.entries(STRETCH).forEach(([color, cells]) => m.set(cells[cells.length - 1].join(","), color));
    return m;
  }, []);

  const renderYard = (color) => {
    const [r0, c0] = YARD_ORIGIN[color];
    const list = tokens[color] || [];
    const isAI = roles[color] === "ai";
    // Any tokens OTHER colors have captured and are holding prisoner here,
    // in THIS color's yard — rendered small, locked, and tinted in their
    // owner's color so it's obvious at a glance whose token is being held
    // and by whom. A hostage never renders in its own owner's yard (see the
    // `!tk.heldBy` filter just below) — it only ever shows up here, at its
    // captor's base, until bought back.
    const hostages = active.flatMap((oc) =>
      (tokens[oc] || []).filter((tk) => tk.heldBy === color).map((tk) => ({ ownerColor: oc, tokenId: tk.id }))
    );
    return (
      <div key={color} style={{ gridRow: `${r0 + 1} / span 6`, gridColumn: `${c0 + 1} / span 6`, background: COLORS[color].dim, border: `2px solid ${COLORS[color].hex}55`, borderRadius: 14, position: "relative", margin: 3 }}>
        {isAI && <Bot size={12} className="absolute top-1.5 left-1.5 opacity-60" style={{ color: COLORS[color].hex }} />}
        <div className="absolute inset-3 rounded-lg" style={{ background: c.surface }}>
          <div className="w-full h-full grid grid-cols-2 grid-rows-2 place-items-center">
            {list.filter((tk) => tk.step === -1 && !tk.heldBy).map((tk) => {
              const canTap = turnColor === color && movable.includes(tk.id) && roles[color] !== "ai";
              return (
                <button key={tk.id} onClick={() => canTap && onTokenTap(tk.id)} disabled={!canTap}
                  className="rounded-full transition-transform" style={{
                    width: "44%", height: "44%", background: COLORS[color].hex, border: "2px solid rgba(255,255,255,0.6)",
                    boxShadow: canTap ? `0 0 0 4px ${COLORS[color].hex}55` : "none",
                    cursor: canTap ? "pointer" : "default", transform: canTap ? "scale(1.08)" : "scale(1)",
                  }} />
              );
            })}
          </div>
        </div>
        {hostages.length > 0 && (
          <div className="absolute flex items-center gap-1 flex-wrap justify-center" style={{ left: 4, right: 4, bottom: -9, zIndex: 5 }}>
            {hostages.map((h) => (
              <div key={`${h.ownerColor}-${h.tokenId}`} title={`${COLORS[h.ownerColor].name} token held captive`}
                className="flex items-center justify-center rounded-full" style={{ width: 16, height: 16, background: COLORS[h.ownerColor].hex, border: `1.5px solid ${c.surface}`, boxShadow: "0 1px 3px rgba(0,0,0,0.4)" }}>
                <Lock size={9} style={{ color: "#fff" }} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderTrackCell = (r, cc) => {
    const key = `${r},${cc}`;
    const stretchColor = stretchCellColor.get(key);
    const startColor = startCellColor.get(key);
    const finalColor = finalCellColor.get(key);
    const isSafe = safeCellSet.has(key);
    const occ = occupants.get(key) || [];
    let bg = c.surface;
    if (finalColor) bg = COLORS[finalColor].hex;
    else if (stretchColor) bg = COLORS[stretchColor].dim;
    else if (startColor) bg = COLORS[startColor].dim;
    return (
      <div key={key} style={{ gridRow: r + 1, gridColumn: cc + 1, background: bg, border: `1px solid ${c.border}`, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {isSafe && !finalColor && <Shield size={8} style={{ color: c.textFaint, opacity: 0.55 }} />}
        {occ.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-[1px]" style={{ position: "absolute", inset: 1 }}>
            {occ.map(({ color, tokenId }) => {
              const canTap = turnColor === color && movable.includes(tokenId) && roles[color] !== "ai";
              const size = occ.length > 1 ? "50%" : "76%";
              const hex = COLORS[color].hex;
              return (
                <button key={`${color}-${tokenId}`} onClick={() => canTap && onTokenTap(tokenId)} disabled={!canTap}
                  className={phase === "won" ? "ludo-runner ludo-runner-celebrate" : "ludo-runner"} style={{
                    width: size, height: size, background: "transparent", border: "none", padding: 0,
                    filter: canTap ? `drop-shadow(0 0 2px ${hex}) drop-shadow(0 0 4px ${hex}aa)` : "none",
                    cursor: canTap ? "pointer" : "default",
                  }}>
                  {/* A tiny running figure, all inline SVG shapes — no image
                      assets, so it costs nothing to load and nothing extra
                      to keep animating. Legs/arms swing via the .ludo-limb
                      CSS classes above; the whole figure also bobs slightly. */}
                  <svg viewBox="0 0 24 24" width="100%" height="100%" style={{ overflow: "visible" }}>
                    <line className="ludo-limb ludo-limb-a" x1="10" y1="13" x2="10" y2="20" stroke={hex} strokeWidth="2.4" strokeLinecap="round" />
                    <line className="ludo-limb ludo-limb-b" x1="14" y1="13" x2="14" y2="20" stroke={hex} strokeWidth="2.4" strokeLinecap="round" />
                    <line className="ludo-limb ludo-limb-b" x1="9" y1="10" x2="6" y2="14" stroke={hex} strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
                    <line className="ludo-limb ludo-limb-a" x1="15" y1="10" x2="18" y2="14" stroke={hex} strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
                    <rect x="9.5" y="7.5" width="5" height="6.5" rx="2.2" fill={hex} stroke="rgba(255,255,255,0.7)" strokeWidth="0.8" />
                    <circle cx="12" cy="5" r="3.3" fill={hex} stroke="rgba(255,255,255,0.7)" strokeWidth="0.8" />
                  </svg>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const centerCells = [];
  for (let r = 6; r <= 8; r++) for (let cc = 6; cc <= 8; cc++) {
    const key = `${r},${cc}`;
    if (trackCellSet.has(key) || stretchCellColor.has(key)) continue;
    centerCells.push(
      <div key={key} style={{
        gridRow: r + 1, gridColumn: cc + 1,
        background: r === 7 && cc === 7 ? `conic-gradient(${COLORS.red.hex} 0deg 90deg, ${COLORS.green.hex} 90deg 180deg, ${COLORS.yellow.hex} 180deg 270deg, ${COLORS.blue.hex} 270deg 360deg)` : c.surface,
        border: `1px solid ${c.border}`, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {r === 7 && cc === 7 && <Trophy size={11} color="#fff" style={{ filter: "drop-shadow(0 0 1px rgba(0,0,0,0.5))" }} />}
      </div>
    );
  }

  const renderDie = (val, i) => {
    const Icon = DICE_ICONS[(val || 1) - 1];
    // Usable if it can move something alone, OR it's needed to complete a
    // combine (the other die still unused and combine is on the table).
    const usable = dice != null && !diceUsed[i] && (dieHasActions(i) || (combineHasActions && !diceUsed[1 - i]));
    const isSelected = selectedDice.includes(i);
    return (
      <button key={i} onClick={() => tapDie(i)} disabled={!usable || roles[turnColor] === "ai"}
        className="flex items-center justify-center rounded-xl transition-all" style={{
          width: 44, height: 44, background: isSelected ? COLORS[turnColor]?.hex : c.surface,
          border: `2px solid ${isSelected ? COLORS[turnColor]?.hex : c.border}`,
          opacity: diceUsed[i] ? 0.3 : usable ? 1 : 0.55, cursor: usable && roles[turnColor] !== "ai" ? "pointer" : "default",
        }}>
        <Icon size={24} style={{ color: isSelected ? "#fff" : c.text }} />
      </button>
    );
  };

  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-16">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>
        <div className="flex items-center gap-2">
          {phase !== "setup" && (
            <button onClick={() => setSfxOn((v) => !v)} title="Sound effects" aria-label="Toggle sound effects"
              className="flex items-center justify-center rounded-full w-8 h-8 shrink-0" style={{ background: sfxOn ? c.accent : c.surface, border: `1px solid ${sfxOn ? c.accent : c.border}`, color: sfxOn ? c.accentText : c.textDim }}>
              <Music size={14} />
            </button>
          )}
          {phase !== "setup" && (
            <button onClick={() => { setReadAloud((v) => !v); if (readAloud) ludoSpeech.stop(); }} title="Read battle log aloud" aria-label="Toggle read aloud"
              className="flex items-center justify-center rounded-full w-8 h-8 shrink-0" style={{ background: readAloud ? c.accent : c.surface, border: `1px solid ${readAloud ? c.accent : c.border}`, color: readAloud ? c.accentText : c.textDim }}>
              {readAloud ? <Volume2 size={14} /> : <VolumeX size={14} />}
            </button>
          )}
          <button onClick={() => setShowHelp(true)} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 font-body text-xs" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }}>
            <HelpCircle size={14} /> Help
          </button>
        </div>
      </div>

      <div className="mb-5">
        <div className="font-display text-2xl" style={{ color: c.text }}>Ludo</div>
        <div className="font-body text-sm" style={{ color: c.textDim }}>Two dice, AI opponents optional — 2 to 4 players.</div>
      </div>

      {phase === "setup" && (
        <div>
          {/* This pass-and-play setup below needs no account at all — a
              guest can play right now. This banner is the only place that
              cares whether anyone's signed in: it's the "want real
              opponents instead of the people next to you" upsell, not a
              gate on the game itself. */}
          {loggedIn ? (
            <button onClick={onFindOpponents} className="w-full flex items-center gap-2 rounded-xl px-3.5 py-2.5 mb-3 font-body text-sm text-left" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }}>
              <Bot size={16} style={{ color: c.accent }} className="shrink-0" />
              Looking for real Matchday opponents instead? Head back to Home — the Ludo lobby is waiting there.
            </button>
          ) : (
            <button onClick={onRequireAuth} className="w-full flex items-center gap-2 rounded-xl px-3.5 py-2.5 mb-3 font-body text-sm text-left" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }}>
              <User size={16} style={{ color: c.accent }} className="shrink-0" />
              Playing as a guest — sign in to find real Matchday opponents and play together instead of pass-and-play.
            </button>
          )}
          {!Object.keys(roles).length && (
            <button onClick={() => setShowHelp(true)} className="w-full flex items-center gap-2 rounded-xl px-3.5 py-2.5 mb-4 font-body text-sm text-left" style={{ background: c.surface, border: `1px dashed ${c.border}`, color: c.textDim }}>
              <HelpCircle size={16} style={{ color: c.accent }} className="shrink-0" />
              New to Ludo? Tap Help above for a full rules rundown — and switch AI explanations on below so a computer opponent can talk you through it.
            </button>
          )}
          <div className="font-body text-xs uppercase tracking-wide mb-2" style={{ color: c.textFaint }}>Who's playing?</div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {COLOR_ORDER.map((color) => {
              const role = roles[color];
              return (
                <button key={color} onClick={() => cycleColor(color)} className="flex items-center gap-2 rounded-xl px-3 py-2.5 font-body text-sm transition-colors"
                  style={{ background: role ? COLORS[color].dim : c.surface, border: `1.5px solid ${role ? COLORS[color].hex : c.border}`, color: c.text }}>
                  <span className="rounded-full shrink-0" style={{ width: 14, height: 14, background: COLORS[color].hex }} />
                  {COLORS[color].name}
                  {role && (
                    <span className="ml-auto flex items-center gap-1 text-xs" style={{ color: c.textFaint }}>
                      {role === "ai" ? <Bot size={12} /> : <User size={12} />}
                      {role === "ai" ? "AI" : "Human"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <button onClick={quickPlayVsBots} className="w-full flex items-center justify-center gap-2 rounded-xl py-2.5 mb-3 font-body text-sm" style={{ background: c.surface, border: `1.5px dashed ${c.accent}`, color: c.accent }}>
            <Rocket size={15} /> Quick Play — you vs 3 bots
          </button>
          {anyAI && (
            <button onClick={() => setAiExplain((v) => !v)} className="w-full flex items-center justify-between rounded-xl px-3 py-2.5 mb-2 font-body text-sm" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}>
              <span className="flex items-center gap-2"><Bot size={14} style={{ color: c.textFaint }} /> AI explains its moves</span>
              <span className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase" style={{ background: aiExplain ? c.accent : c.border, color: aiExplain ? c.accentText : c.textFaint }}>{aiExplain ? "On" : "Off"}</span>
            </button>
          )}
          <button onClick={() => setSfxOn((v) => !v)} className="w-full flex items-center justify-between rounded-xl px-3 py-2.5 mb-2 font-body text-sm" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}>
            <span className="flex items-center gap-2"><Music size={14} style={{ color: c.textFaint }} /> Sound effects</span>
            <span className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase" style={{ background: sfxOn ? c.accent : c.border, color: sfxOn ? c.accentText : c.textFaint }}>{sfxOn ? "On" : "Off"}</span>
          </button>
          <button onClick={() => setReadAloud((v) => !v)} className="w-full flex items-center justify-between rounded-xl px-3 py-2.5 mb-4 font-body text-sm" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}>
            <span className="flex items-center gap-2">{readAloud ? <Volume2 size={14} style={{ color: c.textFaint }} /> : <VolumeX size={14} style={{ color: c.textFaint }} />} Read the battle log aloud</span>
            <span className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase" style={{ background: readAloud ? c.accent : c.border, color: readAloud ? c.accentText : c.textFaint }}>{readAloud ? "On" : "Off"}</span>
          </button>
          <button onClick={startGame} disabled={Object.keys(roles).length < 2} className="w-full rounded-xl py-3 font-display text-base disabled:opacity-40" style={{ background: c.accent, color: c.accentText }}>
            {Object.keys(roles).length < 2 ? "Pick at least 2 colors" : `Start (${Object.keys(roles).length} players)`}
          </button>
        </div>
      )}

      {(phase === "playing" || phase === "won") && (
        <div>
          <style>{`
            @keyframes ludoBoardShake {
              0%, 100% { transform: translate(0, 0); }
              15% { transform: translate(-7px, 3px) rotate(-0.6deg); }
              30% { transform: translate(7px, -3px) rotate(0.6deg); }
              45% { transform: translate(-5px, -3px); }
              60% { transform: translate(5px, 3px); }
              80% { transform: translate(-2px, 1px); }
            }
            .ludo-shake { animation: ludoBoardShake 0.55s ease; }
            /* Running-person tokens: cheap, code-only animation (2 legs +
               2 arms scissoring, plus a tiny bob) — no images, no per-move
               JS, just a looping CSS transform so every token on the board
               looks like it's jogging in place. Low CPU (GPU-composited
               transforms only) and zero extra data. */
            @keyframes ludoRunBob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6%); } }
            @keyframes ludoRunSwingA { 0%, 100% { transform: rotate(28deg); } 50% { transform: rotate(-28deg); } }
            @keyframes ludoRunSwingB { 0%, 100% { transform: rotate(-28deg); } 50% { transform: rotate(28deg); } }
            .ludo-runner { animation: ludoRunBob 0.46s ease-in-out infinite; transform-origin: 50% 70%; }
            .ludo-limb { transform-box: fill-box; transform-origin: 50% 0%; animation-duration: 0.46s; animation-iteration-count: infinite; animation-timing-function: ease-in-out; }
            .ludo-limb-a { animation-name: ludoRunSwingA; }
            .ludo-limb-b { animation-name: ludoRunSwingB; }
            /* Game over: EVERY token on the board celebrates, not just the
               winner's — a bigger, bouncier jump instead of a steady jog,
               with arms/legs swinging wider and faster. Same shapes, same
               zero-asset approach, just a livelier keyframe set. */
            @keyframes ludoCelebrateJump { 0%, 100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-22%) rotate(3deg); } }
            @keyframes ludoCelebrateSwingA { 0%, 100% { transform: rotate(50deg); } 50% { transform: rotate(-50deg); } }
            @keyframes ludoCelebrateSwingB { 0%, 100% { transform: rotate(-50deg); } 50% { transform: rotate(50deg); } }
            .ludo-runner-celebrate { animation-name: ludoCelebrateJump; animation-duration: 0.38s; }
            .ludo-runner-celebrate .ludo-limb { animation-duration: 0.38s; }
            .ludo-runner-celebrate .ludo-limb-a { animation-name: ludoCelebrateSwingA; }
            .ludo-runner-celebrate .ludo-limb-b { animation-name: ludoCelebrateSwingB; }
            @keyframes ludoSlam {
              0% { transform: scale(3.4) rotate(-7deg); opacity: 0; }
              16% { transform: scale(0.9) rotate(2deg); opacity: 1; }
              28% { transform: scale(1.1) rotate(-1deg); }
              40% { transform: scale(1) rotate(0deg); }
              86% { transform: scale(1.03); opacity: 1; }
              100% { transform: scale(1.12); opacity: 0; }
            }
            @keyframes ludoFlash { 0% { opacity: 0; } 8% { opacity: 1; } 100% { opacity: 0; } }
            @keyframes ludoDim { 0% { opacity: 0; } 10% { opacity: 1; } 82% { opacity: 1; } 100% { opacity: 0; } }
            @keyframes ludoBurst {
              0% { transform: translate(0, 0) scale(0.2) rotate(0deg); opacity: 1; }
              100% { transform: translate(var(--dx), var(--dy)) scale(1.5) rotate(160deg); opacity: 0; }
            }
            .ludo-banner { animation: ludoSlam 2.1s cubic-bezier(0.2, 0.9, 0.3, 1) forwards; }
            .ludo-flash { animation: ludoFlash 0.9s ease-out forwards; }
            .ludo-dim { animation: ludoDim 2.1s ease forwards; }
            .ludo-burst { animation: ludoBurst 1.1s ease-out forwards; }
          `}</style>
          <div className={`aspect-square w-full rounded-2xl overflow-hidden mb-4 relative${shaking ? " ludo-shake" : ""}`} style={{ border: `2px solid ${c.border}`, background: c.surface }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(15, 1fr)", gridTemplateRows: "repeat(15, 1fr)", width: "100%", height: "100%" }}>
              {COLOR_ORDER.map(renderYard)}
              {TRACK.map(([r, cc]) => renderTrackCell(r, cc))}
              {Object.entries(STRETCH).flatMap(([color, cells]) => cells.map(([r, cc]) => renderTrackCell(r, cc)))}
              {centerCells}
            </div>
            {celebrate && (() => {
              const hex = celebrate.gold ? "#F5B800" : COLORS[celebrate.color].hex;
              const big = (celebrate.level || 0) >= 2;
              return (
                <div key={celebrate.key} className="absolute inset-0 pointer-events-none flex items-center justify-center overflow-hidden" style={{ zIndex: 30 }}>
                  <div className="ludo-dim absolute inset-0" style={{ background: "rgba(0,0,0,0.55)" }} />
                  <div className="ludo-flash absolute inset-0" style={{ background: `radial-gradient(circle at center, ${hex}dd 0%, transparent 70%)` }} />
                  {BURST.map((p, i) => (
                    <span key={i} className="ludo-burst absolute" style={{ "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, fontSize: p.size, animationDelay: `${p.delay}ms` }}>
                      {celebrate.gold ? "⭐" : i % 4 === 0 ? "💀" : "💥"}
                    </span>
                  ))}
                  <div className="ludo-banner relative w-full text-center" style={{ background: `linear-gradient(90deg, transparent 0%, ${hex} 14%, ${hex} 86%, transparent 100%)`, padding: big ? "22px 0" : "16px 0" }}>
                    <div className="font-display uppercase" style={{ fontSize: big ? 46 : 38, lineHeight: 1, letterSpacing: "0.04em", color: "#fff", textShadow: "0 3px 0 rgba(0,0,0,0.45), 0 0 22px rgba(255,255,255,0.7)" }}>
                      {celebrate.text}
                    </div>
                    {celebrate.sub && (
                      <div className="font-body font-bold uppercase mt-1.5" style={{ fontSize: 12, letterSpacing: "0.22em", color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.5)" }}>
                        {celebrate.sub}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>

          {(stats.captures > 0 || stats.finishes > 0) && (
            <div className="flex items-center gap-4 px-1 mb-3 font-body text-xs" style={{ color: c.textFaint }}>
              <span className="flex items-center gap-1"><Flame size={12} /> {stats.captures} capture{stats.captures === 1 ? "" : "s"} this game</span>
              <span className="flex items-center gap-1"><Trophy size={12} /> {stats.finishes} home</span>
            </div>
          )}

          <div className="rounded-xl px-4 py-3 mb-3" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            <div className="flex items-center gap-3 mb-3">
              <span className="rounded-full shrink-0 flex items-center justify-center" style={{ width: 20, height: 20, background: turnColor ? COLORS[turnColor].hex : c.border }}>
                {roles[turnColor] === "ai" && <Bot size={12} color="#fff" />}
              </span>
              <div className="flex-1 font-body text-sm min-w-0" style={{ color: c.text }}>{message || `${turnColor ? COLORS[turnColor].name : ""}'s turn`}</div>
              <button onClick={rollDice} disabled={rolling || dice != null || phase === "won" || roles[turnColor] === "ai" || aiBusy}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 font-body text-sm disabled:opacity-40 shrink-0" style={{ background: c.accent, color: c.accentText }}>
                {dice == null ? "Roll" : "Rolled"}
              </button>
            </div>
            {dice != null && (
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  {renderDie(dice[0], 0)}
                  {renderDie(dice[1], 1)}
                  {selectedDice.length === 2 && combineHasActions && (
                    <span className="flex items-center gap-1.5 rounded-xl px-3 h-11 font-body text-xs" style={{ background: COLORS[turnColor].dim, color: COLORS[turnColor].hex, border: `2px solid ${COLORS[turnColor].hex}` }}>
                      <Combine size={14} /> {dice[0]}+{dice[1]} = {dice[0] + dice[1]}
                    </span>
                  )}
                  {selectedDice.length === 2 && !combineHasActions && (
                    <span className="flex items-center gap-1.5 rounded-xl px-3 h-11 font-body text-xs" style={{ color: c.textFaint, border: `2px dashed ${c.border}` }}>
                      No token can use that combined move
                    </span>
                  )}
                </div>
                {combineHasActions && roles[turnColor] !== "ai" && selectedDice.length === 0 && (
                  <div className="font-body text-[11px] mt-1.5" style={{ color: c.textFaint }}>Tap one die to move a single token, or tap both to combine them into one bigger move.</div>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl px-3.5 py-2.5 mb-3" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1.5 flex items-center gap-1.5" style={{ color: c.textFaint }}><Skull size={10} /> Battle log</div>
            {log.length > 0 ? (
              <div className="space-y-1 max-h-32 overflow-y-auto mb-2.5">
                {log.map((entry, i) => {
                  const isSpeaking = speakingId === `log-${entry.id}`;
                  return (
                    <div key={entry.id} className="flex items-center gap-1.5 font-body text-xs" style={{ color: i === 0 ? c.text : c.textFaint }}>
                      <button onClick={() => ludoSpeech.speak(`log-${entry.id}`, entry.text, entry.color)} className="shrink-0" aria-label="Read aloud" style={{ color: isSpeaking ? c.accent : c.textFaint }}>
                        {isSpeaking ? <Volume2 size={11} /> : <Volume2 size={11} style={{ opacity: 0.4 }} />}
                      </button>
                      <span>{entry.text}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="font-body text-xs mb-2.5" style={{ color: c.textFaint }}>Nothing yet — roll the dice, or drop a comment below.</div>
            )}
            <div className="flex items-center gap-2">
              <input type="text" value={commentText} onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") postComment(); }}
                placeholder="Say something…" maxLength={140}
                className="flex-1 min-w-0 font-body text-xs rounded-lg px-2.5 py-2 outline-none" style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }} />
              <button onClick={postComment} disabled={!commentText.trim()} className="shrink-0 rounded-lg px-2.5 py-2 disabled:opacity-40" style={{ background: c.accent, color: c.accentText }} aria-label="Post comment">
                <Send size={13} />
              </button>
            </div>
          </div>
        </div>
      )}

      {showHelp && <LudoHelpModal onClose={() => setShowHelp(false)} c={c} />}

      {yardChoice && turnColor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="rounded-2xl p-6 text-center max-w-xs w-full" style={{ background: c.surface, border: `2px solid ${COLORS[turnColor].hex}` }}>
            <div className="rounded-full mx-auto mb-3 flex items-center justify-center" style={{ width: 44, height: 44, background: COLORS[turnColor].dim }}>
              <Dice6 size={22} style={{ color: COLORS[turnColor].hex }} />
            </div>
            <div className="font-display text-lg mb-1" style={{ color: c.text }}>Double 6!</div>
            <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>
              {COLORS[turnColor].name} has {yardChoice.tokenIds.length} tokens waiting. Bring out one, or both?
            </div>
            <div className="flex gap-2.5">
              <button onClick={() => chooseYardRelease(1)} className="flex-1 rounded-xl py-3 font-display text-base" style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}>
                Just 1
              </button>
              <button onClick={() => chooseYardRelease(2)} className="flex-1 rounded-xl py-3 font-display text-base" style={{ background: COLORS[turnColor].hex, color: "#fff" }}>
                Both!
              </button>
            </div>
          </div>
        </div>
      )}

      {buybackChoice && turnColor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="rounded-2xl p-6 text-center max-w-xs w-full" style={{ background: c.surface, border: `2px solid ${COLORS[turnColor].hex}` }}>
            <div className="rounded-full mx-auto mb-3 flex items-center justify-center" style={{ width: 44, height: 44, background: COLORS[turnColor].dim }}>
              <Lock size={20} style={{ color: COLORS[turnColor].hex }} />
            </div>
            {!buybackChoice.chosenCaptor ? (
              <>
                <div className="font-display text-lg mb-1" style={{ color: c.text }}>Rolled a 6!</div>
                <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>
                  More than one captor is holding your tokens. Which one do you want to try to buy back from first?
                </div>
                <div className="flex flex-col gap-2">
                  {buybackChoice.captors.map((captor) => (
                    <button key={captor} onClick={() => pickBuybackCaptor(captor)} className="rounded-xl py-3 font-display text-base flex items-center justify-center gap-2"
                      style={{ background: COLORS[captor].dim, color: COLORS[captor].hex, border: `1px solid ${COLORS[captor].hex}55` }}>
                      <Lock size={14} /> From {COLORS[captor].name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="font-display text-lg mb-1" style={{ color: c.text }}>Rolled a 6!</div>
                <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>
                  {COLORS[turnColor].name}'s token is held by {COLORS[buybackChoice.chosenCaptor].name}. Spend this 6 to free it back to your yard — you'll still need another 6 later to actually bring it out. Or wait?
                </div>
                <div className="flex gap-2.5">
                  <button onClick={declineBuyback} className="flex-1 rounded-xl py-3 font-display text-base" style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }}>
                    Wait
                  </button>
                  <button onClick={resolveBuyback} className="flex-1 rounded-xl py-3 font-display text-base flex items-center justify-center gap-1.5" style={{ background: COLORS[turnColor].hex, color: "#fff" }}>
                    <Unlock size={16} /> Free it
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {phase === "won" && winner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="rounded-2xl p-6 text-center max-w-xs w-full" style={{ background: c.surface, border: `2px solid ${COLORS[winner].hex}` }}>
            <Trophy size={36} style={{ color: COLORS[winner].hex, margin: "0 auto 10px" }} />
            <div className="font-display text-xl mb-1" style={{ color: c.text }}>{COLORS[winner].name} wins!</div>
            <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>All four tokens home.</div>
            <button onClick={resetToSetup} className="w-full flex items-center justify-center gap-2 rounded-xl py-3 font-display text-base" style={{ background: c.accent, color: c.accentText }}>
              <RotateCcw size={16} /> Play again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
