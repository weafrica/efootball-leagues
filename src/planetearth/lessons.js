// Planet Earth — the levels: story cards ("why is it like that?"), hands-on missions, and what you discovered.
// Missions are pure functions of a state object reported by the level's game view, so they can be unit-tested.
import { city, dayLength, declination, clockTime, elevationAt, isMorning, fmtTime, TILT } from './sky.js';
import { circularSpeed, RE, ALT } from './orbit.js';
import { FARM_A } from './water.js';

export const SHIP_CRYSTALS = 8;   // the alien ship needs 8 Discovery Crystals to fly home (one per level)
const jhb = city('jhb'), tyo = city('tyo'), lon = city('lon'), tos = city('tos');

export const LEVELS = [
  { id: 'spin', n: 1, icon: '🌍', title: 'Spin the Planet', tagline: 'Why does the Sun come up and go down?', color: '#3aa0ff',
    cards: [
      { art: 'sunearth', title: 'Welcome, explorer!', text: "You've landed on a blue-and-green planet called Earth. Above you hangs a blazing ball of fire, the Sun. Every so often it VANISHES and the sky goes dark!", why: "Don't panic. The Sun isn't going anywhere. Something else is happening..." },
      { art: 'spin', title: 'Earth is spinning!', text: 'Earth is a giant ball that spins around like a top. One full spin takes 24 hours. That is what a "day" is!', why: "Only half of Earth faces the Sun at a time. That half has DAYTIME. The other half is in Earth's own shadow: NIGHT. As Earth turns, you get carried from light into shadow and back again. At the equator you whizz along at about 1,670 km/h, but you can't feel it because everything turns smoothly together." },
      { art: 'timezones', title: 'Clocks around the world', text: 'The sunny part keeps moving round the planet, so noon happens at a different moment in every place.', why: 'Earth turns 360° in 24 hours, so every hour it turns 15°. People split the world into time zones about 15° wide so clocks match the Sun. Places to the EAST see the Sun first, so their clocks are AHEAD. South Africa is 2 hours ahead of London, and Tokyo is 9 hours ahead!' },
    ],
    hands: 'Drag the planet sideways (or use the slider) to spin Earth. Watch the clocks and the light!',
    missions: [
      { id: 'sunrise', text: 'Make the Sun RISE over Johannesburg.', hint: 'Spin Earth until Johannesburg is at the edge of the light, with the Sun just coming up (clock about 6 or 7 in the morning).',
        check: (s) => { const e = s.elev.jhb; return e > -2 && e < 14 && s.morning.jhb; }, done: 'Sunrise! Johannesburg turned INTO the light.' },
      { id: 'tokyo', text: 'Make it NIGHT in Tokyo while it is DAY in London.', hint: 'Tokyo is far east of London. When London has afternoon sun, Tokyo has already spun into darkness.',
        check: (s) => s.elev.tyo < -6 && s.elev.lon > 5, done: 'Yes! Tokyo is 9 hours ahead, so it is already night there.' },
      { id: 'noonq', kind: 'choice', text: 'It is 12:00 noon in Johannesburg. What does the clock say in Tokyo? (Tokyo is further EAST.)', choices: ['05:00 in the morning', '12:00 noon', '19:00 in the evening', '21:00 at night'], answer: 2,
        hint: 'Tokyo is 7 hours ahead of Johannesburg (9 minus 2).', done: 'Right! East is ahead: 12:00 + 7 hours = 19:00.' },
    ],
    codex: ['Day and night happen because Earth SPINS once every 24 hours, not because the Sun moves.', 'Earth turns 15° every hour, so time zones are about 15° wide.', 'Go EAST and the clock is AHEAD; go WEST and it is behind.'] },

  { id: 'tilt', n: 2, icon: '🌦️', title: 'Tilt & the Seasons', tagline: 'Why is it hot in summer and cold in winter?', color: '#ff9f43',
    cards: [
      { art: 'orbit', title: 'Earth goes round the Sun', text: "Earth doesn't only spin. It also travels around the Sun. One whole lap takes about 365 days: a YEAR.", why: "Earth zooms along at about 107,000 km/h. Like the spin, you can't feel it because you travel along smoothly with it." },
      { art: 'tilt', title: 'Earth is tilted!', text: "Earth's spin axis is tilted by 23.4°, like a leaning top, and it always points the same way in space.", why: "When Earth's northern half leans TOWARD the Sun, sunlight hits it more directly and the days are longer: northern summer. Six months later the SOUTHERN half leans toward the Sun. Whichever half leans toward the Sun is warmer and has longer days!" },
      { art: 'seasons', title: "It's NOT about distance!", text: 'Many people think summer is when Earth is closest to the Sun. That is a myth!', why: "Earth is actually closest to the Sun in early JANUARY, in the middle of northern winter. It's the TILT that makes seasons. That's why seasons are opposite: December is summer in Johannesburg but winter in London." },
    ],
    hands: 'Slide through the year. Watch Earth travel, the Sun’s path across the sky, and the length of the day. Then try changing the tilt!',
    missions: [
      { id: 'long', text: 'Find the LONGEST day of the year in Johannesburg.', hint: 'Johannesburg is in the south. Its summer is when the SOUTH leans toward the Sun, around December.',
        check: (s) => s.city === 'jhb' && s.tilt > 20 && s.tilt < 27 && s.dayLen >= dayLength(jhb.lat, -TILT) - 0.04, done: 'Around 21 December: the south leans toward the Sun, so Johannesburg has its longest day (about 14 hours).' },
      { id: 'midnight', text: 'Make the Sun NEVER set in Tromsø, Norway (a city near the Arctic).', hint: 'Choose Tromsø, then find the dates in the northern summer when the north leans toward the Sun.',
        check: (s) => s.city === 'tos' && s.tilt > 20 && s.dayLen >= 23.99, done: 'The midnight sun! Near the poles, in summer the Sun stays up all day and night.' },
      { id: 'notilt', text: 'Straighten the planet: set the tilt to 0°. What happens to the seasons?', hint: 'Drag the Tilt slider all the way to 0 and slide through the year.',
        check: (s) => s.tilt <= 0.5 && s.moved, done: 'With no tilt, every day is 12 hours long everywhere and there are NO seasons. The tilt is the cause!' },
      { id: 'whyq', kind: 'choice', text: 'So what REALLY causes the seasons?', choices: ['Earth gets closer to the Sun in summer', "Earth's spin axis is tilted", 'The Sun gets hotter and colder', 'Earth spins faster in summer'], answer: 1,
        hint: 'You just switched it off by setting it to 0°!', done: "Yes! It's the 23.4° tilt." },
    ],
    codex: ["Seasons come from Earth's 23.4° TILT, not from its distance from the Sun.", 'The two halves of Earth have OPPOSITE seasons.', 'Near the poles, summer brings the midnight Sun and winter brings long darkness.'] },

  { id: 'water', n: 3, icon: '🌧️', title: 'The Water Cycle', tagline: 'Where does rain come from?', color: '#2fc4b2',
    cards: [
      { art: 'waterloop', title: 'The same water, forever', text: 'The water in your glass may once have been drunk by a dinosaur!', why: "Earth's water never leaves. It travels in a giant loop: sea → sky → land → sea. That's the WATER CYCLE, and the Sun is its engine." },
      { art: 'cloud', title: 'The Sun lifts water up', text: 'Sunshine warms the sea and turns water into invisible vapour that rises (evaporation). The warmer the sea, the more vapour: about 7% more for every degree!', why: 'Rising air cools (about 6.5°C for every kilometre up). Cold air can hold less vapour, so at a height called the DEW POINT the vapour turns back into tiny droplets: a CLOUD. When droplets bump and join, they grow heavy and fall as RAIN.' },
      { art: 'mountainrain', title: 'Mountains squeeze the rain out', text: 'When wind meets a mountain the air is forced UP, cools, and drops its rain on the windward side. The far side stays dry: a RAIN SHADOW.', why: 'Air sinking down the far side warms up and drinks water again. Many deserts sit behind mountains, like South Africa’s Karoo behind the Cape Fold Mountains.' },
    ],
    hands: 'Change the Sun, the wind and the mountain, then watch where clouds and rain appear!',
    missions: [
      { id: 'clouds', text: 'Make clouds: get 25 cloud droplets in the sky at once.', hint: 'Keep the Sun warm so lots of water evaporates, then wait for the rising vapour to cool.',
        check: (s) => s.clouds >= 25, done: 'Clouds! Vapour cooled to its dew point and turned into droplets.' },
      { id: 'rainA', text: 'Make it RAIN on the windward farm (the left farm): 40 raindrops.', hint: 'Raise the mountain! Wind forced up a slope cools quickly and rains.', check: (s) => s.rainA - s.base.rainA >= 40, done: 'Rain on the windward slope. The mountain squeezed the water out of the air.' },
      { id: 'shadow', text: 'Create a RAIN SHADOW: the far farm gets almost no rain while the windward farm gets plenty.', hint: 'Make the mountain tall and let it run. The far farm should stay dry.',
        check: (s) => { const a = s.rainA - s.base.rainA, b = s.rainB - s.base.rainB; return a >= 40 && b <= a * 0.25; }, done: 'A rain shadow! That is how many of Earth’s deserts are made.' },
      { id: 'dryq', kind: 'choice', text: 'Why is the land BEHIND a mountain so dry?', choices: ['The air loses its water going up, then sinks and warms', 'The sun is hotter there', 'Rain only falls near the sea', 'Mountains soak up all the clouds like sponges'], answer: 0,
        hint: 'Remember what happens to air going up and coming down.', done: 'Exactly: up = cool and rain; down = warm and dry.' },
    ],
    codex: ['Water travels in a loop: evaporation → clouds → rain → rivers → sea.', 'Rising air cools about 6.5°C per km; at the dew point vapour becomes a cloud.', 'Mountains make rain on the windward side and a RAIN SHADOW (dry land) on the other side.'] },

  { id: 'gravity', n: 4, icon: '🚀', title: "Newton's Cannon", tagline: "Why do things fall, and why doesn't the Moon?", color: '#c46bff',
    cards: [
      { art: 'gravity', title: 'Things fall down', text: 'Drop a ball and it falls. Earth pulls everything toward its centre: that pull is GRAVITY.', why: "Gravity pulls a feather and a cannonball equally hard per kilogram, so without air they fall together! Gravity gets weaker with distance, but it never switches off." },
      { art: 'orbit2', title: "Newton's big idea", text: "Imagine a cannon on a super-tall mountain. Fire it sideways and the ball curves down and lands far away. Fire it FASTER and it lands even farther...", why: 'Fire it fast enough and Earth curves away underneath as fast as the ball falls, so it NEVER lands. That is an ORBIT: falling around the planet. Near Earth that takes about 7.8 km/s (28,000 km/h). The Moon and the space station do exactly this!' },
      { art: 'iss', title: 'Falling forever = floating', text: "Astronauts on the space station aren't beyond gravity. It's still about 90% as strong up there!", why: "They float because they and the station are FALLING together, around the Earth. And fire the ball faster than about 11 km/s and it escapes Earth's gravity for good." },
    ],
    hands: 'Set the speed, press FIRE and watch the ball fly. Zoom out to see big orbits!',
    missions: [
      { id: 'flag', text: 'Land the ball on the flag. It is partway round the Earth.', hint: 'Too slow and it lands close. Try speeds between 7 and 7.6 km/s, aimed flat.', check: (s) => s.last && s.last.outcome === 'landed' && Math.abs(s.last.landedAngle - s.flagAngle) <= 6, done: 'Direct hit! The faster you fire, the farther it flies before gravity pulls it down.' },
      { id: 'orbit', text: 'Make a nearly CIRCULAR orbit: a satellite that never lands.', hint: 'Fire flat (0°) at the speed where Earth curves away as fast as the ball falls: about 7.8 km/s.', check: (s) => s.last && s.last.outcome === 'orbit' && s.last.ecc < 0.04 && s.last.peri > RE + 100, done: 'You built a satellite! At 200 km up the speed for a circle is about 7.8 km/s.' },
      { id: 'escape', text: 'ESCAPE Earth: fire so fast the ball never comes back.', hint: 'Escape speed at this height is a bit over 11 km/s.', check: (s) => s.last && s.last.outcome === 'escape', done: 'Escape velocity! Past about 11 km/s, gravity can never pull the ball back.' },
      { id: 'floatq', kind: 'choice', text: 'Why do astronauts float on the space station?', choices: ["There is no gravity in space", 'They and the station are constantly falling around Earth', 'The station spins to make them float', 'Space air pushes them up'], answer: 1, hint: 'Think about the cannon ball that never lands.', done: "Yes! They're in free-fall around the Earth, all day long." },
    ],
    codex: ['Gravity pulls everything toward the centre of Earth, and it weakens with distance.', 'An ORBIT is falling around a planet: about 7.8 km/s near Earth (28,000 km/h).', 'Faster than about 11.2 km/s and you ESCAPE Earth. Astronauts float because they are in free-fall.'] },
];
export const SOON = [
  { n: 5, icon: '🏭', title: 'Greenhouse Earth', tagline: 'Why is Earth warm enough for life?' },
  { n: 6, icon: '🌋', title: 'Moving Ground', tagline: 'Why do volcanoes and earthquakes happen?' },
  { n: 7, icon: '🦁', title: 'The Web of Life', tagline: 'How do plants, animals and weather depend on each other?' },
  { n: 8, icon: '🌪️', title: 'Wind & Weather', tagline: 'What makes the wind blow and storms form?' },
];
export const levelById = (id) => LEVELS.find((l) => l.id === id);
export const flagAngle = 44;
export function missionDone(level, i, state) { const m = level.missions[i]; return !!(m && m.check && m.check(state)); }
