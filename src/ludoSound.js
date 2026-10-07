// Ludo sound effects — all synthesised with the Web Audio API, so there are
// no audio files to download or host. Every sound is a few oscillators and
// some filtered noise. Browsers only allow audio after a tap, so the first
// call (a dice roll / Start button) quietly unlocks it.

let ctx = null;
let master = null;

function ac() {
  if (!sfx.enabled || typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    } catch { return null; }
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// One oscillator note with a quick attack and an exponential fade-out.
function tone(a, { type = "sine", f0, f1 = null, t = 0, dur = 0.2, vol = 0.3, vibrato = 0, filter = 0 }) {
  const start = a.currentTime + t;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, start);
  if (f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  let node = osc;
  if (filter) {
    const lp = a.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = filter;
    osc.connect(lp); node = lp;
  }
  node.connect(g); g.connect(master);
  if (vibrato) {
    const lfo = a.createOscillator();
    const lg = a.createGain();
    lfo.frequency.value = 7; lg.gain.value = vibrato;
    lfo.connect(lg); lg.connect(osc.frequency);
    lfo.start(start); lfo.stop(start + dur + 0.05);
  }
  osc.start(start); osc.stop(start + dur + 0.05);
}

// A burst of filtered noise — crunches, whooshes, dice clatter.
function noise(a, { t = 0, dur = 0.2, vol = 0.3, freq = 1000, type = "lowpass", q = 1, sweepTo = null }) {
  const start = a.currentTime + t;
  const len = Math.max(1, Math.floor(a.sampleRate * dur));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, start);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, start + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(vol, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(start); src.stop(start + dur + 0.02);
}

export const sfx = {
  enabled: true,
  unlock() { ac(); },

  click() {
    const a = ac(); if (!a) return;
    tone(a, { type: "square", f0: 900, f1: 700, dur: 0.04, vol: 0.08 });
  },

  // Dice rattling in a cup: a run of little wooden clicks that speed up.
  roll() {
    const a = ac(); if (!a) return;
    let t = 0;
    for (let i = 0; i < 9; i++) {
      noise(a, { t, dur: 0.035, vol: 0.28, freq: 1800 + Math.random() * 2200, type: "bandpass", q: 3 });
      tone(a, { type: "triangle", f0: 220 + Math.random() * 120, f1: 120, t, dur: 0.05, vol: 0.12 });
      t += 0.075 - i * 0.004;
    }
  },

  step() {
    const a = ac(); if (!a) return;
    tone(a, { type: "triangle", f0: 560, f1: 360, dur: 0.1, vol: 0.22 });
  },

  safe() {
    const a = ac(); if (!a) return;
    tone(a, { type: "sine", f0: 880, dur: 0.22, vol: 0.2 });
    tone(a, { type: "sine", f0: 1175, t: 0.09, dur: 0.3, vol: 0.18 });
  },

  exit() {
    const a = ac(); if (!a) return;
    [392, 523, 659, 784].forEach((f, i) => tone(a, { type: "triangle", f0: f, t: i * 0.065, dur: 0.16, vol: 0.22 }));
    noise(a, { dur: 0.3, vol: 0.12, freq: 600, type: "highpass", sweepTo: 5000 });
  },

  // The big one. Boom + crunch + a sad-trombone "wah wah wahhh". Higher
  // `level` (a 2nd, 3rd... capture in the same turn) gets extra hits and a
  // rising siren so a rampage really sounds like one.
  capture(level = 1) {
    const a = ac(); if (!a) return;
    tone(a, { type: "sine", f0: 240, f1: 38, dur: 0.55, vol: 0.85 });
    noise(a, { dur: 0.4, vol: 0.55, freq: 900, type: "lowpass", sweepTo: 120 });
    [0, 0.05, 0.11].forEach((t) => noise(a, { t, dur: 0.07, vol: 0.4, freq: 2600, type: "highpass" }));
    noise(a, { t: 0.02, dur: 0.35, vol: 0.2, freq: 300, type: "bandpass", q: 0.8, sweepTo: 4000 });
    const wah = [[311, 0.28], [294, 0.28], [277, 0.28], [262, 0.7]];
    let t = 0.4;
    wah.forEach(([f, d], i) => {
      tone(a, { type: "sawtooth", f0: f, f1: i === 3 ? f * 0.86 : null, t, dur: d, vol: 0.16, vibrato: i === 3 ? 10 : 0, filter: 900 });
      t += d - 0.02;
    });
    for (let i = 1; i < Math.min(level, 4); i++) {
      const at = 0.12 * i;
      tone(a, { type: "sine", f0: 200 + i * 40, f1: 45, t: at, dur: 0.4, vol: 0.5 });
      noise(a, { t: at, dur: 0.15, vol: 0.35, freq: 2000, type: "highpass" });
    }
    if (level >= 2) tone(a, { type: "sawtooth", f0: 300, f1: 1400, t: 0.1, dur: 0.6, vol: 0.09, filter: 2400 });
  },

  home() {
    const a = ac(); if (!a) return;
    [523, 659, 784, 1047].forEach((f, i) => tone(a, { type: "triangle", f0: f, t: i * 0.09, dur: 0.35, vol: 0.24 }));
    tone(a, { type: "sine", f0: 2093, t: 0.36, dur: 0.6, vol: 0.1 });
  },

  win() {
    const a = ac(); if (!a) return;
    const notes = [[523, 0], [523, 0.14], [523, 0.28], [659, 0.42], [784, 0.7], [1047, 1.0]];
    notes.forEach(([f, t]) => tone(a, { type: "square", f0: f, t, dur: 0.22, vol: 0.16, filter: 3000 }));
    [523, 659, 784, 1047].forEach((f) => tone(a, { type: "triangle", f0: f, t: 1.05, dur: 1.1, vol: 0.16 }));
  },

  // A lock mechanically clicking open, then a bright, relieved little
  // fanfare — the "ransom paid, you're free" moment.
  buyback() {
    const a = ac(); if (!a) return;
    noise(a, { dur: 0.045, vol: 0.3, freq: 2400, type: "bandpass", q: 6 });
    noise(a, { t: 0.05, dur: 0.05, vol: 0.28, freq: 1800, type: "bandpass", q: 5 });
    tone(a, { type: "triangle", f0: 200, f1: 90, t: 0.08, dur: 0.12, vol: 0.18 });
    [523, 659, 784, 1047].forEach((f, i) => tone(a, { type: "triangle", f0: f, t: 0.18 + i * 0.07, dur: 0.22, vol: 0.2 }));
    tone(a, { type: "sine", f0: 1568, t: 0.46, dur: 0.4, vol: 0.12 });
  },

  // A small, attention-pulling "you have a choice" alert — plays when the
  // buyback prompt first appears, before the player taps anything.
  ransomAlert() {
    const a = ac(); if (!a) return;
    tone(a, { type: "sine", f0: 740, dur: 0.1, vol: 0.16 });
    tone(a, { type: "sine", f0: 988, t: 0.11, dur: 0.14, vol: 0.14 });
  },

  forfeit() {
    const a = ac(); if (!a) return;
    tone(a, { type: "sawtooth", f0: 140, f1: 90, dur: 0.45, vol: 0.28, filter: 1200 });
    tone(a, { type: "sawtooth", f0: 105, f1: 70, t: 0.22, dur: 0.5, vol: 0.28, filter: 1200 });
  },

  pass() {
    const a = ac(); if (!a) return;
    tone(a, { type: "sine", f0: 420, f1: 190, dur: 0.22, vol: 0.2 });
  },

  whoosh() {
    const a = ac(); if (!a) return;
    noise(a, { dur: 0.35, vol: 0.25, freq: 400, type: "bandpass", q: 1.2, sweepTo: 3500 });
  },
};
