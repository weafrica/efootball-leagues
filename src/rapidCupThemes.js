// src/rapidCupThemes.js
//
// RAPID CUP — PER-CUP VISUAL IDENTITY
//
// Requested: every Rapid Cup should feel different from the last one —
// its own name, its own color palette, its own font — rather than every
// cup looking and being called the same thing. This mirrors
// ladderTierThemes.js's getLadderTierTheme(tier) exactly: a fixed list of
// distinct identities, cycled by a number, so neighboring cups never
// collide even though an endless run of cups can't have endless unique
// looks. Rapid Cup gets its own set of names/colors rather than reusing
// the Ladder's — same mechanism, different identity, so a Rapid Cup never
// gets mistaken for a League Ladder tier at a glance.
//
// `cup_number` (rapid_cup_lobbies.cup_number, a plain incrementing
// sequence set when the lobby row is created — see the
// 20260903230000_rapid_cup_themes migration) is what's cycled on, the
// same role `tier` plays for the ladder. generate_rapid_cup_bracket names
// the league after this same theme server-side, so the theme picked here
// on the client always matches what's actually in the league's name.
export const RAPID_CUP_THEMES = [
  // 1 — Neon Blitz: electric pink/purple, fast and loud.
  {
    name: "Neon Blitz",
    font: "'Baloo 2', 'Barlow Condensed', sans-serif",
    bg: "#120616", surface: "rgba(232,64,220,0.08)", surfaceHover: "rgba(232,64,220,0.16)",
    border: "rgba(232,64,220,0.3)", borderStrong: "rgba(232,64,220,0.55)", text: "#FCE8FB",
    textDim: "rgba(252,232,251,0.62)", textFaint: "rgba(252,232,251,0.4)", accent: "#E840DC",
    accentText: "#120616", green: "#3FBF8F", greenSoft: "rgba(63,191,143,0.3)", greenText: "#A6EFCF",
    red: "#FF5C7A", redSoft: "rgba(255,92,122,0.25)", toastBg: "#FCE8FB", toastText: "#120616",
  },
  // 2 — Inferno Rush: fire orange/red on near-black, aggressive and hot.
  {
    name: "Inferno Rush",
    font: "'Oswald', 'Barlow Condensed', sans-serif",
    bg: "#160805", surface: "rgba(255,90,31,0.09)", surfaceHover: "rgba(255,90,31,0.18)",
    border: "rgba(255,90,31,0.32)", borderStrong: "rgba(255,90,31,0.56)", text: "#FFEDE3",
    textDim: "rgba(255,237,227,0.62)", textFaint: "rgba(255,237,227,0.4)", accent: "#FF5A1F",
    accentText: "#160805", green: "#3FBF6F", greenSoft: "rgba(63,191,111,0.3)", greenText: "#A6EFC0",
    red: "#FF3B3B", redSoft: "rgba(255,59,59,0.25)", toastBg: "#FFEDE3", toastText: "#160805",
  },
  // 3 — Storm Surge: electric blue/white, lightning-fast.
  {
    name: "Storm Surge",
    font: "'Share Tech Mono', 'JetBrains Mono', monospace",
    bg: "#040B18", surface: "rgba(64,138,255,0.08)", surfaceHover: "rgba(64,138,255,0.16)",
    border: "rgba(64,138,255,0.3)", borderStrong: "rgba(64,138,255,0.55)", text: "#E4EEFF",
    textDim: "rgba(228,238,255,0.62)", textFaint: "rgba(228,238,255,0.4)", accent: "#408AFF",
    accentText: "#040B18", green: "#2FBF88", greenSoft: "rgba(47,191,136,0.3)", greenText: "#8CF2CC",
    red: "#FF5C7A", redSoft: "rgba(255,92,122,0.25)", toastBg: "#E4EEFF", toastText: "#040B18",
  },
  // 4 — Golden Strike: black and gold, the prestige/high-stakes look.
  {
    name: "Golden Strike",
    font: "'Cinzel', 'Barlow Condensed', serif",
    bg: "#0C0A05", surface: "rgba(255,199,44,0.08)", surfaceHover: "rgba(255,199,44,0.16)",
    border: "rgba(255,199,44,0.3)", borderStrong: "rgba(255,199,44,0.55)", text: "#FBF2DD",
    textDim: "rgba(251,242,221,0.62)", textFaint: "rgba(251,242,221,0.4)", accent: "#FFC72C",
    accentText: "#0C0A05", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.35)", greenText: "#7FC9A2",
    red: "#D8443A", redSoft: "rgba(216,68,58,0.25)", toastBg: "#FBF2DD", toastText: "#0C0A05",
  },
  // 5 — Toxic Overdrive: acid green/black, chaotic underdog energy.
  {
    name: "Toxic Overdrive",
    font: "'Montserrat', 'Work Sans', sans-serif",
    bg: "#070E05", surface: "rgba(173,255,47,0.08)", surfaceHover: "rgba(173,255,47,0.16)",
    border: "rgba(173,255,47,0.3)", borderStrong: "rgba(173,255,47,0.55)", text: "#EFFFDF",
    textDim: "rgba(239,255,223,0.62)", textFaint: "rgba(239,255,223,0.4)", accent: "#ADFF2F",
    accentText: "#070E05", green: "#ADFF2F", greenSoft: "rgba(173,255,47,0.3)", greenText: "#D6FFA8",
    red: "#FF4D6D", redSoft: "rgba(255,77,109,0.25)", toastBg: "#EFFFDF", toastText: "#070E05",
  },
  // 6 — Midnight Duel: deep indigo/silver, cold and dramatic.
  {
    name: "Midnight Duel",
    font: "'Bitter', 'Work Sans', serif",
    bg: "#080816", surface: "rgba(150,160,220,0.08)", surfaceHover: "rgba(150,160,220,0.16)",
    border: "rgba(150,160,220,0.3)", borderStrong: "rgba(150,160,220,0.55)", text: "#EAEAFA",
    textDim: "rgba(234,234,250,0.62)", textFaint: "rgba(234,234,250,0.4)", accent: "#A6B0F0",
    accentText: "#080816", green: "#3FBF8F", greenSoft: "rgba(63,191,143,0.3)", greenText: "#A6EFCF",
    red: "#FF5C7A", redSoft: "rgba(255,92,122,0.25)", toastBg: "#EAEAFA", toastText: "#080816",
  },
];

// getRapidCupTheme(cupNumber) — cupNumber is 1-indexed (the Nth Rapid Cup
// lobby ever created); null/undefined/loading falls back to the first
// theme rather than throwing, same reasoning as getLadderTierTheme.
export function getRapidCupTheme(cupNumber) {
  if (!cupNumber || cupNumber < 1) return RAPID_CUP_THEMES[0];
  return RAPID_CUP_THEMES[(cupNumber - 1) % RAPID_CUP_THEMES.length];
}
