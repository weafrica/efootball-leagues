// Planet Earth — the storyline: an alien from Proxima b (Alpha Centauri, Earth's nearest star system) with a broken heart
// is sent to Earth to find out whether "love" is real. Short, funny, with a real discovery at every step.
// Every spoken line has an id; the same ids are used to pre-record the voices on your own PC (see scripts/make-planetearth-voice.ps1).

export const CAST = {
  narrator: { name: 'Narrator', icon: '🎙️', color: '#ffe27a', voice: 'narrator', rate: 1.0 },
  elder: { name: 'Elder Grumbleton', icon: '🧓', color: '#c9a2ff', voice: 'elder', rate: 0.92 },
  bleep: { name: 'BLEEP (ship computer)', icon: '🤖', color: '#7fe9ff', voice: 'bleep', rate: 1.08 },
};
// The ex-partner can be a boy or a girl alien: a few lines come in two versions (each one recorded separately).
export const VARIANTS = {
  he: { ex: 'Blorp', bf: 'boyfriend' },
  she: { ex: 'Blorpa', bf: 'girlfriend' },
};
export const L = (id, who, text, rate) => ({ id, who, text, rate });
export const hasVars = (t) => /\{\w+\}/.test(t);
export const fill = (t, variant = 'she') => t.replace(/\{(\w+)\}/g, (_, k) => (VARIANTS[variant] || VARIANTS.she)[k] ?? '');
export const voiceKey = (line, variant = 'she') => (hasVars(line.text) ? `${line.id}.${variant}` : line.id);

// ---- the shape-shifting forms (the Blend Drive!) ----
export const FORMS = [
  { id: 'penguin', emoji: '🐧', name: 'Penguin', line: L('b_penguin', 'bleep', 'Penguin! Perfect. Except for the antennae.') },
  { id: 'lion', emoji: '🦁', name: 'Lion', line: L('b_lion', 'bleep', 'Lion! Majestic. A little hungry-looking, but majestic.') },
  { id: 'bird', emoji: '🐦', name: 'Bird', line: L('b_bird', 'bleep', 'Bird! You flap. You nearly fall over. Gravity says hello.') },
  { id: 'fish', emoji: '🐟', name: 'Fish', line: L('b_fish', 'bleep', 'Fish! Blub. You are also, technically, drowning. Moving on!') },
  { id: 'rock', emoji: '🪨', name: 'Rock', line: L('b_rock', 'bleep', 'A rock! Honestly, your most convincing one.') },
  { id: 'cactus', emoji: '🌵', name: 'Cactus', line: L('b_cactus', 'bleep', 'Cactus! Painful. For everyone.') },
  { id: 'human', emoji: '🧑', name: 'Human', line: L('b_human', 'bleep', 'Human! Very convincing. Please stop walking like a robot.') },
];

// ---- the prologue: short scenes. "after" is the little game or choice that ends a scene. ----
export const PROLOGUE = [
  { id: 'setup', art: 'title', lines: [L('s0_1', 'narrator', 'Meet our hero: you! An alien from Proxima b, in the Alpha Centauri system. Pick a name, a colour, and who broke your heart.')], after: { type: 'setup' } },
  { id: 'home', art: 'home', lines: [
    L('s1_1', 'narrator', 'Proxima b. The closest planet to Earth that could support life. Just four point two light-years away.'),
    L('s1_2', 'narrator', 'Sky colour: tomato soup. A year lasts only eleven days. You have had a lot of birthdays. All of them boring.'),
    L('s1_3', 'narrator', "But tonight you are taking flowers to your {bf}, {ex}. Tonight is going to be perfect.") ] },
  { id: 'cafe', art: 'cafe', lines: [
    L('s2_1', 'narrator', 'The Moon-Pie Café. Six forty-two p.m. You walk in with flowers. And there is {ex}.', 0.88),
    L('s2_2', 'narrator', 'Holding hands. Not with a person. Not even with an alien. With a... toaster.', 0.82),
    L('s2_3', 'narrator', 'The toaster looks you right in the eye. And goes... pop.', 0.88) ],
    after: { type: 'choice', prompt: 'What do you do?', options: [
      { id: 'a', text: '😱 Scream dramatically', reply: L('s2_ra', 'narrator', 'You scream so loudly that three windows break. The toaster pops again. Out of fear.') },
      { id: 'b', text: '🍦 Throw ice cream', reply: L('s2_rb', 'narrator', 'You miss. The ice cream hits a statue of the Elder. This will come up later.') },
      { id: 'c', text: '👏 Slow clap, then leave', reply: L('s2_rc', 'narrator', 'Iconic. The toaster is deeply moved. It is also a toaster.') } ] } },
  { id: 'sofa', art: 'sofa', lines: [
    L('s3_1', 'narrator', 'Weeks pass. You eat forty-seven tubs of moon ice cream. You watch the same movie nine times.'),
    L('s3_2', 'narrator', 'You decide that love is a scam. A rumour. A trick by the greeting card industry.') ],
    after: { type: 'oath', button: '✍️ Sign the Anti-Love Oath (angrily)', reply: L('s3_3', 'narrator', 'Oath signed. Heart status: frozen like a comet.') } },
  { id: 'council', art: 'council', lines: [
    L('e_1', 'elder', 'Citizen! Proxima b is bored. Nothing new has been discovered in four hundred years.'),
    L('e_2', 'elder', "Earth is full of living things doing this 'love' business. We think it is a scam. Go and find out."),
    L('e_3', 'elder', 'You are angry, alone, and you own a Blend Drive. You are perfect. And do NOT fall in love.') ],
    after: { type: 'choice', prompt: 'Your answer?', options: [
      { id: 'a', text: '🫡 I accept the mission!', reply: L('e_ra', 'elder', 'Excellent. Off you go.') },
      { id: 'b', text: '🍿 Do I get snacks?', reply: L('e_rb', 'elder', '...No. Yes. Fine. One snack.', 0.8) } ] } },
  { id: 'power', art: 'power', lines: [
    L('s4_1', 'narrator', 'Your secret power: the Blend Drive. You can shape-shift into any living thing, and blend in perfectly.'),
    L('s4_2', 'bleep', 'Almost perfectly. We are still working on the antennae.') ] },
  { id: 'blend', art: 'blend', lines: [L('s5_1', 'bleep', 'Training time! Tap three different forms. Try not to turn into anything illegal.')],
    after: { type: 'blend', need: 3, reply: L('s5_2', 'bleep', 'Blend Drive online! You are now officially a very confusing alien.') } },
  { id: 'launch', art: 'launch', lines: [L('s6_1', 'bleep', 'Ship computer BLEEP, online. Destination: Earth. Fuel: some. Brakes: unknown.')],
    after: { type: 'launch', button: '🚀 LAUNCH!', reply: L('s6_2', 'narrator', 'Four point two light-years pass in a blur. You sleep through most of it. Very rude.') } },
  { id: 'crash', art: 'crash', lines: [
    L('s7_1', 'narrator', 'BANG! You crash-land in a field. Smoke. Silence. And a cow, staring at you.', 0.9),
    L('s7_2', 'narrator', 'The cow does not blink. You have never been judged so hard.'),
    L('s7_3', 'bleep', 'Ship power: low. We need eight Discovery Crystals to fly home. Each one hides a secret of how Earth works.'),
    L('s7_4', 'narrator', 'Your mission: discover everything. And prove that love is a scam. Easy.') ] },
];

// ---- a short "transmission from home" before each level, and a "field report" after it ----
export const LEVEL_STORY = {
  spin: {
    intro: [L('spin_i1', 'elder', 'Citizen! First mystery. Every night the Sun vanishes. Is Earth being ghosted?'), L('spin_i2', 'bleep', 'I have seventeen theories. Sixteen are wrong. One is just "magic".')],
    outro: [L('spin_o1', 'narrator', 'Field report: the Sun never leaves. Earth just spins away for a while, then comes right back.'), L('spin_o2', 'elder', 'So the Sun is faithful, and Earth is a little dramatic. Noted. Suspicious, but noted.')] },
  tilt: {
    intro: [L('tilt_i1', 'elder', 'Next! Earthlings moan about hot summers AND cold winters. Make up your mind, planet!'), L('tilt_i2', 'bleep', 'Warning: this planet is leaning. Possibly dizzy.')],
    outro: [L('tilt_o1', 'narrator', 'Field report: Earth leans toward the Sun in summer and away in winter. It is the tilt, not the distance.'), L('tilt_o2', 'elder', 'A planet that leans in, then pulls away. We know someone like that.')] },
  water: {
    intro: [L('water_i1', 'elder', 'Mystery three: rain. Where does it go? And why does it always come back?'), L('water_i2', 'bleep', 'I tried to catch some. It is wet. Report complete.')],
    outro: [L('water_o1', 'narrator', 'Field report: water goes from sea to cloud to rain, and always flows back home.'), L('water_o2', 'elder', 'It always returns home. Unlike some people. Hmm.')] },
  gravity: {
    intro: [L('gravity_i1', 'elder', 'Mystery four: the Moon. It circles Earth. Every single day. Is it stalking?'), L('gravity_i2', 'bleep', 'It is called an orbit. Stalkers get restraining orders. The Moon gets poems.')],
    outro: [L('gravity_o1', 'narrator', 'Field report: gravity pulls everything together. The Moon never leaves. It just keeps falling around Earth.'), L('gravity_o2', 'elder', 'The most loyal relationship in the solar system. And it is a rock.')] },
  greenhouse: {
    intro: [L('greenhouse_i1', 'elder', 'Mystery five: Earth wears an invisible blanket of gas. We call it the cuddle layer.'), L('greenhouse_i2', 'bleep', 'Too much blanket and Earth overheats. Even cuddles have limits.')],
    outro: [L('greenhouse_o1', 'narrator', 'Field report: greenhouse gases keep Earth warm enough for life. The right amount matters.'), L('greenhouse_o2', 'elder', 'Warmth is useful. Fine. We will allow it.')] },
  plates: {
    intro: [L('plates_i1', 'elder', 'Mystery six: the ground itself is moving. Continents crash, drift, and break up.'), L('plates_i2', 'bleep', 'Pangaea was the original breakup. One big continent, split into seven.')],
    outro: [L('plates_o1', 'narrator', 'Field report: plates creep a few centimetres a year, building mountains, volcanoes and earthquakes where they meet.'), L('plates_o2', 'elder', 'So even continents break up. And Earth survived. Hmm.')] },
  life: {
    intro: [L('life_i1', 'elder', 'Final mystery: living things. Some partner for life. Some eat their partner. Earth is a soap opera.'), L('life_i2', 'bleep', 'Fun fact: male seahorses carry the babies. Respect.')],
    outro: [L('life_o1', 'narrator', 'Field report: living things depend on each other. Remove one, and the whole web wobbles.'), L('life_o2', 'bleep', 'Connections matter. Even for lions. And penguins. Always penguins.')] },
};

// The Heart-o-meter: your frozen heart slowly thaws as you discover how connected the world is.
export const HEART_STAGES = [
  '🧊 Heart: frozen like a comet.', '🌡️ A tiny bit warmer. Probably a solar flare.', '😒 Still angry, but... curious.', '🤔 Okay, the Moon is pretty loyal.',
  '😳 Wait, are my antennae blushing?', '🥹 Even rocks and rivers keep coming back.', '💗 Maybe, just maybe, it is not a scam.', '❤️ Fine. LOVE EXISTS. Please tell nobody.',
];
export const heartStage = (crystals) => HEART_STAGES[Math.max(0, Math.min(HEART_STAGES.length - 1, crystals))];

// ---- every spoken line, for the voice-recording script ----
export function allLines() {
  const out = [];
  for (const sc of PROLOGUE) { out.push(...sc.lines); if (sc.after) { if (sc.after.reply) out.push(sc.after.reply); for (const o of sc.after.options || []) out.push(o.reply); } }
  for (const f of FORMS) out.push(f.line);
  for (const lv of Object.values(LEVEL_STORY)) out.push(...lv.intro, ...lv.outro);
  return out;
}
// One entry per recording (lines with {ex}/{bf} are recorded once for each version).
export function voiceJobs() {
  const jobs = [];
  for (const l of allLines()) {
    const c = CAST[l.who]; const rate = l.rate ?? c.rate;
    if (hasVars(l.text)) for (const v of Object.keys(VARIANTS)) jobs.push({ key: `${l.id}.${v}`, voice: c.voice, rate, text: fill(l.text, v) });
    else jobs.push({ key: l.id, voice: c.voice, rate, text: l.text });
  }
  return jobs;
}
export const wordCount = (t) => t.trim().split(/\s+/).length;

// Little sound effects that go with some lines (comedy timing!). Names match audio.js.
export const LINE_SFX = { s2_1: 'sting', s2_2: 'sting', s2_3: 'pop', s2_ra: 'scream', s2_rb: 'boing', s2_rc: 'clap', s3_3: 'wah', e_3: 'sting', e_rb: 'wah', s5_2: 'ok', s6_2: 'whoosh', s7_1: 'crash' };
