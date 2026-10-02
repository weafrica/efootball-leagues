// Glowveld — screen shell (menu, HUD, touch controls, game loop). Written with React.createElement (no JSX)
// so the file can be syntax-checked with plain Node.
import React, { useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { createWorld, step, snapshot, applySnapshot, roster, humanJoin, humanLeave, setInput, movePlayer, DT, W, H, COLORS, GOLDEN_HOUR, OVER_SECONDS } from './sim.js';
import { draw, makeFx, feed, updateFx, drawPlayer } from './render.js';
import * as audio from './audio.js';
import { joinRoom } from './net.js';

const h = React.createElement;
const SAVE_KEY = 'glowveld-save-v1';
const HAT_ICON = ['—', '🎉', '👑', '🧢', '📡', '🌸', '😇', '🍃'];
// hats unlock as you bank more sparks over time — a reason to come back
const HAT_UNLOCK = [0, 0, 2500, 100, 900, 250, 1500, 500];
const ADJ = ['Happy', 'Sunny', 'Brave', 'Cosmic', 'Speedy', 'Jolly', 'Lucky', 'Mighty', 'Bouncy', 'Zesty', 'Golden', 'Clever'];
const ANI = ['Gecko', 'Impala', 'Meerkat', 'Penguin', 'Zebra', 'Springbok', 'Hornbill', 'Pangolin', 'Lion', 'Sunbird', 'Otter', 'Giraffe'];
const EMOTES = ['❤️', '😂', '👏', '😮', '🔥'];
const randName = () => ADJ[Math.floor(Math.random() * ADJ.length)] + ' ' + ANI[Math.floor(Math.random() * ANI.length)];

function loadSave() {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); return { name: s.name || randName(), color: s.color ?? Math.floor(Math.random() * COLORS.length), hat: s.hat || 0, total: s.total || 0, rounds: s.rounds || 0, wins: s.wins || 0, best: s.best || 0, seen: !!s.seen, mute: !!s.mute, id: s.id || 'g' + Math.random().toString(36).slice(2, 10) }; }
  catch { return { name: randName(), color: 0, hat: 0, total: 0, rounds: 0, wins: 0, best: 0, seen: false, mute: false, id: 'g' + Math.random().toString(36).slice(2, 10) }; }
}
function storeSave(s) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } }
const fmt = (t) => { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

const btn = (bg, fg = '#fff') => ({ background: bg, color: fg, border: 'none', borderRadius: 18, padding: '14px 20px', fontSize: 18, fontWeight: 800, cursor: 'pointer', boxShadow: '0 5px 0 rgba(0,0,0,0.25)', fontFamily: 'inherit', touchAction: 'manipulation' });
const panel = { background: 'rgba(20,28,60,0.82)', backdropFilter: 'blur(6px)', borderRadius: 22, padding: 20, color: '#fff', boxShadow: '0 10px 40px rgba(0,0,0,0.4)' };

export default function GlowveldPage({ profile, onBack, showToast }) {
  const [save, setSave] = useState(loadSave);
  const [screen, setScreen] = useState('menu'); // menu | play
  const [how, setHow] = useState(() => !loadSave().seen);
  const [status, setStatus] = useState('');
  const [hud, setHud] = useState(null);
  const [emoteOpen, setEmoteOpen] = useState(false);
  const cvs = useRef(null), wrap = useRef(null), joyBase = useRef(null), joyKnob = useRef(null);
  const saveRef = useRef(save); saveRef.current = save;
  const G = useRef({ w: null, fx: makeFx(), view: { cx: W / 2, cy: H / 2, dt: 0.016, cw: 800, ch: 600, zoom: 1 }, mode: 'menu', host: true, net: null, outbox: [], acc: 0, last: 0,
    keys: {}, joy: { x: 0, y: 0, id: null, ox: 0, oy: 0 }, act: { pulse: 0, dash: 0, emote: 0 }, sent: { mx: 0, my: 0, t: 0 }, hudT: 0, synced: false, snapAt: 0, lastRound: 0, ros: [], countT: 0, humans: 1, stopped: false }).current;

  const me = () => ({ id: save.id, name: save.name, color: save.color, hat: save.hat });
  const patchSave = (p) => setSave((s) => { const n = { ...s, ...p }; storeSave(n); return n; });

  // ---------- starting / stopping ----------
  const stopNet = () => { if (G.net) { G.net.leave(); G.net = null; } };
  const startSolo = () => {
    stopNet(); audio.unlock(); audio.setMuted(save.mute); audio.startMusic();
    const w = createWorld((Math.random() * 1e9) | 0); humanJoin(w, me()); G.w = w; G.mode = 'solo'; G.host = true; G.synced = true; G.lastRound = w.round; G.humans = 1;
    setStatus(''); setScreen('play');
  };
  const startOnline = async () => {
    audio.unlock(); audio.setMuted(save.mute); audio.startMusic(); setStatus('Finding a room…'); stopNet();
    const m = me(); G.mode = 'online'; G.synced = false; G.w = null;
    const handlers = {
      onHost: (isHost) => {
        const was = G.host; G.host = isHost;
        if (isHost) {
          if (!G.w) { G.w = createWorld((Math.random() * 1e9) | 0); humanJoin(G.w, m); G.synced = true; G.lastRound = G.w.round; }
          else { G.w.ev = []; if (!G.w.players.some((p) => p.id === m.id)) humanJoin(G.w, m); }
          G.net && G.net.send('ros', roster(G.w));
          if (!was && G.synced) showToast && showToast('You are now running the room');
        }
      },
      onJoin: (u) => { if (G.host && G.w && String(u.id) !== String(m.id)) { humanJoin(G.w, u); G.net && G.net.send('ros', roster(G.w)); } },
      onLeave: (id) => { if (G.host && G.w) { humanLeave(G.w, id); G.net && G.net.send('ros', roster(G.w)); } },
      onCount: (n) => { G.humans = n; },
      onInput: (p) => { if (G.host && G.w && p) setInput(G.w, p.id, p); },
      onRoster: (r) => { G.ros = r; },
      onSnap: (s) => { if (!G.host) clientSnap(s); },
      onDisconnect: () => { showToast && showToast('Lost connection — switching to solo'); G.host = true; G.mode = 'solo'; if (!G.w) { G.w = createWorld(1); humanJoin(G.w, m); } },
    };
    let room = null;
    try { room = await joinRoom(supabase, m, handlers); } catch { room = null; }
    if (!room) { showToast && showToast('Could not find an online room — starting solo with bots'); startSolo(); return; }
    G.net = room; setStatus(''); setScreen('play');
    if (G.host && G.w) room.send('ros', roster(G.w));
  };
  function clientSnap(s) {
    if (!G.w) { G.w = createWorld(1); }
    const w = G.w, id = saveRef.current.id;
    const prev = new Map(w.players.map((p) => [p.id, { x: p.x, y: p.y }]));
    applySnapshot(w, s, G.ros);
    for (const p of w.players) {
      const o = prev.get(p.id); p.ax = p.x; p.ay = p.y;
      if (o && Math.hypot(o.x - p.x, o.y - p.y) < 160) {
        if (p.id === id) { if (p.stun <= 0) { const k = Math.hypot(o.x - p.x, o.y - p.y) < 90 ? 0.25 : 1; p.x = o.x + (p.x - o.x) * k; p.y = o.y + (p.y - o.y) * k; } }
        else { p.x = o.x; p.y = o.y; }
      }
    }
    G.snapAt = performance.now(); G.synced = true;
    feed(G.fx, s.e || [], id, audio.sfx, w);
  }
  const leave = () => {
    G.stopped = true; stopNet(); audio.stopMusic();
    try { if (/^\/(glowveld|vediogame)/i.test(window.location.pathname)) window.history.pushState({}, '', '/'); } catch { /* */ }
    onBack && onBack();
  };
  const toMenu = () => { stopNet(); G.w = null; G.mode = 'menu'; G.synced = false; setHud(null); setScreen('menu'); };

  // ---------- main loops ----------
  useEffect(() => {
    const canvas = cvs.current, ctx = canvas.getContext('2d');
    // demo world behind the menu: bots playing by themselves
    G.demo = createWorld((Math.random() * 1e9) | 0);
    const resize = () => {
      const r = wrap.current.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(r.width * dpr); canvas.height = Math.floor(r.height * dpr); G.dpr = dpr; G.view.cw = canvas.width; G.view.ch = canvas.height;
    };
    resize(); window.addEventListener('resize', resize);

    const readInput = () => {
      const k = G.keys; let mx = (k.ArrowRight || k.d || k.D ? 1 : 0) - (k.ArrowLeft || k.a || k.A ? 1 : 0), my = (k.ArrowDown || k.s || k.S ? 1 : 0) - (k.ArrowUp || k.w || k.W ? 1 : 0);
      if (!mx && !my) { mx = G.joy.x; my = G.joy.y; }
      return { mx, my };
    };
    const tick = () => {
      const now = performance.now(); let dt = (now - (G.last || now)) / 1000; G.last = now; dt = Math.min(dt, 0.25);
      const playing = G.mode !== 'menu' && G.w;
      const w = playing ? G.w : G.demo, id = saveRef.current.id;
      if (playing) {
        const inp = readInput(); const a = G.act; const mw = w.players.find((p) => p.id === id);
        if (G.host) {
          if (mw) setInput(w, id, { ...inp, pulse: a.pulse, dash: a.dash, emote: a.emote });
          a.pulse = a.dash = a.emote = 0;
          G.acc += dt;
          while (G.acc >= DT) { step(w, DT); G.acc -= DT; const ev = w.ev.splice(0); if (ev.length) { feed(G.fx, ev, id, audio.sfx, w); G.outbox.push(...ev); } G.tick = (G.tick || 0) + 1;
            if (G.net && G.tick % 4 === 0) { const s = snapshot(w); s.e = G.outbox.splice(0); G.net.send('snap', s); }
            if (G.net && G.tick % 90 === 0) G.net.send('ros', roster(w)); }
        } else {
          // client: send controls (throttled), predict our own movement, glide everyone else toward the latest snapshot
          const sg = G.sent; const changed = Math.abs(inp.mx - sg.mx) > 0.12 || Math.abs(inp.my - sg.my) > 0.12;
          if (G.net && (a.pulse || a.dash || a.emote || (changed && now - sg.t > 90) || ((inp.mx || inp.my) && now - sg.t > 140))) {
            G.net.send('inp', { id, mx: inp.mx, my: inp.my, pulse: a.pulse, dash: a.dash, emote: a.emote }); sg.mx = inp.mx; sg.my = inp.my; sg.t = now;
          }
          if (mw) { mw.inp = { mx: inp.mx, my: inp.my, pulse: 0, dash: 0 }; if (a.dash && mw.dcd <= 0 && mw.stun <= 0) { mw.dash = 0.22; mw.dcd = 3.4; } mw.stun = Math.max(0, mw.stun - dt); mw.dash = Math.max(0, mw.dash - dt); mw.dcd = Math.max(0, mw.dcd - dt); mw.pcd = Math.max(0, mw.pcd - dt); movePlayer(mw, dt); }
          if (a.pulse && mw && mw.pcd <= 0 && mw.stun <= 0) mw.pcd = 2.2;
          a.pulse = a.dash = a.emote = 0;
          const since = Math.min(0.3, (now - G.snapAt) / 1000);
          for (const p of w.players) if (p.id !== id && p.ax !== undefined) { const tx = p.ax + p.vx * since, ty = p.ay + p.vy * since; const k = Math.min(1, dt * 14); p.x += (tx - p.x) * k; p.y += (ty - p.y) * k; }
          for (const g of w.grem) { g.x += g.vx * dt; g.y += g.vy * dt; }
        }
      } else { G.acc += dt; while (G.acc >= DT) { step(w, DT); G.acc -= DT; const ev = w.ev.splice(0); void ev; } }
      // HUD + progress at ~6 Hz
      if (playing && now - G.hudT > 160) {
        G.hudT = now; const mw = w.players.find((p) => p.id === id);
        const board = [...w.players].sort((x, y) => y.score - x.score); const rank = mw ? board.indexOf(mw) + 1 : 0;
        setHud({ left: w.left, round: w.round, phase: w.phase, over: w.over, score: mw ? mw.score : 0, carry: mw ? mw.carry : 0, rank, pcd: mw ? mw.pcd : 0, dcd: mw ? mw.dcd : 0, shield: mw ? mw.shield : 0, speed: mw ? mw.speed : 0, magnet: mw ? mw.magnet : 0, dark: w.dark, humans: G.mode === 'online' ? G.humans : 1,
          online: G.mode === 'online', synced: G.synced && !!mw, host: G.host, stuns: mw ? mw.stuns : 0, best: mw ? mw.bankedMax : 0,
          board: board.slice(0, 5).map((p) => ({ id: p.id, name: p.name, score: p.score, bot: p.bot, color: p.color })), result: w.phase === 'over' ? w.result.slice(0, 5).map((pid) => { const p = w.players.find((q) => q.id === pid); return p ? { id: p.id, name: p.name, score: p.score, bot: p.bot, color: p.color } : null; }).filter(Boolean) : [] });
        audio.setMood(w.left <= GOLDEN_HOUR ? 2 : w.dark ? 1 : 0);
        if (mw && w.round !== G.lastRound) { G.lastRound = w.round; }
        if (w.phase === 'over' && G.countedRound !== w.round && mw) {
          G.countedRound = w.round; const won = board[0] === mw; const s0 = saveRef.current;
          const next = { ...s0, total: s0.total + mw.score, rounds: s0.rounds + 1, wins: s0.wins + (won ? 1 : 0), best: Math.max(s0.best, mw.score) };
          setSave(next); storeSave(next);
          const newHats = HAT_UNLOCK.map((u, i) => (u > s0.total && u <= next.total ? i : -1)).filter((i) => i >= 0);
          if (newHats.length && showToast) showToast('New hat unlocked: ' + newHats.map((i) => HAT_ICON[i]).join(' '));
        }
      }
    };
    const interval = setInterval(tick, 1000 / 30);   // an interval (not rAF) so a room host keeps simulating in a background tab
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame); const playing = G.mode !== 'menu' && G.w; const w = playing ? G.w : G.demo;
      G.view.dt = 1 / 60; updateFx(G.fx, 1 / 60);
      G.view.zoom = playing ? 1 : 0.62; if (!playing) { G.view.cx = W / 2 + Math.sin(G.fx.tm * 0.15) * 160; G.view.cy = H / 2 + Math.cos(G.fx.tm * 0.11) * 90; }
      draw(ctx, w, G.view, G.fx, playing ? saveRef.current.id : null);
      if (G.fx.banner) { const b = G.fx.banner, a = Math.min(1, b.life / 0.4, (b.max - b.life) / 0.2 + 0.2); const cw = G.view.cw, ch = G.view.ch;
        ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.lineJoin = 'round'; const fs = Math.max(26, Math.min(cw / 14, 64)); ctx.font = `900 ${fs}px system-ui,sans-serif`; ctx.lineWidth = fs / 6; ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.strokeText(b.t, cw / 2, ch * 0.3); ctx.fillStyle = b.col; ctx.fillText(b.t, cw / 2, ch * 0.3);
        if (b.sub) { ctx.font = `800 ${fs * 0.42}px system-ui,sans-serif`; ctx.lineWidth = fs / 12; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.strokeText(b.sub, cw / 2, ch * 0.3 + fs * 0.7); ctx.fillStyle = '#fff'; ctx.fillText(b.sub, cw / 2, ch * 0.3 + fs * 0.7); } ctx.restore(); }
    };
    frame();

    const kd = (e) => {
      if (G.mode === 'menu') return; const k = e.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault();
      if (!G.keys[k]) { if (k === ' ' || k === 'z' || k === 'Z') G.act.pulse = 1; if (k === 'Shift' || k === 'x' || k === 'X') G.act.dash = 1; if (/^[1-5]$/.test(k)) G.act.emote = +k; }
      G.keys[k] = true; audio.unlock();
    };
    const ku = (e) => { G.keys[e.key] = false; };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', ku);
    return () => { clearInterval(interval); cancelAnimationFrame(raf); window.removeEventListener('resize', resize); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); stopNet(); audio.stopMusic(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- touch joystick ----------
  const jd = (e) => {
    if (G.mode === 'menu' || G.joy.id !== null) return; if (e.target.dataset.btn) return;
    const r = wrap.current.getBoundingClientRect(); if (e.clientX - r.left > r.width * 0.62) return;
    G.joy.id = e.pointerId; G.joy.ox = e.clientX; G.joy.oy = e.clientY; audio.unlock();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
    if (joyBase.current) { joyBase.current.style.opacity = 1; joyBase.current.style.left = (e.clientX - r.left - 55) + 'px'; joyBase.current.style.top = (e.clientY - r.top - 55) + 'px'; joyKnob.current.style.transform = 'translate(0px,0px)'; }
  };
  const jm = (e) => {
    if (e.pointerId !== G.joy.id) return; let dx = e.clientX - G.joy.ox, dy = e.clientY - G.joy.oy; const d = Math.hypot(dx, dy), R = 55;
    if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; } G.joy.x = Math.abs(dx) < 8 && Math.abs(dy) < 8 ? 0 : dx / R; G.joy.y = Math.abs(dx) < 8 && Math.abs(dy) < 8 ? 0 : dy / R;
    if (joyKnob.current) joyKnob.current.style.transform = `translate(${dx}px,${dy}px)`;
  };
  const ju = (e) => { if (e.pointerId !== G.joy.id) return; G.joy.id = null; G.joy.x = G.joy.y = 0; if (joyBase.current) joyBase.current.style.opacity = 0; };
  const act = (k) => (e) => { e.preventDefault(); e.stopPropagation(); audio.unlock(); if (k === 'emote') setEmoteOpen((o) => !o); else G.act[k] = 1; };
  const doEmote = (n) => (e) => { e.preventDefault(); e.stopPropagation(); G.act.emote = n; setEmoteOpen(false); };

  // ---------- UI pieces ----------
  const unlocked = (i) => save.total >= HAT_UNLOCK[i];
  const level = Math.floor(Math.sqrt(save.total / 25)) + 1;
  const fullscreen = { position: 'fixed', inset: 0, zIndex: 9000, background: '#12204a', fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none', overflow: 'hidden' };

  const menu = h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, overflowY: 'auto' } },
    h('div', { style: { ...panel, maxWidth: 440, width: '100%', textAlign: 'center' } },
      h('div', { style: { fontSize: 44, fontWeight: 900, letterSpacing: 1, color: '#ffe27a', textShadow: '0 4px 0 rgba(0,0,0,0.3)' } }, 'GLOWVELD'),
      h('div', { style: { opacity: 0.85, marginBottom: 12, fontWeight: 600 } }, 'Grab the Sparks. Light up Kasi. Out-sparkle everyone!'),
      h('div', { style: { display: 'flex', gap: 10, justifyContent: 'center', alignItems: 'center', marginBottom: 10 } },
        h('canvas', { width: 96, height: 96, ref: (c) => { if (!c) return; const g = c.getContext('2d'); g.clearRect(0, 0, 96, 96); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, 0, 96, 96); drawPlayer(g, { id: 1, name: '', x: 48, y: 56, vx: 0, vy: 0, a: 0.4, color: save.color, hat: save.hat, carry: 0, stun: 0, shield: 0, speed: 0, grace: 0, emT: 0, emote: 0 }, 0, false, 1.6); }, style: { borderRadius: 18 } }),
        h('div', { style: { textAlign: 'left' } },
          h('div', { style: { fontSize: 22, fontWeight: 800 } }, save.name),
          h('div', { style: { opacity: 0.8, fontSize: 14 } }, 'Level ' + level + ' • ' + save.total + ' sparks banked'),
          h('button', { onClick: () => patchSave({ name: randName() }), style: { ...btn('#3b4a8a'), padding: '6px 12px', fontSize: 14, marginTop: 6, boxShadow: 'none' } }, '🎲 New name'))),
      h('div', { style: { display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 8 } },
        COLORS.map((c, i) => h('button', { key: i, onClick: () => patchSave({ color: i }), 'aria-label': 'colour ' + (i + 1), style: { width: 32, height: 32, borderRadius: 16, background: c, border: save.color === i ? '4px solid #fff' : '3px solid rgba(0,0,0,0.25)', cursor: 'pointer' } }))),
      h('div', { style: { display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 14 } },
        HAT_ICON.map((ic, i) => h('button', { key: i, disabled: !unlocked(i), onClick: () => patchSave({ hat: i }), title: unlocked(i) ? '' : 'Bank ' + HAT_UNLOCK[i] + ' sparks to unlock', style: { width: 42, height: 38, borderRadius: 12, fontSize: 20, background: save.hat === i ? '#ffe27a' : '#2b3a78', color: save.hat === i ? '#222' : '#fff', border: 'none', opacity: unlocked(i) ? 1 : 0.45, cursor: unlocked(i) ? 'pointer' : 'not-allowed' } }, unlocked(i) ? ic : '🔒'))),
      h('button', { onClick: startSolo, style: { ...btn('#2fc46b'), width: '100%', fontSize: 22, marginBottom: 10 } }, '▶  Play now'),
      h('button', { onClick: startOnline, disabled: !!status, style: { ...btn('#3a7bff'), width: '100%', marginBottom: 10, opacity: status ? 0.7 : 1 } }, status || '🌍  Play online with others'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { onClick: () => setHow(true), style: { ...btn('#7a5cff'), flex: 1, padding: '10px 8px', fontSize: 15 } }, '❓ How to play'),
        h('button', { onClick: () => { const m = !save.mute; patchSave({ mute: m }); audio.setMuted(m); }, style: { ...btn('#4a5580'), flex: 1, padding: '10px 8px', fontSize: 15 } }, save.mute ? '🔇 Sound off' : '🔊 Sound on'),
        h('button', { onClick: leave, style: { ...btn('#6b3b4a'), flex: 1, padding: '10px 8px', fontSize: 15 } }, '← Back')),
      h('div', { style: { opacity: 0.7, fontSize: 12, marginTop: 10 } }, 'Rounds played: ' + save.rounds + ' • Wins: ' + save.wins + ' • Best round: ' + save.best)));

  const howOverlay = how && h('div', { style: { position: 'absolute', inset: 0, background: 'rgba(8,12,36,0.78)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, zIndex: 5, overflowY: 'auto' } },
    h('div', { style: { ...panel, maxWidth: 460, width: '100%', background: 'rgba(30,40,88,0.97)' } },
      h('div', { style: { fontSize: 26, fontWeight: 900, color: '#ffe27a', marginBottom: 10 } }, 'How to play'),
      [['✨', 'Run around and grab glowing Sparks.'], ['🏆', 'Carry them to the big Beacon in the middle to bank them. Banked sparks are your score!'],
        ['⚡', 'Zap pulse knocks nearby rivals dizzy — they drop their sparks. Nobody gets hurt!'], ['🌑', 'Blackout! One part of town goes dark. Sparks turn golden (worth 3) but cheeky Gremlins come to nick them.'],
        ['🎁', 'Bubbles, Zoom shoes, Magnets and Cash-in bolts appear — grab them!'], ['🔥', 'Final 20 seconds is Golden Hour: everything you bank counts double.']]
        .map(([ic, t], i) => h('div', { key: i, style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 9, fontSize: 16, fontWeight: 600 } }, h('div', { style: { fontSize: 28 } }, ic), h('div', null, t))),
      h('div', { style: { fontSize: 14, opacity: 0.85, margin: '8px 0 12px' } }, 'Move: WASD / arrows or the left side of the screen. Zap: Space or ⚡ button. Dash: Shift or 💨 button. Emotes: 1–5.'),
      h('button', { onClick: () => { setHow(false); if (!save.seen) patchSave({ seen: true }); }, style: { ...btn('#2fc46b'), width: '100%' } }, 'Got it — let\'s play!')));

  const sec = (v) => (v > 0 ? Math.ceil(v) : 0);
  const playUI = screen === 'play' && h('div', { style: { position: 'absolute', inset: 0, pointerEvents: 'none' } },
    // top bar
    h('div', { style: { position: 'absolute', top: 8, left: 8, right: 8, display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { ...panel, padding: '6px 14px', fontSize: 26, fontWeight: 900, minWidth: 92, textAlign: 'center', color: hud && hud.left <= GOLDEN_HOUR && hud.phase === 'play' ? '#ffcf5a' : '#fff' } }, hud ? fmt(hud.left) : '–:––'),
        hud && hud.left <= GOLDEN_HOUR && hud.phase === 'play' ? h('div', { style: { ...panel, padding: '3px 10px', background: '#c97a00', fontWeight: 800, fontSize: 13, textAlign: 'center' } }, '🔥 GOLDEN HOUR ×2') : null,
        hud && hud.dark ? h('div', { style: { ...panel, padding: '3px 10px', background: 'rgba(60,40,120,0.9)', fontWeight: 800, fontSize: 13, textAlign: 'center' } }, '🌑 Blackout ' + sec(hud.dark.t) + 's') : null),
      h('div', { style: { ...panel, padding: '8px 12px', minWidth: 150, fontSize: 14 } },
        h('div', { style: { fontWeight: 800, opacity: 0.8, marginBottom: 3 } }, hud ? 'Round ' + hud.round + (hud.online ? ' • 🌍 ' + hud.humans + ' online' : '') : ''),
        hud && hud.board.map((p, i) => h('div', { key: p.id, style: { display: 'flex', justifyContent: 'space-between', gap: 10, fontWeight: p.id === save.id ? 900 : 600, color: p.id === save.id ? '#ffe27a' : '#fff' } },
          h('span', null, (i + 1) + '. ' + (p.bot ? '' : '👤 ') + p.name.slice(0, 11)), h('span', null, p.score)))),
      h('div', { style: { display: 'flex', gap: 6, pointerEvents: 'auto' } },
        h('button', { onClick: () => { const m = !save.mute; patchSave({ mute: m }); audio.setMuted(m); }, style: { ...btn('#3a4580'), padding: '8px 12px', fontSize: 18 }, 'aria-label': 'sound' }, save.mute ? '🔇' : '🔊'),
        h('button', { onClick: toMenu, style: { ...btn('#7a3b4a'), padding: '8px 12px', fontSize: 18 }, 'aria-label': 'leave game' }, '✕'))),
    // my status
    hud && h('div', { style: { position: 'absolute', left: 10, bottom: 12, ...panel, padding: '8px 14px', fontWeight: 800, display: 'flex', gap: 14, alignItems: 'center' } },
      h('div', null, '✨ ' + hud.carry + '/24'), h('div', { style: { color: '#ffe27a' } }, '🏆 ' + hud.score), h('div', { style: { opacity: 0.8 } }, '#' + hud.rank),
      hud.shield > 0 ? h('div', null, '🫧') : null, hud.speed > 0 ? h('div', null, '👟') : null, hud.magnet > 0 ? h('div', null, '🧲') : null),
    hud && !hud.synced && h('div', { style: { position: 'absolute', top: '45%', left: 0, right: 0, textAlign: 'center', color: '#fff', fontWeight: 800, fontSize: 22, textShadow: '0 2px 6px #000' } }, 'Joining the game…'),
    // joystick visuals
    h('div', { ref: joyBase, style: { position: 'absolute', width: 110, height: 110, borderRadius: 55, background: 'rgba(255,255,255,0.18)', border: '3px solid rgba(255,255,255,0.45)', opacity: 0, transition: 'opacity .1s' } },
      h('div', { ref: joyKnob, style: { position: 'absolute', left: 30, top: 30, width: 50, height: 50, borderRadius: 25, background: 'rgba(255,255,255,0.7)' } })),
    // action buttons
    h('div', { style: { position: 'absolute', right: 12, bottom: 14, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10, pointerEvents: 'auto' } },
      emoteOpen && h('div', { style: { display: 'flex', gap: 6, ...panel, padding: 6 } }, EMOTES.map((e, i) => h('button', { key: i, 'data-btn': 1, onPointerDown: doEmote(i + 1), style: { fontSize: 26, background: 'transparent', border: 'none', cursor: 'pointer' } }, e))),
      h('div', { style: { display: 'flex', gap: 12, alignItems: 'flex-end' } },
        h('button', { 'data-btn': 1, onPointerDown: act('emote'), style: { ...btn('#4a5580'), width: 50, height: 50, borderRadius: 25, padding: 0, fontSize: 24 }, 'aria-label': 'emotes' }, '😀'),
        h('button', { 'data-btn': 1, onPointerDown: act('dash'), style: { ...btn(hud && hud.dcd > 0 ? '#566' : '#3aa0ff'), width: 66, height: 66, borderRadius: 33, padding: 0, fontSize: 28, opacity: hud && hud.dcd > 0 ? 0.6 : 1 }, 'aria-label': 'dash' }, hud && hud.dcd > 0 ? Math.ceil(hud.dcd) : '💨'),
        h('button', { 'data-btn': 1, onPointerDown: act('pulse'), style: { ...btn(hud && hud.pcd > 0 ? '#665' : '#ffb020'), width: 88, height: 88, borderRadius: 44, padding: 0, fontSize: 38, opacity: hud && hud.pcd > 0 ? 0.6 : 1 }, 'aria-label': 'zap' }, hud && hud.pcd > 0 ? Math.ceil(hud.pcd) : '⚡'))),
    // end-of-round results
    hud && hud.phase === 'over' && h('div', { style: { position: 'absolute', inset: 0, background: 'rgba(10,14,40,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 } },
      h('div', { style: { ...panel, width: 340, maxWidth: '100%', textAlign: 'center', pointerEvents: 'auto' } },
        h('div', { style: { fontSize: 30, fontWeight: 900, color: '#ffe27a' } }, hud.rank === 1 ? '🏆 You won!' : hud.rank <= 3 ? '🎉 Top 3!' : 'Round over'),
        h('div', { style: { opacity: 0.85, margin: '2px 0 10px', fontWeight: 700 } }, 'You banked ' + hud.score + ' • Rank #' + hud.rank),
        hud.result.map((p, i) => h('div', { key: p.id, style: { display: 'flex', justifyContent: 'space-between', padding: '5px 10px', borderRadius: 10, marginBottom: 4, background: p.id === save.id ? 'rgba(255,226,122,0.25)' : 'rgba(255,255,255,0.08)', fontWeight: 800 } },
          h('span', null, ['🥇', '🥈', '🥉', '4.', '5.'][i] + ' ' + (p.bot ? '' : '👤 ') + p.name), h('span', null, p.score))),
        h('div', { style: { fontSize: 13, opacity: 0.8, marginTop: 8 } }, 'Zaps landed: ' + hud.stuns + ' • Biggest bank: ' + hud.best),
        h('div', { style: { fontWeight: 800, marginTop: 8 } }, 'Next round in ' + Math.max(0, Math.ceil(OVER_SECONDS - hud.over)) + 's'))));

  return h('div', { ref: wrap, style: fullscreen, onPointerDown: jd, onPointerMove: jm, onPointerUp: ju, onPointerCancel: ju },
    h('canvas', { ref: cvs, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' } }),
    screen === 'menu' ? menu : null, playUI, howOverlay);
}
