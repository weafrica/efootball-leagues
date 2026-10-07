// Plays the whole tutorial with a scripted "perfect" player and checks every step can be completed.
import { step, setInput, DT, W, H, BEACON, ROUND_SECONDS, RING_N, rollRing, ringCell, ringStart, isSafeCell, snapshot, applySnapshot, roster, createWorld, humanJoin } from '../src/glowveld/sim.js';
import { createTutorial, tutUpdate, tutNext, tutInfo, STEP_COUNT } from '../src/glowveld/tutorial.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

function play(skipAt = -1) {
  const t = createTutorial({ id: 'me', name: 'Tester', color: 2, hat: 0 }); const w = t.w, me = t.me; const log = []; let stepTicks = 0, lastI = 0, maxTicks = 0;
  for (let tick = 0; tick < 30 * 600 && !t.finished; tick++) {
    const info = tutInfo(t, false); let inp = { mx: 0, my: 0 };
    if (t.i !== lastI) { maxTicks = Math.max(maxTicks, stepTicks); stepTicks = 0; lastI = t.i; log.push(t.i); } stepTicks++;
    if (t.i === skipAt) { tutNext(t); continue; }
    const tg = info.target;
    if (tg && !info.ok) { const dx = tg.x - me.x, dy = tg.y - me.y, d = Math.hypot(dx, dy) || 1; inp = { mx: dx / d, my: dy / d }; if (d < 14) inp = { mx: 0, my: 0 }; }
    if (info.last && !info.ok) { tutNext(t); continue; }
    if (info.title === 'Zap a rival!' && t.dummy && Math.hypot(t.dummy.x - me.x, t.dummy.y - me.y) < 70) inp.pulse = 1;
    if (info.title === 'Dash!') inp.dash = 1;
    if (info.title === 'Blackout!' && w.grem[0] && Math.hypot(w.grem[0].x - me.x, w.grem[0].y - me.y) < 70) inp.pulse = 1;
    setInput(w, me.id, inp);
    step(w, DT); const ev = w.ev.splice(0); tutUpdate(t, ev, DT);
    if (w.left < ROUND_SECONDS - 1) { ok(false, 'tutorial clock must never run'); break; }
  }
  return { t, log, maxTicks };
}
{
  const { t, log, maxTicks } = play();
  ok(t.finished, 'tutorial can be completed start to finish');
  ok(log.length === STEP_COUNT - 1, `visited all ${STEP_COUNT} steps in order (${log.join(',')})`);
  ok(maxTicks / 30 < 60, `no single step takes over a minute (slowest ${(maxTicks / 30).toFixed(0)}s)`);
  ok(t.w.players.length === 1 && t.w.sparks.length === 0 && t.w.grem.length === 0 && !t.w.dark, 'practice dummy, gremlin and blackout are cleaned up at the end');
  ok(t.w.round === 1 && t.w.phase === 'play', 'round never ended during tutorial');
}
for (let i = 0; i < STEP_COUNT - 1; i++) { // "Skip step" at any point must never leave the next step impossible
  const { t } = play(i); ok(t.finished, `skipping step ${i + 1} still lets the tutorial finish`);
}
{
  const t = createTutorial({ id: 'me', name: 'T', color: 0, hat: 0 });
  for (let i = 0; i < STEP_COUNT; i++) { const info = tutInfo(t, i % 2 === 0); ok(info.title && info.text.length > 20, `step ${i + 1} has a title and text`); tutNext(t); }
}
// ---- ring race rules ----
{
  const w = createWorld(5); w.players.forEach((p) => { p.rs = 0; p.laps = 0; });
  let badSafe = 0, boots = 0, lapsOk = true;
  for (let i = 0; i < 4000; i++) {
    const p = w.players[i % w.players.length]; const before = p.rs, laps0 = p.laps; w.ev = [];
    rollRing(w, p, 1);
    for (const e of w.ev) if (e.k === 'roll') {
      if (e.a < 1 || e.a > 6 || e.b < 1 || e.b > 6) lapsOk = false;
      if (e.boot.length) { boots += e.boot.length; if (isSafeCell((ringStart(p) + e.to) % RING_N)) badSafe++; }
    }
    if (p.rs < 0 || p.rs >= RING_N) lapsOk = false;
  }
  ok(lapsOk, 'dice are 1-6 and runner position always stays on the ring');
  ok(badSafe === 0, 'nobody is ever booted on a safe start square');
  ok(boots > 20, `boots do happen (${boots} in 4000 rolls)`);
}
{
  const a = createWorld(3); for (let i = 0; i < 900; i++) { step(a); a.ev.length = 0; }
  const b = createWorld(1); applySnapshot(b, JSON.parse(JSON.stringify(snapshot(a))), roster(a));
  ok(a.players.every((p, i) => b.players[i].rs === p.rs && b.players[i].laps === p.laps && b.players[i].seat === p.seat), 'ring position, laps and seat survive a network snapshot');
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
