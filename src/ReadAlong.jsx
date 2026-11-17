// Read-along text for a story page: while the narration plays, the line being
// read is softly highlighted in green and the word being spoken is solid
// green, so a reader can follow along (and a learner can match sound to word).
//
// WHERE THE TIMING COMES FROM
// The narration is one pre-rendered audio file per page (see Stories.jsx),
// and nothing stored with the story says when each line is spoken. So the
// timing is worked out in the browser from the audio itself:
//   1. Decode the audio and find the quiet gaps between spoken lines.
//   2. Estimate where each line ends from how much text it has.
//   3. Snap each estimate to the nearest real gap (when there is one).
// If decoding fails for any reason it falls back to the text-length estimate
// alone, and if there is no audio at all the page is just plain text — the
// highlight is an enhancement, never a requirement.
//
// EXACT TIMING, IF YOU EVER WANT IT
// If a node carries `lineTimings` (an array of start times in seconds, one
// per line), those are used as-is and no audio analysis happens. The narration
// scripts aren't in the repo, so nothing writes this yet.

import React, { useEffect, useMemo, useRef, useState } from "react";

// One unit per spoken line; a node with plain text is split into sentences.
function splitUnits(node) {
  if (node.lines?.length) return node.lines.map((l) => String(l.text || "")).filter(Boolean);
  const text = String(node.text || "");
  const parts = text.match(/[^.!?…]+[.!?…]*["”’)]*\s*/g) || [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

// How long a line takes to say, roughly: letters and digits, plus extra for
// the pauses that commas and full stops add.
function unitWeight(text) {
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const soft = (text.match(/[,;:–—-]/g) || []).length;
  const hard = (text.match(/[.!?…]/g) || []).length;
  return Math.max(1, letters + soft * 3 + hard * 6);
}

const FRAME = 0.02; // seconds per loudness sample
const MIN_GAP = 0.14; // a quiet stretch this long counts as a gap between lines
const LINE_GAP = 0.3; // typical pause between two lines, used for the estimate

async function analyseAudio(src) {
  const res = await fetch(src);
  const buf = await res.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, 22050);
  const audioBuf = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buf, resolve, reject); // callbacks for old Safari, promise elsewhere
    if (p && p.then) p.then(resolve, reject);
  });
  const data = audioBuf.getChannelData(0);
  const frame = Math.max(1, Math.round(audioBuf.sampleRate * FRAME));
  const n = Math.floor(data.length / frame);
  const level = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) sum += data[j] * data[j];
    level[i] = Math.sqrt(sum / frame);
    if (level[i] > peak) peak = level[i];
  }
  const threshold = Math.max(0.002, peak * 0.06);
  let first = 0;
  while (first < n && level[first] < threshold) first++;
  let last = n - 1;
  while (last > first && level[last] < threshold) last--;
  const gaps = [];
  let runStart = -1;
  for (let i = first; i <= last; i++) {
    if (level[i] < threshold) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const len = (i - runStart) * FRAME;
      if (len >= MIN_GAP) gaps.push({ start: runStart * FRAME, end: i * FRAME, len, mid: ((runStart + i) / 2) * FRAME });
      runStart = -1;
    }
  }
  return {
    duration: audioBuf.duration,
    speechStart: Math.max(0, first * FRAME - 0.04),
    speechEnd: Math.min(audioBuf.duration, (last + 1) * FRAME + 0.05),
    gaps,
  };
}

// Returns { starts, ends } — when each line starts and ends being read.
function buildTimings(units, a, explicitStarts) {
  const n = units.length;
  if (explicitStarts) {
    const starts = explicitStarts.map(Number);
    const ends = starts.map((_, i) => (i < n - 1 ? starts[i + 1] : a.speechEnd ?? a.duration));
    return { starts, ends };
  }
  const span = Math.max(0.1, a.speechEnd - a.speechStart);
  const weights = units.map(unitWeight);
  const total = weights.reduce((x, y) => x + y, 0);
  const talk = Math.max(0.1, span - LINE_GAP * (n - 1));
  const bounds = [];
  let acc = 0;
  let prev = a.speechStart;
  const window = Math.max(0.9, span * 0.12);
  for (let i = 0; i < n - 1; i++) {
    acc += weights[i];
    const estimate = a.speechStart + (acc / total) * talk + LINE_GAP * i + LINE_GAP / 2;
    let best = null;
    for (const g of a.gaps || []) {
      if (g.mid <= prev + 0.25 || Math.abs(g.mid - estimate) > window) continue;
      const score = g.len - 0.5 * Math.abs(g.mid - estimate);
      if (!best || score > best.score) best = { mid: g.mid, score };
    }
    const b = Math.min(a.speechEnd - 0.1, Math.max(prev + 0.25, best ? best.mid : estimate));
    bounds.push(b);
    prev = b;
  }
  const starts = [a.speechStart, ...bounds];
  const ends = [...bounds, a.speechEnd];
  return { starts, ends };
}

export default function ReadAlong({ node, nodeKey, audioRef, enabled, c }) {
  const units = useMemo(() => splitUnits(node), [node]);
  const [active, setActive] = useState({ unit: -1, word: -1 });
  const unitEls = useRef([]);

  useEffect(() => {
    const audio = audioRef?.current;
    setActive({ unit: -1, word: -1 });
    if (!enabled || !audio || units.length === 0) return undefined;

    let cancelled = false;
    let timings = null;
    let raf = 0;
    let last = { unit: -1, word: -1 };

    const tick = () => {
      cancelAnimationFrame(raf);
      if (cancelled || !timings || timings.src !== audio.src) return;
      const t = audio.currentTime;
      let unit = timings.starts.length - 1;
      for (let i = 0; i < timings.ends.length; i++) {
        if (t < timings.ends[i]) { unit = i; break; }
      }
      // Word inside the line: by how much of its text has been "said" so far.
      // The last bit of each line's slot is its pause, so the words use the
      // slot minus that pause.
      const start = timings.starts[unit];
      const slot = timings.ends[unit] - start;
      const usable = Math.max(0.1, slot - Math.min(LINE_GAP, slot * 0.15));
      const progress = Math.min(1, Math.max(0, (t - start) / usable));
      const words = units[unit].split(/\s+/).filter(Boolean);
      const lens = words.map((w) => w.length + 1);
      const totalLen = lens.reduce((x, y) => x + y, 0);
      let word = words.length - 1;
      let run = 0;
      for (let i = 0; i < words.length; i++) {
        run += lens[i];
        if (progress * totalLen <= run) { word = i; break; }
      }
      if (unit !== last.unit || word !== last.word) {
        last = { unit, word };
        setActive(last);
      }
      if (!audio.paused && !audio.ended) raf = requestAnimationFrame(tick);
    };

    const prepare = async () => {
      const src = audio.src;
      if (!src) return;
      timings = null;
      const explicit = Array.isArray(node.lineTimings) && node.lineTimings.length === units.length ? node.lineTimings : null;
      let analysis = null;
      try {
        analysis = explicit ? { duration: audio.duration, speechStart: 0, speechEnd: audio.duration || explicit[explicit.length - 1] + 3, gaps: [] } : await analyseAudio(src);
      } catch {
        const d = audio.duration;
        if (Number.isFinite(d) && d > 0) analysis = { duration: d, speechStart: 0, speechEnd: d, gaps: [] };
      }
      if (cancelled || audio.src !== src || !analysis) return;
      timings = { src, ...buildTimings(units, analysis, explicit) };
      tick();
    };

    const onEnded = () => { cancelAnimationFrame(raf); last = { unit: -1, word: -1 }; setActive(last); };

    // The page's audio file is attached by Stories.jsx after this effect runs,
    // so wait for the browser to say the new file is loaded.
    audio.addEventListener("loadedmetadata", prepare);
    audio.addEventListener("play", tick);
    audio.addEventListener("playing", tick);
    audio.addEventListener("seeked", tick);
    audio.addEventListener("timeupdate", tick);
    audio.addEventListener("ended", onEnded);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      audio.removeEventListener("loadedmetadata", prepare);
      audio.removeEventListener("play", tick);
      audio.removeEventListener("playing", tick);
      audio.removeEventListener("seeked", tick);
      audio.removeEventListener("timeupdate", tick);
      audio.removeEventListener("ended", onEnded);
    };
  }, [enabled, nodeKey, units, audioRef, node]);

  // Keep the line being read in view on small screens.
  useEffect(() => {
    if (active.unit < 0) return;
    const el = unitEls.current[active.unit];
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 70 || r.bottom > window.innerHeight - 90) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active.unit]);

  return (
    <p className="text-base leading-relaxed text-center">
      {units.map((u, i) => {
        const isActive = active.unit === i;
        let content = u;
        if (isActive) {
          let wordIndex = -1;
          content = u.split(/(\s+)/).map((token, k) => {
            if (/^\s+$/.test(token) || token === "") return token;
            wordIndex += 1;
            return wordIndex === active.word
              ? <span key={k} style={{ background: c.green, color: "#fff", borderRadius: 4, padding: "0 3px" }}>{token}</span>
              : token;
          });
        }
        return (
          <React.Fragment key={i}>
            <span
              ref={(el) => { unitEls.current[i] = el; }}
              style={isActive ? { background: c.greenSoft, borderRadius: 6, padding: "1px 3px", WebkitBoxDecorationBreak: "clone", boxDecorationBreak: "clone", transition: "background .2s" } : undefined}
            >
              {content}
            </span>
            {i < units.length - 1 ? " " : ""}
          </React.Fragment>
        );
      })}
    </p>
  );
}
