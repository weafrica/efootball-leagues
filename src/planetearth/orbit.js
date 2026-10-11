// Planet Earth — Newton's cannon: real gravity, integrated with RK4. Units: km, seconds, km/s.
export const MU = 398600.4418;  // Earth's gravitational parameter, km^3/s^2
export const RE = 6371;         // Earth's radius, km
export const ALT = 200;         // the cannon sits on a (very tall!) 200 km mountain
export const circularSpeed = (r) => Math.sqrt(MU / r);
export const escapeSpeed = (r) => Math.sqrt(2 * MU / r);
const acc = (x, y) => { const r2 = x * x + y * y, k = -MU / (r2 * Math.sqrt(r2)); return [k * x, k * y]; };
function rk4(s, dt) {
  const f = (x, y, vx, vy) => { const [ax, ay] = acc(x, y); return [vx, vy, ax, ay]; };
  const k1 = f(s.x, s.y, s.vx, s.vy);
  const k2 = f(s.x + k1[0] * dt / 2, s.y + k1[1] * dt / 2, s.vx + k1[2] * dt / 2, s.vy + k1[3] * dt / 2);
  const k3 = f(s.x + k2[0] * dt / 2, s.y + k2[1] * dt / 2, s.vx + k2[2] * dt / 2, s.vy + k2[3] * dt / 2);
  const k4 = f(s.x + k3[0] * dt, s.y + k3[1] * dt, s.vx + k3[2] * dt, s.vy + k3[3] * dt);
  return { x: s.x + dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), y: s.y + dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
    vx: s.vx + dt / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]), vy: s.vy + dt / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]) };
}
// Fire from the top of the mountain (0, RE+ALT), aimed at `angle` degrees above flat, at `speed` km/s.
// Returns the whole flight: points [{x,y,t}], what happened ('landed' | 'orbit' | 'escape'), and orbit shape.
export function fire(speed, angle = 0, alt = ALT) {
  const r0 = RE + alt, a = angle * Math.PI / 180;
  let s = { x: 0, y: r0, vx: speed * Math.cos(a), vy: speed * Math.sin(a) };
  const eps = (speed * speed) / 2 - MU / r0, h = s.x * s.vy - s.y * s.vx;       // energy and angular momentum
  const ecc = Math.sqrt(Math.max(0, 1 + 2 * eps * h * h / (MU * MU)));
  const out = { points: [{ x: s.x, y: s.y, t: 0 }], outcome: 'orbit', landedAngle: null, ecc, eps, speed, angle, alt };
  if (eps < 0) { const sa = -MU / (2 * eps); out.a = sa; out.peri = sa * (1 - ecc); out.apo = sa * (1 + ecc); out.period = 2 * Math.PI * Math.sqrt(sa ** 3 / MU); }
  else out.outcome = 'escape';
  const tMax = eps < 0 ? Math.min(out.period * 1.02, 8 * 3600) : 6 * 3600;
  let t = 0, swept = 0, prev = Math.atan2(s.x, s.y);                                // swept = angle travelled around Earth (clockwise)
  for (let i = 0; i < 20000 && t < tMax; i++) {
    const r = Math.hypot(s.x, s.y), v = Math.hypot(s.vx, s.vy), dt = Math.max(0.5, Math.min(r > 3 * RE ? 120 : 30, 0.006 * r / Math.max(v, 0.1)));
    const n = rk4(s, dt); t += dt;
    const ang = Math.atan2(n.x, n.y); let d = ang - prev; if (d < -Math.PI) d += 2 * Math.PI; if (d > Math.PI) d -= 2 * Math.PI; swept += d; prev = ang;
    if (Math.hypot(n.x, n.y) <= RE) {                                              // hit the ground: interpolate the landing spot
      const r1 = r, r2 = Math.hypot(n.x, n.y), f = (r1 - RE) / Math.max(1e-9, r1 - r2);
      const lx = s.x + (n.x - s.x) * f, ly = s.y + (n.y - s.y) * f; out.points.push({ x: lx, y: ly, t: t - dt + dt * f });
      out.outcome = 'landed'; out.landedAngle = Math.abs(swept - d + d * f) * 180 / Math.PI; out.flightTime = t - dt + dt * f; return out;
    }
    s = n; out.points.push({ x: s.x, y: s.y, t });
    if (out.outcome === 'escape' && Math.hypot(s.x, s.y) > 40 * RE) break;
  }
  return out;
}
// Position along a flight at time t (seconds), by linear interpolation of the stored points.
export function at(flight, t) {
  const p = flight.points; if (t <= 0) return p[0]; if (t >= p[p.length - 1].t) return p[p.length - 1];
  let lo = 0, hi = p.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].t <= t) lo = m; else hi = m; }
  const f = (t - p[lo].t) / Math.max(1e-9, p[hi].t - p[lo].t); return { x: p[lo].x + (p[hi].x - p[lo].x) * f, y: p[lo].y + (p[hi].y - p[lo].y) * f, t };
}
