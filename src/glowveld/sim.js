// Glowveld — deterministic game simulation (pure JS: no React, no DOM, no network).
//
// One "host" runs this (in solo play that's you; in a room it's the first human).
// Everyone else just receives snapshots. Because it is pure and seeded it is also
// unit-testable in Node (scripts/test-glowveld.mjs).
//
// THE GAME IN ONE LINE: grab glowing Sparks, carry them to the Beacon in the middle
// of Kasi Square to bank them — but rivals can Zap you and make you drop them, and
// when a Blackout hits a quarter of the map, Sparks go golden and cheeky Gremlins
// come out to nick them. Nobody ever gets hurt: the worst that happens is you get
// dizzy and drop your sparks.

export const W = 1400, H = 900, DT = 1 / 30;
export const ROUND_SECONDS = 150, OVER_SECONDS = 12, TOTAL = 10;
export const BEACON = { x: 700, y: 450, r: 74 };
export const PR = 16;
// ---- Ludo-style "Ring Race": every time you bank Sparks you roll TWO dice and your runner hops that many
// steps round the ring road. Land exactly on a rival's runner (not on a safe start square) and they are
// booted back to their start. 6+6 or a boot earns another roll. A full lap is worth LAP_BONUS points.
export const RING_N = 30, RING_RX = 280, RING_RY = 200, LAP_BONUS = 8, BOOT_BONUS = 3;
export const ringStart = (p) => (((p.seat | 0) * 3) % RING_N + RING_N) % RING_N;
export const ringXY = (i) => { const a = -Math.PI / 2 + (i / RING_N) * Math.PI * 2; return { x: BEACON.x + RING_RX * Math.cos(a), y: BEACON.y + RING_RY * Math.sin(a) }; };
export const ringCell = (p) => (ringStart(p) + (p.rs | 0)) % RING_N;
export const isSafeCell = (c) => c % 3 === 0;                 // player radius
export const CARRY_CAP = 24;
export const GOLDEN_HOUR = 20;        // last N seconds bank double
const BASE_SPEED = 178, PULSE_R = 96, PULSE_CD = 2.2, DASH_CD = 3.4, DASH_T = 0.22;

export const COLORS = ['#ff5d73', '#ffb020', '#ffd93b', '#5ad469', '#2fc4b2', '#3aa0ff', '#7a7cff', '#c46bff', '#ff7ac8', '#ff8a4c'];
export const HATS = ['none', 'party', 'crown', 'cap', 'antenna', 'flower', 'halo', 'leaf'];
const BOT_NAMES = ['Thabo', 'Lerato', 'Sipho', 'Zanele', 'Pieter', 'Nomsa', 'Kabelo', 'Ayesha', 'Tumi', 'Jabu', 'Mia', 'Bongani',
  'Naledi', 'Ruan', 'Palesa', 'Themba', 'Chloe', 'Lwazi', 'Anele', 'Yusuf', 'Refilwe', 'Dumi', 'Karabo', 'Sandile'];
const KINDS = ['grabber', 'hunter', 'sneaky', 'rookie'];

// ---------- static map: mirrored so nobody gets a better corner ----------
const Q_TREES = [[240, 190, 40], [560, 300, 30]];
const Q_RECTS = [[400, 110, 120, 46, 'stall'], [110, 330, 80, 80, 'shack'], [450, 240, 56, 56, 'crate']];
export const TREES = [], RECTS = [];
for (const mx of [0, 1]) for (const my of [0, 1]) {
  for (const [x, y, r] of Q_TREES) TREES.push({ x: mx ? W - x : x, y: my ? H - y : y, r });
  for (const [x, y, w, h, k] of Q_RECTS) RECTS.push({ x: mx ? W - x - w : x, y: my ? H - y - h : y, w, h, k });
}

// ---------- seeded RNG (state lives in the world so it survives snapshots) ----------
function rnd(w) {
  w.rs = (w.rs + 0x6D2B79F5) | 0;
  let t = Math.imul(w.rs ^ (w.rs >>> 15), 1 | w.rs);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rr = (w, a, b) => a + (b - a) * rnd(w);
const hyp = Math.hypot;
export const quadOf = (x, y) => (x > W / 2 ? 1 : 0) + (y > H / 2 ? 2 : 0);

function blocked(x, y, pad) {
  for (const t of TREES) if (hyp(x - t.x, y - t.y) < t.r + pad) return true;
  for (const r of RECTS) if (x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad) return true;
  return hyp(x - BEACON.x, y - BEACON.y) < BEACON.r + pad + 30;
}
function freeSpot(w, quad = -1) {
  for (let i = 0; i < 30; i++) {
    const x = rr(w, 50, W - 50), y = rr(w, 50, H - 50);
    if (quad >= 0 && quadOf(x, y) !== quad) continue;
    if (!blocked(x, y, 28)) return { x, y };
  }
  return { x: 100, y: 100 };
}
function pushOut(p, rad) {
  for (const t of TREES) {
    const d = hyp(p.x - t.x, p.y - t.y), m = t.r + rad;
    if (d < m && d > 0.001) { p.x = t.x + ((p.x - t.x) / d) * m; p.y = t.y + ((p.y - t.y) / d) * m; }
  }
  for (const r of RECTS) {
    const cx = Math.max(r.x, Math.min(p.x, r.x + r.w)), cy = Math.max(r.y, Math.min(p.y, r.y + r.h));
    const dx = p.x - cx, dy = p.y - cy, d = hyp(dx, dy);
    if (d < rad) {
      if (d > 0.001) { p.x = cx + (dx / d) * rad; p.y = cy + (dy / d) * rad; }
      else { p.y = r.y - rad; }
    }
  }
  p.x = Math.max(rad, Math.min(W - rad, p.x));
  p.y = Math.max(rad, Math.min(H - rad, p.y));
}

// ---------- world ----------
export function createWorld(seed = 1) {
  const w = { seed, rs: seed | 0, nid: 1, round: 0, phase: 'play', left: ROUND_SECONDS, t: 0, over: 0, players: [],
    sparks: [], grem: [], pups: [], dark: null, stage: 0, nextDark: 20, nextPup: 7, nextGrem: 0, sv: 0, ev: [], result: [] };
  fillBots(w);
  newRound(w);
  return w;
}
const nid = (w) => w.nid++;

function mkPlayer(w, o) {
  return { id: o.id ?? nid(w), name: o.name, color: o.color ?? 0, hat: o.hat ?? 0, seat: o.seat ?? 0, rs: 0, laps: 0, bot: !!o.bot,
    kind: o.kind || 'grabber', skill: o.skill ?? 0.7, x: BEACON.x, y: BEACON.y + 160, vx: 0, vy: 0, a: 0, dx: 0, dy: 1,
    carry: 0, score: 0, stun: 0, grace: 0, shield: 0, speed: 0, magnet: 0, pcd: 0, dcd: 0, dash: 0,
    inp: { mx: 0, my: 0, pulse: 0, dash: 0 }, bt: 0, tx: BEACON.x, ty: BEACON.y, tid: 0, emote: 0, emT: 0, stuns: 0, bankedMax: 0 };
}
export function fillBots(w) {
  while (w.players.length < TOTAL) {
    const used = new Set(w.players.map((p) => p.name.replace(/^🤖 ?/, '')));
    const free = BOT_NAMES.filter((n) => !used.has(n));
    const name = free[Math.floor(rnd(w) * free.length)] || 'Bot' + w.nid;
    w.players.push(mkPlayer(w, { name, color: Math.floor(rnd(w) * COLORS.length), hat: Math.floor(rnd(w) * HATS.length),
      seat: w.players.length, bot: true, kind: KINDS[Math.floor(rnd(w) * KINDS.length)], skill: 0.55 + rnd(w) * 0.4 }));
  }
}
export function humanJoin(w, { id, name, color, hat }) {
  if (w.players.some((p) => p.id === id)) return;
  // a human takes the seat of the lowest-scoring bot, so the arena always stays full
  let idx = -1, best = Infinity;
  w.players.forEach((p, i) => { if (p.bot && p.score < best) { best = p.score; idx = i; } });
  const pl = mkPlayer(w, { id, name, color, hat, bot: false, seat: idx >= 0 ? w.players[idx].seat : w.players.length });
  const spot = freeSpot(w); pl.x = spot.x; pl.y = spot.y; pl.grace = 2;
  if (idx >= 0) w.players.splice(idx, 1, pl); else if (w.players.length < TOTAL + 2) w.players.push(pl);
}
export function humanLeave(w, id) {
  const p = w.players.find((q) => q.id === id);
  if (!p) return;
  p.bot = true; p.kind = 'grabber'; p.skill = 0.7; // a friendly bot takes over, keeping the score
  if (!p.name.startsWith('🤖')) p.name = '🤖 ' + p.name;
}
export const humanCount = (w) => w.players.filter((p) => !p.bot).length;

function newRound(w) {
  w.round++; w.phase = 'play'; w.left = ROUND_SECONDS; w.t = 0; w.over = 0; w.result = [];
  w.sparks = []; w.grem = []; w.pups = []; w.dark = null; w.stage = 0; w.nextDark = 20; w.nextPup = 7; w.nextGrem = 0; w.sv++;
  w.players.forEach((p, i) => {
    const a = (i / w.players.length) * Math.PI * 2, R = 230;
    Object.assign(p, { x: BEACON.x + Math.cos(a) * R * 1.35, y: BEACON.y + Math.sin(a) * R, vx: 0, vy: 0, carry: 0, score: 0, stun: 0, rs: 0, laps: 0,
      grace: 1.5, shield: 0, speed: 0, magnet: 0, pcd: 0, dcd: 0, dash: 0, stuns: 0, bankedMax: 0 });
    pushOut(p, PR);
    if (p.name.startsWith('🤖') && false) p.name = p.name;
  });
  for (let i = 0; i < 34; i++) spawnSpark(w);
  w.ev.push({ k: 'start' });
}

function addSpark(w, x, y, v = 1) { w.sparks.push({ id: nid(w), x, y, v }); w.sv++; }
function spawnSpark(w) {
  const q = w.dark ? (rnd(w) < 0.55 ? w.dark.q : -1) : -1;
  const s = freeSpot(w, q);
  const gold = (w.dark && quadOf(s.x, s.y) === w.dark.q) ? rnd(w) < 0.6 : rnd(w) < 0.06;
  addSpark(w, s.x, s.y, gold ? 3 : 1);
}
function dropSparks(w, x, y, value, from) {
  // scatter `value` worth of sparks around (x,y)
  let left = value;
  while (left > 0) {
    const v = left >= 3 && rnd(w) < 0.25 ? 3 : 1; left -= v;
    const a = rnd(w) * Math.PI * 2, d = rr(w, 20, 70);
    const q = { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d }; pushOut(q, 8);
    addSpark(w, q.x, q.y, v);
  }
}

// ---------- movement (exported so the client can predict its own player) ----------
export function movePlayer(p, dt) {
  const still = p.stun > 0;
  let mx = still ? 0 : p.inp.mx, my = still ? 0 : p.inp.my;
  const m = hyp(mx, my); if (m > 1) { mx /= m; my /= m; }
  if (m > 0.1) { p.dx = mx / (m || 1); p.dy = my / (m || 1); p.a = Math.atan2(p.dy, p.dx); }
  let spd = BASE_SPEED * (p.speed > 0 ? 1.35 : 1) * (1 - Math.min(0.35, p.carry * 0.012));
  let tx = mx * spd, ty = my * spd;
  if (p.dash > 0) { tx = p.dx * spd * 2.6; ty = p.dy * spd * 2.6; }
  const k = Math.min(1, dt * (still ? 3.5 : 13));
  p.vx += (tx - p.vx) * k; p.vy += (ty - p.vy) * k;
  p.x += p.vx * dt; p.y += p.vy * dt;
  pushOut(p, PR);
}

// ---------- bots ----------
function nearest(list, x, y, f) {
  let best = null, bd = Infinity;
  for (const e of list) { if (f && !f(e)) continue; const d = hyp(e.x - x, e.y - y); if (d < bd) { bd = d; best = e; } }
  return best ? { e: best, d: bd } : null;
}
function clearPath(x1, y1, x2, y2) {
  const d = hyp(x2 - x1, y2 - y1), n = Math.ceil(d / 16);
  for (let i = 1; i < n; i++) { const t = i / n; if (blocked(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, PR - 2)) return false; }
  return true;
}
function botThink(w, p, dt) {
  p.bt -= dt;
  // stuck detector: if we should be moving but barely have, wander to a free spot for a moment
  p.sn = (p.sn || 0) + dt;
  if (p.sn >= 1.1) {
    if (p.sx !== undefined && p.stun <= 0 && hyp(p.x - p.sx, p.y - p.sy) < 9 && hyp(p.tx - p.x, p.ty - p.y) > 24) {
      const sp = freeSpot(w); p.tx = sp.x; p.ty = sp.y; p.tid = 0; p.bt = 1.4;
    }
    p.sx = p.x; p.sy = p.y; p.sn = 0;
  }
  if (p.bt <= 0) {
    p.bt = 0.18 + (1 - p.skill) * 0.4 + rnd(w) * 0.12;
    const bankAt = { grabber: 10, hunter: 7, sneaky: 5, rookie: 4 + Math.floor(rnd(w) * 9) }[p.kind];
    const dB = hyp(BEACON.x - p.x, BEACON.y - p.y);
    const gr = nearest(w.grem, p.x, p.y);
    let go = null;
    if (p.carry > 0 && (p.carry >= bankAt || w.left < 9 || (gr && gr.d < 140 && !p.shield))) go = { x: BEACON.x, y: BEACON.y, id: 0 };
    if (!go) { const pu = nearest(w.pups, p.x, p.y, () => true); if (pu && pu.d < 240) go = { x: pu.e.x, y: pu.e.y, id: pu.e.id }; }
    if (!go && p.kind === 'hunter') {
      const rv = nearest(w.players, p.x, p.y, (q) => q !== p && q.carry >= 5 && q.stun <= 0 && q.grace <= 0);
      if (rv && rv.d < 340) go = { x: rv.e.x, y: rv.e.y, id: 0 };
    }
    if (!go) {
      let best = null, bs = -Infinity, bestAny = null, ba = -Infinity;
      for (const s of w.sparks) {
        const d = hyp(s.x - p.x, s.y - p.y);
        const sc = s.v * 1.6 - d / 110 + rnd(w) * (1 - p.skill) * 2;
        if (sc > ba) { ba = sc; bestAny = s; }
        if (sc > bs && clearPath(p.x, p.y, s.x, s.y)) { bs = sc; best = s; }
      }
      if (!best) best = bestAny;
      if (best) go = { x: best.x, y: best.y, id: best.id };
      else go = { x: BEACON.x, y: BEACON.y, id: 0 };
    }
    p.tx = go.x; p.ty = go.y; p.tid = go.id;
    // zap decisions
    if (p.pcd <= 0 && p.stun <= 0) {
      const foe = nearest(w.players, p.x, p.y, (q) => q !== p && q.stun <= 0 && q.grace <= 0);
      if (foe && foe.d < PULSE_R - 14 && rnd(w) < p.skill * 0.9 && (foe.e.carry >= 3 || (p.carry >= 6 && foe.d < 64))) p.inp.pulse = 1;
      const g2 = nearest(w.grem, p.x, p.y);
      if (g2 && g2.d < PULSE_R - 20 && g2.e.loot > 0) p.inp.pulse = 1;
    }
    if (p.dcd <= 0 && p.carry >= 8 && dB > 260 && rnd(w) < 0.5) p.inp.dash = 1;
  }
  // steering with a little obstacle avoidance
  let dx = p.tx - p.x, dy = p.ty - p.y; const d = hyp(dx, dy) || 1;
  let mx = dx / d, my = dy / d;
  for (const t of TREES) { const q = hyp(p.x - t.x, p.y - t.y), rg = t.r + PR + 42; if (q < rg && q > 0.01) { const f = (1 - q / rg) * 1.8; mx += ((p.x - t.x) / q) * f; my += ((p.y - t.y) / q) * f; } }
  for (const r of RECTS) {
    const cx = Math.max(r.x, Math.min(p.x, r.x + r.w)), cy = Math.max(r.y, Math.min(p.y, r.y + r.h));
    const q = hyp(p.x - cx, p.y - cy), rg = PR + 42;
    if (q < rg) { const qq = q || 0.01; const f = (1 - q / rg) * 1.8; mx += ((p.x - cx) / qq) * f; my += ((p.y - cy) / qq) * f; }
  }
  const m = hyp(mx, my) || 1;
  const s = d < 10 ? 0 : (p.skill < 0.65 ? 0.9 : 1);
  p.inp.mx = (mx / m) * s; p.inp.my = (my / m) * s;
}

// ---------- the tick ----------
export function step(w, dt = DT) {
  if (w.phase === 'over') {
    w.over += dt;
    if (w.over >= OVER_SECONDS) newRound(w);
    return;
  }
  w.t += dt; w.left -= dt;
  if (w.tut) w.left = ROUND_SECONDS;   // tutorial: the clock never runs out
  if (w.left <= 0) return endRound(w);

  // Blackout ("load-shedding") scheduling: one quarter of Kasi goes dark for a while
  if (w.dark) {
    w.dark.t -= dt;
    if (w.dark.t <= 0) {
      for (const g of w.grem) { if (g.loot > 0) dropSparks(w, g.x, g.y, g.loot); w.ev.push({ k: 'poof', x: g.x, y: g.y }); }
      w.grem = []; w.ev.push({ k: 'light', q: w.dark.q }); w.dark = null;
    }
  } else {
    w.nextDark -= dt;
    if (w.nextDark <= 0 && w.left > 14) {
      w.stage++; w.dark = { q: Math.floor(rnd(w) * 4), t: 18, stage: Math.min(w.stage + 1, 8) }; w.nextDark = 30; w.nextGrem = 1.5;
      w.ev.push({ k: 'dark', q: w.dark.q, stage: w.dark.stage });
    }
  }
  if (w.dark) {
    w.nextGrem -= dt;
    if (w.nextGrem <= 0 && w.grem.length < 4) {
      w.nextGrem = 3.2;
      const s = freeSpot(w, w.dark.q);
      w.grem.push({ id: nid(w), x: s.x, y: s.y, vx: 0, vy: 0, st: 0, loot: 0, fl: 0, wt: 0, wx: 0, wy: 0 });
      w.ev.push({ k: 'gremlin', x: s.x, y: s.y });
    }
  }
  // sparks and power-ups
  const target = 38;
  for (let i = 0; i < 2 && !w.tut && w.sparks.length < target; i++) if (rnd(w) < 0.5) spawnSpark(w);
  w.nextPup -= dt;
  if (w.nextPup <= 0) {
    w.nextPup = rr(w, 8, 13);
    if (w.pups.length < 3) { const s = freeSpot(w); w.pups.push({ id: nid(w), x: s.x, y: s.y, k: ['shoe', 'shield', 'magnet', 'bolt'][Math.floor(rnd(w) * 4)] }); }
  }

  // players
  for (const p of w.players) {
    p.pcd = Math.max(0, p.pcd - dt); p.dcd = Math.max(0, p.dcd - dt); p.stun = Math.max(0, p.stun - dt);
    p.grace = Math.max(0, p.grace - dt); p.shield = Math.max(0, p.shield - dt); p.speed = Math.max(0, p.speed - dt);
    p.magnet = Math.max(0, p.magnet - dt); p.dash = Math.max(0, p.dash - dt); p.emT = Math.max(0, p.emT - dt);
    if (p.bot && !p.still) botThink(w, p, dt);
    if (p.stun <= 0 && p.inp.dash && p.dcd <= 0) { p.dash = DASH_T; p.dcd = DASH_CD; w.ev.push({ k: 'dash', p: p.id, x: p.x, y: p.y }); }
    p.inp.dash = 0;
    movePlayer(p, dt);
  }
  // zaps
  for (const p of w.players) {
    if (!p.inp.pulse) continue;
    p.inp.pulse = 0;
    if (p.pcd > 0 || p.stun > 0) continue;
    p.pcd = PULSE_CD; w.ev.push({ k: 'pulse', p: p.id, x: p.x, y: p.y });
    for (const q of w.players) {
      if (q === p || q.grace > 0 || q.stun > 0) continue;
      const d = hyp(q.x - p.x, q.y - p.y); if (d > PULSE_R) continue;
      if (q.shield > 0) { q.shield = 0; q.grace = 0.6; w.ev.push({ k: 'pop', x: q.x, y: q.y }); continue; }
      const nx = (q.x - p.x) / (d || 1), ny = (q.y - p.y) / (d || 1);
      q.stun = 0.75; q.grace = 2.0; q.vx = nx * 340; q.vy = ny * 340; p.stuns++;
      const lost = Math.ceil(q.carry * 0.45); q.carry -= lost;
      if (lost > 0) dropSparks(w, q.x, q.y, lost);
      w.ev.push({ k: 'zap', p: p.id, q: q.id, x: q.x, y: q.y, n: lost });
    }
    for (const g of w.grem) {
      if (hyp(g.x - p.x, g.y - p.y) > PULSE_R) continue;
      if (g.loot > 0) dropSparks(w, g.x, g.y, g.loot);
      g.dead = true; w.ev.push({ k: 'poof', x: g.x, y: g.y });
    }
    w.grem = w.grem.filter((g) => !g.dead);
  }
  // gremlins
  for (const g of w.grem) {
    g.st = Math.max(0, g.st - dt);
    let tx = 0, ty = 0, sp = 55;
    if (g.st > 0) { sp = 0; }
    else if (g.loot > 0) {
      g.fl -= dt;
      const a = Math.atan2(g.y - BEACON.y, g.x - BEACON.x); tx = Math.cos(a); ty = Math.sin(a); sp = 125;
      if (g.fl <= 0) { g.dead = true; w.ev.push({ k: 'poof', x: g.x, y: g.y }); continue; }
    } else {
      const v = nearest(w.players, g.x, g.y, (q) => q.carry > 0 && q.stun <= 0);
      if (v && v.d < 320) { tx = (v.e.x - g.x) / v.d; ty = (v.e.y - g.y) / v.d; sp = 104; }
      else { g.wt -= dt; if (g.wt <= 0) { g.wt = 1.5; const a = rnd(w) * 6.283; g.wx = Math.cos(a); g.wy = Math.sin(a); } tx = g.wx; ty = g.wy; }
    }
    g.vx += (tx * sp - g.vx) * Math.min(1, dt * 6); g.vy += (ty * sp - g.vy) * Math.min(1, dt * 6);
    g.x += g.vx * dt; g.y += g.vy * dt; pushOut(g, 13);
    if (g.st <= 0 && g.loot <= 0) {
      for (const p of w.players) {
        if (p.stun > 0 || p.grace > 0 || hyp(p.x - g.x, p.y - g.y) > PR + 14) continue;
        if (p.shield > 0) { p.shield = 0; g.st = 1.6; w.ev.push({ k: 'pop', x: p.x, y: p.y }); break; }
        const steal = Math.min(p.carry, 3);
        if (steal > 0) { p.carry -= steal; g.loot = steal; g.fl = 4; w.ev.push({ k: 'steal', x: p.x, y: p.y, p: p.id, n: steal }); break; }
      }
    }
  }
  w.grem = w.grem.filter((g) => !g.dead);

  // pickups, magnets, banking
  const mult = w.left <= GOLDEN_HOUR ? 2 : 1;
  for (const p of w.players) {
    if (p.still) continue;   // tutorial practice dummy never picks anything up
    if (p.magnet > 0 && p.stun <= 0) for (const s of w.sparks) {
      const d = hyp(s.x - p.x, s.y - p.y);
      if (d < 175 && d > 1) { const m = Math.min(d, 270 * dt); s.x += ((p.x - s.x) / d) * m; s.y += ((p.y - s.y) / d) * m; w.sv++; }
    }
    if (p.stun <= 0 && p.carry < CARRY_CAP) {
      for (let i = w.sparks.length - 1; i >= 0; i--) {
        const s = w.sparks[i];
        if (hyp(s.x - p.x, s.y - p.y) < PR + 11) {
          p.carry = Math.min(CARRY_CAP, p.carry + s.v); w.sparks.splice(i, 1); w.sv++;
          w.ev.push({ k: 'pick', p: p.id, x: s.x, y: s.y, v: s.v });
          if (p.carry >= CARRY_CAP) break;
        }
      }
    }
    for (let i = w.pups.length - 1; i >= 0; i--) {
      const u = w.pups[i];
      if (p.stun > 0 || hyp(u.x - p.x, u.y - p.y) > PR + 14) continue;
      w.pups.splice(i, 1);
      if (u.k === 'shoe') p.speed = 7; else if (u.k === 'shield') p.shield = 9; else if (u.k === 'magnet') p.magnet = 8;
      else if (u.k === 'bolt') bank(w, p, mult, true);
      w.ev.push({ k: 'pup', p: p.id, x: u.x, y: u.y, t: u.k });
    }
    if (p.carry > 0 && p.stun <= 0 && hyp(p.x - BEACON.x, p.y - BEACON.y) < BEACON.r + PR * 0.4) bank(w, p, mult, false);
  }
  // remembered emote timers are cosmetic only
}
function bank(w, p, mult, remote) {
  if (p.carry <= 0) return;
  let gain = p.carry * mult; if (p.carry >= 10) gain += 3;
  p.score += gain; p.bankedMax = Math.max(p.bankedMax, p.carry);
  w.ev.push({ k: 'bank', p: p.id, x: remote ? p.x : BEACON.x, y: remote ? p.y : BEACON.y, n: gain, big: p.carry >= 10 });
  const rolls = p.carry >= 10 ? 2 : 1;
  p.carry = 0;
  rollRing(w, p, rolls);
}
// Roll `n` pairs of dice for p's runner (extra rolls for 6+6 and for booting someone; three 6+6 in a row forfeits).
export function rollRing(w, p, n) {
  let left = n, sixes = 0, guard = 0;
  while (left > 0 && guard++ < 6) {
    left--;
    const a = 1 + Math.floor(rnd(w) * 6), b = 1 + Math.floor(rnd(w) * 6), from = p.rs;
    if (a === 6 && b === 6) {
      sixes++;
      if (sixes >= 3) { w.ev.push({ k: 'roll', p: p.id, a, b, from, to: from, forfeit: 1 }); break; }
      left++;
    }
    let to = from + a + b, lap = 0;
    if (to >= RING_N) { to -= RING_N; lap = 1; p.laps++; p.score += LAP_BONUS; }
    p.rs = to;
    const cell = ringCell(p), boot = [];
    if (!isSafeCell(cell)) {
      for (const q of w.players) if (q !== p && !q.still && ringCell(q) === cell) { q.rs = 0; boot.push(q.id); }
    }
    if (boot.length) { left++; p.boots = (p.boots || 0) + boot.length; p.score += BOOT_BONUS * boot.length; }
    w.ev.push({ k: 'roll', p: p.id, a, b, from, to, lap, boot });
  }
}
function endRound(w) {
  w.phase = 'over'; w.over = 0; w.left = 0;
  w.result = [...w.players].sort((a, b) => b.score - a.score).map((p) => p.id);
  w.grem = []; w.dark = null;
  w.ev.push({ k: 'end' });
}
export function setInput(w, id, inp) {
  const p = w.players.find((q) => q.id === id); if (!p || p.bot) return;
  p.inp.mx = clamp1(inp.mx); p.inp.my = clamp1(inp.my);
  if (inp.pulse) p.inp.pulse = 1;
  if (inp.dash) p.inp.dash = 1;
  if (inp.emote && p.emT <= 0) { p.emote = inp.emote | 0; p.emT = 2.5; w.ev.push({ k: 'emote', p: p.id, e: p.emote }); }
}
const clamp1 = (v) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

// ---------- snapshots (small: arrays, rounded numbers) ----------
const r1 = (v) => Math.round(v * 10) / 10, r0 = Math.round;
export function roster(w) { return w.players.map((p) => [p.id, p.name, p.color, p.hat, p.bot ? 1 : 0]); }
export function snapshot(w, withSparks = true) {
  const s = {
    m: [w.phase === 'play' ? 0 : 1, r1(w.left), w.round, w.stage, w.dark ? [w.dark.q, r1(w.dark.t), w.dark.stage] : 0, w.rs, w.nid, r1(w.nextDark), r1(w.nextPup), w.over ? r1(w.over) : 0, w.result],
    p: w.players.map((p) => [p.id, r0(p.x), r0(p.y), r1(p.a), p.carry, p.score, r1(p.stun), r1(p.shield), r1(p.speed), r1(p.magnet), r1(p.pcd), r1(p.dcd), r1(p.dash), r1(p.grace), r0(p.vx), r0(p.vy), p.emote, r1(p.emT), p.bot ? 1 : 0, p.rs, p.laps, p.seat]),
    g: w.grem.map((g) => [g.id, r0(g.x), r0(g.y), r0(g.vx), r0(g.vy), r1(g.st), g.loot]),
    u: w.pups.map((u) => [u.id, r0(u.x), r0(u.y), u.k]),
    e: w.ev,
  };
  if (withSparks) s.s = w.sparks.map((q) => [q.id, r0(q.x), r0(q.y), q.v]);
  return s;
}
// Apply a snapshot onto a client-side world. `ros` = roster rows. Returns nothing.
export function applySnapshot(w, s, ros) {
  const [ph, left, round, stage, dark, rs, nidv, nd, np, over, result] = s.m;
  w.phase = ph ? 'over' : 'play'; w.left = left; w.round = round; w.stage = stage;
  w.dark = dark ? { q: dark[0], t: dark[1], stage: dark[2] } : null; w.rs = rs; w.nid = nidv; w.nextDark = nd; w.nextPup = np; w.over = over; w.result = result || [];
  const byId = new Map(w.players.map((p) => [p.id, p]));
  const next = [];
  for (const a of s.p) {
    let p = byId.get(a[0]);
    if (!p) { const r = (ros || []).find((x) => x[0] === a[0]); p = mkPlayer(w, { id: a[0], name: r ? r[1] : '?', color: r ? r[2] : 0, hat: r ? r[3] : 0, bot: true }); }
    p.x = a[1]; p.y = a[2]; p.a = a[3]; p.carry = a[4]; p.score = a[5]; p.stun = a[6]; p.shield = a[7]; p.speed = a[8]; p.magnet = a[9];
    p.pcd = a[10]; p.dcd = a[11]; p.dash = a[12]; p.grace = a[13]; p.vx = a[14]; p.vy = a[15]; p.emote = a[16]; p.emT = a[17]; p.bot = !!a[18]; p.rs = a[19] | 0; p.laps = a[20] | 0; p.seat = a[21] | 0;
    const r = (ros || []).find((x) => x[0] === a[0]); if (r) { p.name = r[1]; p.color = r[2]; p.hat = r[3]; }
    next.push(p);
  }
  w.players = next;
  w.grem = s.g.map((a) => ({ id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], st: a[5], loot: a[6], fl: 0, wt: 0, wx: 0, wy: 0 }));
  w.pups = s.u.map((a) => ({ id: a[0], x: a[1], y: a[2], k: a[3] }));
  if (s.s) { w.sparks = s.s.map((a) => ({ id: a[0], x: a[1], y: a[2], v: a[3] })); w.sv++; }
}

// ---------- tutorial helpers (used by tutorial.js) ----------
export const isBlocked = blocked;
export const putSpark = (w, x, y, v = 1) => addSpark(w, x, y, v);
export function makeTutorialWorld(meInfo) {
  const w = createWorld(7);
  w.players = []; w.sparks = []; w.pups = []; w.grem = []; w.dark = null; w.tut = true; w.ev = [];
  w.nextDark = 1e9; w.nextPup = 1e9; w.nextGrem = 1e9;
  humanJoin(w, meInfo);
  const me = w.players[0]; me.x = BEACON.x; me.y = BEACON.y + 170; me.vx = me.vy = 0; me.grace = 0;
  return w;
}
export function addDummy(w, name, x, y, carry) {
  const p = mkPlayer(w, { name, color: 4, hat: 1, bot: true, kind: 'rookie', skill: 0.5 });
  p.x = x; p.y = y; p.carry = carry; p.still = true; p.grace = 0; p.seat = 5; w.players.push(p); return p;
}
export function addGremlin(w, x, y) {
  const g = { id: nid(w), x, y, vx: 0, vy: 0, st: 0, loot: 0, fl: 0, wt: 0, wx: 0, wy: 0 }; w.grem.push(g); return g;
}
export function addPowerup(w, x, y, k) { const u = { id: nid(w), x, y, k }; w.pups.push(u); return u; }
