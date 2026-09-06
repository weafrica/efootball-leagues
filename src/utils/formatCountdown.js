// src/utils/formatCountdown.js
//
// Shared "Xd Xh left" / "Xh left" / "Xm left" countdown formatter — was two
// near-identical local functions (LeagueDetail.jsx's Ladder Cup opponent
// deadline text, LeagueLadderDetail.jsx's League Ladder fixture countdown),
// promoted here so the League Ladder homepage work (banner countdown, nav
// badge tooltip, fixtures-list copy — all reading the same
// countdown_expires_at) has one function to call instead of a third
// copy-pasted version.
//
// The two originals differed in three small ways, all kept as options
// below so neither existing call site's on-screen text changes:
//   - LeagueLadderDetail's read Date.now() itself; LeagueDetail's took a
//     ticking `now` from its parent (LadderCupOpponentBoard's own
//     setInterval) so every row on that board re-renders off one shared
//     clock instead of each row polling its own. `now` defaults to
//     Date.now() here so a caller that doesn't have one (League Ladder's
//     case) doesn't have to fake it.
//   - the label once time's already up: "Expired" (League Ladder — a
//     pending fixture past its countdown, ahead of the hourly/Sunday
//     forfeit sweep actually catching it) vs "Overdue" (Ladder Cup's pool
//     visibility window).
//   - whether the 1-24h bucket also shows minutes ("3h left" vs
//     "3h 42m left") and whether the under-1h bucket can ever read "0m
//     left" or always shows at least 1m. League Ladder's original never
//     showed minutes alongside hours and floored at 1m; Ladder Cup's
//     showed both and had no floor.
//
// Both buckets are computed off the same floor(ms/60000) minute count
// either way — `showMinutesWithHours`/`minMinutes` only change how that
// count gets displayed, not the underlying math, so switching a call site
// between the two "flavors" is just an options change, never a behavior
// surprise.
//
// deadline: a Date/ISO-string/epoch, or null/undefined (returns null —
// callers only render this for rows that actually have a deadline set).
export function formatCountdown(deadline, {
  now = Date.now(),
  expiredLabel = "Expired",
  showMinutesWithHours = false,
  minMinutes = 1,
} = {}) {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - new Date(now).getTime();
  if (ms <= 0) return expiredLabel;

  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return showMinutesWithHours ? `${hours}h ${minutes}m left` : `${hours}h left`;
  return `${Math.max(minMinutes, minutes)}m left`;
}
