# "Eliminated — Unless You Revive" — animation concepts (future plan)

Status: idea-gathering only. Nothing here is built yet — no code, no
assets. Every idea below is buildable with CSS keyframes / SVG (`stroke-
dasharray`, `<animate>`) / a Tabler icon, same constraints as the rest of
this app: no image or video assets, no paid libraries.

Target: `LadderCupSecondLifeOffer` in `src/LeagueDetail.jsx` — the card a
club sees the moment it's eliminated-unless-revived (see the win-scaled
fee work, `20260915_ladder_cup_win_scaled_fees.sql`).

## The idea that started this: fired manager

A manager figure (simple SVG — circle head, rectangle suit body) walks off
alone toward a stadium exit silhouette, shoulders visibly drooping
(`transform: rotate()` on the whole figure, slight downward drift). Sad,
personal, and specific to football in a way most of the other ideas
aren't — leans on "you're the manager who just got sacked" rather than a
generic game-over screen.

## Football-specific

- **Red card slow-motion.** A referee's arm (SVG) rises and holds a red
  rectangle that scales up and rotates slightly as it "flies toward
  camera," like a slow-mo replay. On-brand with zero explanation needed.
- **VAR review freeze-frame.** Screen desaturates (`filter: grayscale`), a
  scanning line sweeps top to bottom, broadcast-style corner brackets
  animate in, then everything flashes red and "ELIMINATED" stamps down —
  like a VAR decision being confirmed.
- **Stadium floodlights cutting off.** A row of small circles (floodlights)
  turn off one by one left-to-right via staggered `animation-delay`,
  ending with just one spotlight left on the Revive button.
- **Locker room door swings shut.** A CSS rectangle "door" slams closed
  with a shadow, padlock icon appears — then on hover/focus creaks back
  open with light spilling through, hinting at Revive before you tap it.

## Video-game classics

- **Arcade "CONTINUE?" countdown.** Retro "GAME OVER" flash, then a coin
  (SVG circle, `rotateY` flip to fake a spin) and a "10…9…8…" countdown —
  classic arcade-cabinet continue screen. The countdown can double as a
  visible cue for the actual response deadline.
- **Boss HP bar drains to zero.** A horizontal bar visibly drains, shakes
  at empty, cracks. Tapping Revive refills it back up with a snap. Very
  broadly game-literate — everyone who's played anything reads an empty
  red bar instantly.
- **Bracket elimination stamp.** Big red "X" or "OUT" rubber-stamps down
  with a scale+rotate bounce and a slight screen shake, esports-bracket
  style. Blunter and punchier than the more melancholy options.

## Body / vital-sign metaphor

- **Flatlining heart monitor.** Extends the heartbeat pulse already on
  this card. An SVG ECG line beeps normally, then flattens into a straight
  red line as the heart icon dims. Revive triggers a "CLEAR!" defibrillator
  jolt (lightning-bolt SVG flash) and the line jumps back to a beat.
  Cheapest to build — the heartbeat animation already exists, this extends
  it rather than starting fresh.
- **Fade to ghost.** The club's heart/crest icon slowly desaturates and
  goes translucent with a slow upward drift, like a spirit leaving. Revive
  reverses it with a glow ripple pulling it back to full color. Quieter and
  more haunting than the vital-sign version.

## Environmental / mood metaphor

- **Ash instead of confetti.** The mirror image of a win-celebration
  confetti burst, if one ever gets built: grey/ember particles drifting
  downward instead of colorful ones flying up. Reuses the same
  particle-system code, just re-skinned and reversed — cheap once either
  side exists.
- **Ember-to-phoenix reassembly.** The app's rebirth copy already leans
  phoenix ("RISEN FROM THE ASHES," "PHOENIX MOMENT" — see
  `rebirthAnnouncement`, `src/formats/ladderCup.js`). Animate the
  heart/crest crumbling into floating embers on elimination, then on
  Revive, the embers sweep upward and an SVG phoenix outline draws itself
  in (`stroke-dasharray` reveal). Ties the visual most tightly to language
  already shipped.

## Broadcast-style

- **Breaking-news ticker.** A red "ELIMINATED" banner slides in like a
  live sports lower-third, with a glitch/scanline flicker on the text
  (`text-shadow` offset animation + `clip-path` steps). Feels like real
  sports coverage rather than a game UI — may suit "Survival Ladder Cup"
  branding better than something more cartoonish.
- **Digital scoreboard flicker.** A 7-segment-style "FULL TIME —
  ELIMINATED" readout with individual bulbs flickering on/off via
  randomized opacity keyframes. Stadium-authentic, pairs naturally with a
  countdown clock for the decision deadline.

## Open questions for whichever direction gets picked

- Does the chosen animation replace the current pulsing-heart HUD element
  entirely, or run alongside it?
- Should the Revive button itself react (pulse, glow) once the
  elimination animation finishes, to draw the eye to the one action
  available?
- Tone check: several of these (fired manager, flatline, ghost fade) are
  melancholy; several (arcade continue, HP bar, bracket stamp) are punchy
  and game-y. Worth picking one register rather than mixing — a sad
  manager next to an arcade coin animation would feel inconsistent.
