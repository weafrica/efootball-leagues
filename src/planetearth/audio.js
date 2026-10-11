// Planet Earth — tiny synthesised sound effects (Web Audio, no files).
let ctx = null, master = null, muted = false;
export function unlock() { try { if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.4; master.connect(ctx.destination); } if (ctx.state === 'suspended') ctx.resume(); } catch { /* no audio */ } }
export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.4; }
function tone(f, d, type = 'sine', v = 0.2, slide = 0, when = 0) { if (!ctx || muted) return; const t = ctx.currentTime + when, o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + d); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.01); o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.05); }
const hz = (n) => 262 * Math.pow(2, n / 12);
export const sfx = {
  click: () => tone(660, 0.06, 'triangle', 0.12),
  next: () => tone(520, 0.1, 'triangle', 0.14, 780),
  ok: () => [0, 4, 7, 12].forEach((s, i) => tone(hz(s), 0.14, 'triangle', 0.16, 0, i * 0.07)),
  bad: () => tone(200, 0.22, 'sawtooth', 0.12, 120),
  win: () => [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(hz(s), 0.22, 'triangle', 0.16, 0, i * 0.09)),
  fire: () => { tone(180, 0.35, 'sawtooth', 0.16, 60); tone(900, 0.2, 'square', 0.05, 200); },
  boom: () => tone(90, 0.5, 'sawtooth', 0.2, 40),
};
