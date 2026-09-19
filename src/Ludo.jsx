import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  ArrowLeft, Trophy, RotateCcw, Dice1, Dice2, Dice3, Dice4, Dice5, Dice6,
  HelpCircle, X, Search, Bot, User, Skull, Shield, Zap, Combine,
} from "lucide-react";

// ---------------------------------------------------------------------------
// BOARD GEOMETRY — unchanged from the first version. See the derivation
// notes that used to live here (kept out now to save space): TRACK is a
// hand-verified 56-cell closed loop (every consecutive pair, including the
// wraparound, is a real orthogonal step; no cell repeats). The 4 starting
// squares land unevenly spaced (13/14/14/15 cells apart) rather than a
// perfect 13 apart — doesn't affect fairness, every color still travels
// once all the way around before turning home, just counted from a
// different absolute cell. Moves render as a jump to the new square
// (matching the dice) rather than an animated walk, so the one place this
// isn't pixel-adjacent — a color's last shared square before its own home
// column — never actually shows.
const TRACK = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [6, 6],
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6], [0, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 8],
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14],
  [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9], [8, 8],
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
  [14, 7],
  [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], [8, 6],
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  [7, 0], [6, 0],
];
const TRACK_LEN = TRACK.length; // 56
const START_INDEX = { red: 0, green: 13, yellow: 27, blue: 41 };
const SAFE_INDICES = new Set([0, 6, 13, 19, 27, 33, 41, 47]);
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
        if (v === 6) actions.push({ kind: "exit", die: i, tokenId: tk.id, fromStep: -1, resultStep: 0, dist: v });
      } else if (tk.step < HOME_STEP) {
        const ns = tk.step + v;
        if (ns <= HOME_STEP) actions.push({ kind: "move", die: i, tokenId: tk.id, fromStep: tk.step, resultStep: ns, dist: v });
      }
    });
  });
  if (!diceUsed[0] && !diceUsed[1] && dice[0] !== dice[1]) {
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
  next[color] = (tokensByColor[color] || []).map((tk) => tk.id === action.tokenId ? { ...tk, step: action.resultStep } : tk);
  let captured = false, capturedColor = null;
  if (action.resultStep >= 0 && action.resultStep < TRACK_LEN && !isSafeStep(color, action.resultStep)) {
    const [ar, ac] = absCellForStep(color, action.resultStep);
    active.filter((oc) => oc !== color).forEach((oc) => {
      next[oc] = (next[oc] || tokensByColor[oc] || []).map((ox) => {
        if (ox.step === -1 || ox.step >= TRACK_LEN) return ox;
        const [orr, occ] = absCellForStep(oc, ox.step);
        if (orr === ar && occ === ac) { captured = true; capturedColor = oc; return { ...ox, step: -1 }; }
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
  if (sim.captured) score += 1000;
  if (sim.finished) score += 500;
  if (action.kind === "exit") score += 70;
  if (action.resultStep < TRACK_LEN && isSafeStep(color, action.resultStep)) score += 35;
  if (isDangerous(color, action.resultStep, sim.tokens, active)) score -= 55;
  if (action.fromStep >= 0 && isDangerous(color, action.fromStep, tokensByColor, active)) score += 15; // extra credit for escaping danger
  return { score, sim };
}

function explainAction(action, color, sim, dice) {
  const name = COLORS[color].name;
  if (sim.captured) return `${name} lands on ${COLORS[sim.capturedColor].name} and sends them back to base!`;
  if (sim.finished) return `${name} brings a token all the way home!`;
  if (action.kind === "exit") return `${name} rolled an actual 6 and deploys a new token.`;
  if (action.kind === "combine") return `${name} combines both dice (${dice[0]}+${dice[1]}=${dice[0] + dice[1]}) to push one token further.`;
  if (action.resultStep < TRACK_LEN && isSafeStep(color, action.resultStep)) return `${name} tucks the token onto a safe square.`;
  return `${name} advances a token ${action.dist} square${action.dist === 1 ? "" : "s"}.`;
}

const KILLSTREAK_LABEL = { 2: "DOUBLE CAPTURE!", 3: "TRIPLE CAPTURE!", 4: "RAMPAGE!" };

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
    "Each die can move a different token. Or combine both dice to move one token their total (combining never brings a token out of the yard, only a lone 6 does that).",
    "You can't overshoot your home square — the exact number is needed to finish a token.",
  ]},
  { heading: "Capturing", items: [
    "Land exactly on a square an opponent occupies and their token is sent straight back to their yard.",
    "Starting squares and the star squares are safe — no captures ever happen there.",
    "A capture earns you another roll, on top of anything from doubles.",
  ]},
  { heading: "Extra rolls & forfeits", items: [
    "Rolling doubles (both dice the same) gives you another roll after you finish using this pair.",
    "Three doubles in a row forfeits your turn — no moves from that third pair.",
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

export default function LudoPage({ onBack, c }) {
  const [phase, setPhase] = useState("setup"); // setup | playing | won
  const [active, setActive] = useState([]);
  const [roles, setRoles] = useState({}); // color -> 'human' | 'ai'
  const [aiExplain, setAiExplain] = useState(true);
  const [showHelp, setShowHelp] = useState(false);

  const [tokens, setTokens] = useState({});
  const [turnIdx, setTurnIdx] = useState(0);
  const [dice, setDice] = useState(null);
  const [diceUsed, setDiceUsed] = useState([false, false]);
  const [rolling, setRolling] = useState(false);
  const [armed, setArmed] = useState(null); // {type:'die', index} | {type:'combine'}
  const [doubleStreak, setDoubleStreak] = useState(0);
  const [turnCaptures, setTurnCaptures] = useState(0);
  const [message, setMessage] = useState("");
  const [log, setLog] = useState([]);
  const [celebrate, setCelebrate] = useState(null); // {text} shown as a brief center banner
  const [winner, setWinner] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

  const epochRef = useRef(0); // bumped every new turn; AI loop checks it to abort if stale
  const celebrateTimer = useRef(null);
  useEffect(() => () => { if (celebrateTimer.current) clearTimeout(celebrateTimer.current); }, []);

  const turnColor = active[turnIdx];

  const pushLog = useCallback((text, big) => {
    setLog((l) => [text, ...l].slice(0, 8));
    if (big) {
      setCelebrate({ text: big });
      if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
      celebrateTimer.current = setTimeout(() => setCelebrate(null), 1500);
    }
  }, []);

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

  const startGame = () => {
    const order = COLOR_ORDER.filter((c2) => roles[c2]);
    const t = {};
    order.forEach((c2) => { t[c2] = freshTokens(); });
    epochRef.current += 1;
    setActive(order);
    setTokens(t);
    setTurnIdx(0);
    setDice(null);
    setDiceUsed([false, false]);
    setArmed(null);
    setDoubleStreak(0);
    setTurnCaptures(0);
    setWinner(null);
    setLog([]);
    setMessage(`${COLORS[order[0]].name}'s turn — roll the dice.`);
    setPhase("playing");
  };

  const resetToSetup = () => {
    epochRef.current += 1;
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
    setArmed(null);
    setDoubleStreak(0);
    setTurnCaptures(0);
    setTurnIdx((i) => {
      const next = (i + 1) % active.length;
      setMessage(`${COLORS[active[next]].name}'s turn — roll the dice.`);
      return next;
    });
  }, [active]);

  const resolveEndOfDice = useCallback((finalDice) => {
    const d = finalDice;
    if (d[0] === d[1]) {
      setDoubleStreak((s) => {
        const next = s + 1;
        if (next >= 3) {
          pushLog(`${COLORS[turnColor].name} rolled three doubles — turn forfeited.`);
          setMessage("Three doubles in a row — turn forfeited!");
          setTimeout(() => reallyAdvanceTurn(), 700);
          return 0;
        }
        setDice(null);
        setDiceUsed([false, false]);
        setArmed(null);
        setMessage(`Doubles! ${COLORS[turnColor].name} rolls again.`);
        return next;
      });
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

    if (captured) {
      setTurnCaptures((n) => {
        const next = n + 1;
        const label = KILLSTREAK_LABEL[next];
        pushLog(`💥 ${COLORS[color].name} captured ${COLORS[capturedColor].name}!`, label);
        return next;
      });
    }
    if (finished) pushLog(`🏆 ${COLORS[color].name} got a token home!`);
    if (explain) pushLog(explain);

    const newUsed = [...snapshotUsed];
    diceUsedIdx.forEach((i) => { newUsed[i] = true; });

    const allHome = (nextTokens[color] || []).every((t) => t.step === HOME_STEP);
    if (allHome) {
      setWinner(color);
      setPhase("won");
      setDice(null);
      setArmed(null);
      return { done: true, newUsed, nextTokens };
    }

    setDiceUsed(newUsed);
    setArmed(null);

    if (newUsed[0] && newUsed[1]) {
      resolveEndOfDice(snapshotDice);
    } else {
      // The remaining die might have nothing to do at all -- if so, skip
      // it automatically rather than leaving the player stuck tapping a
      // dead die.
      const remaining = computeActions(color, snapshotDice, newUsed, nextTokens);
      if (remaining.length === 0) {
        const idx = newUsed[0] ? 1 : 0;
        const skipped = [...newUsed]; skipped[idx] = true;
        setTimeout(() => {
          setDiceUsed(skipped);
          if (skipped[0] && skipped[1]) resolveEndOfDice(snapshotDice);
        }, 350);
      }
    }
    return { done: false, newUsed, nextTokens };
  }, [active, resolveEndOfDice, pushLog]);

  const rollDice = () => {
    if (rolling || dice != null || phase !== "playing" || aiBusy) return;
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
        setDice(d);
        setRolling(false);
        setDiceUsed([false, false]);

        const actions = computeActions(turnColor, d, [false, false], tokens);
        if (actions.length === 0) {
          setMessage(`No moves for ${d[0]} & ${d[1]}.`);
          setTimeout(() => resolveEndOfDice(d), 700);
        } else {
          setMessage(`${COLORS[turnColor].name} rolled ${d[0]} & ${d[1]} — tap a die, then a token.`);
        }
      }
    }, 65);
  };

  // ---- human interaction ----------------------------------------------
  const currentActions = useMemo(() => {
    if (dice == null || phase !== "playing") return [];
    return computeActions(turnColor, dice, diceUsed, tokens);
  }, [dice, diceUsed, tokens, turnColor, phase]);

  const armedActions = useMemo(() => {
    if (!armed) return [];
    return currentActions.filter((a) => {
      if (armed.type === "die") return (a.kind === "exit" || a.kind === "move") && a.die === armed.index;
      if (armed.type === "combine") return a.kind === "combine";
      return false;
    });
  }, [armed, currentActions]);
  const movable = armedActions.map((a) => a.tokenId);

  const dieHasActions = (i) => currentActions.some((a) => (a.kind === "exit" || a.kind === "move") && a.die === i);
  const combineHasActions = currentActions.some((a) => a.kind === "combine");

  const armDie = (i) => { if (dieHasActions(i)) setArmed((a) => a && a.type === "die" && a.index === i ? null : { type: "die", index: i }); };
  const armCombine = () => { if (combineHasActions) setArmed((a) => a && a.type === "combine" ? null : { type: "combine" }); };

  const onTokenTap = (tokenId) => {
    if (roles[turnColor] === "ai" || aiBusy) return;
    const action = armedActions.find((a) => a.tokenId === tokenId);
    if (!action) return;
    commitAction(action, turnColor, tokens, dice, diceUsed, null);
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
        setRolling(true);
        for (let i = 0; i < 6; i++) {
          if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
          setDice([rollOne(), rollOne()]);
          await wait(65);
        }
        d = [rollOne(), rollOne()];
        if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
        setDice(d);
        setRolling(false);
        used = [false, false];
        setDiceUsed(used);
        await wait(250);
      }
      if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }

      // Resolve both dice, one decision at a time, so each move is
      // visible rather than the whole turn jumping at once.
      while (!(used[0] && used[1])) {
        if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
        const actions = computeActions(turnColor, d, used, workingTokens);
        if (actions.length === 0) {
          if (aiExplain) pushLog(`${COLORS[turnColor].name} has no move — passes.`);
          used = [true, true];
          break;
        }
        const scored = actions.map((a) => ({ a, ...scoreAction(a, turnColor, workingTokens, active) }));
        scored.sort((x, y) => y.score - x.score);
        const best = scored[0];
        const explanation = aiExplain ? explainAction(best.a, turnColor, best.sim, d) : null;

        await wait(550);
        if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
        const result = commitAction(best.a, turnColor, workingTokens, d, used, explanation);
        if (result.done) { setAiBusy(false); return; }
        workingTokens = result.nextTokens;
        used = result.newUsed;
        await wait(250);
      }

      if (cancelled || epochRef.current !== myEpoch) { setAiBusy(false); return; }
      if (used[0] && used[1]) resolveEndOfDice(d);
      setAiBusy(false);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, turnColor, roles]);

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
    return (
      <div key={color} style={{ gridRow: `${r0 + 1} / span 6`, gridColumn: `${c0 + 1} / span 6`, background: COLORS[color].dim, border: `2px solid ${COLORS[color].hex}55`, borderRadius: 14, position: "relative", margin: 3 }}>
        {isAI && <Bot size={12} className="absolute top-1.5 left-1.5 opacity-60" style={{ color: COLORS[color].hex }} />}
        <div className="absolute inset-3 rounded-lg" style={{ background: c.surface }}>
          <div className="w-full h-full grid grid-cols-2 grid-rows-2 place-items-center">
            {list.filter((tk) => tk.step === -1).map((tk) => {
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
              return (
                <button key={`${color}-${tokenId}`} onClick={() => canTap && onTokenTap(tokenId)} disabled={!canTap} className="rounded-full" style={{
                  width: occ.length > 1 ? "48%" : "72%", height: occ.length > 1 ? "48%" : "72%",
                  background: COLORS[color].hex, border: "1.5px solid rgba(255,255,255,0.7)",
                  boxShadow: canTap ? `0 0 0 3px ${COLORS[color].hex}66` : "none", cursor: canTap ? "pointer" : "default",
                }} />
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
    const usable = dice != null && !diceUsed[i] && dieHasActions(i);
    const isArmed = armed && armed.type === "die" && armed.index === i;
    return (
      <button key={i} onClick={() => armDie(i)} disabled={!usable || roles[turnColor] === "ai"}
        className="flex items-center justify-center rounded-xl transition-all" style={{
          width: 44, height: 44, background: isArmed ? COLORS[turnColor]?.hex : c.surface,
          border: `2px solid ${isArmed ? COLORS[turnColor]?.hex : c.border}`,
          opacity: diceUsed[i] ? 0.3 : usable ? 1 : 0.55, cursor: usable && roles[turnColor] !== "ai" ? "pointer" : "default",
        }}>
        <Icon size={24} style={{ color: isArmed ? "#fff" : c.text }} />
      </button>
    );
  };

  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-16">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>
        <button onClick={() => setShowHelp(true)} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 font-body text-xs" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }}>
          <HelpCircle size={14} /> Help
        </button>
      </div>

      <div className="mb-5">
        <div className="font-display text-2xl" style={{ color: c.text }}>Ludo</div>
        <div className="font-body text-sm" style={{ color: c.textDim }}>Two dice, AI opponents optional — 2 to 4 players.</div>
      </div>

      {phase === "setup" && (
        <div>
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
          {anyAI && (
            <button onClick={() => setAiExplain((v) => !v)} className="w-full flex items-center justify-between rounded-xl px-3 py-2.5 mb-4 font-body text-sm" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}>
              <span className="flex items-center gap-2"><Bot size={14} style={{ color: c.textFaint }} /> AI explains its moves</span>
              <span className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase" style={{ background: aiExplain ? c.accent : c.border, color: aiExplain ? c.accentText : c.textFaint }}>{aiExplain ? "On" : "Off"}</span>
            </button>
          )}
          <button onClick={startGame} disabled={Object.keys(roles).length < 2} className="w-full rounded-xl py-3 font-display text-base disabled:opacity-40" style={{ background: c.accent, color: c.accentText }}>
            {Object.keys(roles).length < 2 ? "Pick at least 2 colors" : `Start (${Object.keys(roles).length} players)`}
          </button>
        </div>
      )}

      {(phase === "playing" || phase === "won") && (
        <div>
          <div className="aspect-square w-full rounded-2xl overflow-hidden mb-4 relative" style={{ border: `2px solid ${c.border}`, background: c.surface }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(15, 1fr)", gridTemplateRows: "repeat(15, 1fr)", width: "100%", height: "100%" }}>
              {COLOR_ORDER.map(renderYard)}
              {TRACK.map(([r, cc]) => renderTrackCell(r, cc))}
              {Object.entries(STRETCH).flatMap(([color, cells]) => cells.map(([r, cc]) => renderTrackCell(r, cc)))}
              {centerCells}
            </div>
            {celebrate && (
              <div className="absolute inset-x-0 top-3 flex justify-center pointer-events-none">
                <div className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-display text-sm animate-pulse" style={{ background: "rgba(0,0,0,0.8)", color: "#fff" }}>
                  <Zap size={14} style={{ color: "#E8B923" }} /> {celebrate.text}
                </div>
              </div>
            )}
          </div>

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
              <div className="flex items-center gap-2 flex-wrap">
                {renderDie(dice[0], 0)}
                {renderDie(dice[1], 1)}
                {combineHasActions && roles[turnColor] !== "ai" && (
                  <button onClick={armCombine} className="flex items-center gap-1.5 rounded-xl px-3 h-11 font-body text-xs" style={{ background: armed?.type === "combine" ? COLORS[turnColor].hex : c.bg, color: armed?.type === "combine" ? "#fff" : c.textDim, border: `2px solid ${armed?.type === "combine" ? COLORS[turnColor].hex : c.border}` }}>
                    <Combine size={14} /> {dice[0]}+{dice[1]}
                  </button>
                )}
              </div>
            )}
          </div>

          {log.length > 0 && (
            <div className="rounded-xl px-3.5 py-2.5 mb-3" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1.5 flex items-center gap-1.5" style={{ color: c.textFaint }}><Skull size={10} /> Battle log</div>
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {log.map((entry, i) => (
                  <div key={i} className="font-body text-xs" style={{ color: i === 0 ? c.text : c.textFaint }}>{entry}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {showHelp && <LudoHelpModal onClose={() => setShowHelp(false)} c={c} />}

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
