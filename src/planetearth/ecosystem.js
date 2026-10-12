// Planet Earth — a savanna food web: grass → antelope → lions. Every animal is a little agent with an energy bar.
// Boom-and-bust cycles and "trophic cascades" (what happens when lions vanish) EMERGE from these simple rules. Pure JS (no DOM).
export const GW = 40, GH = 26;
export const P = { am: 0.12, gr: 0.02, lm: 0.04, kill: 2, eat: 0.16, ar: 2.0, lr: 2.9, lionCap: 14 };
const rnd = (w) => { w.rs = (w.rs + 0x6D2B79F5) | 0; let t = Math.imul(w.rs ^ (w.rs >>> 15), 1 | w.rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const cl = (v, a, b) => Math.max(a, Math.min(b, v));
export function createEco(seed = 1) {
  const w = { rs: seed | 0, t: 0, grass: new Float32Array(GW * GH).fill(0.85), ants: [], lions: [], rain: 1, drought: 0, nid: 1, hist: [], histT: 0, balancedFor: 0, eaten: 0, antBirths: 0, kills: 0, maxAnts: 0 };
  addAnts(w, 55); addLions(w, 4); return w;
}
export function addAnts(w, n) { for (let i = 0; i < n; i++) if (w.ants.length < 420) w.ants.push({ id: w.nid++, x: rnd(w) * GW, y: rnd(w) * GH, e: 0.9 + rnd(w) * 0.5, tx: 0, ty: 0, think: 0 }); }
export function addLions(w, n) { for (let i = 0; i < n; i++) if (w.lions.length < P.lionCap) w.lions.push({ id: w.nid++, x: rnd(w) * GW, y: rnd(w) * GH, e: 1.6 + rnd(w) * 0.5, tx: 0, ty: 0, think: 0 }); }
export function removeLions(w) { w.lions = []; }
export function startDrought(w) { w.drought = 25; }
export const avgGrass = (w) => { let s = 0; for (let i = 0; i < w.grass.length; i++) s += w.grass[i]; return s / w.grass.length; };
const cell = (x, y) => cl(Math.floor(y), 0, GH - 1) * GW + cl(Math.floor(x), 0, GW - 1);

export function stepEco(w, dt) {
  w.t += dt; if (w.drought > 0) w.drought -= dt;
  const rain = w.rain * (w.drought > 0 ? 0.1 : 1);
  for (let i = 0; i < w.grass.length; i++) w.grass[i] += (rain * P.gr * (1 - w.grass[i]) + 0.001) * dt * (w.grass[i] > 0.02 ? 1 : 0.5);
  const born = [];
  for (const a of w.ants) {
    a.e -= P.am * dt; a.think -= dt;
    let fx = 0, fy = 0, flee = false;
    for (const l of w.lions) { const d = Math.hypot(l.x - a.x, l.y - a.y); if (d < 3.2) { flee = true; fx += (a.x - l.x) / (d + 0.01); fy += (a.y - l.y) / (d + 0.01); } }
    if (flee) { const m = Math.hypot(fx, fy) || 1; a.x += (fx / m) * 3.6 * dt; a.y += (fy / m) * 3.6 * dt; }
    else {
      if (a.think <= 0) { a.think = 0.5; let best = -1, bx = a.x, by = a.y; for (let k = 0; k < 6; k++) { const x = a.x + (rnd(w) - 0.5) * 5, y = a.y + (rnd(w) - 0.5) * 5, g = w.grass[cell(x, y)] + rnd(w) * 0.08; if (g > best) { best = g; bx = x; by = y; } } a.tx = bx; a.ty = by; }
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy); if (d > 0.1) { a.x += (dx / d) * 1.9 * dt; a.y += (dy / d) * 1.9 * dt; }
    }
    a.x = cl(a.x, 0, GW - 0.01); a.y = cl(a.y, 0, GH - 0.01);
    const c = cell(a.x, a.y), take = Math.min(w.grass[c], P.eat * dt); w.grass[c] -= take; a.e += take * 0.95; w.eaten += take;
    if (a.e > P.ar && w.ants.length + born.length < 420) { a.e -= 1.0; born.push({ id: w.nid++, x: a.x, y: a.y, e: 1.0, tx: a.x, ty: a.y, think: 0 }); w.antBirths++; }
  }
  w.ants = w.ants.filter((a) => a.e > 0).concat(born);
  const cubs = [];
  for (const l of w.lions) {
    l.e -= P.lm * dt; let target = null, bd = 1e9;
    for (const a of w.ants) { const d = Math.hypot(a.x - l.x, a.y - l.y); if (d < bd) { bd = d; target = a; } }
    if (target && bd < 8 && l.e < P.lr - 0.2) { l.x += ((target.x - l.x) / (bd + 0.01)) * 3.1 * dt; l.y += ((target.y - l.y) / (bd + 0.01)) * 3.1 * dt;
      if (bd < 0.9 && rnd(w) < P.kill * dt) { target.e = -1; l.e = Math.min(3.5, l.e + 0.9); w.kills++; } }
    else { l.think -= dt; if (l.think <= 0) { l.think = 1.5; const a = rnd(w) * 6.283; l.tx = l.x + Math.cos(a) * 4; l.ty = l.y + Math.sin(a) * 4; } const dx = l.tx - l.x, dy = l.ty - l.y, d = Math.hypot(dx, dy); if (d > 0.1) { l.x += (dx / d) * 1.0 * dt; l.y += (dy / d) * 1.0 * dt; } }
    l.x = cl(l.x, 0, GW - 0.01); l.y = cl(l.y, 0, GH - 0.01);
    l.cd = Math.max(0, (l.cd || 0) - dt);                                                          // lions are territorial and breed slowly
    if (l.e > P.lr && l.cd <= 0 && w.lions.length + cubs.length < P.lionCap) { l.e -= 1.6; l.cd = 40; cubs.push({ id: w.nid++, x: l.x, y: l.y, e: 1.3, tx: l.x, ty: l.y, think: 0, cd: 40 }); }
  }
  w.lions = w.lions.filter((l) => l.e > 0).concat(cubs); w.ants = w.ants.filter((a) => a.e > 0);
  w.maxAnts = Math.max(w.maxAnts, w.ants.length);
  w.histT += dt; if (w.histT >= 1) { w.histT = 0; w.hist.push({ g: avgGrass(w), a: w.ants.length, l: w.lions.length }); if (w.hist.length > 160) w.hist.shift(); }
  const ok = w.ants.length >= 8 && w.lions.length >= 2 && avgGrass(w) >= 0.3; w.balancedFor = ok ? w.balancedFor + dt : 0;
}
