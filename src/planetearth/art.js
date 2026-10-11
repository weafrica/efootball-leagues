// Planet Earth — everything you see is drawn here with canvas code (no image files, zero download cost).
import { drawGlobe, cityScreen } from './earthmap.js';
import { subsolarLon, sunElevation, declination, dayLength, orbitAngle, fmtTime, clockTime, CITIES, TILT } from './sky.js';
import { WW, WH, SEA_X, FARM_A, FARM_B, groundY, cloudBase, surfaceTemp, dewPoint, airTemp } from './water.js';
import { RE, ALT, at } from './orbit.js';

export const ALIEN_COLORS = ['#7be37b', '#8fd3ff', '#ff9de0', '#ffd36b', '#c9a2ff', '#ff9a7a'];
export const ALIEN_NAMES = ['Zorp', 'Blip', 'Quark', 'Nebby', 'Zimble', 'Pixel', 'Orbo', 'Fizz', 'Glimmer', 'Wobble', 'Zeeb', 'Comet'];
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

export function drawStars(ctx, w, h, tm, n = 70) {
  for (let i = 0; i < n; i++) { const x = hash(i) * w, y = hash(i + 500) * h, r = 0.5 + hash(i + 900) * 1.3, a = 0.35 + 0.65 * Math.abs(Math.sin(tm * (0.6 + hash(i + 77)) + i));
    ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill(); }
}
export function spaceBg(ctx, w, h, tm) {
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#050a24'); g.addColorStop(1, '#14204f'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); drawStars(ctx, w, h, tm);
}
export function drawSun(ctx, x, y, r, tm, glow = 1) {
  const g = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * (2.4 + glow)); g.addColorStop(0, 'rgba(255,230,120,0.9)'); g.addColorStop(1, 'rgba(255,200,60,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * (2.4 + glow), 0, 6.3); ctx.fill();
  ctx.strokeStyle = 'rgba(255,225,110,0.8)'; ctx.lineWidth = Math.max(1.5, r * 0.1); for (let i = 0; i < 12; i++) { const a = (i / 12) * 6.283 + tm * 0.3; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r * 1.15, y + Math.sin(a) * r * 1.15); ctx.lineTo(x + Math.cos(a) * r * (1.4 + 0.15 * Math.sin(tm * 3 + i)), y + Math.sin(a) * r * (1.4 + 0.15 * Math.sin(tm * 3 + i))); ctx.stroke(); }
  ctx.fillStyle = '#ffd93b'; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.3); ctx.fill();
}
// ---- the alien: you! ----
export function drawAlien(ctx, x, y, s, ci = 0, tm = 0, look = { x: 0, y: 0 }, mood = 'happy') {
  const col = ALIEN_COLORS[ci % ALIEN_COLORS.length], bob = Math.sin(tm * 3) * s * 0.04; y += bob;
  ctx.save(); ctx.lineCap = 'round';
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(x, y + s * 0.62, s * 0.4, s * 0.09, 0, 0, 6.3); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = s * 0.05; for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + d * s * 0.18, y - s * 0.5); ctx.quadraticCurveTo(x + d * s * 0.35, y - s * 0.85, x + d * s * (0.3 + 0.05 * Math.sin(tm * 4)), y - s * 0.95); ctx.stroke(); ctx.fillStyle = '#fff6a8'; ctx.beginPath(); ctx.arc(x + d * s * (0.3 + 0.05 * Math.sin(tm * 4)), y - s * 0.95, s * 0.07, 0, 6.3); ctx.fill(); }
  ctx.lineWidth = s * 0.08; for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(x + d * s * 0.42, y + s * 0.05); ctx.lineTo(x + d * s * 0.6, y + s * (0.2 + 0.08 * Math.sin(tm * 5 + d))); ctx.stroke(); }
  const g = ctx.createRadialGradient(x - s * 0.15, y - s * 0.25, s * 0.05, x, y, s * 0.65); g.addColorStop(0, '#ffffffaa'); g.addColorStop(0.25, col); g.addColorStop(1, col);
  ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(x, y, s * 0.5, s * 0.58, 0, 0, 6.3); ctx.fill(); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 2; ctx.stroke();
  const lx = Math.max(-1, Math.min(1, look.x)) * s * 0.05, ly = Math.max(-1, Math.min(1, look.y)) * s * 0.05;
  for (const d of [-1, 1]) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(x + d * s * 0.2, y - s * 0.1, s * 0.15, s * 0.2, 0, 0, 6.3); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#1b2440'; ctx.beginPath(); ctx.arc(x + d * s * 0.2 + lx, y - s * 0.08 + ly, s * 0.08, 0, 6.3); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x + d * s * 0.2 + lx - s * 0.025, y - s * 0.12 + ly, s * 0.025, 0, 6.3); ctx.fill(); }
  ctx.strokeStyle = '#2a2a44'; ctx.lineWidth = s * 0.035; ctx.beginPath();
  if (mood === 'wow') ctx.arc(x, y + s * 0.2, s * 0.06, 0, 6.3); else ctx.arc(x, y + s * 0.12, s * 0.15, 0.15, Math.PI - 0.15); ctx.stroke();
  ctx.restore();
}
export function drawUfo(ctx, x, y, s, tm, smoke = false) {
  ctx.save(); ctx.translate(x, y + Math.sin(tm * 2) * s * 0.03);
  if (smoke) for (let i = 0; i < 5; i++) { const t = (tm * 0.5 + i / 5) % 1; ctx.fillStyle = `rgba(190,190,200,${0.5 * (1 - t)})`; ctx.beginPath(); ctx.arc(-s * 0.1 + Math.sin(i * 3) * s * 0.1, -s * 0.2 - t * s * 0.8, s * (0.06 + t * 0.12), 0, 6.3); ctx.fill(); }
  ctx.fillStyle = 'rgba(160,230,255,0.9)'; ctx.beginPath(); ctx.ellipse(0, -s * 0.12, s * 0.22, s * 0.2, 0, Math.PI, 0); ctx.fill();
  const g = ctx.createLinearGradient(0, -s * 0.1, 0, s * 0.12); g.addColorStop(0, '#d8dee9'); g.addColorStop(1, '#7c859c'); ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(0, 0, s * 0.5, s * 0.14, 0, 0, 6.3); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 2; ctx.stroke();
  for (let i = -2; i <= 2; i++) { ctx.fillStyle = Math.floor(tm * 4 + i) % 2 ? '#ffe27a' : '#ff8a4c'; ctx.beginPath(); ctx.arc(i * s * 0.16, s * 0.01, s * 0.03, 0, 6.3); ctx.fill(); }
  ctx.restore();
}
function label(ctx, t, x, y, size = 13, col = '#fff', align = 'center') { ctx.font = `800 ${size}px system-ui,sans-serif`; ctx.textAlign = align; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeText(t, x, y); ctx.fillStyle = col; ctx.fillText(t, x, y); }
const arrow = (ctx, x1, y1, x2, y2, col = '#fff', lw = 3) => { ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); const a = Math.atan2(y2 - y1, x2 - x1); ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - Math.cos(a - 0.45) * 9, y2 - Math.sin(a - 0.45) * 9); ctx.lineTo(x2 - Math.cos(a + 0.45) * 9, y2 - Math.sin(a + 0.45) * 9); ctx.closePath(); ctx.fill(); };

// ---- little scenes for the story cards ----
export function cardArt(ctx, kind, w, h, tm) {
  spaceBg(ctx, w, h, tm); const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.34;
  if (kind === 'sunearth') { drawSun(ctx, w * 0.14, cy, h * 0.14, tm); drawGlobe(ctx, w * 0.62, cy, R, 20, 15, { sun: { lon: 110, lat: 0 }, grid: false }); drawAlien(ctx, w * 0.9, h * 0.72, h * 0.25, 0, tm, { x: -1, y: -0.5 }, 'wow'); }
  else if (kind === 'spin') { drawSun(ctx, w * 0.92, cy, h * 0.1, tm); drawGlobe(ctx, cx * 0.9, cy, R, -((tm * 20) % 360), 15, { sun: { lon: -((tm * 20) % 360) + 90, lat: 0 }, grid: false }); arrow(ctx, cx * 0.9 - R * 0.6, cy - R * 1.2, cx * 0.9 + R * 0.6, cy - R * 1.2, '#ffe27a'); label(ctx, 'spins!', cx * 0.9, cy - R * 1.3, 13, '#ffe27a'); }
  else if (kind === 'timezones') { const cl = [['London', 12], ['Joburg', 14], ['Mumbai', 17.5], ['Tokyo', 21], ['Sydney', 22]]; cl.forEach(([n, hr], i) => { const x = w * (0.12 + i * 0.19), r = Math.min(w * 0.075, h * 0.2); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, cy, r, 0, 6.3); ctx.fill(); ctx.strokeStyle = '#223'; ctx.lineWidth = 2.5; const a1 = ((hr % 12) / 12) * 6.283 - 1.5708, a2 = 0 - 1.5708; ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + Math.cos(a1) * r * 0.5, cy + Math.sin(a1) * r * 0.5); ctx.moveTo(x, cy); ctx.lineTo(x + Math.cos(a2) * r * 0.8, cy + Math.sin(a2) * r * 0.8); ctx.stroke(); label(ctx, n, x, cy + r + 16, 11); label(ctx, hr >= 18 || hr < 6 ? '🌙' : '☀️', x, cy - r - 8, 16); if (i) arrow(ctx, x - w * 0.12, cy + r + 30, x - w * 0.07, cy + r + 30, '#ffe27a', 2); }); label(ctx, 'east → later', cx, h - 10, 12, '#ffe27a'); }
  else if (kind === 'orbit') { drawSun(ctx, cx, cy, R * 0.28, tm); ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.5, R * 0.95, 0, 0, 6.3); ctx.stroke(); ctx.setLineDash([]); const a = tm * 0.8; drawGlobe(ctx, cx + Math.cos(a) * R * 1.5, cy + Math.sin(a) * R * 0.95, R * 0.28, 28, 10, { sun: { lon: 28 + 90, lat: 0 }, grid: false }); label(ctx, '1 year = 1 lap', cx, h - 10, 12, '#ffe27a'); }
  else if (kind === 'tilt') { drawSun(ctx, w * 0.1, cy, h * 0.1, tm); for (let i = 0; i < 5; i++) { ctx.strokeStyle = 'rgba(255,225,110,0.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(w * 0.2, cy - R + i * R * 0.5); ctx.lineTo(w * 0.52, cy - R + i * R * 0.5); ctx.stroke(); }
    drawGlobe(ctx, w * 0.66, cy, R, 28, 0, { sun: { lon: 28 - 90, lat: 0 }, grid: false }); ctx.save(); ctx.translate(w * 0.66, cy); ctx.rotate(0.409); ctx.strokeStyle = '#ffe27a'; ctx.lineWidth = 3; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(0, -R * 1.35); ctx.lineTo(0, R * 1.35); ctx.stroke(); ctx.setLineDash([]); ctx.restore(); label(ctx, '23.4° tilt', w * 0.66, cy - R * 1.45, 13, '#ffe27a'); }
  else if (kind === 'seasons') { drawSun(ctx, cx, cy, R * 0.25, tm); [[-1, 0, 'Jun: N summer'], [1, 0, 'Dec: S summer'], [0, -1, 'Mar'], [0, 1, 'Sep']].forEach(([dx, dy, t]) => { const x = cx + dx * R * 1.5, y = cy + dy * R * 0.95; drawGlobe(ctx, x, y, R * 0.24, 28, 10, { sun: { lon: 28 + (dx ? (dx > 0 ? -90 : 90) : 0) + 90 * 0, lat: 0 }, grid: false }); label(ctx, t, x, y + R * 0.4, 11, dx ? '#ffe27a' : '#cfe'); }); }
  else if (kind === 'waterloop') { ctx.fillStyle = '#1b5fc9'; ctx.fillRect(0, h * 0.72, w * 0.5, h * 0.28); ctx.fillStyle = '#4a9a4a'; ctx.beginPath(); ctx.moveTo(w * 0.5, h); ctx.lineTo(w * 0.5, h * 0.72); ctx.lineTo(w * 0.75, h * 0.5); ctx.lineTo(w, h * 0.72); ctx.lineTo(w, h); ctx.fill(); drawSun(ctx, w * 0.1, h * 0.2, h * 0.09, tm);
    ctx.fillStyle = '#fff'; for (const [x, y] of [[0.42, 0.18], [0.5, 0.15], [0.58, 0.19]]) { ctx.beginPath(); ctx.arc(w * x, h * y, h * 0.08, 0, 6.3); ctx.fill(); } arrow(ctx, w * 0.25, h * 0.7, w * 0.36, h * 0.28, '#9cf'); arrow(ctx, w * 0.62, h * 0.3, w * 0.7, h * 0.46, '#9cf'); arrow(ctx, w * 0.8, h * 0.78, w * 0.56, h * 0.82, '#9cf'); label(ctx, 'evaporation', w * 0.2, h * 0.5, 11); label(ctx, 'rain', w * 0.8, h * 0.4, 11); label(ctx, 'rivers', w * 0.72, h * 0.9, 11); }
  else if (kind === 'cloud') { ctx.fillStyle = '#8fd0ff'; ctx.fillRect(0, h * 0.8, w, h * 0.2); for (let i = 0; i < 6; i++) { const t = (tm * 0.3 + i / 6) % 1; ctx.fillStyle = `rgba(255,255,255,${0.7 - t * 0.4})`; ctx.beginPath(); ctx.arc(w * (0.2 + i * 0.06) + Math.sin(tm + i) * 4, h * 0.8 - t * h * 0.5, 3, 0, 6.3); ctx.fill(); } ctx.fillStyle = '#fff'; for (const [x, y, r] of [[0.28, 0.2, 0.09], [0.35, 0.16, 0.1], [0.42, 0.22, 0.08]]) { ctx.beginPath(); ctx.arc(w * x, h * y, h * r, 0, 6.3); ctx.fill(); } label(ctx, 'Cooler up high → cloud!', w * 0.62, h * 0.22, 12, '#ffe27a'); label(ctx, '28°C', w * 0.9, h * 0.78, 12, '#ff9a7a'); label(ctx, '10°C', w * 0.9, h * 0.25, 12, '#9cf'); arrow(ctx, w * 0.9, h * 0.72, w * 0.9, h * 0.32, '#fff', 2); }
  else if (kind === 'mountainrain') { ctx.fillStyle = '#8a8f9c'; ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w * 0.15, h * 0.8); ctx.lineTo(w * 0.5, h * 0.3); ctx.lineTo(w * 0.85, h * 0.8); ctx.lineTo(w, h * 0.85); ctx.lineTo(w, h); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(w * 0.42, h * 0.43); ctx.lineTo(w * 0.5, h * 0.3); ctx.lineTo(w * 0.58, h * 0.43); ctx.fill();
    ctx.fillStyle = '#eef6ff'; for (const [x, y, r] of [[0.28, 0.32, 0.08], [0.35, 0.28, 0.09], [0.22, 0.38, 0.06]]) { ctx.beginPath(); ctx.arc(w * x, h * y, h * r, 0, 6.3); ctx.fill(); } ctx.strokeStyle = '#6ab8ff'; ctx.lineWidth = 2; for (let i = 0; i < 6; i++) { const x = w * (0.2 + i * 0.04), t = (tm * 1.5 + i * 0.3) % 1; ctx.beginPath(); ctx.moveTo(x, h * 0.4 + t * h * 0.3); ctx.lineTo(x - 2, h * 0.4 + t * h * 0.3 + 9); ctx.stroke(); }
    arrow(ctx, w * 0.04, h * 0.2, w * 0.2, h * 0.2, '#fff'); label(ctx, 'wind', w * 0.1, h * 0.14, 11); label(ctx, 'RAIN', w * 0.3, h * 0.62, 12, '#9cf'); label(ctx, 'DRY', w * 0.8, h * 0.65, 12, '#ffcf6a'); label(ctx, 'rain shadow', w * 0.8, h * 0.74, 11, '#ffcf6a'); }
  else if (kind === 'gravity') { drawGlobe(ctx, cx, h * 1.15, h * 0.78, 28, 60, { grid: false }); ctx.fillStyle = '#e24b4b'; const y = h * 0.1 + ((tm * 0.8) % 1) * h * 0.2; ctx.beginPath(); ctx.arc(cx, y, 9, 0, 6.3); ctx.fill(); arrow(ctx, cx + 30, h * 0.2, cx + 30, h * 0.38, '#ffe27a'); label(ctx, 'gravity pulls DOWN', cx + 40, h * 0.3, 12, '#ffe27a', 'left'); }
  else if (kind === 'orbit2') { const ex = cx, ey = h * 1.1, er = h * 0.72; drawGlobe(ctx, ex, ey, er, 28, 90, { grid: false }); ctx.fillStyle = '#8a8f9c'; ctx.fillRect(ex - 6, ey - er - 14, 12, 14); ctx.fillStyle = '#444'; ctx.fillRect(ex, ey - er - 12, 22, 6); [['#9cf', 0.25], ['#ffe27a', 0.5], ['#ff9a7a', 1.0]].forEach(([c2, k], i) => { ctx.strokeStyle = c2; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(ex, ey, er + 14 + i * 1, -1.5708, -1.5708 + k * 1.6); ctx.stroke(); }); label(ctx, 'faster → farther → ORBIT', cx, h * 0.16, 12, '#ffe27a'); }
  else if (kind === 'iss') { drawGlobe(ctx, cx, h * 1.3, h * 0.95, 28, 40, { grid: false }); const a = tm * 0.5; const x = cx + Math.cos(a) * w * 0.3, y = h * 0.3 + Math.sin(a) * h * 0.08; ctx.fillStyle = '#cfd6e6'; ctx.fillRect(x - 24, y - 6, 48, 12); ctx.fillStyle = '#4a7fd6'; ctx.fillRect(x - 40, y - 12, 14, 24); ctx.fillRect(x + 26, y - 12, 14, 24); drawAlien(ctx, x + 70, y + 20 + Math.sin(tm * 2) * 5, h * 0.2, 0, tm, { x: 0, y: 0 }, 'wow'); label(ctx, 'falling together = floating', cx, h - 12, 12, '#ffe27a'); }
  else { drawUfo(ctx, cx, cy, h * 0.6, tm, true); }
}

// ---- Level 1: the spinning planet, sun on the right ----
export function drawSpin(ctx, w, h, tm, st) {
  spaceBg(ctx, w, h, tm); const R = Math.min(w * 0.4, h * 0.4), cx = w * 0.47, cy = h * 0.5, sl = subsolarLon(st.utc), lon0 = sl - 90;
  drawSun(ctx, w * 0.95, cy, Math.min(w, h) * 0.07, tm);
  ctx.strokeStyle = 'rgba(255,225,110,0.18)'; ctx.lineWidth = 3; for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(w * 0.9, cy + i * R * 0.35); ctx.lineTo(cx + R * 1.05, cy + i * R * 0.35); ctx.stroke(); }
  drawGlobe(ctx, cx, cy, R, lon0, 12, { sun: { lon: sl, lat: 0 }, cities: CITIES.filter((c) => c.id !== 'tos'), labels: true, selected: st.selected });
  arrow(ctx, cx - R * 0.5, cy - R * 1.17, cx + R * 0.5, cy - R * 1.17, '#ffe27a', 3); label(ctx, 'Earth spins this way', cx, cy - R * 1.25, 12, '#ffe27a'); label(ctx, 'DAY', cx + R * 0.55, cy + R * 1.2, 13, '#ffe27a'); label(ctx, 'NIGHT', cx - R * 0.55, cy + R * 1.2, 13, '#9fb4ff');
}
export function spinCityAt(w, h, st, px, py) { // which city did the player tap?
  const R = Math.min(w * 0.4, h * 0.4), cx = w * 0.47, cy = h * 0.5, lon0 = subsolarLon(st.utc) - 90; let best = null, bd = 22;
  for (const c of CITIES) { const s = cityScreen(c, cx, cy, R, lon0, 12); if (!s.visible) continue; const d = Math.hypot(s.x - px, s.y - py); if (d < bd) { bd = d; best = c.id; } } return best;
}

// ---- Level 2: orbit view + the Sun's path across your sky ----
export function drawSeasons(ctx, w, h, tm, st) {
  const wide = w >= h * 1.15, A = wide ? [0, 0, w * 0.5, h] : [0, 0, w, h * 0.5], B = wide ? [w * 0.5, 0, w * 0.5, h] : [0, h * 0.5, w, h * 0.5];
  // orbit panel
  { const [x0, y0, pw, ph] = A; ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip(); spaceBg(ctx, pw, ph, tm); ctx.translate(x0, y0);
    const cx = pw / 2, cy = ph / 2, a = Math.min(pw * 0.38, ph * 0.38); drawSun(ctx, cx, cy, a * 0.2, tm);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.setLineDash([5, 6]); ctx.beginPath(); ctx.arc(cx, cy, a, 0, 6.3); ctx.stroke(); ctx.setLineDash([]);
    [[79, 'Mar 20'], [171, 'Jun 21'], [265, 'Sep 22'], [354, 'Dec 21']].forEach(([d, t]) => { const an = orbitAngle(d); label(ctx, t, cx + Math.cos(an) * a * 1.0, cy - Math.sin(an) * a * 1.0 + (Math.sin(an) > 0 ? -a * 0.32 : a * 0.42), 10, 'rgba(255,255,255,0.75)'); });
    const an = orbitAngle(st.day), ex = cx + Math.cos(an) * a, ey = cy - Math.sin(an) * a, re = a * 0.17;
    ctx.fillStyle = '#1d5fcf'; ctx.beginPath(); ctx.arc(ex, ey, re, 0, 6.3); ctx.fill(); const ds = Math.atan2(cy - ey, cx - ex);
    ctx.fillStyle = 'rgba(5,8,40,0.62)'; ctx.beginPath(); ctx.arc(ex, ey, re, ds + Math.PI / 2, ds + Math.PI * 1.5); ctx.fill();
    const lean = Math.sin(st.tilt * Math.PI / 180) * re * 1.9; ctx.strokeStyle = '#ffe27a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(ex, ey + lean * 0.0 + re * 1.0 * 0 + lean); ctx.lineTo(ex, ey - lean); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex, ey - lean, 3.5, 0, 6.3); ctx.fill(); label(ctx, 'N', ex + 10, ey - lean - 2, 11, '#fff');
    const dec = declination(st.day, st.tilt); label(ctx, dec > 4 ? 'North leans TOWARD the Sun' : dec < -4 ? 'South leans TOWARD the Sun' : 'Neither half leans toward the Sun', cx, ph - 10, 12, '#ffe27a'); ctx.restore(); }
  // sky panel
  { const [x0, y0, pw, ph] = B; ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip(); ctx.translate(x0, y0);
    const dec = declination(st.day, st.tilt), lat = st.lat, hy = ph * 0.74, top = 28, len = dayLength(lat, dec), noon = sunElevation(lat, dec, 0);
    const g = ctx.createLinearGradient(0, 0, 0, hy); g.addColorStop(0, '#2a62c9'); g.addColorStop(1, '#a9d8ff'); ctx.fillStyle = g; ctx.fillRect(0, 0, pw, hy);
    ctx.fillStyle = '#4e9d4a'; ctx.fillRect(0, hy, pw, ph - hy);
    const X = (H) => pw * 0.5 + (H / 180) * pw * 0.5, Y = (e) => hy - (e / 90) * (hy - top);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 3; ctx.beginPath(); let pen = false; for (let H = -180; H <= 180; H += 3) { const e = sunElevation(lat, dec, H); if (e >= 0) { pen ? ctx.lineTo(X(H), Y(e)) : ctx.moveTo(X(H), Y(e)); pen = true; } else pen = false; } ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.setLineDash([3, 5]); ctx.beginPath(); pen = false; for (let H = -180; H <= 180; H += 3) { const e = sunElevation(lat, dec, H); if (e < 0) { pen ? ctx.lineTo(X(H), Y(e) * 0 + hy + (-e / 90) * (ph - hy)) : ctx.moveTo(X(H), hy + (-e / 90) * (ph - hy)); pen = true; } else pen = false; } ctx.stroke(); ctx.setLineDash([]);
    const Hs = ((tm * 40) % 360) - 180, es = sunElevation(lat, dec, Hs); if (es > -4) drawSun(ctx, X(Hs), Y(es), 11, tm, 0.2);
    drawAlien(ctx, pw * 0.5, hy + (ph - hy) * 0.45, Math.min(ph * 0.2, 50), st.alienColor || 0, tm, { x: Math.cos(Hs * 0.017) * 0.8, y: -0.8 });
    label(ctx, st.cityName || 'Your spot', 10, 18, 13, '#fff', 'left'); label(ctx, 'Day length: ' + (len >= 23.99 ? '24 h (the Sun never sets!)' : len <= 0.01 ? '0 h (polar night)' : len.toFixed(1) + ' h'), 10, 36, 13, '#ffe27a', 'left'); label(ctx, 'Noon Sun height: ' + Math.max(0, noon).toFixed(0) + '°', 10, 54, 12, '#fff', 'left'); ctx.restore(); }
}

// ---- Level 3: the water cycle world ----
export function drawWater(ctx, w, h, tm, wt) {
  const s = Math.min(w / WW, h / WH), ox = (w - WW * s) / 2, X = (x) => ox + x * s, Y = (y) => h - (y + 55) * s, sun = wt.sun;
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, `rgb(${60 + sun * 40},${120 + sun * 40},${210})`); g.addColorStop(1, '#bfe6ff'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  drawSun(ctx, X(70), Y(335), 14 + sun * 12, tm, sun);
  // sea
  ctx.fillStyle = '#1f6fd0'; ctx.beginPath(); ctx.moveTo(X(0), h); ctx.lineTo(X(0), Y(0)); for (let x = 0; x <= SEA_X; x += 10) ctx.lineTo(X(x), Y(0) + Math.sin(tm * 2 + x * 0.09) * 2.5 * s); ctx.lineTo(X(SEA_X), h); ctx.fill();
  // land
  ctx.beginPath(); ctx.moveTo(X(SEA_X), h); for (let x = SEA_X; x <= WW; x += 8) ctx.lineTo(X(x), Y(groundY(wt, x))); ctx.lineTo(X(WW), h); ctx.closePath(); const lg = ctx.createLinearGradient(0, Y(180), 0, Y(0)); lg.addColorStop(0, '#9a8f84'); lg.addColorStop(0.5, '#6f8f4a'); lg.addColorStop(1, '#5aa04a'); ctx.fillStyle = lg; ctx.fill();
  if (wt.mtn.h > 90) { ctx.fillStyle = '#fff'; ctx.beginPath(); let first = true; for (let x = SEA_X; x <= WW; x += 4) { const gy = groundY(wt, x); if (gy > 0.72 * wt.mtn.h + 10) { first ? ctx.moveTo(X(x), Y(gy)) : ctx.lineTo(X(x), Y(gy)); first = false; } } for (let x = WW; x >= SEA_X; x -= 4) { const gy = groundY(wt, x); if (gy > 0.72 * wt.mtn.h + 10) ctx.lineTo(X(x), Y(Math.max(gy - 18, 0.72 * wt.mtn.h))); } ctx.fill(); }
  // farms
  for (const [fa, nm, n] of [[FARM_A, 'Farm A', wt.stats.rainA], [FARM_B, 'Farm B', wt.stats.rainB]]) { const mid = (fa[0] + fa[1]) / 2, gy = groundY(wt, mid); ctx.fillStyle = '#c9a23a'; ctx.fillRect(X(fa[0]), Y(groundY(wt, fa[0])) - 3, (fa[1] - fa[0]) * s, 7); ctx.strokeStyle = '#3d8a2e'; ctx.lineWidth = 2; for (let x = fa[0] + 6; x < fa[1]; x += 11) { const gy2 = groundY(wt, x); ctx.beginPath(); ctx.moveTo(X(x), Y(gy2)); ctx.lineTo(X(x), Y(gy2) - 9 * s); ctx.stroke(); }
    label(ctx, nm, X(mid), Y(gy) + 26 * s, 12, '#fff'); label(ctx, '💧 ' + n, X(mid), Y(gy) + 42 * s, 11, '#bfe6ff'); }
  // cloud-base line + thermometer
  const cb = cloudBase(wt); ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(X(0), Y(cb)); ctx.lineTo(X(WW), Y(cb)); ctx.stroke(); ctx.setLineDash([]);
  label(ctx, `Cloud forms here: ${airTemp(wt, cb).toFixed(0)}°C = dew point`, X(8), Y(cb) - 5, 10, '#fff', 'left'); label(ctx, `Sea ${surfaceTemp(wt).toFixed(0)}°C`, X(8), Y(0) + 22 * s, 11, '#fff', 'left');
  // wind arrows
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2; for (let i = 0; i < 4; i++) { const x = ((tm * 40 * wt.wind + i * 200) % WW), y = 300 - i * 10; ctx.beginPath(); ctx.moveTo(X(x), Y(y)); ctx.lineTo(X(x + 20 * Math.min(wt.wind, 2)), Y(y)); ctx.stroke(); }
  // particles
  for (const q of wt.p) { if (q.k === 'v') { ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(X(q.x) - 1, Y(q.y) - 1, 2.5, 2.5); }
    else if (q.k === 'c') { ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(X(q.x), Y(q.y), 4.2 * s + 1, 0, 6.3); ctx.fill(); }
    else if (q.k === 'r') { ctx.strokeStyle = '#4a9bff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X(q.x), Y(q.y)); ctx.lineTo(X(q.x) - 1, Y(q.y) + 8); ctx.stroke(); }
    else { ctx.fillStyle = '#58b0ff'; ctx.beginPath(); ctx.arc(X(q.x), Y(q.y) - 1, 2, 0, 6.3); ctx.fill(); } }
}

// ---- Level 4: Newton's cannon ----
export function drawCannon(ctx, w, h, tm, st) {
  spaceBg(ctx, w, h, tm); const cx = w / 2, cy = h * 0.66, sc = (Math.min(w, h) * 0.36 / RE) / st.zoom, Rp = RE * sc;
  const P = (x, y) => ({ x: cx + x * sc, y: cy - y * sc });
  drawGlobe(ctx, cx, cy, Rp, tm * 2, 90, { grid: false });
  const top = P(0, RE), mt = P(0, RE + ALT); ctx.fillStyle = '#8a8f9c'; ctx.beginPath(); ctx.moveTo(top.x - Math.max(4, 40 * sc), top.y + 2); ctx.lineTo(mt.x, mt.y); ctx.lineTo(top.x + Math.max(4, 40 * sc), top.y + 2); ctx.fill();
  ctx.fillStyle = '#333'; ctx.save(); ctx.translate(mt.x, mt.y); ctx.rotate(-st.angle * Math.PI / 180); ctx.fillRect(-2, -3, Math.max(14, 700 * sc), 6); ctx.restore();
  if (st.flagAngle != null) { const a = st.flagAngle * Math.PI / 180, f = P(Math.sin(a) * RE, Math.cos(a) * RE), f2 = P(Math.sin(a) * (RE + 380), Math.cos(a) * (RE + 380)); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f2.x, f2.y); ctx.stroke(); ctx.fillStyle = '#ff4b4b'; ctx.beginPath(); ctx.moveTo(f2.x, f2.y); ctx.lineTo(f2.x + 14, f2.y + 5); ctx.lineTo(f2.x, f2.y + 10); ctx.fill(); }
  const COLS = ['#6fd0ff', '#ffe27a', '#ff9a7a', '#c9a2ff'];
  (st.history || []).slice(-3).forEach((f, i, arr) => { ctx.strokeStyle = COLS[i % 4]; ctx.globalAlpha = 0.25 + 0.2 * i; ctx.lineWidth = 2; ctx.beginPath(); f.points.forEach((p, k) => { const q = P(p.x, p.y); k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }); ctx.stroke(); }); ctx.globalAlpha = 1;
  if (st.flight) { const f = st.flight; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.beginPath(); let n = 0; for (const p of f.points) { if (p.t > st.t) break; const q = P(p.x, p.y); n ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); n++; } ctx.stroke(); const b = at(f, st.t), q = P(b.x, b.y); ctx.fillStyle = '#ff6a3d'; ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, 6.3); ctx.fill(); ctx.fillStyle = '#ffd27a'; ctx.beginPath(); ctx.arc(q.x - 1.5, q.y - 1.5, 2.3, 0, 6.3); ctx.fill(); }
  else { const a = st.angle * Math.PI / 180, L = 20 + st.speed * 8; arrow(ctx, mt.x, mt.y, mt.x + Math.cos(a) * L, mt.y - Math.sin(a) * L, '#ffe27a', 3); }
  label(ctx, st.speed.toFixed(2) + ' km/s', mt.x, mt.y - 22, 13, '#ffe27a');
}
