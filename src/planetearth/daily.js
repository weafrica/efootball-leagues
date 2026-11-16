// Planet Earth — the Daily Discovery: three quick questions that change every day (same for everyone on the same date),
// plus a streak counter. Pure JS (no DOM). One question is a real calculation (time zones or daylight hours); two come from a fact bank.
import { CITIES, clockTime, fmtTime, dayLength, declination, fmtDay } from './sky.js';

export const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function addDays(key, n) { const [y, m, d] = key.split('-').map(Number), x = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; }
export function dayOfYear(key) { const [y, m, d] = key.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000); }   // 0 = 1 January
const hashKey = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rng = (seed) => { let s = seed | 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
function shuffle(a, r) { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }

// ---- the fact bank: [topic, question, right answer, three wrong answers, why] ----
export const BANK = [
  ['spin', 'How long does Earth take to spin around once?', '24 hours', ['1 hour', '7 days', '365 days'], 'One full spin is one day. That is why we have day and night.'],
  ['spin', 'Places to the EAST of you have clocks that are...', 'Ahead of yours', ['Behind yours', 'Exactly the same', 'Stopped'], 'Earth spins eastward, so the Sun reaches eastern places first.'],
  ['spin', 'What really causes day and night?', 'Earth spinning', ['The Sun moving round Earth', 'The Moon blocking the Sun', 'Clouds'], 'The Sun stays put. Earth turns, carrying us into and out of its shadow.'],
  ['tilt', "About how much is Earth's axis tilted?", '23.4°', ['90°', '0°', '45°'], 'That lean is the reason we have seasons.'],
  ['tilt', 'It is summer in Johannesburg. What season is it in London?', 'Winter', ['Summer', 'Spring', 'It has no seasons'], 'The two halves of Earth lean toward the Sun at opposite times of year.'],
  ['tilt', 'In which month is Earth closest to the Sun?', 'January', ['July', 'April', 'October'], 'Seasons come from the tilt, not the distance. Earth is closest in early January!'],
  ['water', 'What turns sea water into invisible vapour?', 'Heat from the Sun', ['The Moon', 'Wind alone', 'Salt'], 'Evaporation: warm water becomes vapour and rises.'],
  ['water', 'Where does most of the rain fall around a mountain?', 'On the side facing the wind', ['On the far side', 'At the very top only', 'Nowhere'], 'Air forced up the windward slope cools, and its water falls as rain.'],
  ['water', 'About how many degrees does air cool for every kilometre it rises?', '6.5°C', ['0.5°C', '25°C', '60°C'], 'Cooler air holds less vapour, so rising air makes clouds.'],
  ['gravity', 'Why do astronauts float on the space station?', 'They are falling around Earth', ['There is no gravity there', 'The station spins', 'Space air holds them up'], 'Gravity up there is still about 90% as strong. They are in free fall.'],
  ['gravity', 'About how fast must you go to orbit just above Earth?', '7.8 km/s', ['78 km/h', '300 km/h', '1,000 km/h'], 'That is about 28,000 km/h: fast enough that Earth curves away as you fall.'],
  ['gravity', 'Without air, a feather and a cannonball dropped together...', 'Land at the same time', ['The feather lands first', 'The cannonball lands first', 'Neither lands'], 'Gravity speeds everything up equally. Air is what slows the feather.'],
  ['greenhouse', 'With no greenhouse gases, Earth would average about...', '−18°C', ['+15°C', '+40°C', '0°C'], 'Greenhouse gases add about 33°C and make Earth comfortable.'],
  ['greenhouse', 'Doubling the carbon dioxide warms Earth by about...', '3°C', ['0.1°C', '30°C', '300°C'], 'A few degrees for the whole planet is a big change.'],
  ['greenhouse', 'A greenhouse gas acts like a...', 'Blanket for heat', ['Mirror for sunlight', 'Heater', 'Umbrella'], 'It slows how fast heat escapes to space.'],
  ['plates', 'About how fast do tectonic plates move?', 'As fast as fingernails grow', ['As fast as a car', 'As fast as a snail', 'They never move'], 'A few centimetres a year adds up over millions of years.'],
  ['plates', 'What made the Himalayan mountains?', 'Two continents colliding', ['A giant volcano', 'Wind', 'Rivers digging up rock'], 'Neither continent sinks, so the crust crumples upward.'],
  ['plates', 'Why do earthquakes happen suddenly?', 'Stuck rock stores strain, then slips', ['Plates suddenly speed up', 'The mantle melts', 'Volcanoes cause them'], 'Like a stretched rubber band that snaps.'],
  ['life', 'About how much energy passes up each step of a food chain?', 'About 10%', ['About 90%', 'About 50%', '100%'], 'That is why there are far fewer lions than antelope.'],
  ['life', 'If all the lions vanish from a savanna, what happens to the grass?', 'Antelope boom and eat it all', ['It grows taller', 'Nothing changes', 'Lions come back by magic'], 'A trophic cascade: remove a predator and the whole web wobbles.'],
  ['life', 'In which animal do the MALES carry the babies?', 'Seahorse', ['Penguin', 'Lion', 'Elephant'], 'Male seahorses carry the eggs in a pouch until they hatch.'],
  ['weather', 'In the daytime, a sea breeze blows from...', 'The sea to the land', ['The land to the sea', 'The sky to the ground', 'It does not blow'], 'Hot land makes air rise, and cooler sea air rushes in.'],
  ['weather', 'In the southern hemisphere, moving winds curve...', 'To the left', ['To the right', 'Straight', 'Up'], 'Earth’s spin bends them: right in the north, left in the south.'],
  ['weather', 'About how many seconds between a lightning flash and thunder for every kilometre away?', 'About 3', ['About 30', 'About 0.3', 'None'], 'Light is much faster than sound. Count the seconds and divide by 3!'],
  ['proxima', 'How far is Proxima b, the closest planet that could support life?', '4.2 light-years', ['42 light-years', '4.2 million km', '420 light-years'], 'Light from the Alpha Centauri system takes about 4.2 years to reach us.'],
  ['proxima', 'How long is a year on Proxima b?', 'About 11 days', ['365 days', '1 hour', '100 years'], 'It orbits its small red star very closely, so a year is over in eleven Earth days.'],
];

// ---- generated puzzles (real calculations) ----
function timeZonePuzzle(r) {
  const cs = CITIES.filter((c) => c.id !== 'tos'), A = cs[Math.floor(r() * cs.length)]; let B = A; while (B === A) B = cs[Math.floor(r() * cs.length)];
  const utc = Math.floor(r() * 48) / 2, ta = clockTime(A, utc), right = fmtTime(clockTime(B, utc)), set = new Set([right]);
  for (const d of shuffle([1, -1, 2, -2, 3, -3, 4, 0.5, -0.5, 6], r)) { if (set.size >= 4) break; set.add(fmtTime(clockTime(B, utc) + d)); }
  const choices = shuffle([...set], r); const diff = B.tz - A.tz;
  return { id: 'tz', topic: 'spin', q: `It is ${fmtTime(ta)} in ${A.name}. What time is it in ${B.name}? (standard time)`, choices, answer: choices.indexOf(right), why: `${B.name} is ${Math.abs(diff)} hour${Math.abs(diff) === 1 ? '' : 's'} ${diff >= 0 ? 'ahead of' : 'behind'} ${A.name}, so ${fmtTime(ta)} ${diff >= 0 ? '+' : '−'} ${Math.abs(diff)} h = ${right}.` };
}
const label = (h) => (h >= 24 ? '24 hours (the Sun never sets!)' : h <= 0 ? '0 hours (polar night)' : `${h} hours`);
function dayLengthPuzzle(r, key) {
  const cs = CITIES, C = cs[Math.floor(r() * cs.length)], day = dayOfYear(key), len = dayLength(C.lat, declination(day)), right = Math.round(len), set = new Set([right]);
  for (const d of shuffle([1, -1, 2, -2, 3, -3, 4, -4], r)) { if (set.size >= 4) break; const v = right + d; if (v >= 0 && v <= 24) set.add(v); }
  const choices = shuffle([...set].map(label), r);
  return { id: 'dl', topic: 'tilt', q: `About how many hours of daylight does ${C.name} get on ${fmtDay(day)}?`, choices, answer: choices.indexOf(label(right)), why: `On ${fmtDay(day)}, ${C.name} (${Math.abs(C.lat).toFixed(0)}°${C.lat >= 0 ? 'N' : 'S'}) gets about ${len >= 23.99 ? '24' : len <= 0.01 ? '0' : len.toFixed(1)} hours of daylight. It depends on the tilt and your latitude.` };
}
export function makeDaily(key) {
  const r = rng(hashKey(key)), gen = (hashKey(key) & 1) ? timeZonePuzzle(r) : dayLengthPuzzle(r, key);
  const picks = shuffle(BANK.map((_, i) => i), r).slice(0, 2).map((i) => { const [topic, q, a, wrong, why] = BANK[i]; const choices = shuffle([a, ...wrong], r); return { id: 'b' + i, topic, q, choices, answer: choices.indexOf(a), why }; });
  return { key, questions: [gen, ...picks] };
}

// ---- the streak ----
export const newDaily = () => ({ last: null, streak: 0, best: 0, total: 0 });
export const doneToday = (d, key) => !!d && d.last === key;
export function activeStreak(d, key) { if (!d || !d.last) return 0; return d.last === key || d.last === addDays(key, -1) ? d.streak : 0; }
export function applyDaily(d, key) {
  const cur = d || newDaily(); if (cur.last === key) return cur;                         // already counted today
  const streak = cur.last === addDays(key, -1) ? cur.streak + 1 : 1;
  return { last: key, streak, best: Math.max(cur.best || 0, streak), total: (cur.total || 0) + 1 };
}
