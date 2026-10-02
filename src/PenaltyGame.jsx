import React, { useState, useRef, useEffect, useCallback } from "react";

// PenaltyGame — a small timing mini-game: a marker sweeps across a power
// bar, tap to stop it in the target zone. Canvas-free, pure SVG + CSS +
// requestAnimationFrame — no assets, tiny code, same "100% code" spirit
// as the rest of the engine. onResult("win" | "lose") fires once, then
// the story continues from whichever node the caller wires it to.
export default function PenaltyGame({ onResult, c }) {
  const [phase, setPhase] = useState("ready"); // ready | swinging | done
  const [pos, setPos] = useState(0); // 0-100 across the bar
  const [result, setResult] = useState(null);
  const dirRef = useRef(1);
  const rafRef = useRef(null);
  const posRef = useRef(0);

  const targetStart = 62, targetEnd = 84; // the "goal" zone on the power bar

  useEffect(() => {
    if (phase !== "swinging") return;
    const speed = 1.7;
    const tick = () => {
      let next = posRef.current + dirRef.current * speed;
      if (next >= 100) { next = 100; dirRef.current = -1; }
      if (next <= 0) { next = 0; dirRef.current = 1; }
      posRef.current = next;
      setPos(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [phase]);

  const start = () => { posRef.current = 0; dirRef.current = 1; setPos(0); setPhase("swinging"); };

  const strike = useCallback(() => {
    if (phase !== "swinging") return;
    cancelAnimationFrame(rafRef.current);
    const hit = posRef.current >= targetStart && posRef.current <= targetEnd;
    setResult(hit ? "win" : "lose");
    setPhase("done");
    setTimeout(() => onResult(hit ? "win" : "lose"), 1100);
  }, [phase, onResult]);

  return (
    <div className="max-w-xs mx-auto text-center select-none" onClick={phase === "swinging" ? strike : undefined}>
      <div className="text-xs font-mono uppercase tracking-wider mb-2" style={{ color: c.textFaint }}>
        Penalty — tap the bar in the target zone
      </div>

      <div style={{ position: "relative", height: 28, borderRadius: 8, background: c.surface, border: `1px solid ${c.border}`, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: `${targetStart}%`, width: `${targetEnd - targetStart}%`, top: 0, bottom: 0, background: c.green || "#2ecc71", opacity: 0.35 }} />
        <div style={{ position: "absolute", left: `${pos}%`, top: 0, bottom: 0, width: 4, marginLeft: -2, background: c.accent, transition: phase === "done" ? "none" : undefined }} />
      </div>

      <div className="mt-4">
        {phase === "ready" && (
          <button onClick={start} className="rounded-xl px-5 py-2.5 font-bold" style={{ background: c.accent, color: c.accentText }}>
            Ready
          </button>
        )}
        {phase === "swinging" && (
          <div className="text-sm font-semibold animate-pulse" style={{ color: c.accent }}>Tap anywhere to strike!</div>
        )}
        {phase === "done" && (
          <div className="text-base font-bold" style={{ color: result === "win" ? (c.green || "#2ecc71") : c.textDim }}>
            {result === "win" ? "Top corner! 🎉" : "Straight at the keeper."}
          </div>
        )}
      </div>
    </div>
  );
}
