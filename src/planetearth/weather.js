// Planet Earth — wind and weather. Two little labs (pure JS, no DOM):
//  1. Breeze Lab: land heats up and cools down much faster than the sea, so the wind changes direction every day.
//  2. Spin Lab: Earth spins, so moving air (and balls!) curve: to the right in the north, to the left in the south.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// ---- Breeze Lab ----
export function createBreeze() { return { hour: 6, days: 0, sun: 1, Tl: 12, Ts: 17, maxDayWind: 0, maxNightWind: 0 }; }
export const solar = (hour, sun = 1) => Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12)) * sun;     // 0 at night, 1 at noon
// Hours pass. Land follows the Sun within ~2 hours; the sea takes ~20 hours to change.
export function stepBreeze(b, dtHours) {
  b.hour += dtHours; while (b.hour >= 24) { b.hour -= 24; b.days++; }
  const s = solar(b.hour, b.sun);
  b.Tl += (12 + 18 * s - b.Tl) * Math.min(1, dtHours * 0.6);
  b.Ts += (16.5 + 3 * s - b.Ts) * Math.min(1, dtHours * 0.05);
  const u = windSpeed(b); b.maxDayWind = Math.max(b.maxDayWind, u); b.maxNightWind = Math.max(b.maxNightWind, -u);
}
// Surface wind in m/s. Positive = sea breeze (sea → land). Negative = land breeze (land → sea).
export const windSpeed = (b) => clamp(0.9 * (b.Tl - b.Ts), -9, 9);
// ---- Spin Lab ----
export const OMEGA0 = 0.22;   // exaggerated spin (rad/s) so you can SEE the curve; the real Earth turns 7.3e-5 rad/s
// A ball thrown from (0,-1) toward the target at (0,0.8) on a spinning disc. lat: -90..90 (spin strength = sin(lat)),
// aim: degrees left(-) / right(+) of straight at the target. Returns the ball's path as seen ON the spinning surface.
export const TARGET = { x: 0, y: 0.8, r: 0.14 };
export function throwBall(lat, aim, speed = 1.0, tEnd = 4) {
  const om = OMEGA0 * Math.sin((lat * Math.PI) / 180), a = (aim * Math.PI) / 180, vx = speed * Math.sin(a), vy = speed * Math.cos(a);
  const pts = []; let hit = false, closest = 1e9;
  for (let t = 0; t <= tEnd + 1e-9; t += 0.02) {
    const x = (vx + om) * t, y = -1 + vy * t, c = Math.cos(-om * t), s = Math.sin(-om * t);    // the ball keeps the spin speed of the spot it left from; then look at it from the spinning surface
    const rx = x * c - y * s, ry = x * s + y * c; pts.push({ x: rx, y: ry, t });
    const d = Math.hypot(rx - TARGET.x, ry - TARGET.y); closest = Math.min(closest, d); if (d <= TARGET.r) { hit = true; break; }
    if (Math.hypot(rx, ry) > 2.6) break;
  }
  return { pts, hit, closest, lat, aim, speed, om, side: Math.sign(pts[Math.min(pts.length - 1, 40)].x) };
}
