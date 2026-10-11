// Planet Earth — the hub, the story, the lessons and the games. Written with React.createElement (no JSX) so plain Node can syntax-check it.
import React, { useEffect, useRef, useState, Suspense } from 'react';
import { LEVELS, SOON, SHIP_CRYSTALS, flagAngle } from './lessons.js';
import { cardArt, drawSpin, spinCityAt, drawSeasons, drawWater, drawCannon, drawAlien, drawUfo, spaceBg, drawSun, ALIEN_COLORS, ALIEN_NAMES } from './art.js';
import { drawGlobe } from './earthmap.js';
import { CITIES, city, clockTime, elevationAt, isMorning, fmtTime, dayLength, declination, fmtDay, TILT } from './sky.js';
import { createWater, step as waterStep, counts } from './water.js';
import { fire, RE } from './orbit.js';
import * as snd from './audio.js';

const GlowveldPage = React.lazy(() => import('../glowveld/GlowveldPage.jsx'));
const h = React.createElement;
const SAVE_KEY = 'planetearth-save-v1';
const rname = () => ALIEN_NAMES[Math.floor(Math.random() * ALIEN_NAMES.length)];
function loadSave() {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); return { name: s.name || rname(), color: s.color ?? 0, levels: s.levels || {}, story: !!s.story, mute: !!s.mute }; }
  catch { return { name: rname(), color: 0, levels: {}, story: false, mute: false }; }
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

// ---------- the lesson: story cards → hands-on missions → what you discovered ----------
function LevelShell({ level, save, onExit, onDone, onNext }) {
  const [phase, setPhase] = useState('intro'), [ci, setCi] = useState(0), [mi, setMi] = useState(0), [msg, setMsg] = useState(null);
  const [hints, setHints] = useState(0), [wrong, setWrong] = useState(0), [hintOn, setHintOn] = useState(false), [qOpen, setQOpen] = useState(false), [picked, setPicked] = useState(-1), [doneN, setDoneN] = useState(0);
  const stateRef = useRef({}), baseRef = useRef({ rainA: 0, rainB: 0 }), epochRef = useRef(0), lock = useRef(false);
  const missions = level.missions, m = missions[mi];
  const advance = () => { const s = stateRef.current; baseRef.current = { rainA: s.rainA || 0, rainB: s.rainB || 0 }; lock.current = false; setMsg(null); setHintOn(false); setPicked(-1); if (mi + 1 >= missions.length) { setPhase('result'); snd.sfx.win(); onDone(Math.max(1, 3 - Math.min(2, hints + wrong))); } else { setMi(mi + 1); setQOpen(missions[mi + 1].kind === 'choice'); } };
  const complete = () => { if (lock.current) return; lock.current = true; snd.sfx.ok(); setMsg(m.done); setDoneN((n) => n + 1); setQOpen(false); setTimeout(advance, 2400); };
  useEffect(() => {
    if (phase !== 'play') return undefined;
    const id = setInterval(() => {
      const s = stateRef.current; if (s.epoch !== undefined && s.epoch !== epochRef.current) { epochRef.current = s.epoch; baseRef.current = { rainA: 0, rainB: 0 }; }
      if (!m || m.kind === 'choice' || lock.current) return; let ok = false; try { ok = !!m.check({ ...s, base: baseRef.current }); } catch { ok = false; } if (ok) complete();
    }, 250);
    return () => clearInterval(id);
  }, [phase, mi, hints, wrong]);
  const View = { spin: SpinView, tilt: SeasonsView, water: WaterView, gravity: CannonView }[level.id];
  const head = h('div', { style: { padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(0,0,0,0.3)' } },
    h('button', { onClick: onExit, style: { ...btn('#4a5580'), padding: '6px 12px', fontSize: 14, boxShadow: 'none' } }, '← Map'),
    h('div', { style: { fontWeight: 900, fontSize: 17, flex: 1 } }, level.icon + ' Level ' + level.n + ': ' + level.title));

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
          h('div', { style: { opacity: 0.85, fontWeight: 700 } }, 'You discovered how ' + level.title.toLowerCase() + ' works!')),
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

// ---------- the story (first visit) ----------
function StoryScreen({ save, onDone, startStep = 0 }) {
  const [step, setStep] = useState(startStep), [name, setName] = useState(save.name), [color, setColor] = useState(save.color);
  const texts = [
    ['💥 CRASH LANDING!', 'Your spaceship zoomed through the sky and landed with a BANG on a strange blue planet called EARTH. You know absolutely nothing about this place!'],
    ['💎 Your ship needs power', 'The engine is broken. To fly home you must find ' + SHIP_CRYSTALS + ' Discovery Crystals. Each one is hidden in a secret of how Earth works: why the Sun goes down, why it rains, why things fall... Learn each secret by playing with it!'],
    ['👽 Who are you?', 'Choose your alien name and colour, explorer!'],
  ];
  const draw = (ctx, w, hh, tm) => { spaceBg(ctx, w, hh, tm); drawGlobe(ctx, w * 0.5, hh * 1.25, hh * 0.85, tm * 5, 40, { grid: false });
    if (step === 0) { drawUfo(ctx, w * 0.5, hh * 0.35, hh * 0.7, tm, true); } else if (step === 1) { drawAlien(ctx, w * 0.5, hh * 0.45, hh * 0.45, color, tm, { x: 0, y: -1 }, 'wow'); for (let i = 0; i < SHIP_CRYSTALS; i++) { const a = (i / SHIP_CRYSTALS) * 6.283 + tm * 0.5, x = w * 0.5 + Math.cos(a) * hh * 0.55, y = hh * 0.45 + Math.sin(a) * hh * 0.3; ctx.fillStyle = '#7fe9ff'; ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill(); } }
    else drawAlien(ctx, w * 0.5, hh * 0.5, hh * 0.55, color, tm, { x: Math.sin(tm), y: 0 }); };
  return h('div', { style: shell },
    h('div', { style: { height: '38%', minHeight: 170, flex: '0 0 auto' } }, h(CanvasView, { key: step === 2 ? 'c' + color : 's' + step, draw })),
    h('div', { style: { flex: 1, overflowY: 'auto', padding: 14, maxWidth: 560, width: '100%', margin: '0 auto', boxSizing: 'border-box' } },
      h('div', { style: panel }, h('div', { style: { fontSize: 24, fontWeight: 900, color: '#ffe27a', marginBottom: 8 } }, texts[step][0]), h('div', { style: { fontSize: 17, lineHeight: 1.5, fontWeight: 600 } }, texts[step][1]),
        step === 2 ? h('div', { style: { marginTop: 12 } },
          h('input', { value: name, maxLength: 14, onChange: (e) => setName(e.target.value), style: { width: '100%', boxSizing: 'border-box', fontSize: 20, fontWeight: 800, padding: '10px 12px', borderRadius: 12, border: 'none', textAlign: 'center' } }),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 } }, ALIEN_COLORS.map((c, i) => h('button', { key: i, onClick: () => { setColor(i); snd.sfx.click(); }, 'aria-label': 'colour ' + (i + 1), style: { width: 38, height: 38, borderRadius: 19, background: c, border: color === i ? '4px solid #fff' : '3px solid rgba(0,0,0,0.3)', cursor: 'pointer' } })))) : null)),
    h('div', { style: { padding: 14, maxWidth: 560, width: '100%', margin: '0 auto', boxSizing: 'border-box' } },
      h('button', { onClick: () => { snd.unlock(); snd.sfx.next(); if (step < 2) setStep(step + 1); else onDone((name || '').trim() || rname(), color); }, style: { ...btn('#2fc46b'), width: '100%', fontSize: 20 } }, step < 2 ? 'Next →' : '🌍 Explore Earth!')));
}

// ---------- the hub ----------
function Hub({ save, onLevel, onArcade, onCodex, onBack, onMute, onName }) {
  const c = crystals(save);
  const draw = (ctx, w, hh, tm) => { spaceBg(ctx, w, hh, tm); const R = Math.min(78, hh * 0.38), cx = w * 0.5, cy = hh * 0.55; drawSun(ctx, w * 0.93, hh * 0.25, 10, tm, 0.3); drawGlobe(ctx, cx, cy, R, -tm * 6, 15, { sun: { lon: -tm * 6 + 90, lat: 0 }, grid: false }); drawAlien(ctx, w * 0.17, hh * 0.68, 62, save.color, tm, { x: 1, y: -0.3 }); drawUfo(ctx, w * 0.82, hh * 0.58, 80, tm, c < SHIP_CRYSTALS); };
  return h('div', { style: shell },
    h('div', { style: { overflowY: 'auto', flex: 1 } },
      h('div', { style: { position: 'relative', height: 210 } }, h(CanvasView, { draw }),
        h('div', { style: { position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', alignItems: 'center', gap: 8 } },
          h('button', { onClick: onBack, style: { ...btn('rgba(20,28,60,0.85)'), padding: '6px 12px', fontSize: 14, boxShadow: 'none' } }, '← Back'), h('div', { style: { flex: 1, textAlign: 'center', fontWeight: 900, fontSize: 22, letterSpacing: 2, color: '#ffe27a', textShadow: '0 2px 0 rgba(0,0,0,0.5)' } }, 'PLANET EARTH'),
          h('button', { onClick: onCodex, style: { ...btn('rgba(20,28,60,0.85)'), padding: '6px 10px', fontSize: 16, boxShadow: 'none' }, 'aria-label': 'codex' }, '📖'), h('button', { onClick: onMute, style: { ...btn('rgba(20,28,60,0.85)'), padding: '6px 10px', fontSize: 16, boxShadow: 'none' }, 'aria-label': 'sound' }, save.mute ? '🔇' : '🔊'))),
      h('div', { style: { maxWidth: 560, margin: '0 auto', padding: '8px 12px 30px', boxSizing: 'border-box' } },
        h('div', { style: { ...panel, marginBottom: 10 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, h('div', { style: { fontWeight: 900, fontSize: 18 } }, '👽 ' + save.name), h('button', { onClick: onName, style: { ...btn('#4a5580'), padding: '4px 10px', fontSize: 12, boxShadow: 'none' } }, 'Change')),
          h('div', { style: { margin: '8px 0 4px', fontSize: 14, fontWeight: 700, opacity: 0.9 } }, '🚀 Ship power: ' + c + ' / ' + SHIP_CRYSTALS + ' Discovery Crystals'),
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
  const [save, setSave] = useState(loadSave), [screen, setScreen] = useState(() => (loadSave().story ? 'hub' : 'story')), [levelId, setLevelId] = useState(null);
  const patch = (p) => setSave((s) => { const n = { ...s, ...p }; store(n); return n; });
  useEffect(() => { snd.setMuted(save.mute); }, [save.mute]);
  const leave = () => { try { if (/^\/planet/i.test(window.location.pathname)) window.history.pushState({}, '', '/'); } catch { /* */ } if (onBack) onBack(); };
  const level = LEVELS.find((l) => l.id === levelId);
  if (screen === 'story') return h(StoryScreen, { save, onDone: (name, color) => { patch({ name, color, story: true }); setScreen('hub'); } });
  if (screen === 'rename') return h(StoryScreen, { save, startStep: 2, onDone: (name, color) => { patch({ name, color }); setScreen('hub'); } });
  if (screen === 'codex') return h(Codex, { save, onClose: () => setScreen('hub') });
  if (screen === 'arcade') return h(Suspense, { fallback: h('div', { style: { ...shell, alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800 } }, 'Loading Glowveld…') }, h(GlowveldPage, { onBack: () => setScreen('hub'), showToast }));
  if (screen === 'level' && level) {
    return h(LevelShell, { key: level.id, level, save, onExit: () => setScreen('hub'),
      onDone: (stars) => { const prev = save.levels[level.id] ? save.levels[level.id].stars : 0; patch({ levels: { ...save.levels, [level.id]: { stars: Math.max(prev || 0, stars) } } }); },
      onNext: LEVELS[level.n] ? () => { setLevelId(LEVELS[level.n].id); } : null });
  }
  return h(Hub, { save, onLevel: (id) => { snd.unlock(); snd.sfx.next(); setLevelId(id); setScreen('level'); }, onArcade: () => { snd.unlock(); setScreen('arcade'); }, onCodex: () => setScreen('codex'), onBack: leave,
    onMute: () => patch({ mute: !save.mute }), onName: () => setScreen('rename') });
}
