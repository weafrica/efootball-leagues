// Glowveld renderer — every pixel is drawn with canvas code. No images anywhere.
import { W, H, BEACON, TREES, RECTS, COLORS, HATS, PR, GOLDEN_HOUR, quadOf, RING_N, LAP_BONUS, ringStart, ringXY, isSafeCell } from './sim.js';

const SKIN = ['#8d5524', '#c68642', '#e0ac69', '#f1c27d', '#a0674b', '#6b4226'];
const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

// ground is painted once into an offscreen canvas and reused every frame
let ground = null;
function makeGround() {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#7fb35a'); gr.addColorStop(1, '#6aa24d'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 1500; i++) { const x = hash(i) * W, y = hash(i + 9000) * H, k = hash(i + 4000);
    g.fillStyle = k < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(30,70,20,0.07)'; g.beginPath(); g.arc(x, y, 6 + k * 22, 0, 6.3); g.fill(); }
  // dusty roads (cross + ring) so the world has a "town" shape
  g.lineCap = 'round'; g.strokeStyle = '#d9b97a'; g.lineWidth = 58;
  for (const [a, b, c2, d] of [[0, H / 2, W, H / 2], [W / 2, 0, W / 2, H]]) { g.beginPath(); g.moveTo(a, b); g.lineTo(c2, d); g.stroke(); }
  g.beginPath(); g.ellipse(W / 2, H / 2, 280, 200, 0, 0, 6.3); g.stroke();
  g.strokeStyle = '#e7cd95'; g.lineWidth = 36;
  for (const [a, b, c2, d] of [[0, H / 2, W, H / 2], [W / 2, 0, W / 2, H]]) { g.beginPath(); g.moveTo(a, b); g.lineTo(c2, d); g.stroke(); }
  g.beginPath(); g.ellipse(W / 2, H / 2, 280, 200, 0, 0, 6.3); g.stroke();
  // grass tufts and flowers
  for (let i = 0; i < 380; i++) { const x = hash(i + 1) * W, y = hash(i + 77) * H; if (Math.abs(y - H / 2) < 34 || Math.abs(x - W / 2) < 34) continue;
    g.strokeStyle = 'rgba(40,90,30,0.55)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 4, y); g.lineTo(x - 6, y - 8); g.moveTo(x, y); g.lineTo(x, y - 10); g.moveTo(x + 4, y); g.lineTo(x + 6, y - 8); g.stroke();
    if (hash(i + 5) > 0.82) { g.fillStyle = ['#fff', '#ffd1e8', '#fff3a0'][i % 3]; g.beginPath(); g.arc(x + 9, y - 4, 3, 0, 6.3); g.fill(); } }
  // Kasi Square paving
  g.fillStyle = '#f0dfb8'; g.beginPath(); g.arc(BEACON.x, BEACON.y, BEACON.r + 52, 0, 6.3); g.fill();
  g.strokeStyle = 'rgba(160,120,60,0.35)'; g.lineWidth = 2;
  for (let r = BEACON.r + 12; r < BEACON.r + 52; r += 14) { g.beginPath(); g.arc(BEACON.x, BEACON.y, r, 0, 6.3); g.stroke(); }
  // Shweshwe-style border pattern around the map edge
  const tile = 28; for (let x = 0; x < W; x += tile) for (const y of [0, H - 12]) { g.fillStyle = (x / tile) % 2 ? '#2a5fa8' : '#f4f1e8'; g.fillRect(x, y, tile, 12); g.fillStyle = '#e24b4b'; g.fillRect(x + 10, y + 3, 6, 6); }
  for (let y = 12; y < H - 12; y += tile) for (const x of [0, W - 12]) { g.fillStyle = (y / tile) % 2 ? '#2a5fa8' : '#f4f1e8'; g.fillRect(x, y, 12, tile); g.fillStyle = '#e24b4b'; g.fillRect(x + 3, y + 10, 6, 6); }
  return c;
}

function tree(g, t, tm) {
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.ellipse(t.x + 6, t.y + t.r * 0.7, t.r * 1.1, t.r * 0.5, 0, 0, 6.3); g.fill();
  g.fillStyle = '#7a4b2a'; g.fillRect(t.x - 5, t.y - 4, 10, t.r * 0.9);
  const sway = Math.sin(tm * 1.3 + t.x) * 1.5;
  for (const [dx, dy, r, col] of [[-t.r * 0.5, -t.r * 0.2, t.r * 0.75, '#2f8f4e'], [t.r * 0.5, -t.r * 0.2, t.r * 0.75, '#2f8f4e'], [0, -t.r * 0.7, t.r * 0.9, '#3fae60']]) {
    g.fillStyle = col; g.beginPath(); g.arc(t.x + dx + sway, t.y + dy, r, 0, 6.3); g.fill(); }
}
function building(g, r) {
  g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(r.x + 6, r.y + 8, r.w, r.h);
  if (r.k === 'crate') { g.fillStyle = '#b57b3e'; g.fillRect(r.x, r.y, r.w, r.h); g.strokeStyle = '#7a4b22'; g.lineWidth = 3; g.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4); g.beginPath(); g.moveTo(r.x, r.y); g.lineTo(r.x + r.w, r.y + r.h); g.moveTo(r.x + r.w, r.y); g.lineTo(r.x, r.y + r.h); g.stroke(); return; }
  if (r.k === 'shack') { g.fillStyle = '#e8b86a'; g.fillRect(r.x, r.y, r.w, r.h); g.fillStyle = '#9aa7b2'; g.fillRect(r.x - 4, r.y - 6, r.w + 8, 22);
    g.strokeStyle = '#7d8a95'; g.lineWidth = 2; for (let i = 0; i < r.w + 8; i += 8) { g.beginPath(); g.moveTo(r.x - 4 + i, r.y - 6); g.lineTo(r.x - 4 + i, r.y + 16); g.stroke(); }
    g.fillStyle = '#6b3f1f'; g.fillRect(r.x + r.w / 2 - 9, r.y + r.h - 30, 18, 30); g.fillStyle = '#ffe9a8'; g.fillRect(r.x + 8, r.y + 30, 16, 14); return; }
  // stall with striped awning
  g.fillStyle = '#d9a35c'; g.fillRect(r.x, r.y + 14, r.w, r.h - 14);
  const n = 6, sw = r.w / n; for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#fff' : '#e0455b'; g.fillRect(r.x + i * sw, r.y, sw, 20); }
  g.fillStyle = '#3b2a1a'; for (let i = 0; i < 4; i++) { g.fillStyle = ['#ff8a4c', '#5ad469', '#ffd93b', '#ff5d73'][i]; g.beginPath(); g.arc(r.x + 16 + i * 26, r.y + 34, 8, 0, 6.3); g.fill(); }
}
function beacon(g, tm, power, left) {
  const { x, y } = BEACON, pulse = 1 + Math.sin(tm * 3) * 0.06;
  const rg = g.createRadialGradient(x, y, 10, x, y, 230 * pulse); rg.addColorStop(0, `rgba(255,236,150,${0.55 + power * 0.25})`); rg.addColorStop(1, 'rgba(255,236,150,0)');
  g.fillStyle = rg; g.beginPath(); g.arc(x, y, 230 * pulse, 0, 6.3); g.fill();
  g.fillStyle = '#6b7a99'; g.beginPath(); g.arc(x, y, BEACON.r, 0, 6.3); g.fill();
  g.strokeStyle = '#ffe27a'; g.lineWidth = 8; g.beginPath(); g.arc(x, y, BEACON.r - 6, 0, 6.3); g.stroke();
  g.save(); g.translate(x, y); g.rotate(tm * (left <= GOLDEN_HOUR ? 1.8 : 0.6));
  for (let i = 0; i < 8; i++) { g.rotate(Math.PI / 4); g.fillStyle = i % 2 ? '#ffd93b' : '#fff6c4'; g.beginPath(); g.moveTo(0, -BEACON.r + 14); g.lineTo(9, -BEACON.r + 34); g.lineTo(-9, -BEACON.r + 34); g.fill(); }
  g.restore();
  g.fillStyle = '#ffd93b'; g.beginPath(); g.arc(x, y, 30 + Math.sin(tm * 5) * 3, 0, 6.3); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x + 6, y - 22); g.lineTo(x - 10, y + 3); g.lineTo(x, y + 3); g.lineTo(x - 6, y + 22); g.lineTo(x + 12, y - 4); g.lineTo(x + 2, y - 4); g.closePath(); g.fill();
}
function spark(g, s, tm) {
  const bob = Math.sin(tm * 4 + s.id) * 2, r = s.v > 1 ? 9 : 6.5;
  const gl = g.createRadialGradient(s.x, s.y + bob, 1, s.x, s.y + bob, r * 3); const col = s.v > 1 ? '255,200,40' : '120,235,255';
  gl.addColorStop(0, `rgba(${col},0.75)`); gl.addColorStop(1, `rgba(${col},0)`); g.fillStyle = gl; g.beginPath(); g.arc(s.x, s.y + bob, r * 3, 0, 6.3); g.fill();
  g.fillStyle = s.v > 1 ? '#ffd23b' : '#7fe9ff'; g.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4 + tm, rr = i % 2 ? r * 0.5 : r; g.lineTo(s.x + Math.cos(a) * rr, s.y + bob + Math.sin(a) * rr); }
  g.closePath(); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(s.x, s.y + bob, 2.2, 0, 6.3); g.fill();
}
const PUP_ICON = { shoe: ['#3aa0ff', 'Speed'], shield: ['#7a7cff', 'Bubble'], magnet: ['#ff5d73', 'Magnet'], bolt: ['#ffb020', 'Cash-in'] };
function powerup(g, u, tm) {
  const [col] = PUP_ICON[u.k], b = Math.sin(tm * 3 + u.id) * 3;
  g.fillStyle = 'rgba(0,0,0,0.2)'; g.beginPath(); g.ellipse(u.x, u.y + 18, 12, 5, 0, 0, 6.3); g.fill();
  g.fillStyle = col; g.beginPath(); g.arc(u.x, u.y + b, 15, 0, 6.3); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke();
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath();
  if (u.k === 'shoe') { g.moveTo(u.x - 7, u.y + b - 4); g.lineTo(u.x + 2, u.y + b - 4); g.lineTo(u.x + 8, u.y + b + 4); g.lineTo(u.x - 7, u.y + b + 4); g.closePath(); g.fill(); }
  else if (u.k === 'shield') { g.arc(u.x, u.y + b, 7, 0, 6.3); g.stroke(); }
  else if (u.k === 'magnet') { g.arc(u.x, u.y + b + 2, 7, Math.PI, 0); g.stroke(); }
  else { g.moveTo(u.x + 3, u.y + b - 8); g.lineTo(u.x - 5, u.y + b + 1); g.lineTo(u.x + 1, u.y + b + 1); g.lineTo(u.x - 3, u.y + b + 9); g.stroke(); }
}
function gremlin(g, m, tm) {
  const bob = Math.sin(tm * 9 + m.id) * 2;
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.ellipse(m.x, m.y + 14, 12, 5, 0, 0, 6.3); g.fill();
  g.fillStyle = m.st > 0 ? '#9b8fb5' : '#5b3b8c'; g.beginPath(); g.ellipse(m.x, m.y + bob, 13, 12, 0, 0, 6.3); g.fill();
  g.beginPath(); g.moveTo(m.x - 11, m.y - 6 + bob); g.lineTo(m.x - 18, m.y - 20 + bob); g.lineTo(m.x - 4, m.y - 10 + bob); g.moveTo(m.x + 11, m.y - 6 + bob); g.lineTo(m.x + 18, m.y - 20 + bob); g.lineTo(m.x + 4, m.y - 10 + bob); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(m.x - 5, m.y - 2 + bob, 4, 0, 6.3); g.arc(m.x + 5, m.y - 2 + bob, 4, 0, 6.3); g.fill();
  g.fillStyle = '#222'; g.beginPath(); g.arc(m.x - 5 + (m.vx > 0 ? 1 : -1), m.y - 2 + bob, 1.8, 0, 6.3); g.arc(m.x + 5 + (m.vx > 0 ? 1 : -1), m.y - 2 + bob, 1.8, 0, 6.3); g.fill();
  g.strokeStyle = '#222'; g.lineWidth = 2; g.beginPath(); g.arc(m.x, m.y + 5 + bob, 4, 0.1, Math.PI - 0.1); g.stroke();
  if (m.loot > 0) { g.fillStyle = '#ffd23b'; g.beginPath(); g.arc(m.x, m.y - 22 + bob, 6, 0, 6.3); g.fill(); g.fillStyle = '#7a4b00'; g.font = 'bold 9px sans-serif'; g.textAlign = 'center'; g.fillText(m.loot, m.x, m.y - 19 + bob); }
  if (m.st > 0) { g.fillStyle = '#ffd93b'; for (let i = 0; i < 3; i++) { const a = tm * 6 + i * 2.1; g.beginPath(); g.arc(m.x + Math.cos(a) * 14, m.y - 18 + Math.sin(a) * 4, 2.5, 0, 6.3); g.fill(); } }
}
function hatDraw(g, kind, x, y) {
  g.save(); g.translate(x, y - 14); g.lineWidth = 2; g.strokeStyle = '#0003';
  if (kind === 'party') { g.fillStyle = '#ff5d73'; g.beginPath(); g.moveTo(-8, 0); g.lineTo(8, 0); g.lineTo(0, -20); g.closePath(); g.fill(); g.stroke(); g.fillStyle = '#ffd93b'; g.beginPath(); g.arc(0, -21, 3, 0, 6.3); g.fill(); }
  else if (kind === 'crown') { g.fillStyle = '#ffd23b'; g.beginPath(); g.moveTo(-10, 0); g.lineTo(-10, -12); g.lineTo(-5, -6); g.lineTo(0, -14); g.lineTo(5, -6); g.lineTo(10, -12); g.lineTo(10, 0); g.closePath(); g.fill(); g.stroke(); }
  else if (kind === 'cap') { g.fillStyle = '#3aa0ff'; g.beginPath(); g.arc(0, 0, 11, Math.PI, 0); g.fill(); g.fillRect(2, -2, 15, 4); }
  else if (kind === 'antenna') { g.strokeStyle = '#444'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -16); g.stroke(); g.fillStyle = '#ff5d73'; g.beginPath(); g.arc(0, -18, 4, 0, 6.3); g.fill(); }
  else if (kind === 'flower') { for (let i = 0; i < 5; i++) { g.fillStyle = '#ff9ad0'; g.beginPath(); g.arc(Math.cos(i * 1.256) * 5, -6 + Math.sin(i * 1.256) * 5, 4, 0, 6.3); g.fill(); } g.fillStyle = '#ffd93b'; g.beginPath(); g.arc(0, -6, 3, 0, 6.3); g.fill(); }
  else if (kind === 'halo') { g.strokeStyle = '#ffe27a'; g.lineWidth = 3; g.beginPath(); g.ellipse(0, -8, 10, 3.5, 0, 0, 6.3); g.stroke(); }
  else if (kind === 'leaf') { g.fillStyle = '#4cc66b'; g.beginPath(); g.ellipse(0, -8, 4, 10, 0.5, 0, 6.3); g.fill(); }
  g.restore();
}
export function drawPlayer(g, p, tm, isMe, big = 1) {
  const speed = Math.hypot(p.vx, p.vy), walk = Math.sin(tm * 14 + p.id.toString().length * 3 + (typeof p.id === 'number' ? p.id : 0)) * Math.min(1, speed / 120);
  const col = COLORS[p.color % COLORS.length], skin = SKIN[(typeof p.id === 'number' ? p.id : p.name.length) % SKIN.length];
  g.save(); g.translate(p.x, p.y); g.scale(big, big); g.translate(-p.x, -p.y);
  g.fillStyle = 'rgba(0,0,0,0.22)'; g.beginPath(); g.ellipse(p.x, p.y + 15, 14, 6, 0, 0, 6.3); g.fill();
  if (p.shield > 0) { g.strokeStyle = `rgba(150,170,255,${0.6 + Math.sin(tm * 8) * 0.2})`; g.fillStyle = 'rgba(150,170,255,0.18)'; g.lineWidth = 3; g.beginPath(); g.arc(p.x, p.y, 25, 0, 6.3); g.fill(); g.stroke(); }
  if (p.speed > 0) { g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2; for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(p.x - p.vx * 0.06 - 6, p.y - 8 + i * 8); g.lineTo(p.x - p.vx * 0.14 - 14, p.y - 8 + i * 8); g.stroke(); } }
  const flash = p.grace > 0 && Math.floor(tm * 14) % 2 === 0 && p.stun <= 0;
  g.globalAlpha = flash ? 0.5 : 1;
  // feet
  g.fillStyle = '#3a2a1f'; g.beginPath(); g.ellipse(p.x - 6, p.y + 12 + walk * 3, 5, 3.5, 0, 0, 6.3); g.ellipse(p.x + 6, p.y + 12 - walk * 3, 5, 3.5, 0, 0, 6.3); g.fill();
  // body (shweshwe-style patterned top)
  g.fillStyle = col; g.beginPath(); g.roundRect ? g.roundRect(p.x - 12, p.y - 6, 24, 20, 8) : g.rect(p.x - 12, p.y - 6, 24, 20); g.fill();
  g.fillStyle = 'rgba(255,255,255,0.45)'; for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(p.x - 6 + i * 6, p.y + 4, 1.6, 0, 6.3); g.fill(); }
  // arms
  g.strokeStyle = skin; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(p.x - 12, p.y - 2); g.lineTo(p.x - 17, p.y + 6 + walk * 4); g.moveTo(p.x + 12, p.y - 2); g.lineTo(p.x + 17, p.y + 6 - walk * 4); g.stroke();
  // head
  const dizzy = p.stun > 0, fx = Math.cos(p.a) * 2.5, fy = Math.sin(p.a) * 1.5;
  g.fillStyle = skin; g.beginPath(); g.arc(p.x, p.y - 12, 11, 0, 6.3); g.fill();
  g.fillStyle = '#2b1b12'; g.beginPath(); g.arc(p.x, p.y - 15, 11, Math.PI * 1.05, Math.PI * 1.95); g.fill();
  if (dizzy) { g.strokeStyle = '#222'; g.lineWidth = 1.6; for (const dx of [-4, 4]) { g.beginPath(); g.moveTo(p.x + dx - 2, p.y - 14); g.lineTo(p.x + dx + 2, p.y - 10); g.moveTo(p.x + dx + 2, p.y - 14); g.lineTo(p.x + dx - 2, p.y - 10); g.stroke(); } }
  else { g.fillStyle = '#fff'; g.beginPath(); g.arc(p.x - 4 + fx, p.y - 12 + fy, 3, 0, 6.3); g.arc(p.x + 4 + fx, p.y - 12 + fy, 3, 0, 6.3); g.fill(); g.fillStyle = '#111'; g.beginPath(); g.arc(p.x - 4 + fx * 1.4, p.y - 12 + fy * 1.4, 1.5, 0, 6.3); g.arc(p.x + 4 + fx * 1.4, p.y - 12 + fy * 1.4, 1.5, 0, 6.3); g.fill(); }
  g.strokeStyle = '#7a2e2e'; g.lineWidth = 1.6; g.beginPath(); g.arc(p.x + fx * 0.6, p.y - 7, dizzy ? 2 : 3.2, dizzy ? Math.PI : 0.2, dizzy ? 6.28 : Math.PI - 0.2); g.stroke();
  g.globalAlpha = 1;
  hatDraw(g, HATS[p.hat % HATS.length], p.x, p.y - 12);
  if (dizzy) { g.fillStyle = '#ffd93b'; for (let i = 0; i < 3; i++) { const a = tm * 7 + i * 2.1; g.beginPath(); g.arc(p.x + Math.cos(a) * 14, p.y - 30 + Math.sin(a) * 4, 3, 0, 6.3); g.fill(); } }
  g.restore();
  // carried sparks stack above the head
  if (p.carry > 0) {
    const n = Math.min(6, Math.ceil(p.carry / 4));
    for (let i = 0; i < n; i++) { g.fillStyle = '#7fe9ff'; g.beginPath(); g.arc(p.x - (n - 1) * 5 + i * 10, p.y - 40 + Math.sin(tm * 5 + i) * 2, 4, 0, 6.3); g.fill(); }
    g.fillStyle = '#fff'; g.strokeStyle = '#000a'; g.lineWidth = 3; g.font = 'bold 13px system-ui,sans-serif'; g.textAlign = 'center'; g.strokeText(p.carry, p.x, p.y - 49); g.fillText(p.carry, p.x, p.y - 49);
  }
  if (p.emT > 0 && p.emote) { const e = ['❤️', '😂', '👏', '😮', '🔥'][(p.emote - 1) % 5]; g.font = '26px system-ui'; g.textAlign = 'center'; g.fillText(e, p.x, p.y - 58 - (2.5 - p.emT) * 8); }
  // name tag
  g.font = 'bold 11px system-ui,sans-serif'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.fillStyle = isMe ? '#ffe27a' : '#fff';
  g.strokeText(p.name, p.x, p.y + 30); g.fillText(p.name, p.x, p.y + 30);
}

// ----- particles & floating text -----
export function makeFx() { return { parts: [], texts: [], shake: 0, rings: [], flash: 0, banner: null, tm: 0, dice: [], rp: new Map() }; }
function burst(fx, x, y, col, n, spd = 120, life = 0.6, size = 3) { for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, v = spd * (0.3 + Math.random()); fx.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, col, size }); } }
export function feed(fx, ev, meId, snd, w) {
  for (const e of ev) {
    const mine = e.p === meId;
    if (e.k === 'pick') { burst(fx, e.x, e.y, e.v > 1 ? '#ffd23b' : '#7fe9ff', 5, 90, 0.35, 2.5); if (mine) snd.pick(e.v); }
    else if (e.k === 'bank') { burst(fx, e.x, e.y, '#ffe27a', e.big ? 40 : 18, 200, 0.9, 4); fx.texts.push({ x: e.x, y: e.y - 30, t: '+' + e.n, life: 1.1, max: 1.1, col: '#ffe27a', size: e.big ? 34 : 22 }); fx.rings.push({ x: e.x, y: e.y, r: 20, life: 0.6, max: 0.6, col: '#ffe27a' }); if (mine) { snd.bank(e.big); fx.flash = 0.25; } }
    else if (e.k === 'zap') { burst(fx, e.x, e.y, '#fff27a', 24, 220, 0.5, 3); fx.shake = Math.max(fx.shake, 0.25); if (e.q === meId) { snd.hit(); fx.shake = 0.5; } else snd.zap(); if (e.n > 0) fx.texts.push({ x: e.x, y: e.y - 24, t: '-' + e.n, life: 1, max: 1, col: '#ff7a7a', size: 22 }); }
    else if (e.k === 'pulse') { fx.rings.push({ x: e.x, y: e.y, r: 10, life: 0.35, max: 0.35, col: '#b8f3ff', grow: 96 }); if (mine) snd.pulse(); }
    else if (e.k === 'dash') { burst(fx, e.x, e.y + 10, '#fff', 8, 80, 0.3, 3); if (mine) snd.dash(); }
    else if (e.k === 'pup') { burst(fx, e.x, e.y, '#fff', 18, 160, 0.6, 3); const n = { shoe: 'Zoom!', shield: 'Bubble!', magnet: 'Magnet!', bolt: 'Cash-in!' }[e.t]; if (mine) { snd.pup(); fx.texts.push({ x: e.x, y: e.y - 24, t: n, life: 1.2, max: 1.2, col: '#fff', size: 22 }); } }
    else if (e.k === 'pop') { burst(fx, e.x, e.y, '#aab4ff', 16, 140, 0.5, 3); snd.pop(); }
    else if (e.k === 'steal') { burst(fx, e.x, e.y, '#9b6bd6', 12, 130, 0.5, 3); snd.steal(); fx.texts.push({ x: e.x, y: e.y - 24, t: 'Cheeky!', life: 1, max: 1, col: '#d8b8ff', size: 20 }); }
    else if (e.k === 'poof') { burst(fx, e.x, e.y, '#c3a8f0', 16, 130, 0.5, 4); snd.poof(); }
    else if (e.k === 'gremlin') { snd.gremlin(); }
    else if (e.k === 'dark') { snd.dark(); fx.banner = { t: 'BLACKOUT! Sparks go golden', sub: 'Stage ' + e.stage + ' — watch for Gremlins', life: 2.8, max: 2.8, col: '#ffcf5a' }; fx.shake = 0.4; }
    else if (e.k === 'light') { snd.light(); fx.banner = { t: 'Power is back!', sub: '', life: 1.6, max: 1.6, col: '#9ff0b0' }; }
    else if (e.k === 'start') { snd.go(); fx.banner = { t: 'GO!', sub: 'Grab Sparks — bank them at the Beacon', life: 2.2, max: 2.2, col: '#fff' }; }
    else if (e.k === 'end') { snd.win(); }
    else if (e.k === 'emote') { snd.emote(); }
    else if (e.k === 'roll') {
      const rp = w.players.find((q) => q.id === e.p); if (!rp) continue;
      const cc = ringXY(ringStart(rp) + e.to);
      fx.dice.push({ x: cc.x, y: cc.y - 30, a: e.a, b: e.b, life: 2.0, max: 2.0, me: mine, forfeit: !!e.forfeit });
      if (mine) snd.dice();
      if (e.forfeit) fx.texts.push({ x: cc.x, y: cc.y - 50, t: 'Too lucky! Turn lost', life: 1.4, max: 1.4, col: '#ffb3b3', size: 18 });
      if (e.lap) { fx.texts.push({ x: cc.x, y: cc.y - 56, t: 'LAP! +' + LAP_BONUS, life: 1.6, max: 1.6, col: '#9ff0b0', size: 28 }); burst(fx, cc.x, cc.y, '#9ff0b0', 22, 160, 0.8, 4); if (mine) snd.lap(); }
      if (e.boot && e.boot.length) {
        const victims = e.boot.map((id) => w.players.find((q) => q.id === id)).filter(Boolean);
        for (const v of victims) { const vc = ringXY(ringStart(v)); fx.texts.push({ x: vc.x, y: vc.y - 30, t: 'BOOTED!', life: 1.4, max: 1.4, col: '#ffb3b3', size: 24 }); burst(fx, cc.x, cc.y, '#ff9a9a', 16, 150, 0.6, 3); }
        if (mine || e.boot.includes(meId)) snd.boot();
        if (mine && victims[0]) fx.banner = { t: 'BOOT! 👢', sub: 'You sent ' + victims.map((v) => v.name).join(' & ') + ' back to the start (+' + 3 * victims.length + ')', life: 2.2, max: 2.2, col: '#ffd0a0' };
        else if (e.boot.includes(meId)) fx.banner = { t: 'Booted! 👢', sub: rp.name + ' landed on your runner — back to the start!', life: 2.4, max: 2.4, col: '#ffb3b3' };
      }
    }
  }
}
export function updateFx(fx, dt) {
  fx.tm += dt; fx.shake = Math.max(0, fx.shake - dt); fx.flash = Math.max(0, fx.flash - dt);
  for (const p of fx.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy *= 0.94; p.life -= dt; }
  fx.parts = fx.parts.filter((p) => p.life > 0).slice(-400);
  for (const t of fx.texts) { t.y -= 34 * dt; t.life -= dt; } fx.texts = fx.texts.filter((t) => t.life > 0).slice(-30);
  for (const r of fx.rings) { r.life -= dt; r.r += (r.grow || 60) * dt * 2.6; } fx.rings = fx.rings.filter((r) => r.life > 0);
  if (fx.banner) { fx.banner.life -= dt; if (fx.banner.life <= 0) fx.banner = null; }
  for (const d of fx.dice) d.life -= dt; fx.dice = fx.dice.filter((d) => d.life > 0);
}

// ----- Ring Race: stepping-stone pads round the Beacon and a little runner per player -----
function ringPads(g, w, tm) {
  for (let i = 0; i < RING_N; i++) {
    const { x, y } = ringXY(i), safe = isSafeCell(i), owner = w.players.find((p) => !p.still && ringStart(p) === i);
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.28)';
    g.fillStyle = safe ? (owner ? COLORS[owner.color % COLORS.length] : '#fff4d0') : 'rgba(255,255,255,0.6)';
    g.beginPath(); g.arc(x, y, safe ? 13 : 9, 0, 6.3); g.fill(); g.stroke();
    if (safe) { g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.arc(x, y, 4, 0, 6.3); g.fill(); }
  }
}
function runner(g, x, y, col, k, tm, moving, isMe) {
  const sw = moving ? Math.sin(tm * 18) : Math.sin(tm * 2) * 0.2;
  g.save(); g.translate(x, y); g.scale(k, k);
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.ellipse(0, 16, 11, 4.5, 0, 0, 6.3); g.fill();
  if (isMe) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(0, 4, 20, 0, 6.3); g.stroke(); }
  g.strokeStyle = col; g.lineCap = 'round'; g.lineWidth = 4.5;
  g.beginPath(); g.moveTo(-3, 6); g.lineTo(-3 + sw * 6, 16); g.moveTo(3, 6); g.lineTo(3 - sw * 6, 16); g.stroke();
  g.lineWidth = 3.4; g.beginPath(); g.moveTo(-6, -2); g.lineTo(-10 - sw * 3, 4); g.moveTo(6, -2); g.lineTo(10 + sw * 3, 4); g.stroke();
  g.fillStyle = col; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1.6; g.beginPath(); g.arc(0, 1, 7, 0, 6.3); g.fill(); g.stroke();
  g.beginPath(); g.arc(0, -10, 6, 0, 6.3); g.fill(); g.stroke();
  g.restore();
}
function ringTokens(g, w, fx, meId, tm, dt) {
  const seen = new Map();
  for (const p of w.players) {
    if (p.still) continue;
    const target = (p.laps | 0) * RING_N + (p.rs | 0);
    let cur = fx.rp.has(p.id) ? fx.rp.get(p.id) : target;
    if (target < cur - 0.01) cur = target; else cur += Math.min(target - cur, 9 * dt);
    fx.rp.set(p.id, cur);
    const moving = target - cur > 0.02, c = ringXY(ringStart(p) + cur), key = Math.round(cur + ringStart(p)) % RING_N, n = seen.get(key) || 0; seen.set(key, n + 1);
    const hop = moving ? -Math.abs(Math.sin(cur * Math.PI)) * 9 : 0, isMe = p.id === meId;
    runner(g, c.x + n * 7, c.y + hop - n * 4, COLORS[p.color % COLORS.length], isMe ? 1.05 : 0.78, tm, moving, isMe);
    if (isMe) { g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3; g.font = 'bold 11px system-ui,sans-serif'; g.textAlign = 'center'; g.strokeText('YOU', c.x + n * 7, c.y + hop - 30 - n * 4); g.fillText('YOU', c.x + n * 7, c.y + hop - 30 - n * 4); }
  }
}
const PIPS = { 1: [[0, 0]], 2: [[-1, -1], [1, 1]], 3: [[-1, -1], [0, 0], [1, 1]], 4: [[-1, -1], [1, -1], [-1, 1], [1, 1]], 5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]], 6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]] };
function die(g, x, y, v, s) {
  g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 2; g.beginPath();
  if (g.roundRect) g.roundRect(x - s / 2, y - s / 2, s, s, s * 0.22); else g.rect(x - s / 2, y - s / 2, s, s);
  g.fill(); g.stroke(); g.fillStyle = '#222';
  for (const [dx, dy] of PIPS[v] || []) { g.beginPath(); g.arc(x + dx * s * 0.25, y + dy * s * 0.25, s * 0.075, 0, 6.3); g.fill(); }
}
function drawDice(g, fx) {
  for (const d of fx.dice) {
    const k = d.me ? 1.5 : 1, t = d.max - d.life, rise = Math.min(1, t * 4) * 18, shake = t < 0.5 ? Math.sin(t * 60) * 3 : 0;
    g.globalAlpha = Math.min(1, d.life * 2); const y = d.y - rise, s = 26 * k;
    die(g, d.x - s * 0.62 + shake, y, d.a, s); die(g, d.x + s * 0.62 - shake, y, d.b, s);
    g.font = `900 ${14 * k}px system-ui,sans-serif`; g.textAlign = 'center'; g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.fillStyle = d.forfeit ? '#ffb3b3' : '#fff';
    if (t > 0.4) { const txt = '= ' + (d.a + d.b); g.strokeText(txt, d.x, y - s * 0.75); g.fillText(txt, d.x, y - s * 0.75); }
  }
  g.globalAlpha = 1;
}

// ----- the frame -----
export function draw(ctx, w, view, fx, meId) {
  const { cw, ch } = view; const tm = fx.tm;
  if (!ground) ground = makeGround();
  const me = w.players.find((p) => p.id === meId);
  const zoom = Math.max(0.55, Math.min(cw / 900, ch / 640)) * (view.zoom || 1);
  const fx0 = me ? me.x : W / 2, fy0 = me ? me.y : H / 2;
  view.cx += ((fx0) - view.cx) * Math.min(1, view.dt * 6); view.cy += ((fy0) - view.cy) * Math.min(1, view.dt * 6);
  const sx = (fx.shake > 0 ? (Math.random() - 0.5) * 14 * fx.shake : 0), sy = (fx.shake > 0 ? (Math.random() - 0.5) * 14 * fx.shake : 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#2a5fa8'; ctx.fillRect(0, 0, cw, ch);
  const vw = cw / zoom, vh = ch / zoom;
  const camX = Math.max(0, Math.min(W - vw, view.cx - vw / 2)), camY = Math.max(0, Math.min(H - vh, view.cy - vh / 2));
  const ox = vw >= W ? (vw - W) / 2 : 0, oy = vh >= H ? (vh - H) / 2 : 0;
  ctx.setTransform(zoom, 0, 0, zoom, (-(vw >= W ? 0 : camX) + ox) * zoom + sx, (-(vh >= H ? 0 : camY) + oy) * zoom + sy);
  view.camX = camX; view.camY = camY; view.zoomEff = zoom; view.ox = ox; view.oy = oy;
  ctx.drawImage(ground, 0, 0);
  beacon(ctx, tm, w.phase === 'play' ? 1 : 0, w.left);
  ringPads(ctx, w, tm);
  for (const s of w.sparks) spark(ctx, s, tm);
  for (const u of w.pups) powerup(ctx, u, tm);
  // y-sorted drawables so characters walk behind/in front of trees correctly
  const items = [];
  for (const t of TREES) items.push({ y: t.y + t.r, f: () => tree(ctx, t, tm) });
  for (const r of RECTS) items.push({ y: r.y + r.h, f: () => building(ctx, r) });
  for (const m of w.grem) items.push({ y: m.y, f: () => gremlin(ctx, m, tm) });
  for (const p of w.players) items.push({ y: p.y, f: () => drawPlayer(ctx, p, tm, p.id === meId) });
  items.sort((a, b) => a.y - b.y); for (const it of items) it.f();
  ringTokens(ctx, w, fx, meId, tm, view.dt || 1 / 60);
  // particles / rings / floating text
  for (const r of fx.rings) { ctx.globalAlpha = r.life / r.max; ctx.strokeStyle = r.col; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, 6.3); ctx.stroke(); } ctx.globalAlpha = 1;
  for (const p of fx.parts) { ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.3); ctx.fill(); } ctx.globalAlpha = 1;
  // Blackout: the dark quarter gets a moody overlay with a light hole around the Beacon, every player and every spark
  if (w.dark) {
    const q = w.dark.q, qx = (q % 2) * W / 2, qy = Math.floor(q / 2) * H / 2, fade = Math.min(1, (18 - w.dark.t) * 2, w.dark.t * 2, 1);
    ctx.save(); ctx.beginPath(); ctx.rect(qx, qy, W / 2, H / 2); ctx.clip();
    ctx.fillStyle = `rgba(8,10,40,${0.62 * fade})`; ctx.fillRect(qx, qy, W / 2, H / 2);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of w.players) { const rg = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 130); rg.addColorStop(0, `rgba(255,236,170,${0.3 * fade})`); rg.addColorStop(1, 'rgba(255,236,170,0)'); ctx.fillStyle = rg; ctx.fillRect(p.x - 130, p.y - 130, 260, 260); }
    for (const s of w.sparks) if (quadOf(s.x, s.y) === q) { const rg = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, 42); rg.addColorStop(0, `rgba(255,210,80,${0.5 * fade})`); rg.addColorStop(1, 'rgba(255,210,80,0)'); ctx.fillStyle = rg; ctx.fillRect(s.x - 42, s.y - 42, 84, 84); }
    ctx.restore();
    ctx.strokeStyle = `rgba(255,207,90,${0.5 * fade})`; ctx.setLineDash([14, 10]); ctx.lineWidth = 4; ctx.strokeRect(qx + 3, qy + 3, W / 2 - 6, H / 2 - 6); ctx.setLineDash([]);
  }
  if (w.left <= GOLDEN_HOUR && w.phase === 'play') { ctx.fillStyle = `rgba(255,190,60,${0.08 + Math.sin(tm * 5) * 0.03})`; ctx.fillRect(0, 0, W, H); }
  drawDice(ctx, fx);
  for (const t of fx.texts) { ctx.globalAlpha = Math.min(1, t.life / (t.max * 0.5)); ctx.font = `900 ${t.size}px system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeText(t.t, t.x, t.y); ctx.fillStyle = t.col; ctx.fillText(t.t, t.x, t.y); } ctx.globalAlpha = 1;
  // screen-space overlays
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (fx.flash > 0) { ctx.fillStyle = `rgba(255,240,170,${fx.flash})`; ctx.fillRect(0, 0, cw, ch); }
  if (me && me.stun > 0) { const g = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.25, cw / 2, ch / 2, ch * 0.8); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.35)'); ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch); }
  // compass arrow to the Beacon when it is off-screen
  if (me && w.phase === 'play' && me.carry > 0) {
    const bx = (BEACON.x - camX + ox) * zoom, by = (BEACON.y - camY + oy) * zoom;
    if (bx < 30 || bx > cw - 30 || by < 60 || by > ch - 30) {
      const a = Math.atan2(by - ch / 2, bx - cw / 2), ex = cw / 2 + Math.cos(a) * Math.min(cw, ch) * 0.42, ey = ch / 2 + Math.sin(a) * Math.min(cw, ch) * 0.42;
      ctx.save(); ctx.translate(ex, ey); ctx.rotate(a); ctx.fillStyle = '#ffe27a'; ctx.strokeStyle = '#0006'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-10, -14); ctx.lineTo(-4, 0); ctx.lineTo(-10, 14); ctx.closePath(); ctx.stroke(); ctx.fill(); ctx.restore();
    }
  }
}
export const worldToScreen = (view, x, y) => ({ x: (x - view.camX + view.ox) * view.zoomEff, y: (y - view.camY + view.oy) * view.zoomEff });

// Tutorial pointer: a pulsing ring + bobbing arrow on the target, or an arrow at the screen edge when it is off-screen.
export function drawMarker(ctx, view, x, y, tm) {
  const { cw, ch } = view, z = view.zoomEff || 1, sc = worldToScreen(view, x, y);
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (sc.x < 30 || sc.x > cw - 30 || sc.y < 90 || sc.y > ch - 30) {
    const a = Math.atan2(sc.y - ch / 2, sc.x - cw / 2), R = Math.min(cw, ch) * 0.38, ex = cw / 2 + Math.cos(a) * R * (cw / ch > 1 ? 1.5 : 1), ey = ch / 2 + Math.sin(a) * R;
    const k = Math.max(0.8, z); ctx.translate(Math.max(40, Math.min(cw - 40, ex)), Math.max(100, Math.min(ch - 40, ey))); ctx.rotate(a);
    ctx.fillStyle = '#7dffb0'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 4 * k; ctx.beginPath();
    ctx.moveTo(26 * k + Math.sin(tm * 6) * 4, 0); ctx.lineTo(-12 * k, -18 * k); ctx.lineTo(-4 * k, 0); ctx.lineTo(-12 * k, 18 * k); ctx.closePath(); ctx.stroke(); ctx.fill();
  } else {
    const pulse = 1 + Math.sin(tm * 5) * 0.12, bob = Math.abs(Math.sin(tm * 4)) * 10 * z;
    ctx.strokeStyle = '#7dffb0'; ctx.globalAlpha = 0.9; ctx.lineWidth = 4 * z; ctx.beginPath(); ctx.arc(sc.x, sc.y, 38 * z * pulse, 0, 6.3); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = '#7dffb0'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 3 * z; ctx.beginPath();
    ctx.moveTo(sc.x, sc.y - 44 * z - bob); ctx.lineTo(sc.x - 15 * z, sc.y - 72 * z - bob); ctx.lineTo(sc.x + 15 * z, sc.y - 72 * z - bob); ctx.closePath(); ctx.stroke(); ctx.fill();
  }
  ctx.restore();
}
