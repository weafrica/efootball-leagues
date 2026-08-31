// src/ladderTierThemes.js
//
// LEAGUE LADDER — PER-TIER VISUAL IDENTITY
//
// Requested: every League Ladder tier (League 1, League 2, League 3...)
// should look, read, and feel different from the others — its own color
// palette, its own font, its own accent shape — rather than every tier
// sharing one identical theme. This module is the single source of truth
// for that: LeagueLadderDetail.jsx (the standings/fixtures page) and
// LeagueLadderQuickBanner/LadderWeekendCard in App.jsx (the Home widget)
// all pull from getLadderTierTheme(tier) instead of hardcoding a look, so
// the widget and the page always agree on "what League N looks like".
//
// Each theme keeps the exact same key shape as THEMES.dark/LADDER_THEME
// (bg/surface/border/text/accent/etc.) so it can be dropped in as a
// straight replacement for the `c` prop anywhere those components already
// thread it through. `font` is the one new key — the page/widget apply it
// as the container's fontFamily so every label, number and button in that
// tier inherits it without touching each element by hand.
//
// Six distinct identities, cycling: tier 7 looks like tier 1 again, tier 8
// like tier 2, etc. — an infinite ladder can't have infinite unique looks,
// but neighboring tiers (1 vs 2, 6 vs 7) never collide, which is what
// actually matters for "which league am I looking at right now".
export const LADDER_TIER_THEMES = [
  // 1 — Imperial Gold: the top tier, black-and-gold, ornate serif. Reuses
  // the same family as the old Survival Ladder Cup's LADDER_THEME since
  // "gold = the top of a ladder" is already the app's own visual language.
  {
    name: "Imperial Gold",
    font: "'Cinzel', 'Barlow Condensed', serif",
    bg: "#0A0806", surface: "rgba(232,185,35,0.07)", surfaceHover: "rgba(232,185,35,0.14)",
    border: "rgba(232,185,35,0.28)", borderStrong: "rgba(232,185,35,0.5)", text: "#F5EEDC",
    textDim: "rgba(245,238,220,0.62)", textFaint: "rgba(245,238,220,0.4)", accent: "#E8B923",
    accentText: "#0A0806", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.35)", greenText: "#7FC9A2",
    red: "#C81E3A", redSoft: "rgba(200,30,58,0.25)", toastBg: "#F5EEDC", toastText: "#0A0806",
  },
  // 2 — Crimson Command: bold condensed sans, deep red on charcoal, harder
  // and more "military" than League 1's ornate gold.
  {
    name: "Crimson Command",
    font: "'Oswald', 'Barlow Condensed', sans-serif",
    bg: "#150B0C", surface: "rgba(224,49,49,0.08)", surfaceHover: "rgba(224,49,49,0.16)",
    border: "rgba(224,49,49,0.3)", borderStrong: "rgba(224,49,49,0.55)", text: "#F3E7E7",
    textDim: "rgba(243,231,231,0.62)", textFaint: "rgba(243,231,231,0.4)", accent: "#E03131",
    accentText: "#150B0C", green: "#3C8A5B", greenSoft: "rgba(60,138,91,0.3)", greenText: "#8FD8AA",
    red: "#FF8787", redSoft: "rgba(255,135,135,0.25)", toastBg: "#F3E7E7", toastText: "#150B0C",
  },
  // 3 — Cyber Grid: monospace HUD look, neon cyan on near-black navy.
  {
    name: "Cyber Grid",
    font: "'Share Tech Mono', 'JetBrains Mono', monospace",
    bg: "#060B12", surface: "rgba(34,211,238,0.07)", surfaceHover: "rgba(34,211,238,0.14)",
    border: "rgba(34,211,238,0.28)", borderStrong: "rgba(34,211,238,0.5)", text: "#DFFBFF",
    textDim: "rgba(223,251,255,0.6)", textFaint: "rgba(223,251,255,0.38)", accent: "#22D3EE",
    accentText: "#060B12", green: "#2FBF88", greenSoft: "rgba(47,191,136,0.3)", greenText: "#8CF2CC",
    red: "#F43F5E", redSoft: "rgba(244,63,94,0.25)", toastBg: "#DFFBFF", toastText: "#060B12",
  },
  // 4 — Ranger Forest: earthy slab serif, forest green on warm tan/brown —
  // the "grounded, working-your-way-up" tier, deliberately unflashy.
  {
    name: "Ranger Forest",
    font: "'Bitter', 'Work Sans', serif",
    bg: "#0E140F", surface: "rgba(122,168,116,0.08)", surfaceHover: "rgba(122,168,116,0.16)",
    border: "rgba(122,168,116,0.3)", borderStrong: "rgba(122,168,116,0.52)", text: "#E9F0E6",
    textDim: "rgba(233,240,230,0.62)", textFaint: "rgba(233,240,230,0.4)", accent: "#7AA874",
    accentText: "#0E140F", green: "#7AA874", greenSoft: "rgba(122,168,116,0.3)", greenText: "#C4E0BE",
    red: "#D97757", redSoft: "rgba(217,119,87,0.25)", toastBg: "#E9F0E6", toastText: "#0E140F",
  },
  // 5 — Blaze Arcade: playful rounded display font, orange/lime — the most
  // "gamified" tier, meant to feel loud and a little chaotic. (Previously
  // violet/pink — swapped out per request to keep purple and pink off the
  // ladder's palette entirely.)
  {
    name: "Blaze Arcade",
    font: "'Baloo 2', 'Barlow Condensed', sans-serif",
    bg: "#1A0C05", surface: "rgba(255,140,66,0.08)", surfaceHover: "rgba(255,140,66,0.16)",
    border: "rgba(255,140,66,0.3)", borderStrong: "rgba(255,140,66,0.55)", text: "#FFF0DD",
    textDim: "rgba(255,240,221,0.62)", textFaint: "rgba(255,240,221,0.4)", accent: "#D8FF4D",
    accentText: "#1A0C05", green: "#3FBF6F", greenSoft: "rgba(63,191,111,0.3)", greenText: "#A6EFC0",
    red: "#FF6B4A", redSoft: "rgba(255,107,74,0.25)", toastBg: "#FFF0DD", toastText: "#1A0C05",
  },
  // 6 — Glacier Steel: clean minimal sans, ice blue on deep navy — the
  // deliberate opposite of League 5's noise, cold and clinical. (Previously
  // a near-white background — swapped to a dark navy so no ladder tier
  // renders on a white surface.)
  {
    name: "Glacier Steel",
    font: "'Montserrat', 'Work Sans', sans-serif",
    bg: "#081824", surface: "rgba(56,163,224,0.08)", surfaceHover: "rgba(56,163,224,0.16)",
    border: "rgba(56,163,224,0.3)", borderStrong: "rgba(56,163,224,0.55)", text: "#DCEFFB",
    textDim: "rgba(220,239,251,0.62)", textFaint: "rgba(220,239,251,0.4)", accent: "#38A3E0",
    accentText: "#081824", green: "#2FA36B", greenSoft: "rgba(47,163,107,0.3)", greenText: "#9FE3C0",
    red: "#E14B4B", redSoft: "rgba(225,75,75,0.25)", toastBg: "#DCEFFB", toastText: "#081824",
  },
];

// getLadderTierTheme(tier) — tier is 1-indexed (League 1, League 2, ...);
// null/undefined tier (not loaded yet, or viewing outside a specific
// league) falls back to the League 1 look rather than throwing, since
// every caller here already renders fine with a placeholder theme while
// its own tier fetch is still in flight.
export function getLadderTierTheme(tier) {
  if (!tier || tier < 1) return LADDER_TIER_THEMES[0];
  return LADDER_TIER_THEMES[(tier - 1) % LADDER_TIER_THEMES.length];
}
