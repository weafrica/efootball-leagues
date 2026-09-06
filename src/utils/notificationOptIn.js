// Contextual notification opt-in — when to ask, what to say, and how often
// to keep asking.
//
// Problem this replaces: the app used to call Notification.requestPermission()
// cold, the moment someone signed in (see App.jsx's sessionKey effect) or the
// moment they joined a Rapid Cup lobby (RapidCupBanner). A bare browser
// permission popup with zero context is exactly what makes people reflexively
// tap "Block" — and once a browser records "denied", no page can ever show
// that native prompt again for that origin. So instead:
//
//   1. We only ever show OUR OWN explanatory card first (NotificationOptInPrompt.jsx).
//      The real browser prompt only fires after someone taps "Turn on" on
//      that card — i.e. after they've already said yes once.
//   2. We pick genuinely relevant moments to show that card (see REASONS
//      below) instead of interrupting at signup.
//   3. If they dismiss it, we back off for a while and try again at the next
//      good moment — but we stop forever once permission is actually
//      "granted", and we stop asking (there's nothing left to ask) once the
//      browser itself reports "denied".
//
// State is small and per-user (scoped by user id, so a shared/public device
// signing in as someone else doesn't inherit another person's dismissals),
// kept in localStorage so it survives reloads and app restarts.

const STORAGE_PREFIX = "efootball_notif_optin:";
const RE_ASK_COOLDOWN_MS = 4 * 24 * 60 * 60 * 1000; // ~4 days between asks

// Copy for each moment we might ask. Keep these short — the card has
// limited room — the longer "why" lives in `details`.
export const REASONS = {
  new_week: {
    headline: "Don't miss this week's action",
    body: "A new week just kicked off — fixtures, ladder moves, and lobbies are already filling up.",
    benefits: [
      "Know the moment your next fixture is ready",
      "Get a heads-up before a Ladder move window closes",
      "Catch a Rapid Cup lobby before it fills",
    ],
  },
  joined_league: {
    headline: "Stay on top of your new league",
    body: "You just joined — turn on notifications so you don't miss what happens next.",
    benefits: [
      "See new members joining as they sign up",
      "Get notified the moment fixtures are posted",
      "Never miss a result waiting on your confirmation",
    ],
  },
  joined_cup: {
    headline: "Stay on top of your Cup",
    body: "You're in — turn on notifications so you're first to know what happens in this Cup.",
    benefits: [
      "Get a nudge when it's your turn to play",
      "Know as soon as new members/clubs join",
      "Hear about it the second a match kicks off",
    ],
  },
  new_member: {
    headline: "Someone just joined your league",
    body: "Turn on notifications to see who's joining your leagues and cups as it happens.",
    benefits: [
      "Get notified every time someone new joins",
      "Never miss a fixture once the league fills up",
      "Stay a step ahead of the competition",
    ],
  },
  generic: {
    headline: "Turn on notifications",
    body: "Get a heads-up for the moments that actually need you — fixtures, results, and new members.",
    benefits: [
      "Fixtures and results, the moment they're ready",
      "New members joining your leagues and cups",
      "Countdown alerts before lobbies and deadlines close",
    ],
  },
};

// The longer explanation shown behind "Why enable notifications?" — same
// for every reason, since the underlying pitch (why this is good for you)
// doesn't change moment to moment.
export const NOTIFICATION_DETAILS =
  "Notifications only cover things that need you specifically — a fixture " +
  "that's ready, a result waiting on your confirmation, a new member joining " +
  "your league or cup, or a countdown about to run out. We don't send " +
  "marketing pings, and you can turn them off again any time from your " +
  "browser or phone settings. Most people miss a match or a closing lobby " +
  "at least once before turning this on — enabling it now means that " +
  "doesn't happen to you.";

function storageKey(userId) {
  return `${STORAGE_PREFIX}${userId || "anon"}`;
}

function readState(userId) {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeState(userId, state) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(state));
  } catch {
    // Best-effort — a full/blocked localStorage just means we might ask
    // again sooner than ideal, never a functional break.
  }
}

// 'unsupported' | 'granted' | 'denied' | 'default'
export function getNotificationPermissionState() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

// Should we show our own explanatory card right now? False once granted
// (nothing left to ask) or denied (browser will never show the native
// prompt again for this origin, so asking again would just be a dead end —
// the UI can still explain how to flip it back on in browser settings, but
// that's a different, quieter surface, not this repeated interruption).
export function shouldOfferNotificationOptIn(userId) {
  const permission = getNotificationPermissionState();
  if (permission !== "default") return false;
  const state = readState(userId);
  if (!state.lastShownAt) return true;
  return Date.now() - state.lastShownAt >= RE_ASK_COOLDOWN_MS;
}

export function recordNotificationOptInShown(userId, reason) {
  const state = readState(userId);
  writeState(userId, {
    ...state,
    lastShownAt: Date.now(),
    lastReason: reason,
    timesShown: (state.timesShown || 0) + 1,
  });
}

// Marks the current ISO week (Mon-based) as "seen" for the new_week trigger
// and reports whether this is the first time we've noticed this week —
// i.e. whether the new_week card should fire. Call this once per app
// session load; it's cheap and idempotent within the same week.
export function checkAndMarkNewWeek(userId) {
  const week = isoWeekKey(new Date());
  const state = readState(userId);
  if (state.lastSeenWeek === week) return false;
  writeState(userId, { ...state, lastSeenWeek: week });
  return !!state.lastSeenWeek; // false on a person's very first-ever visit
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${weekNum}`;
}
