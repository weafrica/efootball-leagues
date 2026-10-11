// Tests for Planet Earth: real astronomy/physics numbers, simulation rules, and that every mission can actually be completed.
import { CITIES, city, declination, dayLength, sunElevation, subsolarLon, hourAngle, elevationAt, clockTime, isMorning, fmtTime, TILT } from '../src/planetearth/sky.js';
import { MU, RE, ALT, circularSpeed, escapeSpeed, fire } from '../src/planetearth/orbit.js';
import { createWater, step as wstep, counts, FARM_A, FARM_B } from '../src/planetearth/water.js';
import { LEVELS, SOON, flagAngle, levelById } from '../src/planetearth/lessons.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const near = (a, b, t) => Math.abs(a - b) <= t;

// ---- astronomy ----
const jhb = city('jhb'), lon = city('lon'), tyo = city('tyo'), tos = city('tos');
ok(near(declination(171), TILT, 0.05) && near(declination(354), -TILT, 0.05) && near(declination(79), 0, 0.3), 'Sun is overhead at the tropics on the solstices and the equator on the equinox');
ok(near(dayLength(jhb.lat, declination(354)), 13.6, 0.4) && near(dayLength(jhb.lat, declination(171)), 10.4, 0.4), 'Johannesburg: ~13.6 h daylight in December, ~10.4 h in June');
ok(near(dayLength(lon.lat, declination(171)), 16.4, 0.4), 'London: ~16.4 h of daylight in June');
ok(dayLength(tos.lat, declination(171)) === 24 && dayLength(tos.lat, declination(354)) === 0, 'Tromsø has midnight sun in June and polar night in December');
ok(CITIES.every((c) => near(dayLength(c.lat, declination(100, 0)), 12, 0.01)), 'with NO tilt every place has 12 hours of daylight all year');
ok(near(dayLength(0, declination(10)), 12, 0.01) && near(dayLength(0, declination(200)), 12, 0.01), 'the equator always has 12 h of daylight');
ok(subsolarLon(12) === 0 && subsolarLon(18) === -90 && Math.abs(subsolarLon(0)) === 180, 'the Sun is over longitude 0 at 12:00 UTC and moves west');
ok(near(sunElevation(0, 0, 0), 90, 0.001), 'equator at equinox noon: Sun straight overhead');
ok(fmtTime(clockTime(jhb, 10)) === '12:00' && fmtTime(clockTime(tyo, 10)) === '19:00' && fmtTime(clockTime(lon, 10)) === '10:00', 'clocks: noon in Johannesburg = 19:00 in Tokyo = 10:00 in London');
ok(isMorning(jhb, 4) && !isMorning(jhb, 12), 'morning / afternoon detection');

// ---- orbit physics ----
ok(near(circularSpeed(RE + ALT), 7.788, 0.01) && near(escapeSpeed(RE + ALT), 11.015, 0.01), 'circular speed ~7.8 km/s and escape speed ~11 km/s');
const circ = fire(circularSpeed(RE + ALT), 0), slow = fire(6, 0), fast = fire(7.5, 0), esc = fire(11.2, 0);
ok(circ.outcome === 'orbit' && circ.ecc < 0.01, 'launching at circular speed gives a circular orbit');
ok(slow.outcome === 'landed' && fast.outcome === 'landed' && fast.landedAngle > slow.landedAngle, 'faster shots land farther away');
ok(esc.outcome === 'escape', 'above escape speed the ball escapes');
ok(circ.points.length > 100 && circ.points.every((p) => Number.isFinite(p.x + p.y)), 'trajectory data is finite');
let minR = 1e9, maxR = 0; for (const p of circ.points) { const r = Math.hypot(p.x, p.y); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
ok(maxR - minR < 30, `energy is conserved around a circular orbit (radius varies ${(maxR - minR).toFixed(2)} km)`);
ok(near(circ.period / 60, 88.5, 1.5), `orbit period at 200 km is ~88 min (${(circ.period / 60).toFixed(1)})`);

// ---- water cycle ----
function runWater(o, secs = 90, seed = 3) { const w = createWater(seed); w.sun = o.sun ?? 0.6; w.wind = o.wind ?? 1; w.mtn.h = o.h ?? 20; for (let i = 0; i < secs * 30; i++) wstep(w, 1 / 30); return w; }
for (const o of [{ h: 0 }, { h: 150 }, { h: 80, sun: 1 }, { h: 80, sun: 0 }, { h: 150, wind: 2 }, { h: 150, wind: 0 }]) {
  const w = runWater(o), c = counts(w), s = w.stats; ok(s.evaporated === c.v + c.c + c.r + c.w + s.sea + s.lake + s.away, `water is conserved (${JSON.stringify(o)})`);
}
{ const tall = runWater({ h: 150 }), flat = runWater({ h: 0 });
  ok(tall.stats.rainA >= 100 && tall.stats.rainB <= tall.stats.rainA * 0.1, `tall mountain: rain on the windward farm (${tall.stats.rainA}), almost none on the far farm (${tall.stats.rainB})`);
  ok(flat.stats.rainA < tall.stats.rainA * 0.2, `without a mountain the windward farm stays dry (${flat.stats.rainA} vs ${tall.stats.rainA})`);
  const hot = runWater({ sun: 1, h: 20 }), cold = runWater({ sun: 0, h: 20 }); ok(hot.stats.evaporated > cold.stats.evaporated * 3, `a hot sea evaporates much more (${hot.stats.evaporated} vs ${cold.stats.evaporated})`); }
{ const w = createWater(5); let t25 = null; for (let i = 0; i < 90 * 30; i++) { wstep(w, 1 / 30); if (counts(w).c >= 25) { t25 = i / 30; break; } } ok(t25 !== null && t25 < 40, `clouds appear within 40 s with default settings (${t25} s)`); }

// ---- every level and every mission ----
ok(LEVELS.length === 4 && SOON.length === 4, 'four playable levels plus four coming soon');
for (const l of LEVELS) {
  ok(l.cards.length === 3 && l.cards.every((c) => c.title && c.text.length > 40 && c.why.length > 60 && c.art), `${l.title}: 3 story cards, each explains WHY`);
  ok(l.missions.every((m) => m.text && m.hint && m.done) && l.codex.length === 3, `${l.title}: missions have text, hint and feedback; codex has 3 lines`);
  ok(l.missions.filter((m) => m.kind === 'choice').every((m) => m.choices.length === 4 && m.answer >= 0 && m.answer < 4), `${l.title}: quiz questions have a valid answer`);
}
{ const L = levelById('spin'); const st = (utc) => { const elev = {}, morning = {}; for (const c of CITIES) { elev[c.id] = elevationAt(c, utc, 0); morning[c.id] = isMorning(c, utc); } return { utc, elev, morning }; };
  let m1 = false, m2 = false; for (let u = 0; u < 24; u += 0.05) { if (L.missions[0].check(st(u))) m1 = true; if (L.missions[1].check(st(u))) m2 = true; }
  ok(m1 && m2, 'Level 1: "sunrise in Johannesburg" and "night in Tokyo, day in London" are both achievable');
  ok(!L.missions[0].check(st(8)) && !L.missions[1].check(st(8)), 'Level 1: missions are NOT already done at the starting time (08:00 UTC)');
  ok(L.missions[2].choices[L.missions[2].answer].startsWith('19:00'), 'Level 1: the quiz answer matches the real clock difference'); }
{ const L = levelById('tilt'); const S = (o) => ({ day: 100, tilt: TILT, city: 'jhb', dayLen: 12, moved: false, ...o }); const dl = (cid, day, tilt = TILT) => dayLength((CITIES.find((c) => c.id === cid) || { lat: 0 }).lat, declination(day, tilt));
  let a = false, b = false; for (let d = 0; d < 365; d++) { if (L.missions[0].check(S({ day: d, dayLen: dl('jhb', d) }))) a = true; if (L.missions[1].check(S({ day: d, city: 'tos', dayLen: dl('tos', d) }))) b = true; }
  ok(a && b, 'Level 2: longest day in Johannesburg and midnight sun in Tromsø are achievable');
  ok(!L.missions[0].check(S({ day: 100, dayLen: dl('jhb', 100) })) && !L.missions[1].check(S({ city: 'tos', dayLen: dl('tos', 100) })), 'Level 2: not already done at the start');
  ok(!L.missions[0].check(S({ day: 354, tilt: 60, dayLen: dl('jhb', 354, 60) })), 'Level 2: cannot cheat the longest-day mission with a different tilt');
  ok(L.missions[2].check(S({ tilt: 0, moved: true })) && !L.missions[2].check(S({ tilt: 0, moved: false })) && !L.missions[2].check(S({ tilt: 23, moved: true })), 'Level 2: tilt-0 mission needs tilt 0 AND moving through the year');
  ok(/tilted/.test(L.missions[3].choices[L.missions[3].answer]), 'Level 2: the quiz answer is the tilt'); }
{ const L = levelById('water'); const w = createWater(11); w.mtn.h = 150; w.sun = 0.7; const got = [false, false, false]; const base = { rainA: 0, rainB: 0 };
  for (let i = 0; i < 150 * 30; i++) { wstep(w, 1 / 30); if (i % 15) continue; const s = { clouds: counts(w).c, rainA: w.stats.rainA, rainB: w.stats.rainB, base }; L.missions.slice(0, 3).forEach((m, k) => { if (m.check(s)) got[k] = true; }); }
  ok(got.every(Boolean), 'Level 3: clouds, windward rain and the rain-shadow missions can all be completed in the simulation');
  const w0 = createWater(11); w0.mtn.h = 0; let shadowFlat = false; for (let i = 0; i < 90 * 30; i++) { wstep(w0, 1 / 30); if (L.missions[2].check({ clouds: 0, rainA: w0.stats.rainA, rainB: w0.stats.rainB, base })) shadowFlat = true; }
  ok(!shadowFlat, 'Level 3: a flat land does NOT count as a rain shadow');
  ok(/loses its water/.test(L.missions[3].choices[L.missions[3].answer]), 'Level 3: the quiz answer explains the rain shadow'); }
{ const L = levelById('gravity'); const sum = (f) => ({ outcome: f.outcome, landedAngle: f.landedAngle, ecc: f.ecc, peri: f.peri }); let flag = false; for (let v = 6.5; v < 7.9; v += 0.01) { const f = fire(v, 0); if (L.missions[0].check({ last: sum(f), flagAngle })) { flag = true; break; } }
  ok(flag, 'Level 4: some launch speed lands on the flag');
  ok(L.missions[1].check({ last: sum(circ) }) && !L.missions[1].check({ last: sum(fire(9, 0)) }), 'Level 4: only a near-circular orbit completes the orbit mission');
  ok(L.missions[2].check({ last: sum(esc) }) && !L.missions[2].check({ last: sum(circ) }), 'Level 4: escape mission needs an escape');
  ok(!L.missions[0].check({ last: null, flagAngle }) && !L.missions[0].check({ last: sum(slow), flagAngle }), 'Level 4: not already done at the start'); }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
