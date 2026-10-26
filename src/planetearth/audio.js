// Planet Earth — tiny synthesised sound effects (Web Audio, no files).
let ctx = null, master = null, muted = false;
export function unlock() { try { if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.4; master.connect(ctx.destination); } if (ctx.state === 'suspended') ctx.resume(); } catch { /* no audio */ } }
export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.4; }
function tone(f, d, type = 'sine', v = 0.2, slide = 0, when = 0) { if (!ctx || muted) return; const t = ctx.currentTime + when, o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + d); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.01); o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.05); }
const hz = (n) => 262 * Math.pow(2, n / 12);
function noise(d, v = 0.15, hp = 800, when = 0) { if (!ctx || muted) return; const t = ctx.currentTime + when, n = Math.floor(ctx.sampleRate * d), b = ctx.createBuffer(1, n, ctx.sampleRate), dd = b.getChannelData(0); for (let i = 0; i < n; i++) dd[i] = Math.random() * 2 - 1; const sN = ctx.createBufferSource(); sN.buffer = b; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; const g = ctx.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d); sN.connect(f); f.connect(g); g.connect(master); sN.start(t); }
export const sfx = {
  sting: () => { tone(110, 0.9, 'sawtooth', 0.12, 65); tone(233, 0.7, 'square', 0.05, 349, 0.05); },
  pop: () => tone(380, 0.09, 'triangle', 0.22, 950),
  boing: () => { tone(180, 0.35, 'sine', 0.22, 700); tone(700, 0.3, 'sine', 0.12, 260, 0.3); },
  clap: () => [0, 0.28, 0.5, 0.65, 0.78].forEach((t) => noise(0.07, 0.2, 1800, t)),
  wah: () => { [233, 220, 208].forEach((f, i) => tone(f, 0.38, 'sawtooth', 0.1, f * 0.97, i * 0.42)); tone(196, 0.9, 'sawtooth', 0.1, 150, 1.26); },
  crash: () => { noise(0.7, 0.25, 300); tone(90, 0.6, 'sawtooth', 0.2, 35); },
  whoosh: () => { noise(1.2, 0.12, 900); tone(120, 1.2, 'sawtooth', 0.06, 700); },
  scream: () => { tone(500, 0.6, 'sawtooth', 0.12, 1400); noise(0.5, 0.08, 2500); },
  click: () => tone(660, 0.06, 'triangle', 0.12),
  next: () => tone(520, 0.1, 'triangle', 0.14, 780),
  ok: () => [0, 4, 7, 12].forEach((s, i) => tone(hz(s), 0.14, 'triangle', 0.16, 0, i * 0.07)),
  bad: () => tone(200, 0.22, 'sawtooth', 0.12, 120),
  win: () => [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(hz(s), 0.22, 'triangle', 0.16, 0, i * 0.09)),
  fire: () => { tone(180, 0.35, 'sawtooth', 0.16, 60); tone(900, 0.2, 'square', 0.05, 200); },
  boom: () => tone(90, 0.5, 'sawtooth', 0.2, 40),
};
