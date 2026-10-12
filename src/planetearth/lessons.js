// Planet Earth — the levels: story cards ("why is it like that?"), hands-on missions, and what you discovered.
// Missions are pure functions of a state object reported by the level's game view, so they can be unit-tested.
import { city, dayLength, declination, clockTime, elevationAt, isMorning, fmtTime, TILT } from './sky.js';
import { circularSpeed, RE, ALT } from './orbit.js';
import { FARM_A } from './water.js';
import { toC } from './greenhouse.js';

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

  { id: 'greenhouse', n: 5, icon: '🏭', title: 'Greenhouse Earth', tagline: 'Why is Earth warm enough for life?', color: '#ff7a5a',
    cards: [
      { art: 'gh1', title: 'A freezing surprise', text: 'Sunlight warms Earth. But if Earth had NO atmosphere, it would be a frozen ball at about −18°C. Nothing could live in the oceans!', why: 'Earth gets rid of heat by sending invisible infrared light back to space. Heat in must equal heat out, and doing the sums gives −18°C. But the real average is about +15°C. Something adds 33°C!' },
      { art: 'gh2', title: 'The invisible blanket', text: 'Some gases in the air (water vapour, carbon dioxide, methane) let sunlight IN but catch the heat trying to get OUT, sending some of it back down. That is the GREENHOUSE EFFECT.', why: "Greenhouse gases don't make heat. They slow down how fast heat escapes, like a blanket. Without them there would be no liquid oceans. More gas means a thicker blanket and a warmer planet." },
      { art: 'gh3', title: 'Too much of a good thing', text: 'Burning coal, oil and gas adds extra carbon dioxide. Before factories the air held about 280 parts per million. Today it is over 420.', why: 'Scientists calculate that doubling CO₂ warms Earth by about 3°C in the long run. And warming melts ice. Ice reflects sunlight, so less ice means more heat is absorbed: a feedback that makes warming stronger. Understanding it is the first step to fixing it!' },
    ],
    hands: 'Move the sliders. Watch the sunlight (yellow), reflected light (white) and escaping heat (red). One second is about 5 years!',
    missions: [
      { id: 'freeze', text: 'Take away ALL the greenhouse gases. How cold does Earth get?', hint: 'Slide the greenhouse-gas slider to 0 and wait a few seconds for the oceans to cool.', check: (s) => s.ppm === 0 && s.tempC < -10, done: 'Brrr! Without the blanket Earth freezes, and white ice reflects even more sunlight. That is SNOWBALL Earth.' },
      { id: 'justright', text: 'Bring life back: set the temperature between 10°C and 20°C and let it settle.', hint: 'Put the greenhouse gases back to around 280 to 420 ppm.', check: (s) => s.ppm > 0 && s.tempC >= 10 && s.tempC <= 20 && s.stable, done: 'Just right! The natural greenhouse effect keeps Earth at a comfortable 15°C or so.' },
      { id: 'double', text: 'Double the CO₂ from 280 to about 560 ppm and let it settle. How much does Earth warm?', hint: 'Set the slider near 560 and look at the warming number.', check: (s) => s.ppm >= 520 && s.ppm <= 600 && s.stable, done: 'About +3°C. A small number for the whole planet, but it melts ice, raises seas and changes weather.' },
      { id: 'blanketq', kind: 'choice', text: 'What does a greenhouse gas do?', choices: ['It makes new heat from nothing', 'It catches heat leaving Earth and sends some back down', 'It blocks sunlight from reaching Earth', 'It cools the planet'], answer: 1, hint: 'Think of a blanket.', done: 'Yes! It works like a blanket for heat.' },
    ],
    codex: ['Without greenhouse gases Earth would be about −18°C. They add about +33°C.', 'Greenhouse gases are a blanket: they slow heat escaping rather than making heat.', 'Doubling CO₂ warms Earth about 3°C in the long run, and melting ice makes warming stronger.'] },

  { id: 'plates', n: 6, icon: '🌋', title: 'Moving Ground', tagline: 'Why do volcanoes and earthquakes happen?', color: '#e0682a',
    cards: [
      { art: 'plates1', title: 'Earth has layers', text: 'Earth is like a peach: a thin crust, a thick layer of hot mantle, and a metal core.', why: 'The crust is broken into giant slabs called TECTONIC PLATES. They float on the mantle, which is so hot that rock flows like very thick toothpaste, but only over millions of years.' },
      { art: 'plates2', title: 'The plates move!', text: 'Plates creep about as fast as your fingernails grow (2 to 10 cm a year). South America and Africa used to be joined. The Atlantic Ocean is still getting wider!', why: 'Hot rock rises and cold rock sinks inside the mantle, dragging the plates along. A few centimetres a year adds up to thousands of kilometres over millions of years.' },
      { art: 'plates3', title: 'Where plates meet', text: 'At the edges, plates can crash together, pull apart, or slide past each other. Each makes something different!', why: 'When an ocean plate meets a continent it dives under (SUBDUCTION), melts and feeds volcanoes. Two continents crumple into mountains like the Himalayas. Pulled apart, land splits into rift valleys. And earthquakes? Rock sticks, strain builds up, then it suddenly SLIPS.' },
    ],
    hands: 'Pick the plate types and set their speeds. Then press play: each second is about a million years! Also try the Quake Lab.',
    missions: [
      { id: 'mount', text: 'Build a mountain range: crash two CONTINENTS together until the mountains pass 5 km high.', hint: 'Set both plates to "Continent" and push them toward each other (left plate positive, right plate negative). Then press play.', check: (s) => s.mount >= 5, done: 'A new mountain range! This is how the Himalayas and the Alps were made.' },
      { id: 'rift', text: 'Open a new ocean: pull two continents apart until the rift valley sinks 3 km.', hint: 'Both plates continent, left plate negative, right plate positive.', check: (s) => s.rift >= 3, done: 'A rift valley! East Africa is slowly splitting like this and one day a new ocean will fill the gap.' },
      { id: 'trench', text: 'Make a deep ocean trench AND a chain of volcanoes: push an OCEAN plate into a continent.', hint: 'Left plate "Ocean", right plate "Continent", push them together. Watch the ocean plate dive!', check: (s) => s.trench >= 4 && s.arc >= 2, done: 'Subduction! The sinking plate melts and the magma feeds volcanoes, like the Andes and the Pacific Ring of Fire.' },
      { id: 'bigquake', text: 'In the Quake Lab, make a BIG earthquake of magnitude 7.3 or more.', hint: 'Make the rock stickier (move the Stickiness slider up) so more strain stores up before it breaks.', check: (s) => s.maxMag >= 7.3, done: 'A great earthquake! The stickier the rock, the more strain stored and the bigger the quake.' },
      { id: 'quakeq', kind: 'choice', text: 'Why do earthquakes happen SUDDENLY when plates move slowly?', choices: ['Plates suddenly speed up', 'Rock sticks, strain builds up, then it slips all at once', 'The mantle suddenly melts', 'Volcanoes make them'], answer: 1, hint: 'Remember the stretching spring in the Quake Lab.', done: 'Yes! Like a stretched rubber band that suddenly snaps.' },
    ],
    codex: ['Earth\'s crust is broken into plates that move a few centimetres a year, carried by the flowing mantle.', 'Plate edges make mountains (collision), volcanoes and trenches (subduction), and rift valleys (pulling apart).', 'Earthquakes happen when stuck rock stores strain and then suddenly slips.'] },

  { id: 'life', n: 7, icon: '🦁', title: 'The Web of Life', tagline: 'How do plants and animals depend on each other?', color: '#4caf50',
    cards: [
      { art: 'eco1', title: 'Energy from the Sun', text: 'Grass uses sunlight to make its own food (photosynthesis). Antelope eat the grass. Lions eat the antelope.', why: 'That is a FOOD CHAIN. Energy flows from the Sun to plants to plant-eaters to meat-eaters. Each step passes on only about 10% of the energy, which is why there are far fewer lions than antelope, and far more grass than either.' },
      { art: 'eco2', title: 'Boom and bust', text: 'More antelope means more food for lions, so lions multiply. Then lions eat too many antelope, the antelope crash, lions go hungry, and the cycle starts again.', why: 'Predator and prey numbers rise and fall in linked cycles. This wobble is how nature keeps its balance.' },
      { art: 'eco3', title: 'Take away the lions...', text: 'What if all the lions disappeared one day? You will get to try it yourself in a moment!', why: 'With no predators, antelope boom, eat all the grass, then starve. In Yellowstone in the USA, wolves were removed in the 1920s and elk overgrazed the river banks. When wolves came back in 1995, plants and rivers recovered. Everything is connected!' },
    ],
    hands: 'Watch the savanna. Add or remove animals, change the rainfall, or cause a drought. Time runs 3 times faster than real life.',
    missions: [
      { id: 'balance', text: 'Keep the savanna balanced for 60 seconds: grass, antelope AND lions all alive.', hint: 'Leave it alone, or add a few animals if one group is dying out. Keep the rain steady.', check: (s) => s.balancedFor >= 60, done: 'A balanced ecosystem! Grass, antelope and lions keep each other in check.' },
      { id: 'cascade', text: 'Remove ALL the lions and watch what happens: let the grass drop below 25%.', hint: 'Press "Remove lions" and wait. Be patient: first the antelope boom.', check: (s) => s.lions === 0 && s.grass < 0.25 && s.hadRemoval, done: 'A trophic cascade! No lions led to too many antelope, which ate nearly all the grass.' },
      { id: 'heal', text: 'Heal the land: bring the lions back so the grass climbs above 30% with antelope and lions alive.', hint: 'Add antelope if they died out, add lions, and give the grass time to grow back.', check: (s) => s.lions >= 2 && s.ants >= 8 && s.grass >= 0.3 && s.hadRemoval, done: 'You restored the web of life! Predators protect the plants by keeping grazers in check.' },
      { id: 'whyq', kind: 'choice', text: 'Why are predators like lions important for the grass?', choices: ['Lions fertilise the grass', 'They stop the antelope from eating all of it', 'Lions plant the seeds', 'They are not important'], answer: 1, hint: 'Remember what happened when you removed the lions.', done: 'Exactly: predators keep grazers in balance so plants survive.' },
    ],
    codex: ['A food chain moves energy from the Sun to plants, then plant-eaters, then meat-eaters. Only about 10% passes up each step.', 'Predator and prey numbers rise and fall in linked cycles.', 'Remove a predator and the whole web can collapse: this is called a trophic cascade.'] },
];
export const SOON = [
  { n: 8, icon: '🌪️', title: 'Wind & Weather', tagline: 'What makes the wind blow and storms form?' },
];
export const levelById = (id) => LEVELS.find((l) => l.id === id);
export const flagAngle = 44;
export function missionDone(level, i, state) { const m = level.missions[i]; return !!(m && m.check && m.check(state)); }
