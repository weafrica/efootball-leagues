// Planet Earth — the hub, the story, the lessons and the games. Written with React.createElement (no JSX) so plain Node can syntax-check it.
import React, { useEffect, useRef, useState, Suspense } from 'react';
import { LEVELS, SOON, SHIP_CRYSTALS, flagAngle } from './lessons.js';
import { cardArt, drawSpin, spinCityAt, drawSeasons, drawWater, drawCannon, drawGreenhouse, drawTectonics, drawQuakeLab, drawEcosystem, sceneArt, drawForm, drawAlien, drawUfo, spaceBg, drawSun, ALIEN_COLORS, ALIEN_NAMES } from './art.js';
import { PROLOGUE, LEVEL_STORY, CAST, FORMS, VARIANTS, LINE_SFX, fill, voiceKey, heartStage } from './story.js';
import { playLine, stopVoice, setVoiceMuted, preload } from './voice.js';
import { drawGlobe } from './earthmap.js';
import { CITIES, city, clockTime, elevationAt, isMorning, fmtTime, dayLength, declination, fmtDay, TILT } from './sky.js';
import { createWater, step as waterStep, counts } from './water.js';
import { fire, RE } from './orbit.js';
import { createClimate, stepClimate, eqTemp, toC, isStable, warmingVsBase } from './greenhouse.js';
import { createPlates, stepPlates, createQuakeLab, stepQuakeLab, relSpeed } from './tectonics.js';
import { createEco, stepEco, addAnts, addLions, removeLions, startDrought, avgGrass } from './ecosystem.js';
import * as snd from './audio.js';

const GlowveldPage = React.lazy(() => import('../glowveld/GlowveldPage.jsx'));
const h = React.createElement;
const SAVE_KEY = 'planetearth-save-v1';
const rname = () => ALIEN_NAMES[Math.floor(Math.random() * ALIEN_NAMES.length)];
function loadSave() {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); return { name: s.name || rname(), color: s.color ?? 0, levels: s.levels || {}, story: !!s.story, prologue: !!s.prologue, ex: s.ex === 'he' ? 'he' : 'she', mute: !!s.mute }; }
  catch { return { name: rname(), color: 0, levels: {}, story: false, prologue: false, ex: 'she', mute: false }; }
}
const store = (s) => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } };
const btn = (bg, fg = '#fff') => ({ background: bg, color: fg, border: 'none', borderRadius: 16, padding: '12px 18px', fontSize: 17, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 0 rgba(0,0,0,0.25)', fontFamily: 'inherit', touchAction: 'manipulation' });
const panel = { background: 'rgba(20,28,60,0.88)', borderRadius: 18, padding: 14, color: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.35)' };
const shell = { position: 'fixed', inset: 0, zIndex: 9000, background: '#0a1230', color: '#fff', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const stars = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);
const crystals = (save) => LEVELS.filter((l) => (save.levels[l.id] && save.levels[l.id].stars) > 0).length;
const unlocked = (save, l) => l.n === 1 || !!(save.levels[LEVELS[l.n - 2].id] && save.levels[LEVELS[l.n - 2].id].stars > 0);

// ---------- a canvas that redraws every frame ----------
function CanvasView({ draw, onDown, onMove, onUp, style }) {
  const cv = useRef(null), dr = useRef(draw); dr.current = draw;
  const ev = useRef({}); ev.current = { onDown, onMove, onUp };
  useEffect(() => {
    const c = cv.current, ctx = c.getContext('2d'); let raf = 0, last = performance.now(), w = 300, hh = 200, tm = 0, warned = false;
    const fit = () => { const r = c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1); w = Math.max(1, r.width); hh = Math.max(1, r.height); c.width = Math.floor(w * dpr); c.height = Math.floor(hh * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    fit(); const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null; if (ro) ro.observe(c); window.addEventListener('resize', fit);
    const frame = (now) => { raf = requestAnimationFrame(frame); const dt = Math.min(0.1, (now - last) / 1000); last = now; tm += dt; try { dr.current(ctx, w, hh, tm, dt); } catch (e) { if (!warned) { warned = true; console.error('Planet Earth draw error', e); } } };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); if (ro) ro.disconnect(); window.removeEventListener('resize', fit); };
  }, []);
  const pos = (e) => { const r = e.currentTarget.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  return h('canvas', { ref: cv, style: { width: '100%', height: '100%', display: 'block', touchAction: 'none', ...style },
    onPointerDown: (e) => { snd.unlock(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ } const f = ev.current.onDown; if (f) f(pos(e)); },
    onPointerMove: (e) => { const f = ev.current.onMove; if (f) f(pos(e)); }, onPointerUp: (e) => { const f = ev.current.onUp; if (f) f(pos(e)); } });
}
const slider = (label, value, min, max, step, on, fmt) => h('label', { style: { display: 'block', marginBottom: 6, fontSize: 14, fontWeight: 700 } },
  h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', null, label), h('span', { style: { color: '#ffe27a' } }, fmt ? fmt(value) : value)),
  h('input', { type: 'range', min, max, step, value, onChange: (e) => on(parseFloat(e.target.value)), style: { width: '100%', accentColor: '#ffd93b', height: 28 } }));

// ---------- Level 1: spin the planet ----------
function SpinView({ report }) {
  const st = useRef({ utc: 8, selected: 'jhb', playing: false, drag: null, size: { w: 300, h: 300 } }).current;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => { const elev = {}, morning = {}; for (const c of CITIES) { elev[c.id] = elevationAt(c, st.utc, 0); morning[c.id] = isMorning(c, st.utc); } report({ utc: st.utc, elev, morning }); tick((n) => (n + 1) % 1000); }, 200);
    return () => clearInterval(id);
  }, []);
  const draw = (ctx, w, hh, tm, dt) => { if (st.playing) st.utc = (st.utc + dt * 1.2) % 24; st.size = { w, h: hh }; drawSpin(ctx, w, hh, tm, st); };
  const show = ['jhb', 'lon', 'tyo', 'nyc', 'syd', 'bom'].map(city);
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw,
      onDown: (p) => { st.drag = { x: p.x, moved: 0, p }; },
      onMove: (p) => { if (!st.drag) return; const dx = p.x - st.drag.x; st.drag.x = p.x; st.drag.moved += Math.abs(dx); st.utc = (((st.utc + dx * 0.03) % 24) + 24) % 24; },
      onUp: (p) => { if (st.drag && st.drag.moved < 5) { const id = spinCityAt(st.size.w, st.size.h, st, p.x, p.y); if (id) { st.selected = id; snd.sfx.click(); } } st.drag = null; } })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '8px 12px 10px' } },
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 6 } }, show.map((c) => { const day = elevationAt(c, st.utc, 0) > 0; return h('div', { key: c.id, style: { background: st.selected === c.id ? 'rgba(255,226,122,0.25)' : 'rgba(255,255,255,0.08)', borderRadius: 10, padding: '4px 8px', textAlign: 'center' } },
        h('div', { style: { fontSize: 11, opacity: 0.85, fontWeight: 700 } }, c.name), h('div', { style: { fontSize: 18, fontWeight: 900 } }, (day ? '☀️ ' : '🌙 ') + fmtTime(clockTime(c, st.utc)))); })),
      slider('Time (UTC clock ' + fmtTime(st.utc) + ')', st.utc, 0, 24, 0.05, (v) => { st.utc = v; tick((n) => n + 1); }, () => ''),
      h('button', { onClick: () => { st.playing = !st.playing; snd.sfx.click(); tick((n) => n + 1); }, style: { ...btn(st.playing ? '#c9503a' : '#2fc46b'), width: '100%', padding: '8px', fontSize: 15 } }, st.playing ? '⏸ Stop spinning' : '▶ Spin Earth (1 hour per second)')));
}

// ---------- Level 2: tilt & the seasons ----------
const SPOTS = [city('jhb'), city('lon'), city('tos'), { id: 'eq', name: 'Equator', lat: 0 }];
function SeasonsView({ report, alien }) {
  const st = useRef({ day: 100, tilt: TILT, spot: 'jhb', playing: false, zeroDay: null }).current;
  const [, tick] = useState(0);
  const spot = () => SPOTS.find((s) => s.id === st.spot);
  useEffect(() => {
    const id = setInterval(() => {
      if (st.tilt <= 0.5) { if (st.zeroDay == null) st.zeroDay = st.day; } else st.zeroDay = null;
      const moved = st.zeroDay != null && Math.min(Math.abs(st.day - st.zeroDay), 365 - Math.abs(st.day - st.zeroDay)) >= 30;
      report({ day: st.day, tilt: st.tilt, city: st.spot, dayLen: dayLength(spot().lat, declination(st.day, st.tilt)), moved }); tick((n) => (n + 1) % 1000);
    }, 200);
    return () => clearInterval(id);
  }, []);
  const draw = (ctx, w, hh, tm, dt) => { if (st.playing) st.day = (st.day + dt * 30) % 365; drawSeasons(ctx, w, hh, tm, { day: st.day, tilt: st.tilt, lat: spot().lat, cityName: spot().name, alienColor: alien }); };
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '8px 12px 10px' } },
      h('div', { style: { display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' } }, SPOTS.map((s) => h('button', { key: s.id, onClick: () => { st.spot = s.id; snd.sfx.click(); tick((n) => n + 1); }, style: { ...btn(st.spot === s.id ? '#ff9f43' : '#3a4580'), flex: '1 1 22%', padding: '6px 4px', fontSize: 12, boxShadow: 'none' } }, s.name))),
      slider('Date: ' + fmtDay(st.day), st.day, 0, 364, 1, (v) => { st.day = v; tick((n) => n + 1); }, () => ''),
      slider('Tilt of the planet', st.tilt, 0, 90, 0.5, (v) => { st.tilt = v; tick((n) => n + 1); }, (v) => v.toFixed(1) + '°'),
      h('button', { onClick: () => { st.playing = !st.playing; snd.sfx.click(); tick((n) => n + 1); }, style: { ...btn(st.playing ? '#c9503a' : '#2fc46b'), width: '100%', padding: '8px', fontSize: 15 } }, st.playing ? '⏸ Pause the year' : '▶ Play a whole year')));
}

// ---------- Level 3: the water cycle ----------
function WaterView({ report }) {
  const hold = useRef({ w: createWater((Math.random() * 1e9) | 0), acc: 0, epoch: 0, speed: 2 }).current;
  const [ui, setUi] = useState({ sun: 0.6, wind: 1, mtn: 20, speed: 2 });
  useEffect(() => { const id = setInterval(() => { const w = hold.w, c = counts(w); report({ clouds: c.c, rainA: w.stats.rainA, rainB: w.stats.rainB, epoch: hold.epoch }); }, 250); return () => clearInterval(id); }, []);
  const draw = (ctx, wd, hh, tm, dt) => { const w = hold.w; hold.acc += dt * hold.speed; let n = 0; while (hold.acc >= 1 / 30 && n < 10) { waterStep(w, 1 / 30); hold.acc -= 1 / 30; n++; } if (hold.acc > 0.5) hold.acc = 0; drawWater(ctx, wd, hh, tm, w); };
  const set = (k, v) => { const w = hold.w; if (k === 'sun') w.sun = v; else if (k === 'wind') w.wind = v; else if (k === 'mtn') w.mtn.h = v; else hold.speed = v; setUi((u) => ({ ...u, [k]: v })); };
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '8px 12px 10px' } },
      slider('☀️ Sun heat (sea ' + (5 + 30 * ui.sun).toFixed(0) + '°C)', ui.sun, 0, 1, 0.01, (v) => set('sun', v), () => ''),
      slider('💨 Wind', ui.wind, 0, 2, 0.05, (v) => set('wind', v), (v) => v.toFixed(1) + '×'),
      slider('⛰️ Mountain height', ui.mtn, 0, 160, 1, (v) => set('mtn', v), (v) => Math.round(v * 12) + ' m'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { onClick: () => { hold.w = createWater((Math.random() * 1e9) | 0); hold.w.sun = ui.sun; hold.w.wind = ui.wind; hold.w.mtn.h = ui.mtn; hold.epoch++; snd.sfx.click(); }, style: { ...btn('#4a5580'), flex: 1, padding: '8px', fontSize: 14 } }, '🔄 Fresh sky'),
        h('button', { onClick: () => set('speed', ui.speed === 1 ? 2 : ui.speed === 2 ? 4 : 1), style: { ...btn('#7a5cff'), flex: 1, padding: '8px', fontSize: 14 } }, '⏩ Speed ×' + ui.speed))));
}

// ---------- Level 4: Newton's cannon ----------
function CannonView({ report }) {
  const st = useRef({ speed: 6, angle: 0, zoom: 1, flight: null, t: 0, warp: 100, history: [], last: null, msg: '' }).current;
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => { report({ last: st.last, flagAngle }); tick((n) => (n + 1) % 1000); }, 250); return () => clearInterval(id); }, []);
  const finish = () => {
    const f = st.flight; st.history.push(f); st.last = { outcome: f.outcome, landedAngle: f.landedAngle, ecc: f.ecc, peri: f.peri };
    st.msg = f.outcome === 'landed' ? `Landed ${f.landedAngle.toFixed(0)}° round the Earth after ${Math.round(f.flightTime / 60)} min.` : f.outcome === 'escape' ? "ESCAPED! Earth's gravity can never pull it back." : (f.ecc < 0.04 ? 'A perfect circle! ' : 'ORBIT! ') + `Lowest ${Math.round(f.peri - RE)} km, highest ${Math.round(f.apo - RE)} km. One lap: ${Math.round(f.period / 60)} min.`;
    if (f.outcome === 'landed') snd.sfx.boom(); else snd.sfx.ok();
  };
  const draw = (ctx, w, hh, tm, dt) => { if (st.flight && st.t < st.flight.points[st.flight.points.length - 1].t) { st.t += dt * st.warp; const end = st.flight.points[st.flight.points.length - 1].t; if (st.t >= end) { st.t = end; finish(); } } drawCannon(ctx, w, hh, tm, { ...st, flagAngle }); };
  const shoot = () => {
    snd.unlock(); const f = fire(st.speed, st.angle); st.flight = f; st.t = 0; st.msg = ''; const end = f.points[f.points.length - 1].t; st.warp = Math.max(40, end / 9);
    st.zoom = f.outcome === 'escape' ? 5 : f.apo ? Math.max(1, Math.min(6, f.apo / (RE * 2.2))) : 1; snd.sfx.fire(); tick((n) => n + 1);
  };
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0, position: 'relative' } }, h(CanvasView, { draw }),
      st.msg ? h('div', { style: { ...panel, position: 'absolute', left: 8, right: 8, top: 8, padding: '8px 12px', fontWeight: 800, fontSize: 14, textAlign: 'center' } }, st.msg) : null),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '8px 12px 10px' } },
      slider('🚀 Launch speed', st.speed, 0, 12, 0.01, (v) => { st.speed = v; tick((n) => n + 1); }, (v) => v.toFixed(2) + ' km/s (' + Math.round(v * 3600).toLocaleString() + ' km/h)'),
      slider('🎯 Aim up/down', st.angle, -10, 30, 1, (v) => { st.angle = v; tick((n) => n + 1); }, (v) => v + '°'),
      slider('🔭 Zoom out', st.zoom, 1, 6, 0.1, (v) => { st.zoom = v; tick((n) => n + 1); }, (v) => v.toFixed(1) + '×'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { onClick: shoot, style: { ...btn('#ff6a3d'), flex: 2, padding: '10px', fontSize: 18 } }, '🔥 FIRE!'),
        h('button', { onClick: () => { st.history = []; st.flight = null; st.msg = ''; tick((n) => n + 1); }, style: { ...btn('#4a5580'), flex: 1, padding: '10px', fontSize: 14 } }, 'Clear'))));
}


// ---------- Level 5: the greenhouse lab ----------
function GreenhouseView({ report }) {
  const hold = useRef({ c: createClimate(), ph: [], acc: 0, speed: 5 }).current;
  const [ui, setUi] = useState({ ppm: 280, base: 0.3 });
  useEffect(() => { const id = setInterval(() => { const c = hold.c; report({ ppm: c.ppm, tempC: toC(c.T), stable: isStable(c), warming: warmingVsBase(c) }); }, 250); return () => clearInterval(id); }, []);
  const draw = (ctx, w, hh, tm, dt) => { const c = hold.c; hold.acc += dt * hold.speed; let n = 0; while (hold.acc >= 0.2 && n < 30) { stepClimate(c, 0.2); hold.acc -= 0.2; n++; } hold.acc = Math.min(hold.acc, 0.2); drawGreenhouse(ctx, w, hh, tm, { c, ph: hold.ph, dt }); };
  const warm = warmingVsBase(hold.c);
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '8px 12px 10px' } },
      slider('🏭 Greenhouse gases (280 = before factories, 420 = today)', ui.ppm, 0, 1200, 5, (v) => { hold.c.ppm = v; setUi((u) => ({ ...u, ppm: v })); }, (v) => v + ' ppm'),
      slider('🪞 Surface: dark forests ← → white ice', ui.base, 0.1, 0.7, 0.01, (v) => { hold.c.base = v; setUi((u) => ({ ...u, base: v })); }, (v) => Math.round(v * 100) + '% reflected'),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        h('div', { style: { flex: 2, fontSize: 14, fontWeight: 800, color: '#ffe27a' } }, (warm >= 0 ? '+' : '') + warm.toFixed(1) + '°C compared with 280 ppm'),
        h('button', { onClick: () => { hold.c.ppm = 280; hold.c.base = 0.3; setUi({ ppm: 280, base: 0.3 }); snd.sfx.click(); }, style: { ...btn('#4a5580'), flex: 1, padding: '8px', fontSize: 14 } }, '🔄 Reset'))));
}

// ---------- Level 6: moving ground + the quake lab ----------
function PlateView({ report }) {
  const hold = useRef({ p: createPlates(3), q: createQuakeLab(9), mode: 'plates', playing: false, acc: 0, shake: 0 }).current;
  const [ui, setUi] = useState({ mode: 'plates', left: 'cont', right: 'cont', vL: 0, vR: 0, playing: false, v: 50, sticky: 3 });
  const set = (patch) => setUi((u) => ({ ...u, ...patch }));
  useEffect(() => { const id = setInterval(() => { const p = hold.p, q = hold.q; report({ mount: p.maxMount, rift: p.maxRift, trench: p.maxTrench, arc: p.maxArc, maxMag: q.maxMag }); }, 250); return () => clearInterval(id); }, []);
  const draw = (ctx, w, hh, tm, dt) => {
    hold.shake = Math.max(0, hold.shake - dt * 1.5);
    if (hold.mode === 'plates') { if (hold.playing) { hold.acc += dt; let n = 0; while (hold.acc >= 0.1 && n < 6) { stepPlates(hold.p, 0.1); hold.acc -= 0.1; n++; } hold.acc = Math.min(hold.acc, 0.1); } drawTectonics(ctx, w, hh, tm, { p: hold.p, shake: hold.shake }); }
    else { hold.acc += dt * 10; let n = 0; while (hold.acc >= 0.1 && n < 30) { const r = stepQuakeLab(hold.q, 0.1); if (r) { hold.shake = 1; if (r.mag >= 6.8) snd.sfx.boom(); } hold.acc -= 0.1; n++; } hold.acc = Math.min(hold.acc, 0.1); drawQuakeLab(ctx, w, hh, tm, { q: hold.q }); }
  };
  const setPlate = (k, v) => { hold.p[k] = v; set({ [k]: v }); };
  const speeds = (vL, vR) => { hold.p.vL = vL; hold.p.vR = vR; set({ vL, vR }); };
  const tog = (id, label) => h('button', { key: id, onClick: () => { hold.mode = id; set({ mode: id }); snd.sfx.click(); }, style: { ...btn(ui.mode === id ? '#e0682a' : '#3a4580'), flex: 1, padding: '6px', fontSize: 13, boxShadow: 'none' } }, label);
  const typ = (side, id, label) => h('button', { key: side + id, onClick: () => { setPlate(side, id); snd.sfx.click(); }, style: { ...btn(ui[side] === id ? '#2fc46b' : '#3a4580'), flex: 1, padding: '5px', fontSize: 12, boxShadow: 'none' } }, label);
  const controls = ui.mode === 'plates' ? [
    h('div', { key: 'p1', style: { display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' } }, h('span', { style: { fontSize: 12, fontWeight: 800 } }, 'Left:'), typ('left', 'cont', '🏔️ Continent'), typ('left', 'ocean', '🌊 Ocean'), h('span', { style: { fontSize: 12, fontWeight: 800 } }, 'Right:'), typ('right', 'cont', '🏔️ Continent'), typ('right', 'ocean', '🌊 Ocean')),
    h('div', { key: 'p2', style: { display: 'flex', gap: 6, marginBottom: 6 } },
      h('button', { onClick: () => { speeds(3, -3); snd.sfx.click(); }, style: { ...btn('#c9503a'), flex: 1, padding: '6px', fontSize: 13, boxShadow: 'none' } }, '💥 Push together'), h('button', { onClick: () => { speeds(-3, 3); snd.sfx.click(); }, style: { ...btn('#3a7bff'), flex: 1, padding: '6px', fontSize: 13, boxShadow: 'none' } }, '↔️ Pull apart'), h('button', { onClick: () => { speeds(0, 0); snd.sfx.click(); }, style: { ...btn('#4a5580'), flex: 1, padding: '6px', fontSize: 13, boxShadow: 'none' } }, '⏹ Stop')),
    slider('Left plate speed (cm/yr, + moves right)', ui.vL, -10, 10, 0.5, (v) => { hold.p.vL = v; set({ vL: v }); }, (v) => v.toFixed(1)),
    slider('Right plate speed (cm/yr, − moves left)', ui.vR, -10, 10, 0.5, (v) => { hold.p.vR = v; set({ vR: v }); }, (v) => v.toFixed(1)),
    h('div', { key: 'p3', style: { display: 'flex', gap: 8 } },
      h('button', { onClick: () => { hold.playing = !hold.playing; set({ playing: hold.playing }); snd.sfx.click(); }, style: { ...btn(ui.playing ? '#c9503a' : '#2fc46b'), flex: 2, padding: '8px', fontSize: 14 } }, ui.playing ? '⏸ Pause' : '▶ Play (1 s ≈ 1 million years)'),
      h('button', { onClick: () => { const old = hold.p; const np = createPlates((Math.random() * 1e9) | 0); np.left = old.left; np.right = old.right; np.vL = old.vL; np.vR = old.vR; hold.p = np; snd.sfx.click(); }, style: { ...btn('#4a5580'), flex: 1, padding: '8px', fontSize: 14 } }, '🔄 Fresh')),
  ] : [
    slider('Plate push speed', ui.v, 10, 100, 1, (v) => { hold.q.v = v; set({ v }); }, (v) => (v / 10).toFixed(1) + ' cm/yr'),
    slider('Stickiness of the rock (how much slip it can store)', ui.sticky, 0.3, 10, 0.1, (v) => { hold.q.sticky = v; set({ sticky: v }); }, (v) => v.toFixed(1) + ' m'),
    h('button', { key: 'q', onClick: () => { const o = hold.q; hold.q = createQuakeLab((Math.random() * 1e9) | 0); hold.q.v = o.v; hold.q.sticky = o.sticky; hold.q.crit = o.sticky; snd.sfx.click(); }, style: { ...btn('#4a5580'), width: '100%', padding: '8px', fontSize: 14 } }, '🔄 Reset the lab (time runs 10 years per second)'),
  ];
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '8px 12px 10px' } }, h('div', { style: { display: 'flex', gap: 6, marginBottom: 6 } }, tog('plates', '⛰️ Time-lapse'), tog('quake', '💥 Quake Lab')), controls));
}

// ---------- Level 7: the savanna ----------
function LifeView({ report }) {
  const hold = useRef({ e: createEco((Math.random() * 1e9) | 0), acc: 0, speed: 3, hadRemoval: false }).current;
  const [ui, setUi] = useState({ rain: 1, speed: 3 });
  useEffect(() => { const id = setInterval(() => { const e = hold.e; report({ balancedFor: e.balancedFor, lions: e.lions.length, ants: e.ants.length, grass: avgGrass(e), hadRemoval: hold.hadRemoval }); }, 250); return () => clearInterval(id); }, []);
  const draw = (ctx, w, hh, tm, dt) => { hold.acc += dt * hold.speed; let n = 0; while (hold.acc >= 0.1 && n < 24) { stepEco(hold.e, 0.1); hold.acc -= 0.1; n++; } hold.acc = Math.min(hold.acc, 0.1); drawEcosystem(ctx, w, hh, tm, { e: hold.e }); };
  const act = (fn) => () => { fn(hold.e); snd.sfx.click(); setUi((u) => ({ ...u })); };
  const b = (bg, label, fn) => h('button', { onClick: fn, style: { ...btn(bg), flex: '1 1 30%', padding: '7px 4px', fontSize: 13, boxShadow: 'none' } }, label);
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '8px 12px 10px' } },
      slider('🌧️ Rainfall (grass growth)', ui.rain, 0.2, 2, 0.05, (v) => { hold.e.rain = v; setUi((u) => ({ ...u, rain: v })); }, (v) => v.toFixed(2) + '×'),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } }, b('#8a5a2a', '🦌 +10 antelope', act((e) => addAnts(e, 10))), b('#c98a1a', '🦁 +3 lions', act((e) => addLions(e, 3))), b('#c9503a', '🚫 Remove lions', act((e) => { removeLions(e); hold.hadRemoval = true; }))),
      h('div', { style: { display: 'flex', gap: 6 } }, b('#d9822b', '☀️ Drought', act((e) => startDrought(e))), b('#7a5cff', '⏩ Speed ×' + ui.speed, () => { hold.speed = ui.speed === 1 ? 3 : ui.speed === 3 ? 6 : 1; setUi((u) => ({ ...u, speed: hold.speed })); }), b('#4a5580', '🔄 Fresh savanna', () => { hold.e = createEco((Math.random() * 1e9) | 0); hold.e.rain = ui.rain; hold.hadRemoval = false; snd.sfx.click(); }))));
}

// ---------- the storyline: cinematic lines (with pre-recorded voice), setup, Blend Lab, prologue ----------
function Cinematic({ lines, art, save, variant, st, onDone }) {
  const [i, setI] = useState(0), [shown, setShown] = useState(0);
  const line = lines[i], text = fill(line.text, variant), c = CAST[line.who] || CAST.narrator, typed = shown >= text.length;
  const stRef = useRef({}).current; Object.assign(stRef, st || {}); stRef.speaker = line.who;
  const go = () => { if (i + 1 >= lines.length) onDone(); else setI(i + 1); };
  useEffect(() => { setShown(0); const id = setInterval(() => setShown((n) => (n >= text.length ? n : n + 2)), 28); return () => clearInterval(id); }, [i]);
  useEffect(() => {
    let alive = true; const fx = LINE_SFX[line.id]; if (fx && snd.sfx[fx]) snd.sfx[fx]();
    (async () => { const played = await playLine(voiceKey(line, variant)); if (alive && played) { await new Promise((r) => setTimeout(r, 500)); if (alive) go(); } })();
    preload(lines.slice(i + 1, i + 3).map((l) => voiceKey(l, variant)));
    return () => { alive = false; stopVoice(); };
  }, [i]);
  const tap = () => { snd.unlock(); if (!typed) setShown(text.length); else { stopVoice(); go(); } };
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }, onClick: tap },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw: (ctx, w, hh, tm) => sceneArt(ctx, art, w, hh, tm, { ...stRef, color: save.color, ex: save.ex }) })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '12px 16px 14px', minHeight: 132, cursor: 'pointer' } },
      h('div', { style: { display: 'inline-block', background: c.color, color: '#1a1030', fontWeight: 900, fontSize: 13, borderRadius: 10, padding: '2px 10px', marginBottom: 6 } }, c.icon + ' ' + c.name),
      h('div', { style: { fontSize: 18, lineHeight: 1.4, fontWeight: 700, minHeight: 50 } }, text.slice(0, shown)),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 } },
        h('div', { style: { fontSize: 12, opacity: 0.7 } }, typed ? 'Tap to continue ▶' : '…'),
        h('button', { onClick: (e) => { e.stopPropagation(); stopVoice(); onDone(); }, style: { ...btn('#4a5580'), padding: '4px 10px', fontSize: 12, boxShadow: 'none' } }, 'Skip ⏭'))));
}
function SetupPanel({ initial, onSubmit, label }) {
  const [name, setName] = useState(initial.name), [color, setColor] = useState(initial.color), [ex, setEx] = useState(initial.ex || 'she');
  const exBtn = (id, t) => h('button', { key: id, onClick: () => { setEx(id); snd.sfx.click(); }, style: { ...btn(ex === id ? '#c9503a' : '#3a4580'), flex: 1, padding: '8px 4px', fontSize: 13, boxShadow: 'none' } }, t);
  return h('div', { style: { ...panel, borderRadius: '18px 18px 0 0' } },
    h('input', { value: name, maxLength: 14, onChange: (e) => setName(e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 20, fontWeight: 800, padding: '8px 12px', borderRadius: 12, border: 'none', textAlign: 'center' } }),
    h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', margin: '10px 0' } }, ALIEN_COLORS.map((c, i) => h('button', { key: i, onClick: () => { setColor(i); snd.sfx.click(); }, 'aria-label': 'colour ' + (i + 1), style: { width: 36, height: 36, borderRadius: 18, background: c, border: color === i ? '4px solid #fff' : '3px solid rgba(0,0,0,0.3)', cursor: 'pointer' } }))),
    h('div', { style: { fontWeight: 800, fontSize: 13, margin: '4px 0' } }, '💔 Who broke your heart?'),
    h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } }, exBtn('he', '👦 ' + VARIANTS.he.ex + ' (boyfriend)'), exBtn('she', '👧 ' + VARIANTS.she.ex + ' (girlfriend)')),
    h('button', { onClick: () => { snd.unlock(); onSubmit({ name: (name || '').trim() || rname(), color, ex }); }, style: { ...btn('#2fc46b'), width: '100%' } }, label || 'Continue ▶'));
}
function SetupScreen({ save, onDone }) {
  const [color, setColor] = useState(save.color);
  return h('div', { style: shell }, h('div', { style: { padding: '8px 12px', background: 'rgba(0,0,0,0.3)', fontWeight: 900, fontSize: 17 } }, '👽 Your alien'),
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw: (ctx, w, hh, tm) => { spaceBg(ctx, w, hh, tm); drawAlien(ctx, w / 2, hh * 0.55, Math.min(w, hh) * 0.6, color, tm, { x: Math.sin(tm), y: 0 }); } })),
    h(SetupPanel, { initial: save, label: 'Save', onSubmit: (v) => { onDone(v); } }));
}
function BlendLab({ save, need, onDone }) {
  const [tried, setTried] = useState([]), [form, setForm] = useState(null), [burst, setBurst] = useState(false), [caption, setCaption] = useState('Tap a form to shape-shift!');
  const stRef = useRef({}).current; stRef.form = form; stRef.burst = burst;
  const pick = (f) => { snd.unlock(); snd.sfx.pop(); setForm(f.id); setBurst(true); setTimeout(() => setBurst(false), 900); setCaption(f.line.text); playLine(f.line.id); setTried((t) => (t.includes(f.id) ? t : [...t, f.id])); };
  const ready = tried.length >= need;
  return h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw: (ctx, w, hh, tm) => sceneArt(ctx, 'blend', w, hh, tm, { ...stRef, color: save.color }) })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '10px 14px 12px' } },
      h('div', { style: { fontSize: 16, fontWeight: 800, minHeight: 44, lineHeight: 1.35 } }, '🤖 ' + caption),
      h('div', { style: { fontSize: 12, opacity: 0.8, margin: '2px 0 6px', fontWeight: 700 } }, 'Forms tried: ' + Math.min(tried.length, need) + ' / ' + need),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } }, FORMS.map((f) => h('button', { key: f.id, onClick: () => pick(f), style: { ...btn(tried.includes(f.id) ? '#2f7d5a' : '#3a4580'), flex: '1 1 22%', padding: '8px 2px', fontSize: 13, boxShadow: 'none' } }, f.emoji + ' ' + f.name))),
      ready ? h('button', { onClick: onDone, style: { ...btn('#2fc46b'), width: '100%' } }, 'Blend Drive ready ▶') : null));
}
function Prologue({ save, onDone }) {
  const [si, setSi] = useState(0), [stage, setStage] = useState('lines'), [reply, setReply] = useState(null), [me, setMe] = useState({ name: save.name, color: save.color, ex: save.ex || 'she' });
  const st = useRef({ react: null, launching: false, launchT: 0 }).current;
  const sc = PROLOGUE[si], view = { ...save, ...me };
  const next = () => { stopVoice(); if (si + 1 >= PROLOGUE.length) onDone(me); else { setSi(si + 1); setStage('lines'); setReply(null); } };
  const toReply = (line) => { setReply(line); setStage('reply'); };
  const pane = (children) => h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw: (ctx, w, hh, tm, dt) => { if (st.launching) st.launchT += dt; sceneArt(ctx, sc.art, w, hh, tm, { ...st, color: view.color, ex: view.ex }); } })),
    h('div', { style: { ...panel, borderRadius: '18px 18px 0 0', padding: '12px 14px 14px' } }, children));
  let body;
  if (stage === 'lines') body = h(Cinematic, { key: sc.id, lines: sc.lines, art: sc.art, save: view, variant: view.ex, st, onDone: () => (sc.after ? setStage('after') : next()) });
  else if (stage === 'reply') body = h(Cinematic, { key: sc.id + '-r', lines: [reply], art: sc.art, save: view, variant: view.ex, st, onDone: next });
  else {
    const a = sc.after;
    if (a.type === 'setup') body = h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }, h('div', { style: { flex: 1, minHeight: 0 } }, h(CanvasView, { draw: (ctx, w, hh, tm) => sceneArt(ctx, 'title', w, hh, tm, {}) })), h(SetupPanel, { initial: me, label: 'Start the adventure ▶', onSubmit: (v) => { setMe(v); next(); } }));
    else if (a.type === 'choice') body = pane([h('div', { key: 'p', style: { fontWeight: 900, fontSize: 18, marginBottom: 8, color: '#ffe27a' } }, a.prompt), ...a.options.map((o) => h('button', { key: o.id, onClick: () => { snd.unlock(); if (sc.id === 'cafe') st.react = o.id; toReply(o.reply); }, style: { ...btn('#3a4580'), display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, fontSize: 16 } }, o.text))]);
    else if (a.type === 'oath') body = pane(h('button', { onClick: () => { snd.unlock(); toReply(a.reply); }, style: { ...btn('#c9503a'), width: '100%' } }, a.button));
    else if (a.type === 'blend') body = h(BlendLab, { save: view, need: a.need, onDone: () => toReply(a.reply) });
    else body = pane(h('button', { disabled: st.launching, onClick: () => { snd.unlock(); snd.sfx.whoosh(); st.launching = true; st.launchT = 0; setTimeout(() => toReply(a.reply), 2400); }, style: { ...btn('#ff6a3d'), width: '100%', fontSize: 22 } }, a.button));
  }
  return h('div', { style: shell },
    h('div', { style: { padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(0,0,0,0.3)' } },
      h('div', { style: { fontWeight: 900, fontSize: 16, flex: 1 } }, '🎬 Chapter 1: Heartbreak on Proxima b'),
      h('div', { style: { display: 'flex', gap: 4 } }, PROLOGUE.map((p, i) => h('div', { key: p.id, style: { width: 8, height: 8, borderRadius: 4, background: i <= si ? '#ffe27a' : 'rgba(255,255,255,0.25)' } }))),
      h('button', { onClick: () => { stopVoice(); onDone(me); }, style: { ...btn('#4a5580'), padding: '4px 10px', fontSize: 12, boxShadow: 'none' } }, 'Skip story ⏭')),
    body);
}

// ---------- the lesson: story cards → hands-on missions → what you discovered ----------
function LevelShell({ level, save, onExit, onDone, onNext }) {
  const [phase, setPhase] = useState(LEVEL_STORY[level.id] ? 'transmission' : 'intro'), [ci, setCi] = useState(0), [mi, setMi] = useState(0), [msg, setMsg] = useState(null);
  const [hints, setHints] = useState(0), [wrong, setWrong] = useState(0), [hintOn, setHintOn] = useState(false), [qOpen, setQOpen] = useState(false), [picked, setPicked] = useState(-1), [doneN, setDoneN] = useState(0);
  const stateRef = useRef({}), baseRef = useRef({ rainA: 0, rainB: 0 }), epochRef = useRef(0), lock = useRef(false);
  const missions = level.missions, m = missions[mi];
  const advance = () => { const s = stateRef.current; baseRef.current = { rainA: s.rainA || 0, rainB: s.rainB || 0 }; lock.current = false; setMsg(null); setHintOn(false); setPicked(-1); if (mi + 1 >= missions.length) { setPhase(LEVEL_STORY[level.id] ? 'report' : 'result'); snd.sfx.win(); onDone(Math.max(1, 3 - Math.min(2, hints + wrong))); } else { setMi(mi + 1); setQOpen(missions[mi + 1].kind === 'choice'); } };
  const complete = () => { if (lock.current) return; lock.current = true; snd.sfx.ok(); setMsg(m.done); setDoneN((n) => n + 1); setQOpen(false); setTimeout(advance, 2400); };
  useEffect(() => {
    if (phase !== 'play') return undefined;
    const id = setInterval(() => {
      const s = stateRef.current; if (s.epoch !== undefined && s.epoch !== epochRef.current) { epochRef.current = s.epoch; baseRef.current = { rainA: 0, rainB: 0 }; }
      if (!m || m.kind === 'choice' || lock.current) return; let ok = false; try { ok = !!m.check({ ...s, base: baseRef.current }); } catch { ok = false; } if (ok) complete();
    }, 250);
    return () => clearInterval(id);
  }, [phase, mi, hints, wrong]);
  const View = { spin: SpinView, tilt: SeasonsView, water: WaterView, gravity: CannonView, greenhouse: GreenhouseView, plates: PlateView, life: LifeView }[level.id];
  const head = h('div', { style: { padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,0,0,0.3)' } },
    h('button', { onClick: onExit, style: { ...btn('#4a5580'), padding: '6px 12px', fontSize: 14, boxShadow: 'none' } }, '← Map'),
    h('div', { style: { fontWeight: 900, fontSize: 17, flex: 1 } }, level.icon + ' Level ' + level.n + ': ' + level.title));

  const story = LEVEL_STORY[level.id];
  if (phase === 'transmission' && story) return h('div', { style: shell }, head, h(Cinematic, { key: 'tx', lines: story.intro, art: 'transmission', save, variant: save.ex, onDone: () => setPhase('intro') }));
  if (phase === 'report' && story) return h('div', { style: shell }, head, h(Cinematic, { key: 'rp', lines: story.outro, art: 'transmission', save, variant: save.ex, onDone: () => setPhase('result') }));
  if (phase === 'intro') {
    const c = level.cards[ci], last = ci === level.cards.length - 1;
    return h('div', { style: shell }, head,
      h('div', { style: { flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 640, width: '100%', margin: '0 auto', boxSizing: 'border-box' } },
        h('div', { style: { height: 190, borderRadius: 18, overflow: 'hidden', flex: '0 0 auto', border: '2px solid rgba(255,255,255,0.15)' } }, h(CanvasView, { key: ci, draw: (ctx, w, hh, tm) => cardArt(ctx, c.art, w, hh, tm) })),
        h('div', { style: { ...panel } }, h('div', { style: { fontSize: 22, fontWeight: 900, color: level.color, marginBottom: 6 } }, c.title), h('div', { style: { fontSize: 17, lineHeight: 1.45, fontWeight: 600 } }, c.text)),
        h('div', { style: { ...panel, background: 'rgba(255,226,122,0.13)', border: '2px solid rgba(255,226,122,0.4)' } }, h('div', { style: { fontWeight: 900, color: '#ffe27a', marginBottom: 4 } }, '🤔 Why is it like that?'), h('div', { style: { fontSize: 15.5, lineHeight: 1.5 } }, c.why)),
        h('div', { style: { display: 'flex', gap: 6, justifyContent: 'center' } }, level.cards.map((_, i) => h('div', { key: i, style: { width: 10, height: 10, borderRadius: 5, background: i === ci ? level.color : 'rgba(255,255,255,0.25)' } })))),
      h('div', { style: { display: 'flex', gap: 10, padding: 12, maxWidth: 640, width: '100%', margin: '0 auto', boxSizing: 'border-box' } },
        ci > 0 ? h('button', { onClick: () => { setCi(ci - 1); snd.sfx.click(); }, style: { ...btn('#4a5580'), flex: 1 } }, '← Back') : null,
        h('button', { onClick: () => { snd.unlock(); snd.sfx.next(); if (last) { setPhase('play'); setQOpen(missions[0].kind === 'choice'); } else setCi(ci + 1); }, style: { ...btn(last ? '#2fc46b' : level.color), flex: 2 } }, last ? '🚀 Let’s try it!' : 'Next →')));
  }

  if (phase === 'result') {
    const stars3 = Math.max(1, 3 - Math.min(2, hints + wrong)), nxt = onNext;
    return h('div', { style: shell }, head,
      h('div', { style: { flex: 1, overflowY: 'auto', padding: 12, maxWidth: 640, width: '100%', margin: '0 auto', boxSizing: 'border-box' } },
        h('div', { style: { ...panel, textAlign: 'center' } },
          h('div', { style: { fontSize: 30, fontWeight: 900, color: '#ffe27a' } }, '💎 Discovery Crystal found!'), h('div', { style: { fontSize: 38, letterSpacing: 6, color: '#ffd93b', margin: '6px 0' } }, stars(stars3)),
          h('div', { style: { opacity: 0.85, fontWeight: 700 } }, 'You discovered how ' + level.title.toLowerCase() + ' works!'), h('div', { style: { marginTop: 8, fontWeight: 800, color: '#ffb3c8' } }, '💘 ' + heartStage(crystals(save)))),
        h('div', { style: { ...panel, marginTop: 10 } }, h('div', { style: { fontWeight: 900, fontSize: 18, marginBottom: 6, color: level.color } }, '📖 Earth Codex: what you learned'), level.codex.map((t, i) => h('div', { key: i, style: { margin: '6px 0', fontSize: 16, lineHeight: 1.4 } }, '⭐ ' + t)))),
      h('div', { style: { display: 'flex', gap: 10, padding: 12, maxWidth: 640, width: '100%', margin: '0 auto', boxSizing: 'border-box' } },
        h('button', { onClick: onExit, style: { ...btn('#4a5580'), flex: 1 } }, 'Map'),
        nxt ? h('button', { onClick: nxt, style: { ...btn('#2fc46b'), flex: 2 } }, 'Next level →') : h('button', { onClick: onExit, style: { ...btn('#2fc46b'), flex: 2 } }, 'Back to Earth')));
  }

  // phase === 'play'
  const bar = h('div', { style: { ...panel, borderRadius: 0, padding: '8px 12px' } },
    h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 } }, missions.map((mm, i) => h('div', { key: i, style: { width: 22, height: 22, borderRadius: 11, background: i < mi || (i === mi && msg) ? '#2fc46b' : i === mi ? level.color : 'rgba(255,255,255,0.2)', textAlign: 'center', fontSize: 13, lineHeight: '22px', fontWeight: 900 } }, i < mi || (i === mi && msg) ? '✓' : i + 1)), h('div', { style: { flex: 1 } }),
      h('button', { onClick: () => { setHintOn(!hintOn); if (!hintOn) setHints((n) => n + 1); snd.sfx.click(); }, style: { ...btn('#7a5cff'), padding: '4px 10px', fontSize: 13, boxShadow: 'none' } }, '💡 Hint'),
      m && m.kind === 'choice' ? h('button', { onClick: () => setQOpen(true), style: { ...btn('#ff9f43'), padding: '4px 10px', fontSize: 13, boxShadow: 'none' } }, '❓ Answer') : null),
    h('div', { style: { fontSize: 16, fontWeight: 800, lineHeight: 1.3 } }, msg ? '🎉 ' + msg : 'Mission ' + (mi + 1) + ': ' + m.text),
    hintOn && !msg ? h('div', { style: { fontSize: 14, color: '#ffe27a', marginTop: 4 } }, '💡 ' + m.hint) : null);
  const modal = qOpen && m && m.kind === 'choice' && !msg ? h('div', { style: { position: 'absolute', inset: 0, background: 'rgba(5,8,30,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, zIndex: 5 } },
    h('div', { style: { ...panel, maxWidth: 480, width: '100%', background: 'rgba(30,40,90,0.98)' } },
      h('div', { style: { fontWeight: 900, color: '#ffe27a', marginBottom: 6 } }, '❓ Question time!'), h('div', { style: { fontSize: 18, fontWeight: 800, marginBottom: 10, lineHeight: 1.35 } }, m.text),
      m.choices.map((c, i) => h('button', { key: i, onClick: () => { snd.unlock(); if (i === m.answer) { setPicked(i); complete(); } else { setPicked(i); setWrong((n) => n + 1); snd.sfx.bad(); } }, style: { ...btn(picked === i ? (i === m.answer ? '#2fc46b' : '#c9503a') : '#3a4580'), display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, fontSize: 16, padding: '10px 14px' } }, c)),
      picked >= 0 && picked !== m.answer ? h('div', { style: { color: '#ffb3b3', fontWeight: 700 } }, 'Not quite. Have another go! 💡 ' + m.hint) : null,
      h('button', { onClick: () => setQOpen(false), style: { ...btn('#4a5580'), width: '100%', marginTop: 4, fontSize: 14, padding: '8px' } }, 'Let me look at the planet first'))) : null;
  return h('div', { style: shell }, head, bar, h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' } }, h(View, { report: (s) => { stateRef.current = s; }, alien: save.color }), modal));
}

// ---------- the hub ----------
function Hub({ save, onLevel, onArcade, onCodex, onBack, onMute, onName, onStory }) {
  const c = crystals(save), hold = useRef({ form: null, t: 0, i: 0 }).current, [joke, setJoke] = useState('');
  const draw = (ctx, w, hh, tm, dt) => { if (hold.form) { hold.t -= dt || 0; if (hold.t <= 0) hold.form = null; } spaceBg(ctx, w, hh, tm); const R = Math.min(78, hh * 0.38), cx = w * 0.5, cy = hh * 0.55; drawSun(ctx, w * 0.93, hh * 0.25, 10, tm, 0.3); drawGlobe(ctx, cx, cy, R, -tm * 6, 15, { sun: { lon: -tm * 6 + 90, lat: 0 }, grid: false }); (hold.form ? drawForm(ctx, hold.form, w * 0.17, hh * 0.68, 76, tm, save.color) : drawAlien(ctx, w * 0.17, hh * 0.68, 62, save.color, tm, { x: 1, y: -0.3 })); drawUfo(ctx, w * 0.82, hh * 0.58, 80, tm, c < SHIP_CRYSTALS); };
  return h('div', { style: shell },
    h('div', { style: { overflowY: 'auto', flex: 1 } },
      h('div', { style: { position: 'relative', height: 210 } }, h(CanvasView, { draw, onDown: (p) => { if (p.x < 150 && p.y > 90) { const f = FORMS[hold.i++ % FORMS.length]; hold.form = f.id; hold.t = 3.2; snd.unlock(); snd.sfx.pop(); setJoke(f.emoji + ' ' + f.line.text); playLine(f.line.id); } } }),
        h('div', { style: { position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', { onClick: onBack, style: { ...btn('rgba(20,28,60,0.85)'), padding: '6px 12px', fontSize: 14, boxShadow: 'none' } }, '← Back'), h('div', { style: { flex: 1, textAlign: 'center', fontWeight: 900, fontSize: 22, letterSpacing: 2, color: '#ffe27a', textShadow: '0 2px 0 rgba(0,0,0,0.5)' } }, 'PLANET EARTH'),
          h('button', { onClick: onCodex, style: { ...btn('rgba(20,28,60,0.85)'), padding: '6px 10px', fontSize: 16, boxShadow: 'none' }, 'aria-label': 'codex' }, '📖'), h('button', { onClick: onMute, style: { ...btn('rgba(20,28,60,0.85)'), padding: '6px 10px', fontSize: 16, boxShadow: 'none' }, 'aria-label': 'sound' }, save.mute ? '🔇' : '🔊'))),
      h('div', { style: { maxWidth: 560, margin: '0 auto', padding: '8px 12px 30px', boxSizing: 'border-box' } },
        h('div', { style: { ...panel, marginBottom: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('div', { style: { fontWeight: 900, fontSize: 18 } }, '👽 ' + save.name), h('button', { onClick: onName, style: { ...btn('#4a5580'), padding: '4px 10px', fontSize: 12, boxShadow: 'none' } }, 'Change'), h('button', { onClick: onStory, style: { ...btn('#7a5cff'), padding: '4px 10px', fontSize: 12, boxShadow: 'none' } }, '🎬 Story')),
          h('div', { style: { margin: '8px 0 4px', fontSize: 14, fontWeight: 700, opacity: 0.9 } }, '🚀 Ship power: ' + c + ' / ' + SHIP_CRYSTALS + ' Discovery Crystals'),
          h('div', { style: { margin: '2px 0 6px', fontSize: 13, fontWeight: 800, color: '#ffb3c8' } }, '💘 ' + heartStage(c)),
          joke ? h('div', { style: { margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: '#7fe9ff' } }, joke) : null,
          h('div', { style: { height: 12, borderRadius: 6, background: 'rgba(255,255,255,0.18)', overflow: 'hidden' } }, h('div', { style: { height: 12, background: 'linear-gradient(90deg,#7fe9ff,#ffe27a)', width: (c / SHIP_CRYSTALS * 100) + '%', transition: 'width .4s' } }))),
        LEVELS.map((l) => { const open = unlocked(save, l), s = save.levels[l.id] ? save.levels[l.id].stars : 0;
          return h('button', { key: l.id, disabled: !open, onClick: () => onLevel(l.id), style: { ...panel, display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', border: 'none', marginBottom: 10, opacity: open ? 1 : 0.5, cursor: open ? 'pointer' : 'not-allowed', fontFamily: 'inherit', borderLeft: '6px solid ' + l.color } },
            h('div', { style: { fontSize: 34, width: 48, textAlign: 'center' } }, open ? l.icon : '🔒'),
            h('div', { style: { flex: 1 } }, h('div', { style: { fontSize: 12, opacity: 0.7, fontWeight: 800 } }, 'LEVEL ' + l.n), h('div', { style: { fontSize: 19, fontWeight: 900 } }, l.title), h('div', { style: { fontSize: 14, opacity: 0.85 } }, l.tagline)),
            h('div', { style: { color: '#ffd93b', fontSize: 18, letterSpacing: 2 } }, open ? stars(s || 0) : '')); }),
        h('button', { onClick: onArcade, style: { ...panel, display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', border: 'none', marginBottom: 10, cursor: 'pointer', fontFamily: 'inherit', borderLeft: '6px solid #ffb020' } },
          h('div', { style: { fontSize: 34, width: 48, textAlign: 'center' } }, '🎮'), h('div', { style: { flex: 1 } }, h('div', { style: { fontSize: 12, opacity: 0.7, fontWeight: 800 } }, 'EARTH ARCADE'), h('div', { style: { fontSize: 19, fontWeight: 900 } }, 'Glowveld'), h('div', { style: { fontSize: 14, opacity: 0.85 } }, 'Zap, dash and grab Sparks in Kasi Square. Play with friends and bots!')), h('div', { style: { fontSize: 22 } }, '▶')),
        h('div', { style: { fontWeight: 900, opacity: 0.7, margin: '14px 4px 6px', fontSize: 13 } }, 'COMING SOON'),
        SOON.map((l) => h('div', { key: l.n, style: { ...panel, display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, opacity: 0.45, padding: '10px 14px' } }, h('div', { style: { fontSize: 26, width: 48, textAlign: 'center' } }, '🔒'), h('div', null, h('div', { style: { fontWeight: 800 } }, 'Level ' + l.n + ': ' + l.title), h('div', { style: { fontSize: 13 } }, l.tagline)))))));
}

function Codex({ save, onClose }) {
  const got = LEVELS.filter((l) => save.levels[l.id] && save.levels[l.id].stars > 0);
  return h('div', { style: shell },
    h('div', { style: { padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,0,0,0.3)' } }, h('button', { onClick: onClose, style: { ...btn('#4a5580'), padding: '6px 12px', fontSize: 14, boxShadow: 'none' } }, '← Map'), h('div', { style: { fontWeight: 900, fontSize: 18 } }, '📖 Earth Codex')),
    h('div', { style: { flex: 1, overflowY: 'auto', padding: 12, maxWidth: 560, width: '100%', margin: '0 auto', boxSizing: 'border-box' } },
      got.length ? got.map((l) => h('div', { key: l.id, style: { ...panel, marginBottom: 10, borderLeft: '6px solid ' + l.color } }, h('div', { style: { fontWeight: 900, fontSize: 18, marginBottom: 6 } }, l.icon + ' ' + l.title), l.codex.map((t, i) => h('div', { key: i, style: { margin: '5px 0', fontSize: 15, lineHeight: 1.4 } }, '⭐ ' + t))))
        : h('div', { style: { ...panel, textAlign: 'center', fontSize: 17 } }, 'Nothing here yet! Finish a level to add what you discovered.')));
}

// ---------- the whole thing ----------
export default function PlanetEarthPage({ onBack, showToast }) {
  const [save, setSave] = useState(loadSave), [screen, setScreen] = useState(() => (loadSave().prologue ? 'hub' : 'prologue')), [levelId, setLevelId] = useState(null);
  const patch = (p) => setSave((s) => { const n = { ...s, ...p }; store(n); return n; });
  useEffect(() => { snd.setMuted(save.mute); setVoiceMuted(save.mute); }, [save.mute]);
  const leave = () => { try { if (/^\/planet/i.test(window.location.pathname)) window.history.pushState({}, '', '/'); } catch { /* */ } if (onBack) onBack(); };
  const level = LEVELS.find((l) => l.id === levelId);
  if (screen === 'prologue') return h(Prologue, { save, onDone: (me) => { patch({ ...me, prologue: true, story: true }); setScreen('hub'); } });
  if (screen === 'rename') return h(SetupScreen, { save, onDone: (me) => { patch(me); setScreen('hub'); } });
  if (screen === 'codex') return h(Codex, { save, onClose: () => setScreen('hub') });
  if (screen === 'arcade') return h(Suspense, { fallback: h('div', { style: { ...shell, alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800 } }, 'Loading Glowveld…') }, h(GlowveldPage, { onBack: () => setScreen('hub'), showToast }));
  if (screen === 'level' && level) {
    return h(LevelShell, { key: level.id, level, save, onExit: () => setScreen('hub'),
      onDone: (stars) => { const prev = save.levels[level.id] ? save.levels[level.id].stars : 0; patch({ levels: { ...save.levels, [level.id]: { stars: Math.max(prev || 0, stars) } } }); },
      onNext: LEVELS[level.n] ? () => { setLevelId(LEVELS[level.n].id); } : null });
  }
  return h(Hub, { save, onLevel: (id) => { snd.unlock(); snd.sfx.next(); setLevelId(id); setScreen('level'); }, onArcade: () => { snd.unlock(); setScreen('arcade'); }, onCodex: () => setScreen('codex'), onBack: leave,
    onMute: () => patch({ mute: !save.mute }), onName: () => setScreen('rename'), onStory: () => setScreen('prologue') });
}
