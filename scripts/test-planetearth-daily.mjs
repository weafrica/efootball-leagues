// Tests for the Daily Discovery (questions, puzzles, streak) and progress helpers.
import { dateKey, addDays, dayOfYear, BANK, makeDaily, newDaily, doneToday, activeStreak, applyDaily } from '../src/planetearth/daily.js';
import { crystalsOf, starsOf, certificateStats } from '../src/planetearth/progress.js';
import { CITIES, clockTime, fmtTime, dayLength, declination } from '../src/planetearth/sky.js';
import { LEVELS } from '../src/planetearth/lessons.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

ok(dateKey(new Date(2026, 10, 5)) === '2026-11-05' && dateKey(new Date(2027, 0, 1)) === '2027-01-01', 'date keys are YYYY-MM-DD');
ok(addDays('2026-02-28', 1) === '2026-03-01' && addDays('2026-03-01', -1) === '2026-02-28' && addDays('2026-12-31', 1) === '2027-01-01' && addDays('2028-02-28', 1) === '2028-02-29', 'adding days handles month ends, new year and leap years');
ok(dayOfYear('2026-01-01') === 0 && dayOfYear('2026-12-21') === 354, 'day of year counts from 0');
const keys = Array.from({ length: 120 }, (_, i) => addDays('2026-11-14', i));
ok(keys.every((k) => JSON.stringify(makeDaily(k)) === JSON.stringify(makeDaily(k))), 'the same date always gives the same questions (everyone gets the same daily)');
ok(new Set(keys.map((k) => JSON.stringify(makeDaily(k)))).size >= 115, 'different dates give different questions');
let structural = true, distinctBank = true, types = new Set();
for (const k of keys) { const d = makeDaily(k); if (d.questions.length !== 3) structural = false; for (const q of d.questions) { if (!(q.q && q.why && q.choices.length === 4 && new Set(q.choices).size === 4 && q.answer >= 0 && q.answer < 4 && q.choices[q.answer])) structural = false; } types.add(d.questions[0].id); if (d.questions[1].id === d.questions[2].id) distinctBank = false; }
ok(structural, 'every daily has 3 questions, each with 4 different answers, a valid right answer and an explanation'); ok(distinctBank, 'the two fact questions are never the same'); ok(types.has('tz') && types.has('dl'), 'both kinds of calculated puzzle (time zones, daylight hours) appear');
// the calculated puzzles must really be right
let tzOk = true, dlOk = true, tzN = 0, dlN = 0;
for (const k of keys) { const q = makeDaily(k).questions[0];
  if (q.id === 'tz') { tzN++; const m = q.q.match(/It is (\d\d:\d\d) in (.+?)\. What time is it in (.+?)\?/); const A = CITIES.find((c) => c.name === m[2]), B = CITIES.find((c) => c.name === m[3]); const [hh, mm] = m[1].split(':').map(Number); const utc = hh + mm / 60 - A.tz; if (q.choices[q.answer] !== fmtTime(clockTime(B, utc))) tzOk = false; }
  else { dlN++; const m = q.q.match(/hours of daylight does (.+?) get on/); const C = CITIES.find((c) => c.name === m[1]); const right = Math.round(dayLength(C.lat, declination(dayOfYear(k)))); const txt = q.choices[q.answer]; const num = txt.startsWith('24') ? 24 : txt.startsWith('0 ') ? 0 : parseInt(txt, 10); if (num !== right) dlOk = false; } }
ok(tzOk && tzN > 20, `time-zone puzzles are correct (${tzN} checked)`); ok(dlOk && dlN > 20, `daylight puzzles are correct (${dlN} checked)`);
ok(BANK.length >= 24 && BANK.every((b) => b.length === 5 && new Set([b[2], ...b[3]]).size === 4), `fact bank: ${BANK.length} questions, each with 1 right and 3 different wrong answers`);
const topics = new Set(BANK.map((b) => b[0])); ok(LEVELS.every((l) => BANK.filter((b) => b[0] === l.id).length >= 3) && topics.has('proxima'), 'the bank has at least 3 questions for every level, plus the home planet');
const answerPos = [0, 0, 0, 0]; for (const k of keys) for (const q of makeDaily(k).questions) answerPos[q.answer]++; ok(answerPos.every((n) => n > 40), `the right answer is spread over all four positions (${answerPos.join('/')})`);
// streak
let d = newDaily(); ok(activeStreak(d, '2026-11-14') === 0 && !doneToday(d, '2026-11-14'), 'a new player has no streak');
d = applyDaily(d, '2026-11-14'); ok(d.streak === 1 && d.best === 1 && d.total === 1 && doneToday(d, '2026-11-14'), 'first day: streak 1');
const same = applyDaily(d, '2026-11-14'); ok(same.streak === 1 && same.total === 1, 'doing it twice on the same day does not count twice');
d = applyDaily(d, '2026-11-15'); d = applyDaily(d, '2026-11-16'); ok(d.streak === 3 && d.best === 3 && d.total === 3, 'three days in a row: streak 3');
ok(activeStreak(d, '2026-11-16') === 3 && activeStreak(d, '2026-11-17') === 3 && activeStreak(d, '2026-11-18') === 0, 'the streak stays alive until you miss a whole day');
d = applyDaily(d, '2026-11-19'); ok(d.streak === 1 && d.best === 3 && d.total === 4, 'missing a day resets the streak to 1 but keeps the best (3)');
d = applyDaily({ last: '2026-02-28', streak: 4, best: 4, total: 9 }, '2026-03-01'); ok(d.streak === 5, 'streaks continue across month ends');
// progress helpers
const save = { name: 'Zorp', color: 2, epilogue: false, levels: { spin: { stars: 3 }, tilt: { stars: 2 }, water: { stars: 0 } } };
ok(crystalsOf(save) === 2 && starsOf(save) === 5, 'crystals and stars are counted from the saved levels');
const cs = certificateStats(save, 4); ok(cs.crystals === 2 && cs.total === 8 && cs.stars === 5 && cs.maxStars === 24 && cs.streak === 4 && cs.name === 'Zorp' && /curious/.test(cs.heart) && cs.finished === false, 'certificate numbers: crystals, stars, streak and heart stage');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
