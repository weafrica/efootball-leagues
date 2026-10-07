// Glowveld tutorial — a short guided practice round (pure logic, no DOM, so it is unit-tested in Node).
// Each step has: what to say, where to point, how to know the player did it, and any set-up it needs.
import { W, BEACON, quadOf, isBlocked, makeTutorialWorld, addDummy, addGremlin, addPowerup, putSpark } from './sim.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function open(x, y) {   // nearest free spot to (x,y): never inside a tree, hut or the Beacon
  for (let r = 0; r < 240; r += 20) for (let a = 0; a < 6.3; a += 0.8) {
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (px > 40 && px < W - 40 && py > 40 && py < 860 && !isBlocked(px, py, 22)) return { x: px, y: py };
  }
  return { x, y };
}
const nearestSpark = (t) => { let b = null, bd = 1e9; for (const s of t.w.sparks) { const d = dist(s, t.me); if (d < bd) { bd = d; b = s; } } return b ? { x: b.x, y: b.y } : null; };
const T0 = { x: 950, y: 520 };

export const STEPS = [
  { title: 'Move around', glow: null,
    text: (touch) => (touch ? 'Welcome to Glowveld! Press and hold on the LEFT side of the screen, then drag your thumb to move. Walk into the glowing ring.'
      : 'Welcome to Glowveld! Use W A S D or the arrow keys to move. Walk into the glowing ring.'),
    done: (t) => dist(t.me, T0) < 44, target: () => T0 },
  { title: 'Grab Sparks', glow: null,
    text: () => 'Those glowing stars are Sparks. Walk into 5 of them to pick them up. Watch the ✨ number at the bottom-left go up.',
    setup: (t) => { for (const [dx, dy] of [[-60, -50], [60, -50], [100, 20], [-20, 70], [-90, 20]]) { const q = open(T0.x + dx, T0.y + dy); putSpark(t.w, q.x, q.y, 1); } },
    done: (t) => t.me.carry >= 5, target: (t) => nearestSpark(t) },
  { title: 'Bank them at the Beacon', glow: null,
    text: () => 'Carry your Sparks to the big golden Beacon in the middle and walk into it. That banks them. Banked Sparks are your SCORE (🏆)! (You will also roll dice. More on that next!)',
    setup: (t) => { if (t.me.carry < 5) t.me.carry = 5; t.base = t.me.score; },
    done: (t) => t.me.score > t.base, target: () => ({ x: BEACON.x, y: BEACON.y }) },
  { title: 'Dice & the Ring Race', glow: null,
    text: () => 'Every time you bank, you ROLL TWO DICE 🎲 and your little runner hops that many steps round the ring road, just like Ludo! Land exactly on a rival\'s runner to BOOT them back to the start. A full lap is worth bonus points. Bank these 4 more Sparks and watch your runner hop!',
    setup: (t) => { t.me.carry = 4; },
    done: (t, ev) => ev.some((e) => e.k === 'roll' && e.p === t.me.id),
    target: (t) => (t.me.carry > 0 ? { x: BEACON.x, y: BEACON.y } : null) },
  { title: 'Zap a rival!', glow: 'pulse',
    text: (touch) => 'Meet Practice Pal. He is carrying 8 Sparks! Get close and ' + (touch ? 'tap the big ⚡ button' : 'press SPACE') + '. Zapping makes rivals dizzy so they drop their Sparks. Nobody ever gets hurt!',
    setup: (t) => { const q = open(430, 470); t.dummy = addDummy(t.w, 'Practice Pal', q.x, q.y, 8); t.zapped = false; },
    done: (t, ev) => { if (ev.some((e) => e.k === 'zap' && e.q === t.dummy.id)) { t.zapped = true; return true; } return false; },
    target: (t) => (t.dummy ? { x: t.dummy.x, y: t.dummy.y } : null) },
  { title: 'Steal them back!', glow: null,
    text: () => 'Pal dropped his Sparks! Grab them and bank them at the Beacon before anyone else does.',
    setup: (t) => { t.base = t.me.score; if (!t.zapped && t.dummy) { const q = open(t.dummy.x, t.dummy.y); for (let i = 0; i < 4; i++) { const o = open(q.x + (i - 1.5) * 26, q.y + 30); putSpark(t.w, o.x, o.y, 1); } } },
    done: (t) => t.me.score >= t.base + 4,
    exit: (t) => { t.w.players = t.w.players.filter((p) => !p.still); t.dummy = null; },
    target: (t) => (t.me.carry > 0 ? { x: BEACON.x, y: BEACON.y } : nearestSpark(t)) },
  { title: 'Dash!', glow: 'dash',
    text: (touch) => 'Need to get away fast? ' + (touch ? 'Tap the blue 💨 button' : 'Press SHIFT') + ' to dash forward. It needs a few seconds to recharge.',
    done: (t, ev) => ev.some((e) => e.k === 'dash' && e.p === t.me.id), target: () => null },
  { title: 'Power-ups', glow: null,
    text: () => 'Walk into the glowing bubble to grab a power-up. This one is a Bubble shield that blocks one zap. Others: Zoom shoes, a Magnet, and a Cash-in bolt that banks your Sparks from anywhere!',
    setup: (t) => { const q = open(560, 500); t.pup = addPowerup(t.w, q.x, q.y, 'shield'); },
    done: (t, ev) => ev.some((e) => e.k === 'pup' && e.p === t.me.id),
    exit: (t) => { t.w.pups = []; },
    target: (t) => (t.w.pups[0] ? { x: t.w.pups[0].x, y: t.w.pups[0].y } : null) },
  { title: 'Blackout!', glow: 'pulse',
    text: (touch) => 'Sometimes a part of town goes dark. Sparks turn GOLDEN (worth 3) but cheeky Gremlins sneak in to steal your Sparks. You are carrying 6 now. ' + (touch ? 'Tap ⚡' : 'Press SPACE') + ' near a Gremlin to poof it!',
    setup: (t) => {
      const w = t.w, me = t.me; if (me.carry < 6) me.carry = 6;
      w.dark = { q: quadOf(me.x, me.y), t: 9, stage: 1 };
      const sx = me.x < W - 320 ? 1 : -1;
      for (const [dx, dy] of [[90 * sx, -70], [140 * sx, 50], [60 * sx, 110]]) { const q = open(me.x + dx, me.y + dy); putSpark(w, q.x, q.y, 3); }
      const g = open(me.x + 230 * sx, me.y); addGremlin(w, g.x, g.y);
    },
    hold: (t) => { if (t.w.dark) t.w.dark.t = 9; t.w.nextGrem = 1e9; },
    done: (t, ev) => ev.some((e) => e.k === 'poof'),
    exit: (t) => { t.w.dark = null; t.w.grem = []; t.w.sparks = []; },
    target: (t) => (t.w.grem[0] ? { x: t.w.grem[0].x, y: t.w.grem[0].y } : null) },
  { title: "You're ready!", glow: null,
    text: () => 'A real round lasts 2½ minutes. In the last 20 seconds, Golden Hour, everything you bank counts DOUBLE. Out-sparkle the bots and other players. Have fun!',
    done: null, target: () => null },
];
export const STEP_COUNT = STEPS.length;

function enter(t, i) { t.i = i; t.ok = 0; t.t = 0; const s = STEPS[i]; if (s.setup) s.setup(t); }
export function createTutorial(meInfo) {
  const w = makeTutorialWorld(meInfo);
  const t = { w, me: w.players[0], i: 0, ok: 0, t: 0, base: 0, dummy: null, zapped: false, finished: false };
  enter(t, 0); return t;
}
// call once per simulation tick, with the events that tick produced. Returns 'ok' when a step is completed.
export function tutUpdate(t, ev, dt) {
  if (t.finished) return null;
  t.t += dt;
  const s = STEPS[t.i];
  if (s.hold) s.hold(t);
  if (t.ok > 0) { t.ok -= dt; if (t.ok <= 0) tutNext(t); return null; }
  if (s.done && s.done(t, ev)) { t.ok = 1.3; return 'ok'; }
  return null;
}
// move on (also used by the "Skip step" button). Returns true when the tutorial is finished.
export function tutNext(t) {
  const s = STEPS[t.i]; if (s.exit) s.exit(t);
  if (t.i >= STEPS.length - 1) { t.finished = true; return true; }
  enter(t, t.i + 1); return false;
}
export function tutInfo(t, touch) {
  const s = STEPS[t.i];
  return { i: t.i, n: STEPS.length, title: s.title, text: s.text(!!touch), ok: t.ok > 0, last: t.i === STEPS.length - 1, glow: s.glow, target: s.target ? s.target(t) : null, t: t.t };
}
