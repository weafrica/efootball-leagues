// Ludo banter — 100 short, punchy, comedic one-liners, grouped by situation.
// Short on purpose: the old lines were long sentences with a "reason" tacked
// on the end, which is what made the read-aloud voice sound like a robot
// reading a report. These are quick, exciting, and easy to say out loud.
//
//   CAPTURE 24 · EXIT 12 · FINISH 12 · COMBINE 8 · SAFE 8 · PLAIN 10
//   FORCED 10 · NO_MOVE 8 · JUMP 4 · FORFEIT 4   = 100
//
// `me` / `opp` are colour names ("Red", "Green"); `n` / `sum` are numbers.

export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export const CAPTURE_LINES = [
  (me, opp) => `${me} just ate ${opp}. Nom nom nom!`,
  (me, opp) => `${opp} got sent home. Ouch!`,
  (me, opp) => `Bye-bye ${opp}! Say hi to the yard.`,
  (me, opp) => `${me} yeets ${opp} into orbit!`,
  (me, opp) => `${opp} has left the chat.`,
  (me, opp) => `Boom! ${opp} is toast.`,
  (me, opp) => `${me} says: not today, ${opp}!`,
  (me, opp) => `Sit down, ${opp}. ${me} has the square now.`,
  (me, opp) => `${me} stole ${opp}'s lunch money!`,
  (me, opp) => `Who's ${opp}? Never heard of them.`,
  (me, opp) => `Crunch! ${opp} never saw that coming.`,
  (me, opp) => `${me} did that on purpose. Cold!`,
  (me, opp) => `Back to the yard, ${opp}. Think about what you did.`,
  (me, opp) => `${opp} just got ambushed. Brutal!`,
  (me, opp) => `${me} sends ${opp} home with no snacks.`,
  (me, opp) => `Somebody call ${opp} a taxi!`,
  (me, opp) => `${me} eats ${opp} for breakfast!`,
  (me, opp) => `Delete! ${opp} has been deleted.`,
  (me, opp) => `${opp} tripped over ${me}. Yard time!`,
  (me, opp) => `Sorry, ${opp}. Actually, no. Not sorry!`,
  (me, opp) => `${me} says: my square, my rules!`,
  (me, opp) => `Ka-pow! ${opp} is back to square nothing.`,
  (me, opp) => `${opp} got the boot. Literally.`,
  (me, opp) => `Absolute chaos! ${me} eats ${opp}!`,
];

export const EXIT_LINES = [
  (me) => `${me} rolls a six! Escape from the yard!`,
  (me) => `Freedom! ${me} busts a token out.`,
  (me) => `${me} kicks the door down. Showtime!`,
  (me) => `A wild ${me} token appears!`,
  (me) => `${me} finally gets out. Took long enough!`,
  (me) => `Six! ${me} unleashes another one.`,
  (me) => `Release the token! ${me} is loose.`,
  (me) => `${me} escapes. Nobody saw anything.`,
  (me) => `Jailbreak! ${me} is out.`,
  (me) => `${me} rolled a six. Suspiciously lucky.`,
  (me) => `Reinforcements for ${me}!`,
  (me) => `${me} leaves the yard. Goodbye, curfew!`,
];

export const FINISH_LINES = [
  (me) => `${me} gets one home. Smug alert!`,
  (me) => `Home sweet home for ${me}!`,
  (me) => `One down for ${me}! Slippers on.`,
  (me) => `${me} crosses the line. Cue the confetti!`,
  (me) => `Token home! ${me} is unbearable now.`,
  (me) => `${me} tucks one in. Goodnight!`,
  (me) => `Touchdown! Wrong game, but ${me} scores!`,
  (me) => `${me} made it. Barely a scratch!`,
  (me) => `Home safe! ${me} deserves a nap.`,
  (me) => `${me} parks a token. Valet not included.`,
  (me) => `Ding ding! ${me} is home!`,
  (me) => `Another one home for ${me}. Show off!`,
];

export const COMBINE_LINES = [
  (me, sum) => `${me} goes big: ${sum} squares!`,
  (me, sum) => `Both dice, one token, ${sum} squares. Bold!`,
  (me, sum) => `${me} does math! That's ${sum}!`,
  (me, sum) => `Zoom! ${me} sprints ${sum} squares.`,
  (me, sum) => `${me} cashes in both dice. ${sum}!`,
  (me, sum) => `${sum} squares? ${me} is in a hurry.`,
  (me, sum) => `${me} adds it up and floors it!`,
  (me, sum) => `Big brain move: ${sum} for ${me}.`,
];

export const SAFE_LINES = [
  (me) => `${me} hides on a safe square.`,
  (me) => `Safe! Nobody touches ${me} there.`,
  (me) => `${me} found the cozy spot.`,
  (me) => `Ducking for cover, ${me} style.`,
  (me) => `${me} is basically invisible now.`,
  (me) => `Force field on! ${me} is safe.`,
  (me) => `${me} plays it cool and safe.`,
  (me) => `Untouchable! Well, on that square.`,
];

export const PLAIN_LINES = [
  (me, n) => `${me} scoots ahead ${n}.`,
  (me, n) => `${me} shuffles forward ${n}. Thrilling.`,
  (me, n) => `${me} moves ${n}. Sports!`,
  (me, n) => `A humble ${n} for ${me}.`,
  (me, n) => `${me} inches along. ${n} squares.`,
  (me, n) => `${n} squares closer to glory!`,
  (me, n) => `${me} strolls ${n}. No rush.`,
  (me, n) => `${me} takes a little ${n}-step.`,
  (me, n) => `Progress! ${me} advances ${n}.`,
  (me, n) => `${me} waddles ${n} squares.`,
];

// The obvious move: only one piece can go, so the game plays it for you.
export const FORCED_LINES = [
  (me) => `Only one move. ${me} had no choice!`,
  (me) => `Forced move! Choice? What choice?`,
  (me) => `One option, zero drama. Done!`,
  (me) => `${me} had one move. Democracy is dead.`,
  (me) => `The dice decided. ${me} just follows.`,
  (me) => `Obvious move is obvious!`,
  (me) => `${me} plays the only card in the deck.`,
  (me) => `Autopilot on! Only one way to go.`,
  (me) => `No thinking needed. ${me} moves.`,
  (me) => `${me} was going to do that anyway!`,
];

export const NO_MOVE_LINES = [
  (me) => `${me} has nothing. Awkward silence.`,
  (me) => `${me} stares at the dice. Dice stare back.`,
  (me) => `Stuck! ${me} passes.`,
  (me) => `${me} can't move. Tragic.`,
  (me) => `Nothing to play. ${me} whistles casually.`,
  (me) => `${me} shrugs and passes.`,
  (me) => `No moves! ${me} blames the dice.`,
  (me) => `${me} is stuck. Truly stuck.`,
];

// A lone piece is forced to use both dice, so it can't stop and eat halfway —
// it jumps clean over whoever it could have eaten with one die.
export const JUMP_LINES = [
  (me, opp) => `${me} hops right over ${opp}. No snacking mid-run!`,
  (me, opp) => `${me} jumps ${opp}. A lone token can't eat and run.`,
  (me, opp) => `Too fast to stop! ${me} leaps past ${opp}.`,
  (me, opp) => `${opp} waves as ${me} zooms by.`,
];

export const FORFEIT_LINES = [
  (me) => `Three sixes in a row! ${me} loses the turn.`,
  (me) => `Triple 6-6? Greedy! ${me} forfeits.`,
  (me) => `The dice say no more, ${me}. Turn over!`,
  (me) => `${me} got too lucky. Turn forfeited!`,
];

export const CAPTURE_LABELS = ["CAPTURED!", "SENT HOME!", "OBLITERATED!", "SMASHED!", "DEVOURED!", "NOM NOM NOM!"];
export const MULTI_CAPTURE_LABEL = { 2: "DOUBLE KILL!", 3: "TRIPLE KILL!", 4: "RAMPAGE!" };
