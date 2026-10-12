// Planet Earth — plate tectonics. Two plates meet at a boundary. Their speeds (cm per year) decide what is built there.
// Time-lapse: 1 second of play ≈ 1 million years (Myr). Plus a "Quake Lab": a spring-block model of elastic rebound.
// Pure JS (no DOM). Heights are km above sea level; 1 cell = 10 km; the picture is a 1,200 km wide slice through the crust.
export const N = 120, X0 = 60;                       // number of cells, boundary position
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (o) => { o.rs = (o.rs + 0x6D2B79F5) | 0; let t = Math.imul(o.rs ^ (o.rs >>> 15), 1 | o.rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export function createPlates(seed = 1) {
  return { rs: seed | 0, t: 0, left: 'cont', right: 'cont', vL: 0, vR: 0, mount: 0, trench: 0, arc: 0, rift: 0, ridge: 0, spread: 0, shortening: 0, eruptions: 0, magma: 0, lastErupt: -99, maxMount: 0, maxRift: 0, maxTrench: 0, maxArc: 0 };
}
export const relSpeed = (p) => p.vL - p.vR;        // + : plates approaching each other (convergent), − : moving apart (divergent)
export function boundaryKind(p) {
  const rc = relSpeed(p); if (Math.abs(rc) < 0.3) return 'transform';
  if (rc > 0) return p.left === 'cont' && p.right === 'cont' ? 'collision' : p.left === 'ocean' && p.right === 'ocean' ? 'islandarc' : 'subduction';
  return p.left === 'cont' && p.right === 'cont' ? 'rift' : p.left === 'ocean' && p.right === 'ocean' ? 'ridge' : 'rift';
}
// Advance dt million years.
export function stepPlates(p, dt) {
  const kind = boundaryKind(p), rc = Math.abs(relSpeed(p)); p.t += dt;
  const ax = (cur, rate, back, cap) => clamp(cur + (rate - back * cur) * dt, 0, cap);
  p.mount = ax(p.mount, kind === 'collision' ? 0.375 * rc : 0, 0.25, 12);
  p.trench = ax(p.trench, kind === 'subduction' || kind === 'islandarc' ? 1.0 * rc : 0, 0.15, 7);
  p.arc = ax(p.arc, kind === 'subduction' ? 0.2 * rc : kind === 'islandarc' ? 0.24 * rc : 0, 0.2, kind === 'islandarc' ? 5 : 6);
  p.rift = ax(p.rift, kind === 'rift' ? 0.35 * rc : 0, 0.1, 4.5);
  p.ridge = ax(p.ridge, kind === 'ridge' ? 0.4 * rc : 0, 0.2, 1.8);
  if (kind === 'ridge' || kind === 'rift') p.spread += rc * 10 * dt; if (kind === 'collision' || kind === 'subduction' || kind === 'islandarc') p.shortening += rc * 10 * dt;   // km
  if (kind === 'subduction' || kind === 'islandarc' || kind === 'rift') { p.magma += rc * 0.35 * dt; while (p.magma >= 1) { p.magma -= 1; p.eruptions++; p.lastErupt = p.t; } }
  p.maxMount = Math.max(p.maxMount, p.mount); p.maxRift = Math.max(p.maxRift, p.rift); p.maxTrench = Math.max(p.maxTrench, p.trench); p.maxArc = Math.max(p.maxArc, p.arc);
}
// The height of the ground (km) at cell i, built from the features that exist now.
const g = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));
export function heightAt(p, i) {
  const left = i < X0, base = (left ? p.left : p.right) === 'cont' ? 0.5 : -4;
  let h = base; const kind = boundaryKind(p);
  h += p.mount * g(i, X0, 9) + p.rift * -g(i, X0, 5) + (p.rift > 0 ? 0.25 * p.rift * (g(i, X0 - 11, 4) + g(i, X0 + 11, 4)) : 0);
  h += p.ridge * g(i, X0, 8);
  const dir = p.left === 'ocean' && p.right === 'cont' ? 1 : p.left === 'cont' && p.right === 'ocean' ? -1 : 1;  // the arc grows on the continent (or the right plate)
  h -= p.trench * g(i, X0 - dir * 2, 4);
  h += p.arc * g(i, X0 + dir * 13, 5);
  return h;
}
export const heights = (p) => Array.from({ length: N }, (_, i) => heightAt(p, i));

// ---- Quake Lab: elastic rebound. The plate edge sticks, strain builds, then it suddenly slips. ----
export function createQuakeLab(seed = 7) { return { rs: seed | 0, t: 0, v: 50, sticky: 3, deficit: 0, crit: 3, quakes: [], maxMag: 0, flash: 0, lastSlip: 0 }; }
export const magnitude = (slipMetres) => 6.92 + (2 / 3) * Math.log10(Math.max(slipMetres, 0.001));   // Mw for a 30 km × 30 km patch of rock
// v = plate speed in mm/year (50 mm/yr = 5 cm/yr), sticky = how much slip (m) the rock can store before it breaks.
export function stepQuakeLab(q, dtYears) {
  q.t += dtYears; q.deficit += (q.v / 1000) * dtYears; q.flash = Math.max(0, q.flash - dtYears * 0.05);
  if (q.deficit >= q.crit) { const slip = q.deficit * (0.7 + 0.25 * rnd(q)); q.deficit -= slip; q.lastSlip = slip; const mag = magnitude(slip); q.quakes.push({ t: q.t, mag, slip }); if (q.quakes.length > 60) q.quakes.shift(); q.maxMag = Math.max(q.maxMag, mag); q.flash = 1; q.crit = q.sticky * (0.65 + 0.7 * rnd(q)); return { mag, slip }; }
  return null;
}
