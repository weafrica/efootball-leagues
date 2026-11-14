// Product photo background remover (used in the shop's Edit product screen).
// Runs entirely in the browser: automatic removal for plain backgrounds, plus
// an erase / restore brush to touch up anything it missed. See
// utils/removeBackground.js for how the automatic part works and its limits.
import React, { useState, useEffect, useRef, useCallback } from "react";
import { X, Eraser, Undo2, Wand2, Brush } from "lucide-react";
import { toProxiedUrl } from "./utils/mediaUrl";
import { autoMask, softenMask, paintMask, composite } from "./utils/removeBackground";

const GOLD = "#D4A017";
const MAX_SIDE = 1000; // longest side of the working copy and of the saved photo

function loadBitmap(source) {
  return new Promise(async (resolve, reject) => {
    try {
      let blob = source;
      if (typeof source === "string") {
        const res = await fetch(toProxiedUrl(source));
        if (!res.ok) throw new Error("Couldn't load that photo.");
        blob = await res.blob();
      }
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't read that photo.")); };
      img.src = url;
    } catch (e) { reject(e); }
  });
}

export default function BackgroundRemover({ source, onDone, onClose, c }) {
  const canvasRef = useRef(null);
  const srcRef = useRef(null);        // { data, w, h } original pixels
  const maskRef = useRef(null);       // Uint8Array 0 / 255 (before softening)
  const historyRef = useRef([]);
  const drawingRef = useRef(false);
  const rafRef = useRef(0);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState("");
  const [tolerance, setTolerance] = useState(28);
  const [soften, setSoften] = useState(1);
  const [tool, setTool] = useState("erase"); // erase | restore
  const [brush, setBrush] = useState(18);
  const [white, setWhite] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [saving, setSaving] = useState(false);
  const optsRef = useRef({ soften, white });
  optsRef.current = { soften, white };

  const render = useCallback(() => {
    const cv = canvasRef.current, s = srcRef.current, m = maskRef.current;
    if (!cv || !s || !m) return;
    const { soften: sf, white: wh } = optsRef.current;
    const alpha = softenMask(m, s.w, s.h, sf);
    const out = composite(s.data, alpha, s.w, s.h, wh);
    cv.getContext("2d").putImageData(new ImageData(out, s.w, s.h), 0, 0);
  }, []);
  const scheduleRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; render(); });
  }, [render]);

  const pushHistory = () => {
    historyRef.current.push(maskRef.current.slice());
    if (historyRef.current.length > 15) historyRef.current.shift();
    setCanUndo(true);
  };

  // Load the photo once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const img = await loadBitmap(source);
        if (cancelled) return;
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const tmp = document.createElement("canvas");
        tmp.width = w; tmp.height = h;
        const ctx = tmp.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        srcRef.current = { data, w, h };
        maskRef.current = autoMask(data, w, h, 28);
        const cv = canvasRef.current;
        if (cv) { cv.width = w; cv.height = h; }
        setStatus("ready");
        render();
      } catch (e) { if (!cancelled) { setError(e.message || "Couldn't open that photo."); setStatus("error"); } }
    })();
    return () => { cancelled = true; if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [source, render]);

  useEffect(() => { if (status === "ready") scheduleRender(); }, [soften, white, status, scheduleRender]);

  const runAuto = (tol) => {
    const s = srcRef.current; if (!s) return;
    pushHistory();
    maskRef.current = autoMask(s.data, s.w, s.h, tol);
    scheduleRender();
  };

  const pointFromEvent = (e) => {
    const cv = canvasRef.current, rect = cv.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * cv.width, y: ((e.clientY - rect.top) / rect.height) * cv.height, k: cv.width / rect.width };
  };
  const stroke = (e) => {
    const s = srcRef.current; if (!s) return;
    const { x, y, k } = pointFromEvent(e);
    // The slider is in on-screen pixels; convert to image pixels.
    paintMask(maskRef.current, s.w, s.h, x, y, brush * k, tool === "erase" ? 0 : 255);
    scheduleRender();
  };
  const onDown = (e) => {
    if (status !== "ready") return;
    e.preventDefault();
    canvasRef.current.setPointerCapture?.(e.pointerId);
    pushHistory();
    drawingRef.current = true;
    stroke(e);
  };
  const onMove = (e) => { if (drawingRef.current) stroke(e); };
  const onUp = () => { drawingRef.current = false; };

  const undo = () => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    maskRef.current = prev;
    setCanUndo(historyRef.current.length > 0);
    scheduleRender();
  };

  const finish = async () => {
    setSaving(true);
    try {
      render();
      const blob = await new Promise((res) => canvasRef.current.toBlob(res, "image/png"));
      if (!blob) throw new Error("Couldn't save the photo.");
      onDone(new File([blob], `nobg-${Date.now()}.png`, { type: "image/png" }));
    } catch (e) { setError(e.message); setStatus("error"); }
    setSaving(false);
  };

  const chip = (on) => ({ background: on ? GOLD : c.surface, color: on ? "#1a1200" : c.text, border: `1px solid ${on ? GOLD : c.border}` });
  const checker = "repeating-conic-gradient(#c8c8c8 0% 25%, #f4f4f4 0% 50%) 50% / 16px 16px";

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.75)" }} onClick={onClose}>
      <div className="w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl p-4 max-h-[92vh] overflow-y-auto" style={{ background: c.bg }} onClick={(e) => e.stopPropagation()} data-testid="bg-remover">
        <div className="flex items-center justify-between mb-3">
          <div className="font-extrabold uppercase tracking-tight text-lg">Remove background</div>
          <button onClick={onClose} aria-label="Close"><X size={18} style={{ color: c.textDim }} /></button>
        </div>

        {status === "loading" && <div className="py-16 text-center font-body text-sm" style={{ color: c.textDim }}>Opening photo…</div>}
        {status === "error" && <div className="py-10 text-center font-body text-sm" style={{ color: c.red }}>{error}</div>}

        <div style={{ display: status === "ready" ? "block" : "none" }}>
          <div className="rounded-xl overflow-hidden" style={{ background: white ? "#fff" : checker, touchAction: "none" }}>
            <canvas ref={canvasRef} data-testid="bg-canvas" className="w-full h-auto block cursor-crosshair"
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
          </div>
          <p className="font-body text-xs mt-2" style={{ color: c.textFaint }}>
            Works best on a plain background. Use the brush to erase leftovers or bring back anything that was cut by mistake.
          </p>

          <div className="mt-3 space-y-3">
            <div>
              <div className="flex items-center justify-between font-body text-xs font-semibold mb-1" style={{ color: c.textDim }}>
                <span>Strength (how different from the background still counts as background)</span><span>{tolerance}</span>
              </div>
              <input type="range" min="4" max="90" value={tolerance} aria-label="Strength"
                onChange={(e) => { setTolerance(Number(e.target.value)); }} onPointerUp={() => runAuto(tolerance)} onKeyUp={() => runAuto(tolerance)} className="w-full" />
            </div>
            <div>
              <div className="flex items-center justify-between font-body text-xs font-semibold mb-1" style={{ color: c.textDim }}>
                <span>Smooth edges</span><span>{soften}</span>
              </div>
              <input type="range" min="0" max="3" value={soften} aria-label="Smooth edges" onChange={(e) => setSoften(Number(e.target.value))} className="w-full" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => runAuto(tolerance)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={chip(false)}><Wand2 size={13} /> Auto remove</button>
              <button onClick={() => setTool("erase")} aria-pressed={tool === "erase"} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={chip(tool === "erase")}><Eraser size={13} /> Erase</button>
              <button onClick={() => setTool("restore")} aria-pressed={tool === "restore"} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={chip(tool === "restore")}><Brush size={13} /> Restore</button>
              <button onClick={undo} disabled={!canUndo} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ ...chip(false), opacity: canUndo ? 1 : 0.4 }}><Undo2 size={13} /> Undo</button>
            </div>
            <div>
              <div className="flex items-center justify-between font-body text-xs font-semibold mb-1" style={{ color: c.textDim }}>
                <span>Brush size</span><span>{brush}</span>
              </div>
              <input type="range" min="4" max="60" value={brush} aria-label="Brush size" onChange={(e) => setBrush(Number(e.target.value))} className="w-full" />
            </div>
            <label className="flex items-center gap-2 cursor-pointer font-body text-xs" style={{ color: c.textDim }}>
              <input type="checkbox" checked={white} onChange={(e) => setWhite(e.target.checked)} /> Use a white background instead of transparent
            </label>
          </div>

          <button onClick={finish} disabled={saving} className="w-full mt-4 font-body text-sm font-semibold py-3 rounded-full" style={{ background: GOLD, color: "#1a1200", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Use this photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
