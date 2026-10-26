// Tests for the Planet Earth storyline, the Blend forms and the pre-recorded voice player.
import { CAST, VARIANTS, FORMS, PROLOGUE, LEVEL_STORY, LINE_SFX, HEART_STAGES, heartStage, fill, hasVars, voiceKey, allLines, voiceJobs, wordCount } from '../src/planetearth/story.js';
import { LEVELS } from '../src/planetearth/lessons.js';
import { sfx } from '../src/planetearth/audio.js';
import { configureVoice, loadManifest, hasVoice, voiceUrl, playLine, stopVoice, setVoiceMuted } from '../src/planetearth/voice.js';
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };

// ---- the story itself ----
const lines = allLines(), ids = lines.map((l) => l.id);
ok(new Set(ids).size === ids.length, `every spoken line has a unique id (${ids.length} lines)`);
ok(lines.every((l) => CAST[l.who]), 'every line is spoken by a known character'); ok(lines.every((l) => wordCount(l.text) <= 26), `every line is short (longest: ${Math.max(...lines.map((l) => wordCount(l.text)))} words)`);
ok(lines.every((l) => /[.!?…]$/.test(l.text.trim())), 'every line ends like a sentence (so the voice sounds finished)');
ok(PROLOGUE.length === 9 && PROLOGUE[0].after.type === 'setup' && PROLOGUE.every((s) => s.id && s.art && s.lines.length >= 1), 'the prologue has 9 scenes, starting with the setup');
const types = new Set(PROLOGUE.filter((s) => s.after).map((s) => s.after.type)); ok(['setup', 'choice', 'oath', 'blend', 'launch'].every((t) => types.has(t)), 'prologue uses a choice, an oath, the Blend Lab and a launch');
const cafe = PROLOGUE.find((s) => s.id === 'cafe'), council = PROLOGUE.find((s) => s.id === 'council');
ok(cafe.after.options.map((o) => o.id).join() === 'a,b,c' && cafe.after.options.every((o) => o.reply && o.text) && council.after.options.length === 2, 'the funny choices each have their own reply');
const blend = PROLOGUE.find((s) => s.id === 'blend'); ok(blend.after.need >= 1 && blend.after.need <= FORMS.length && FORMS.length === 7 && new Set(FORMS.map((f) => f.id)).size === 7, 'Blend Lab: 7 different forms and a reachable goal');
ok(FORMS.every((f) => f.line.who === 'bleep' && /antennae|Gravity|drowning|rock|Painful|robot|hungry/i.test(f.line.text)), 'each form has its own joke');
const varLines = lines.filter((l) => hasVars(l.text)); ok(varLines.length >= 2 && varLines.every((l) => ['he', 'she'].every((v) => !/[{}]/.test(fill(l.text, v)))), `lines with {ex}/{bf} fill in for both versions (${varLines.length} lines)`);
ok(fill('your {bf}, {ex}', 'he') === 'your boyfriend, Blorp' && fill('your {bf}, {ex}', 'she') === 'your girlfriend, Blorpa', 'boy and girl ex-partner versions');
ok(lines.filter((l) => !hasVars(l.text)).every((l) => fill(l.text, 'he') === l.text), 'lines without placeholders are unchanged');
const jobs = voiceJobs(), keys = jobs.map((j) => j.key); ok(new Set(keys).size === keys.length && jobs.length === lines.length + varLines.length, `${jobs.length} recordings = ${lines.length} lines + ${varLines.length} second versions`);
ok(jobs.every((j) => j.voice && j.rate > 0.5 && j.rate < 1.5 && !/[{}]/.test(j.text)), 'every recording has a voice, a sane speed and finished text');
ok(voiceKey(varLines[0], 'he') === varLines[0].id + '.he' && voiceKey(lines.find((l) => !hasVars(l.text)), 'he') === lines.find((l) => !hasVars(l.text)).id, 'file names: version lines get .he/.she, others do not');
const words = jobs.reduce((a, j) => a + wordCount(j.text), 0); ok(words / 2.4 / 60 < 8, `all the speech is under 8 minutes (${(words / 2.4 / 60).toFixed(1)})`);
ok(LEVELS.every((l) => LEVEL_STORY[l.id] && LEVEL_STORY[l.id].intro.length === 2 && LEVEL_STORY[l.id].outro.length === 2), 'every level has a 2-line transmission and a 2-line field report');
ok(Object.keys(LINE_SFX).every((id) => ids.includes(id) && typeof sfx[LINE_SFX[id]] === 'function'), 'every line sound effect exists');
ok(HEART_STAGES.length === 8 && heartStage(0).includes('frozen') && heartStage(99) === HEART_STAGES[7] && heartStage(-3) === HEART_STAGES[0] && /LOVE EXISTS/.test(heartStage(7)), 'the Heart-o-meter thaws from frozen to "love exists"');
ok(/Proxima b/.test(lines[1].text) && /four point two light-years/i.test(lines[1].text) && /eleven days/.test(lines[2].text), 'real facts: Proxima b, 4.2 light-years, an 11-day year');

// ---- the voice player ----
const mkFetch = (manifest, status = 200) => async (url) => { if (String(url).endsWith('manifest.json')) { if (status !== 200) return { ok: false }; return { ok: true, json: async () => manifest }; } return { ok: true, blob: async () => ({}), clone() { return this; } }; };
class FakeAudio { constructor(u) { FakeAudio.last = this; this.url = u; } play() { setTimeout(() => this.onended && this.onended(), 5); return Promise.resolve(); } pause() { this.paused = true; } }
const M = { version: 1, lines: { s1_1: { ext: 'mp3', h: 'abc' }, 's1_3.he': { ext: 'wav', h: 'def' } } };
configureVoice({ fetch: mkFetch(M), Audio: FakeAudio }); await loadManifest();
ok(hasVoice('s1_1') && !hasVoice('nope') && voiceUrl('s1_1') === '/planetearth-voice/s1_1.mp3?v=abc' && voiceUrl('s1_3.he') === '/planetearth-voice/s1_3.he.wav?v=def', 'manifest tells which lines have a recording and where');
ok((await playLine('s1_1')) === true && FakeAudio.last.url.includes('s1_1.mp3'), 'a recorded line plays to the end');
ok((await playLine('missing_line')) === false, 'a line with no recording stays silent (no crash)');
configureVoice({ fetch: mkFetch({}, 404), Audio: FakeAudio }); ok((await playLine('s1_1')) === false, 'no manifest yet (not recorded): silent, text-only');
configureVoice({ fetch: async () => { throw new Error('offline'); }, Audio: FakeAudio }); ok((await playLine('s1_1')) === false, 'offline: silent, no crash');
configureVoice({ fetch: async () => ({ ok: true, json: async () => { throw new Error('<html>'); } }), Audio: FakeAudio }); ok((await playLine('s1_1')) === false, 'server returns a web page instead of the manifest: silent, no crash');
configureVoice({ fetch: mkFetch(M), Audio: FakeAudio }); const p1 = playLine('s1_1'); await new Promise((r) => setTimeout(r, 1)); stopVoice(); ok((await p1) === false && FakeAudio.last.paused === true, 'stopping cuts the line off and unblocks the caller');
setVoiceMuted(true); ok((await playLine('s1_1')) === false, 'muted: nothing plays'); setVoiceMuted(false);
const store = new Map(); const caches = { open: async () => ({ match: async (u) => store.get(u), put: async (u, r) => { store.set(u, r); } }) }; let fetches = 0;
configureVoice({ fetch: async (u) => { if (String(u).endsWith('manifest.json')) return { ok: true, json: async () => M }; fetches++; return { ok: true, blob: async () => ({}), clone() { return this; } }; }, Audio: FakeAudio, caches, URL: { createObjectURL: () => 'blob:x' } });
await playLine('s1_1'); await playLine('s1_1'); ok(fetches === 1 && FakeAudio.last.url === 'blob:x', 'a line is downloaded once, then played from the cache');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
