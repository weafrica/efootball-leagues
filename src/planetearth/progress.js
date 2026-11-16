// Planet Earth — small helpers about a player's progress (used by the hub and the certificate).
import { LEVELS, SHIP_CRYSTALS } from './lessons.js';
import { heartStage } from './story.js';
export const crystalsOf = (save) => LEVELS.filter((l) => save.levels && save.levels[l.id] && save.levels[l.id].stars > 0).length;
export const starsOf = (save) => LEVELS.reduce((a, l) => a + ((save.levels && save.levels[l.id] && save.levels[l.id].stars) || 0), 0);
export function certificateStats(save, streak = 0) {
  const crystals = crystalsOf(save), stars = starsOf(save);
  return { name: save.name, color: save.color, crystals, total: SHIP_CRYSTALS, stars, maxStars: LEVELS.length * 3, heart: heartStage(crystals), streak, finished: !!save.epilogue };
}
