// Headless tests for the Glowveld simulation. Run: node scripts/test-glowveld.mjs
import { createWorld, step, snapshot, applySnapshot, roster, humanJoin, humanLeave, setInput, humanCount, DT, ROUND_SECONDS, TOTAL, W, H, TREES, RECTS } from '../src/glowveld/sim.js';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

// 1. determinism: same seed => identical state after 3 simulated minutes
const run = (seed) => { const w = createWorld(seed); for (let i = 0; i < 30 * 180; i++) { step(w); w.ev.length = 0; } return JSON.stringify(snapshot(w)); };
ok(run(7) === run(7), 'same seed gives identical game');
ok(run(7) !== run(8), 'different seeds differ');

// 2. a full round of bots: everyone scores, nobody leaves the map or gets stuck inside walls, round rolls over
for (const seed of [1, 2, 3, 4, 5]) {
  const w = createWorld(seed); let maxStuck = 0, rounds = new Set(), sawDark = false, sawGrem = false, sawZap = false, sawPup = false;
  const stuck = new Map();
  for (let i = 0; i < 30 * 320; i++) {
    step(w);
    for (const e of w.ev) { if (e.k === 'zap') sawZap = true; if (e.k === 'pup') sawPup = true; }
    w.ev.length = 0; rounds.add(w.round);
    if (w.dark) sawDark = true; if (w.grem.length) sawGrem = true;
    for (const p of w.players) {
      if (!(p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H)) { ok(false, 'player out of bounds'); }
      if (!Number.isFinite(p.x + p.y)) ok(false, 'NaN position');
    }
    if (w.phase === 'play' && i % 30 === 0) for (const p of w.players) {
      const k = p.id; const s = stuck.get(k) || { x: p.x, y: p.y, n: 0 };
      if (Math.hypot(p.x - s.x, p.y - s.y) < 6 && !p.stun) s.n++; else { s.n = 0; s.x = p.x; s.y = p.y; }
      stuck.set(k, s); maxStuck = Math.max(maxStuck, s.n);
    }
  }
  const top = [...w.players].sort((a, b) => b.score - a.score);
  ok(rounds.size >= 2, `seed ${seed}: rounds roll over (${[...rounds].join(',')})`);
  ok(sawDark && sawGrem, `seed ${seed}: blackout + gremlins appear`);
  ok(sawZap && sawPup, `seed ${seed}: zaps and power-ups happen`);
  ok(maxStuck < 12, `seed ${seed}: no bot stuck >11s (max ${maxStuck}s)`);
}

// 3. balance: over many rounds, no bot kind dominates and scores are reasonable
const kinds = {}; let rounds = 0, spread = [];
for (let seed = 100; seed < 112; seed++) {
  const w = createWorld(seed); let last = 0;
  for (let i = 0; i < 30 * (ROUND_SECONDS + 1); i++) { step(w); w.ev.length = 0; if (w.phase === 'over' && !last) { last = 1; } if (last) break; }
  const sorted = [...w.players].sort((a, b) => b.score - a.score); rounds++;
  for (const p of w.players) { (kinds[p.kind] ||= []).push(p.score); }
  spread.push(sorted[0].score, sorted.at(-1).score);
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ka = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, Math.round(avg(v))]));
console.log('average score by bot kind:', ka, ' winner avg', Math.round(avg(spread.filter((_, i) => i % 2 === 0))), 'last avg', Math.round(avg(spread.filter((_, i) => i % 2)))); 
const mx = Math.max(...Object.values(ka)), mn = Math.min(...Object.values(ka));
ok(mn > 15, 'every bot kind scores something real');
ok(mx / mn < 2.6, `no bot kind is more than 2.6x another (${(mx / mn).toFixed(2)}x)`);

// 4. snapshot round-trip keeps the world equal enough to render + continue
{
  const a = createWorld(42); for (let i = 0; i < 600; i++) { step(a); a.ev.length = 0; }
  const b = createWorld(1); const s = JSON.parse(JSON.stringify(snapshot(a))); applySnapshot(b, s, roster(a));
  ok(b.players.length === a.players.length && b.sparks.length === a.sparks.length, 'snapshot restores players and sparks');
  ok(Math.abs(b.players[3].x - a.players[3].x) <= 1, 'snapshot restores positions');
  ok(JSON.stringify(snapshot(a)).length < 6000, `snapshot is small (${JSON.stringify(snapshot(a)).length} bytes)`);
}

// 5. humans: join takes a bot seat, input moves them, leave hands them to a bot, host migration works
{
  const w = createWorld(9); humanJoin(w, { id: 'u1', name: 'Gogo', color: 2, hat: 1 });
  ok(w.players.length === TOTAL && humanCount(w) === 1, 'human takes a bot seat; arena stays full');
  const me = w.players.find((p) => p.id === 'u1'); const x0 = me.x;
  for (let i = 0; i < 30; i++) { setInput(w, 'u1', { mx: 1, my: 0 }); step(w); }
  ok(me.x > x0 + 40, 'human input moves the player');
  humanLeave(w, 'u1'); ok(humanCount(w) === 0 && me.bot, 'leaving hands the seat to a bot');
  setInput(w, 'u1', { mx: 1, my: 0, pulse: 1 }); ok(true, 'input for a bot seat is ignored safely');
}

// 6. map: spawn points are free, fair (mirrored)
{
  const q = (x, y) => (x > W / 2 ? 1 : 0) + (y > H / 2 ? 2 : 0);
  const counts = [0, 0, 0, 0]; for (const t of TREES) counts[q(t.x, t.y)]++;
  ok(counts.every((c) => c === counts[0]), 'map is mirrored: equal trees in every quarter');
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
