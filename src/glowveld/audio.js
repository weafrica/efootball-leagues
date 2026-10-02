// Glowveld audio — everything is synthesised live with the Web Audio API (no sound files).
let ctx = null, master = null, musicOn = true, sfxOn = true, musicTimer = null, step16 = 0, nextT = 0, mood = 0;
export function unlock() {
  try {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination); }
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* audio unavailable */ }
}
export function setMuted(m) { musicOn = !m; sfxOn = !m; if (master) master.gain.value = m ? 0 : 0.5; }
function env(g, t, a, d, peak) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
function tone(freq, dur, type = 'sine', vol = 0.2, slideTo = 0, when = 0) {
  if (!ctx || !sfxOn) return; const t = ctx.currentTime + when;
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  env(g, t, 0.01, dur, vol); o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur, vol = 0.15, hp = 800, when = 0) {
  if (!ctx || !sfxOn) return; const t = ctx.currentTime + when, n = Math.floor(ctx.sampleRate * dur);
  const b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = b; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
  const g = ctx.createGain(); env(g, t, 0.005, dur, vol); s.connect(f); f.connect(g); g.connect(master); s.start(t);
}
const PENT = [0, 2, 4, 7, 9];                 // major pentatonic: always sounds happy, never clashes
const hz = (n) => 220 * Math.pow(2, n / 12);
export const sfx = {
  pick: (v = 1) => tone(v > 1 ? 1100 : 760 + Math.random() * 120, 0.09, 'triangle', 0.12, v > 1 ? 1500 : 1000),
  bank: (big) => { [0, 4, 7, big ? 12 : 9].forEach((s, i) => tone(hz(s + 12), 0.18, 'triangle', 0.16, 0, i * 0.06)); },
  zap: () => { tone(520, 0.25, 'sawtooth', 0.12, 90); noise(0.12, 0.1, 1500); },
  pulse: () => { tone(300, 0.2, 'sine', 0.12, 650); },
  hit: () => { tone(200, 0.2, 'square', 0.12, 70); },
  dash: () => noise(0.14, 0.09, 2500),
  pup: () => { [0, 5, 9, 12].forEach((s, i) => tone(hz(s + 12), 0.1, 'square', 0.08, 0, i * 0.05)); },
  pop: () => { tone(900, 0.12, 'triangle', 0.14, 300); },
  dark: () => { tone(240, 0.9, 'sawtooth', 0.1, 70); tone(120, 1.2, 'sine', 0.14, 50); },
  light: () => { [0, 4, 7, 12].forEach((s, i) => tone(hz(s + 12), 0.25, 'sine', 0.12, 0, i * 0.07)); },
  gremlin: () => { tone(180, 0.1, 'square', 0.08, 120); tone(150, 0.12, 'square', 0.08, 100, 0.12); },
  steal: () => { tone(500, 0.2, 'square', 0.1, 150); },
  poof: () => noise(0.18, 0.1, 600),
  tick: () => tone(1000, 0.05, 'square', 0.06),
  go: () => { tone(660, 0.12, 'triangle', 0.15); tone(990, 0.3, 'triangle', 0.15, 0, 0.12); },
  win: () => { [0, 4, 7, 12, 16, 19].forEach((s, i) => tone(hz(s + 12), 0.28, 'triangle', 0.15, 0, i * 0.1)); },
  emote: () => tone(880, 0.1, 'sine', 0.1, 1200),
};
// Generative "Blackout FM": log-drum bass + mbira-ish plucks, tempo and key change with the mood.
function logDrum(t, n) {
  const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine';
  const f = hz(n - 12); o.frequency.setValueAtTime(f * 2.2, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
  env(g, t, 0.005, 0.28, 0.5); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.4);
}
function pluck(t, n, vol = 0.1) {
  const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter(); o.type = 'triangle'; o.frequency.value = hz(n + 12);
  f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(500, t + 0.3);
  env(g, t, 0.004, 0.32, vol); o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + 0.4);
}
function hat(t, v) { const n = Math.floor(ctx.sampleRate * 0.04), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = b; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; const g = ctx.createGain(); env(g, t, 0.002, 0.04, v); s.connect(f); f.connect(g); g.connect(master); s.start(t); }
const BASS = [0, 0, 5, 7], BASS_D = [0, -3, 5, 7];
export function setMood(m) { mood = m; }   // 0 chill, 1 blackout (darker, faster), 2 final golden hour (fastest)
export function startMusic() {
  if (!ctx || musicTimer) return; nextT = ctx.currentTime + 0.1; step16 = 0;
  musicTimer = setInterval(() => {
    if (!ctx || !musicOn) { nextT = ctx ? ctx.currentTime + 0.1 : 0; return; }
    const bpm = mood === 2 ? 118 : mood === 1 ? 108 : 100, sp = 60 / bpm / 4;
    while (nextT < ctx.currentTime + 0.25) {
      const bar = Math.floor(step16 / 16) % 4, s = step16 % 16, root = (mood === 1 ? BASS_D : BASS)[bar];
      if (s === 0 || s === 6 || s === 10 || (s === 14 && bar % 2)) logDrum(nextT, root);
      if (s % 2 === 0 && (s !== 0 || mood)) hat(nextT, s % 4 === 2 ? 0.05 : 0.025);
      if ([2, 5, 8, 11, 13].includes(s) && Math.random() < 0.8) pluck(nextT, root + PENT[(s * 3 + bar + (Math.random() * 3 | 0)) % 5] + (mood === 1 ? -12 : 0), 0.07);
      nextT += sp; step16++;
    }
  }, 60);
}
export function stopMusic() { clearInterval(musicTimer); musicTimer = null; }
