// Planet Earth — the water cycle as a little physics world. Pure JS (no DOM) so it can be tested in Node.
// Real rules used: evaporation grows ~7% per °C; air cools ~6.5 °C per km of height; vapour turns into a cloud
// when the air cools to its dew point (cloud base ≈ 125 m per °C of "dew-point gap"); wind forced up a mountain
// cools and rains out on the windward side; air sinking on the far side warms and dries (the rain shadow).
export const WW = 800, WH = 420, SEA_X = 250, MAXP = 1000;
export const FARM_A = [400, 505], FARM_B = [665, 785];      // windward farm / leeward farm (x ranges)
const LAPSE = 0.078;                                         // °C per pixel (1 px = 12 m, so 6.5 °C per km)
const rnd = (w) => { w.rs = (w.rs + 0x6D2B79F5) | 0; let t = Math.imul(w.rs ^ (w.rs >>> 15), 1 | w.rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

export function createWater(seed = 1) {
  return { rs: seed | 0, t: 0, sun: 0.6, wind: 1, mtn: { x: 560, h: 20, w: 70 }, p: [], pid: 1, evapAcc: 0, coalAcc: 0,
    stats: { evaporated: 0, sea: 0, lake: 0, away: 0, rainA: 0, rainB: 0, rainOther: 0 } };
}
export const groundY = (w, x) => (x < SEA_X ? -30 : (x - SEA_X) * 0.022 + w.mtn.h * Math.exp(-(((x - w.mtn.x) / w.mtn.w) ** 2)));
const slope = (w, x) => (groundY(w, x + 4) - groundY(w, x - 4)) / 8;
export const surfaceTemp = (w) => 5 + 30 * w.sun;               // °C, the sea-surface / low-air temperature
export const dewPoint = (w) => surfaceTemp(w) - 8;               // °C
export const cloudBase = (w) => (surfaceTemp(w) - dewPoint(w)) / LAPSE;   // px above sea level (~100 px ≈ 1.2 km)
export const airTemp = (w, y) => surfaceTemp(w) - LAPSE * y;
export const counts = (w) => { const c = { v: 0, c: 0, r: 0, w: 0 }; for (const q of w.p) c[q.k]++; return c; };

export function step(w, dt) {
  w.t += dt;
  const Ts = surfaceTemp(w), Td = dewPoint(w);
  // 1. evaporation from the sea
  w.evapAcc += 14 * Math.exp(0.07 * (Ts - 20)) * dt;
  while (w.evapAcc >= 1) { w.evapAcc -= 1; if (w.p.length < MAXP) { w.p.push({ id: w.pid++, k: 'v', x: 15 + rnd(w) * (SEA_X - 40), y: 3, vx: 0, vy: 0 }); w.stats.evaporated++; } }
  // 2. move everything
  const keep = [];
  for (const q of w.p) {
    const g = groundY(w, q.x), s = slope(w, q.x);
    if (q.k === 'v' || q.k === 'c') {
      const u = w.wind * 28 * (q.k === 'c' ? 0.92 : 1) + (rnd(w) - 0.5) * 8;
      let lift = q.k === 'v' ? 1 + 8 * w.sun * w.sun : 0;              // warm air rises slowly (convection); a hot sea rises faster
      lift += s * u;                                                    // wind has to climb the slope... or sink down it
      q.x += u * dt; q.y += (lift + (rnd(w) - 0.5) * 6) * dt;
      if (q.y < g + 3) q.y = g + 3;
      if (q.y > WH - 6) q.y = WH - 6;
      const Tp = Ts - LAPSE * q.y;
      if (q.k === 'v' && Tp <= Td) q.k = 'c';                           // cooled to the dew point: a cloud droplet forms
      else if (q.k === 'c' && Tp > Td + 0.4) q.k = 'v';                 // sank and warmed: the droplet evaporates again
      if (q.x > WW - 4) { w.stats.away++; continue; }                    // carried off the map: it will fall as rain somewhere else
      keep.push(q);
    } else if (q.k === 'r') {                                           // rain falls
      q.x += w.wind * 8 * dt; q.y -= 120 * dt;
      if (q.y <= groundY(w, q.x)) {
        if (q.x < SEA_X) { w.stats.sea++; continue; }
        if (q.x >= FARM_A[0] && q.x <= FARM_A[1]) w.stats.rainA++; else if (q.x >= FARM_B[0] && q.x <= FARM_B[1]) w.stats.rainB++; else w.stats.rainOther++;
        q.k = 'w'; q.y = groundY(w, q.x);
      }
      keep.push(q);
    } else {                                                            // runoff: flows downhill, into rivers, the sea or a lake
      const sl = slope(w, q.x);
      if (Math.abs(sl) < 0.006) { w.stats.lake++; continue; }           // flat ground: it pools into a lake / soaks into the ground
      q.x -= Math.sign(sl) * Math.min(55, 12 + Math.abs(sl) * 260) * dt; q.y = groundY(w, q.x);
      if (q.x <= SEA_X) { w.stats.sea++; continue; }
      if (q.x >= WW - 6) { w.stats.lake++; continue; }
      keep.push(q);
    }
  }
  w.p = keep;
  // 3. clouds merge into raindrops when enough droplets crowd together
  w.coalAcc += dt;
  if (w.coalAcc >= 0.4) {
    w.coalAcc = 0; const bins = new Map();
    for (const q of w.p) if (q.k === 'c') { const b = Math.floor(q.x / 26); (bins.get(b) || bins.set(b, []).get(b)).push(q); }
    for (const list of bins.values()) if (list.length >= 9) for (let i = 0; i < 4; i++) { const q = list[i]; q.k = 'r'; }
  }
}
