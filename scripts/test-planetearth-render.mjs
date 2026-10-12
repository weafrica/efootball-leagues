// Draws every Planet Earth screen into a recording stub canvas (no browser needed) to catch crashes and typos.
const grad = { addColorStop() {} }; let calls = 0;
const ctx = new Proxy({}, { get: (t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient' ? () => { calls++; return grad; } : k === 'createImageData' ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) : (k in t ? t[k] : () => { calls++; })), set: (t, k, v) => { t[k] = v; return true; } });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const art = await import('../src/planetearth/art.js'), { drawGlobe, project, cityScreen, LAND } = await import('../src/planetearth/earthmap.js');
const { createWater, step } = await import('../src/planetearth/water.js'), { fire } = await import('../src/planetearth/orbit.js'), { LEVELS } = await import('../src/planetearth/lessons.js');
const { CITIES } = await import('../src/planetearth/sky.js');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const sizes = [[320, 190], [360, 640], [900, 500], [1400, 800]];
try {
  for (const l of LEVELS) for (const c of l.cards) for (const [w, h] of [[320, 190], [600, 190]]) for (const tm of [0, 1.7, 9]) art.cardArt(ctx, c.art, w, h, tm);
  ok(true, 'all story-card illustrations draw at phone and desktop widths');
  for (const [w, h] of sizes) for (const utc of [0, 6, 12, 18.5]) art.drawSpin(ctx, w, h, 1, { utc, selected: 'jhb' });
  ok(true, 'Level 1 globe draws at every size and time of day');
  for (const [w, h] of sizes) for (const day of [0, 79, 171, 265, 354]) for (const tilt of [0, 23.44, 90]) for (const lat of [-26.2, 0, 69.7]) art.drawSeasons(ctx, w, h, 2, { day, tilt, lat, cityName: 'X', alienColor: 2 });
  ok(true, 'Level 2 orbit + sky views draw for all dates, tilts and latitudes (incl. polar day/night)');
  const wt = createWater(4); wt.mtn.h = 140; for (const [w, h] of sizes) { for (let i = 0; i < 600; i++) step(wt, 1 / 30); art.drawWater(ctx, w, h, 3, wt); }
  ok(true, 'Level 3 water world draws with vapour, clouds, rain and runoff');
  for (const [w, h] of sizes) for (const sp of [3, 7.2, 7.79, 9, 11.5]) { const f = fire(sp, 0), last = f.points[f.points.length - 1].t; for (const t of [0, last / 2, last]) art.drawCannon(ctx, w, h, 1, { speed: sp, angle: 0, zoom: sp > 8 ? 4 : 1, flight: f, t, history: [f], flagAngle: 44 }); art.drawCannon(ctx, w, h, 1, { speed: sp, angle: 10, zoom: 1, flight: null, t: 0, history: [], flagAngle: 44 }); }
  ok(true, "Level 4 Newton's cannon draws for every kind of shot");
  { const { createClimate, stepClimate } = await import('../src/planetearth/greenhouse.js'); for (const [ppm, base] of [[0, 0.3], [280, 0.3], [560, 0.1], [1200, 0.1], [280, 0.7]]) { const c = createClimate(); c.ppm = ppm; c.base = base; const ph = []; for (let i = 0; i < 400; i++) { stepClimate(c, 0.2); } for (const [w, h] of sizes) for (let f = 0; f < 30; f++) art.drawGreenhouse(ctx, w, h, f / 30, { c, ph, dt: 0.033 }); } }
  ok(true, 'Level 5 greenhouse lab draws (snowball, normal, hot) with photons');
  { const T = await import('../src/planetearth/tectonics.js'); for (const [l, r, vL, vR] of [['cont', 'cont', 3, -3], ['cont', 'cont', -3, 3], ['ocean', 'cont', 3, -3], ['cont', 'ocean', 3, -3], ['ocean', 'ocean', 3, -3], ['ocean', 'ocean', -3, 3], ['cont', 'cont', 0, 0]]) { const p = T.createPlates(2); p.left = l; p.right = r; p.vL = vL; p.vR = vR; for (let i = 0; i < 250; i++) T.stepPlates(p, 0.1); for (const [w, h] of sizes) { art.drawTectonics(ctx, w, h, 1, { p, shake: 0.5 }); p.lastErupt = p.t; art.drawTectonics(ctx, w, h, 2, { p, shake: 0 }); } }
    const q = T.createQuakeLab(3); q.sticky = q.crit = 5; for (let i = 0; i < 3000; i++) T.stepQuakeLab(q, 0.1); for (const [w, h] of sizes) { art.drawQuakeLab(ctx, w, h, 1, { q }); q.flash = 1; art.drawQuakeLab(ctx, w, h, 2, { q }); } }
  ok(true, 'Level 6 plate boundaries, eruptions and the Quake Lab draw');
  { const E = await import('../src/planetearth/ecosystem.js'); const e = E.createEco(4); for (const [w, h] of sizes) { for (let i = 0; i < 400; i++) E.stepEco(e, 0.1); art.drawEcosystem(ctx, w, h, 1, { e }); } E.startDrought(e); art.drawEcosystem(ctx, 400, 500, 2, { e }); E.removeLions(e); for (let i = 0; i < 600; i++) E.stepEco(e, 0.1); art.drawEcosystem(ctx, 400, 500, 3, { e }); }
  ok(true, 'Level 7 savanna draws (balanced, drought, no lions)');
  for (let ci = 0; ci < art.ALIEN_COLORS.length; ci++) { art.drawAlien(ctx, 100, 100, 80, ci, 1.2, { x: 1, y: -1 }, ci % 2 ? 'wow' : 'happy'); }
  art.drawUfo(ctx, 100, 100, 100, 2, true); art.drawSun(ctx, 50, 50, 12, 1, 1); art.spaceBg(ctx, 300, 300, 4);
  ok(true, 'alien (all colours), UFO and sun draw');
  for (const [lon0, lat0] of [[0, 0], [28, -26], [140, 35], [-70, 40], [180, 90], [0, -90]]) drawGlobe(ctx, 150, 150, 120, lon0, lat0, { sun: { lon: lon0 + 90, lat: 10 }, cities: CITIES, labels: true, selected: 'jhb' });
  ok(true, 'globe draws from many viewpoints with night shadow, cities and labels');
  ok(Object.keys(LAND).length >= 15 && Object.values(LAND).every((p) => p.length >= 4 && p.every(([lo, la]) => lo >= -180 && lo <= 180 && la >= -90 && la <= 90)), 'map data: every outline is valid longitude/latitude');
  const q = project(28, -26, 28, -26); ok(Math.abs(q.x) < 1e-9 && Math.abs(q.y) < 1e-9 && Math.abs(q.z - 1) < 1e-9, 'the map projection puts the view centre in the middle of the globe');
  ok(cityScreen(CITIES[0], 100, 100, 50, CITIES[0].lon, CITIES[0].lat).visible && !cityScreen(CITIES[0], 100, 100, 50, CITIES[0].lon + 180, -CITIES[0].lat).visible, 'cities on the far side of the planet are hidden');
} catch (e) { ok(false, 'renderer crashed: ' + (e && e.stack || e)); }
ok(calls > 20000, `lots of drawing happened (${calls} canvas calls)`);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
