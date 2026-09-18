import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { ArrowLeft, Trophy, RotateCcw, Dice1, Dice2, Dice3, Dice4, Dice5, Dice6, Sparkles } from "lucide-react";

// Split out the same way Shop/Leaderboard/TransferMarket are: lazy-loaded
// from App.jsx, only mounted once someone opens it from Quick Actions.
// This is a local, pass-and-play mini-game (no Supabase, no leagues, no
// Nets) — a lighter break between real fixtures, not part of the money
// economy or results pipeline the rest of the app is built around.
//
// BOARD GEOMETRY — worth explaining since it isn't the textbook-standard
// 52-square Ludo track. Getting the classic cross-shaped board's track to
// close into one valid loop with clean corners, while also leaving room
// for every color's private home column, doesn't actually divide evenly
// into the traditional 52 cells once you also need genuine orthogonal
// adjacency at all 4 corners AND all 4 arm-to-arm handoffs — this
// construction (verified programmatically: 56 cells, every consecutive
// pair including the wraparound is a real orthogonal step, no cell
// reused) is what actually closes cleanly. The 4 starting squares end up
// unevenly spaced (13/14/14/15 cells apart) rather than a perfect 13
// apart, which has zero effect on fairness — every color still travels
// once all the way around before turning home, just counted from a
// different absolute cell. A token's move is rendered as a jump straight
// to its new square (matching the dice, not animated step-by-step), so
// the one place this board isn't pixel-adjacent — the last shared square
// before a color turns into its own home column — never actually shows.
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
// Roughly one per quarter plus every start square — close enough to the
// classic star-square placement, doesn't need to be exact.
const SAFE_INDICES = new Set([0, 6, 13, 19, 27, 33, 41, 47]);

const STRETCH = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
};
const STRETCH_LEN = 6;
const HOME_STEP = TRACK_LEN + STRETCH_LEN - 1; // last valid step index (finished)

// [row0, col0] of each color's 6x6 yard block, and where its 4 tokens
// sit inside it (2x2, in the yard's own local 0-5 coordinate space).
const YARD_ORIGIN = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };
const YARD_SLOT = [[1, 1], [1, 3], [3, 1], [3, 3]];

const COLORS = {
  red: { name: "Red", hex: "#E0433D", dim: "#E0433D33" },
  green: { name: "Green", hex: "#2FA84F", dim: "#2FA84F33" },
  yellow: { name: "Yellow", hex: "#E8B923", dim: "#E8B92333" },
  blue: { name: "Blue", hex: "#3B7FE0", dim: "#3B7FE033" },
};
const COLOR_ORDER = ["red", "green", "yellow", "blue"];

function absCellForStep(color, step) {
  // step: 0..TRACK_LEN-1 -> shared track; TRACK_LEN..HOME_STEP -> stretch.
  if (step < TRACK_LEN) return TRACK[(START_INDEX[color] + step) % TRACK_LEN];
  return STRETCH[color][step - TRACK_LEN];
}
function isSafeStep(color, step) {
  if (step >= TRACK_LEN) return true; // private stretch, never shared
  return SAFE_INDICES.has((START_INDEX[color] + step) % TRACK_LEN);
}

function freshTokens() { return [0, 1, 2, 3].map((i) => ({ id: i, step: -1 })); } // -1 = in yard

function diceIcon(v) { return [Dice1, Dice2, Dice3, Dice4, Dice5, Dice6][v - 1] || Dice1; }

export default function LudoPage({ onBack, c }) {
  const [phase, setPhase] = useState("setup"); // setup | playing | won
  const [active, setActive] = useState([]); // color keys in play, in turn order
  const [tokens, setTokens] = useState({}); // { color: [{id, step}] }
  const [turnIdx, setTurnIdx] = useState(0);
  const [dice, setDice] = useState(null);
  const [rolling, setRolling] = useState(false);
  const [sixStreak, setSixStreak] = useState(0);
  const [movable, setMovable] = useState([]); // token ids the current player can move with `dice`
  const [message, setMessage] = useState("Roll to begin.");
  const [winner, setWinner] = useState(null);
  const passTimer = useRef(null);

  useEffect(() => () => { if (passTimer.current) clearTimeout(passTimer.current); }, []);

  const turnColor = active[turnIdx];

  const toggleColor = (color) => {
    setActive((cur) => cur.includes(color) ? cur.filter((x) => x !== color) : [...cur, color]);
  };

  const startGame = () => {
    const order = COLOR_ORDER.filter((c2) => active.includes(c2));
    const t = {};
    order.forEach((c2) => { t[c2] = freshTokens(); });
    setActive(order);
    setTokens(t);
    setTurnIdx(0);
    setDice(null);
    setSixStreak(0);
    setMovable([]);
    setWinner(null);
    setMessage(`${COLORS[order[0]].name}'s turn — roll the dice.`);
    setPhase("playing");
  };

  const legalMovesFor = useCallback((color, d, tokenList) => {
    return (tokenList || tokens[color]).filter((tk) => {
      if (tk.step === -1) return d === 6; // needs a 6 to leave the yard
      if (tk.step === HOME_STEP) return false; // already home
      return tk.step + d <= HOME_STEP; // can't overshoot past home
    }).map((tk) => tk.id);
  }, [tokens]);

  const advanceTurn = useCallback((grantExtra) => {
    setDice(null);
    setMovable([]);
    if (grantExtra) {
      setMessage(`${COLORS[turnColor].name} rolls again!`);
      return;
    }
    setTurnIdx((i) => {
      const next = (i + 1) % active.length;
      setMessage(`${COLORS[active[next]].name}'s turn — roll the dice.`);
      return next;
    });
    setSixStreak(0);
  }, [active, turnColor]);

  const moveToken = (tokenId) => {
    if (dice == null) return;
    const color = turnColor;
    const list = tokens[color];
    const tk = list.find((x) => x.id === tokenId);
    if (!tk) return;
    const newStep = tk.step === -1 ? 0 : tk.step + dice;
    let captured = false;

    setTokens((prev) => {
      const next = { ...prev };
      next[color] = prev[color].map((x) => x.id === tokenId ? { ...x, step: newStep } : x);
      // Capture: any opponent token sharing this square on the open
      // track (never in a private stretch, never on a safe square) gets
      // sent straight back to its yard.
      if (newStep < TRACK_LEN && !isSafeStep(color, newStep)) {
        const [ar, ac] = absCellForStep(color, newStep);
        active.filter((oc) => oc !== color).forEach((oc) => {
          next[oc] = (next[oc] || prev[oc]).map((ox) => {
            if (ox.step === -1 || ox.step >= TRACK_LEN) return ox;
            const [orr, occ] = absCellForStep(oc, ox.step);
            if (orr === ar && occ === ac) { captured = true; return { ...ox, step: -1 }; }
            return ox;
          });
        });
      }
      return next;
    });

    const justFinished = newStep === HOME_STEP;
    const allHome = list.every((x) => x.id === tokenId || x.step === HOME_STEP) && justFinished;

    if (allHome) {
      setWinner(color);
      setPhase("won");
      setDice(null);
      setMovable([]);
      return;
    }

    const extra = dice === 6 || captured;
    setMessage(captured ? `${COLORS[color].name} sends a token home! ${extra ? "Roll again." : ""}`
      : justFinished ? `${COLORS[color].name} gets a token home! ${extra ? "Roll again." : ""}`
      : extra ? `${COLORS[color].name} rolls again!` : "");
    advanceTurn(extra);
  };

  const rollDice = () => {
    if (rolling || dice != null || phase !== "playing") return;
    setRolling(true);
    setMessage("");
    let ticks = 0;
    const spin = setInterval(() => {
      setDice(1 + Math.floor(Math.random() * 6));
      ticks++;
      if (ticks > 8) {
        clearInterval(spin);
        const value = 1 + Math.floor(Math.random() * 6);
        setDice(value);
        setRolling(false);

        const nextStreak = value === 6 ? sixStreak + 1 : 0;
        if (nextStreak === 3) {
          setSixStreak(0);
          setMessage("Three 6s in a row — turn forfeited!");
          passTimer.current = setTimeout(() => advanceTurn(false), 900);
          return;
        }
        setSixStreak(nextStreak);

        const moves = legalMovesFor(turnColor, value);
        setMovable(moves);
        if (moves.length === 0) {
          setMessage(`No move for ${value} — ${value === 6 ? "rolling again." : "turn passes."}`);
          passTimer.current = setTimeout(() => advanceTurn(value === 6), 900);
        } else if (moves.length === 1) {
          passTimer.current = setTimeout(() => moveToken(moves[0]), 500);
        } else {
          setMessage(`${COLORS[turnColor].name} rolled ${value} — tap a token to move it.`);
        }
      }
    }, 70);
  };

  const resetToSetup = () => {
    setPhase("setup");
    setActive([]);
    setTokens({});
    setWinner(null);
  };

  // ---- rendering helpers -------------------------------------------------
  const occupants = useMemo(() => {
    // key "r,c" -> [{color, tokenId}] for every token currently on the
    // shared track or a private stretch (yard/home tokens render
    // elsewhere).
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
    COLOR_ORDER.forEach((color) => { for (let i = 0; i < TRACK_LEN; i++) if (isSafeStep(color, i)) s.add(`${TRACK[(START_INDEX[color] + i) % TRACK_LEN].join(",")}`); });
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
    return (
      <div key={color}
        style={{
          gridRow: `${r0 + 1} / span 6`, gridColumn: `${c0 + 1} / span 6`,
          background: COLORS[color].dim, border: `2px solid ${COLORS[color].hex}55`,
          borderRadius: 14, position: "relative", margin: 3,
        }}>
        <div className="absolute inset-3 rounded-lg" style={{ background: c.surface }}>
          <div className="w-full h-full grid grid-cols-2 grid-rows-2 place-items-center">
            {list.filter((tk) => tk.step === -1).map((tk) => (
              <button key={tk.id} onClick={() => turnColor === color && dice != null && movable.includes(tk.id) && moveToken(tk.id)}
                disabled={!(turnColor === color && dice != null && movable.includes(tk.id))}
                className="rounded-full transition-transform"
                style={{
                  width: "44%", height: "44%", background: COLORS[color].hex,
                  border: "2px solid rgba(255,255,255,0.6)",
                  boxShadow: turnColor === color && movable.includes(tk.id) ? `0 0 0 4px ${COLORS[color].hex}55` : "none",
                  cursor: turnColor === color && movable.includes(tk.id) ? "pointer" : "default",
                  transform: turnColor === color && movable.includes(tk.id) ? "scale(1.08)" : "scale(1)",
                }} />
            ))}
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
      <div key={key} style={{
        gridRow: r + 1, gridColumn: cc + 1, background: bg,
        border: `1px solid ${c.border}`, position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {isSafe && !finalColor && <Sparkles size={9} style={{ color: c.textFaint, opacity: 0.6 }} />}
        {occ.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-[1px]" style={{ position: "absolute", inset: 1 }}>
            {occ.map(({ color, tokenId }) => {
              const canTap = turnColor === color && dice != null && movable.includes(tokenId);
              return (
                <button key={`${color}-${tokenId}`} onClick={() => canTap && moveToken(tokenId)} disabled={!canTap}
                  className="rounded-full"
                  style={{
                    width: occ.length > 1 ? "48%" : "72%", height: occ.length > 1 ? "48%" : "72%",
                    background: COLORS[color].hex, border: "1.5px solid rgba(255,255,255,0.7)",
                    boxShadow: canTap ? `0 0 0 3px ${COLORS[color].hex}66` : "none",
                    cursor: canTap ? "pointer" : "default",
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
        background: r === 7 && cc === 7
          ? `conic-gradient(${COLORS.red.hex} 0deg 90deg, ${COLORS.green.hex} 90deg 180deg, ${COLORS.yellow.hex} 180deg 270deg, ${COLORS.blue.hex} 270deg 360deg)`
          : c.surfaceAlt || c.surface,
        border: `1px solid ${c.border}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {r === 7 && cc === 7 && <Trophy size={11} color="#fff" style={{ filter: "drop-shadow(0 0 1px rgba(0,0,0,0.5))" }} />}
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-16">
      <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>

      <div className="mb-5">
        <div className="font-display text-2xl" style={{ color: c.text }}>Ludo</div>
        <div className="font-body text-sm" style={{ color: c.textDim }}>Pass-and-play — 2 to 4 on this device.</div>
      </div>

      {phase === "setup" && (
        <div>
          <div className="font-body text-xs uppercase tracking-wide mb-2" style={{ color: c.textFaint }}>Who's playing?</div>
          <div className="grid grid-cols-2 gap-2 mb-5">
            {COLOR_ORDER.map((color) => {
              const on = active.includes(color);
              return (
                <button key={color} onClick={() => toggleColor(color)}
                  className="flex items-center gap-2 rounded-xl px-3 py-2.5 font-body text-sm transition-colors"
                  style={{
                    background: on ? COLORS[color].dim : c.surface,
                    border: `1.5px solid ${on ? COLORS[color].hex : c.border}`,
                    color: c.text,
                  }}>
                  <span className="rounded-full" style={{ width: 14, height: 14, background: COLORS[color].hex }} />
                  {COLORS[color].name}
                  {on && <span className="ml-auto text-xs" style={{ color: c.textFaint }}>Player {active.indexOf(color) + 1}</span>}
                </button>
              );
            })}
          </div>
          <button onClick={startGame} disabled={active.length < 2}
            className="w-full rounded-xl py-3 font-display text-base disabled:opacity-40"
            style={{ background: c.accent, color: c.accentText || "#fff" }}>
            {active.length < 2 ? "Pick at least 2 colors" : `Start (${active.length} players)`}
          </button>
        </div>
      )}

      {(phase === "playing" || phase === "won") && (
        <div>
          <div className="aspect-square w-full rounded-2xl overflow-hidden mb-4" style={{ border: `2px solid ${c.border}`, background: c.surface }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(15, 1fr)", gridTemplateRows: "repeat(15, 1fr)", width: "100%", height: "100%" }}>
              {COLOR_ORDER.map(renderYard)}
              {TRACK.map(([r, cc]) => renderTrackCell(r, cc))}
              {Object.entries(STRETCH).flatMap(([color, cells]) => cells.map(([r, cc]) => renderTrackCell(r, cc)))}
              {centerCells}
            </div>
          </div>

          <div className="flex items-center gap-3 rounded-xl px-4 py-3 mb-3" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            <span className="rounded-full shrink-0" style={{ width: 16, height: 16, background: turnColor ? COLORS[turnColor].hex : c.border }} />
            <div className="flex-1 font-body text-sm" style={{ color: c.text }}>{message || `${turnColor ? COLORS[turnColor].name : ""}'s turn`}</div>
            <button onClick={rollDice} disabled={rolling || dice != null || phase === "won"}
              className="flex items-center gap-1.5 rounded-lg px-3 py-2 font-body text-sm disabled:opacity-40"
              style={{ background: c.accent, color: c.accentText || "#fff" }}>
              {React.createElement(diceIcon(dice || 1), { size: 18 })}
              {dice == null ? "Roll" : dice}
            </button>
          </div>
        </div>
      )}

      {phase === "won" && winner && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="rounded-2xl p-6 text-center max-w-xs w-full" style={{ background: c.surface, border: `2px solid ${COLORS[winner].hex}` }}>
            <Trophy size={36} style={{ color: COLORS[winner].hex, margin: "0 auto 10px" }} />
            <div className="font-display text-xl mb-1" style={{ color: c.text }}>{COLORS[winner].name} wins!</div>
            <div className="font-body text-sm mb-5" style={{ color: c.textDim }}>All four tokens home.</div>
            <button onClick={resetToSetup} className="w-full flex items-center justify-center gap-2 rounded-xl py-3 font-display text-base"
              style={{ background: c.accent, color: c.accentText || "#fff" }}>
              <RotateCcw size={16} /> Play again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
