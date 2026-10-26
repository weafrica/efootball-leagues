// Lists every line of the Planet Earth story that needs a voice recording and writes it as JSON for the Piper script.
//   node scripts/export-planetearth-voice-lines.mjs voice-work/planetearth-lines.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { voiceJobs } from '../src/planetearth/story.js';
const out = process.argv[2] || 'voice-work/planetearth-lines.json';
const lines = voiceJobs().map((j) => ({ ...j, hash: createHash('sha1').update(`${j.voice}|${j.rate}|${j.text}`).digest('hex').slice(0, 10) }));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ story_id: 'planetearth', language: 'en', lines }, null, 2));
const words = lines.reduce((a, l) => a + l.text.split(/\s+/).length, 0);
console.log(`${lines.length} voice lines (${words} words, about ${(words / 2.4 / 60).toFixed(1)} minutes of speech) -> ${out}`);
