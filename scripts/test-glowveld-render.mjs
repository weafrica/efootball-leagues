// Smoke-tests the canvas renderer without a browser: every draw call goes to a recording stub,
// so this catches typos / undefined variables / crashes in any game state.
const grad = { addColorStop() {} };
let calls = 0;
const ctx = new Proxy({}, { get: (t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient' ? () => { calls++; return grad; } : (k in t ? t[k] : (...a) => { calls++; })), set: (t, k, v) => { t[k] = v; return true; } });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { createWorld, step, humanJoin, setInput, rollRing, DT, W, H, BEACON } = await import('../src/glowveld/sim.js');
const { draw, makeFx, feed, updateFx, drawPlayer, drawMarker } = await import('../src/glowveld/render.js');
const { createTutorial, tutUpdate, tutInfo, tutNext, STEP_COUNT } = await import('../src/glowveld/tutorial.js');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const snd = new Proxy({}, { get: () => () => {} });
const view = () => ({ cx: W / 2, cy: H / 2, dt: 1 / 60, cw: 800, ch: 600, zoom: 1 });

function frames(w, fx, v, meId, n = 20) { for (let i = 0; i < n; i++) { updateFx(fx, 1 / 60); draw(ctx, w, v, fx, meId); } }
try {
  const w = createWorld(11); humanJoin(w, { id: 'me', name: 'Me', color: 3, hat: 2 }); const fx = makeFx(), v = view();
  for (let i = 0; i < 30 * 70; i++) { setInput(w, 'me', { mx: Math.sin(i / 40), my: Math.cos(i / 55), pulse: i % 90 === 0 ? 1 : 0, dash: i % 200 === 0 ? 1 : 0, emote: i === 100 ? 2 : 0 }); step(w, DT); feed(fx, w.ev.splice(0), 'me', snd, w); if (i % 20 === 0) frames(w, fx, v, 'me', 1); }
  ok(true, 'drew 70 simulated seconds of a live round (bots, zaps, dice, boots, power-ups)');
  w.dark = { q: 1, t: 12, stage: 3 }; frames(w, fx, v, 'me', 10); ok(true, 'blackout overlay draws');
  const me = w.players.find((p) => p.id === 'me'); me.stun = 1; me.shield = 3; me.speed = 3; me.carry = 9; me.emT = 2; me.emote = 3; frames(w, fx, v, 'me', 10); ok(true, 'stunned / shielded / carrying / emote states draw');
  rollRing(w, me, 3); feed(fx, w.ev.splice(0), 'me', snd, w); frames(w, fx, v, 'me', 40); ok(true, 'dice popups and ring hops draw');
  v.cw = 360; v.ch = 700; frames(w, fx, v, 'me', 5); v.cw = 1600; v.ch = 900; frames(w, fx, v, 'me', 5); ok(true, 'phone-portrait and wide-desktop viewports draw');
  frames(w, fx, v, null, 5); ok(true, 'spectator view (no player) draws');
  for (let i = 0; i < 30 * 200; i++) step(w, DT); frames(w, fx, v, 'me', 5); ok(true, 'end-of-round state draws');
  drawPlayer(ctx, { id: 1, name: '', x: 48, y: 56, vx: 0, vy: 0, a: 0.4, color: 2, hat: 7, carry: 0, stun: 0, shield: 0, speed: 0, grace: 0, emT: 0, emote: 0 }, 0, false, 1.6); ok(true, 'menu avatar preview draws');
  const t = createTutorial({ id: 'me', name: 'T', color: 1, hat: 0 }), tf = makeFx(), tv = view();
  for (let i = 0; i < STEP_COUNT; i++) { for (let k = 0; k < 5; k++) { step(t.w, DT); tutUpdate(t, t.w.ev.splice(0), DT); } updateFx(tf, 1 / 60); draw(ctx, t.w, tv, tf, 'me'); const info = tutInfo(t, i % 2 === 0); if (info.target) drawMarker(ctx, tv, info.target.x, info.target.y, tf.tm); tutNext(t); }
  ok(true, 'every tutorial step draws, including the pointer marker');
  drawMarker(ctx, tv, 5, 5, 1); drawMarker(ctx, tv, W - 5, H - 5, 1); ok(true, 'off-screen pointer arrows draw');
} catch (e) { ok(false, 'renderer crashed: ' + (e && e.stack || e)); }
ok(calls > 5000, `lots of drawing happened (${calls} canvas calls)`);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
