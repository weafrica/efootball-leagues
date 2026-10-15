// The cast — who looks like whom. Every character is just data fed to the
// one SVG rig in PlayerCharacter.jsx (no per-character art), so adding a
// person to a story is a few lines here, not an illustration job.
//
// "player" has no kit colour on purpose: Stage.jsx dresses them in the
// app's own accent colour so "you" match the rest of Matchday.
export const CAST = {
  player:  { name: "You", skin: "#8d5524", hair: "#151515", hairStyle: "short", pants: "#1f3a5f" },
  marcus:  { name: "Marcus", callLabel: "Marcus", skin: "#a86b3c", hair: "#151515", hairStyle: "short",
             kitColor: "#1e2a47", sleeve: "#1e2a47", pants: "#1e2a47", shoes: "#0d0d0d", accessory: "tie", accent: "#d9534f" },
  chidi:   { name: "Chidi", skin: "#5b3720", hair: "#0e0e0e", hairStyle: "afro",
             kitColor: "#e67e22", pants: "#274b6e", accessory: "headband", accent: "#ffffff" },
  coach:   { name: "Coach Dabiri", skin: "#7b4a2a", hair: "#d8d8d8", hairStyle: "short",
             kitColor: "#4b5563", sleeve: "#4b5563", pants: "#374151", accessory: "whistle" },
  mystery: { name: "???", callLabel: "Unknown number", silhouette: true },
  keeper:  { name: "Youth keeper", skin: "#b57c4b", hair: "#1a1a1a", hairStyle: "short",
             kitColor: "#f1c40f", sleeve: "#f1c40f", pants: "#2c3e50", accessory: "gloves" },
  kitman:  { name: "Kit man", skin: "#8a5a35", hair: "#bdbdbd", hairStyle: "cap", accent: "#2d7d46",
             kitColor: "#c6d82e", pants: "#39424e", accessory: "vest" },
  physio:  { name: "Physio", skin: "#c68e5d", hair: "#222222", hairStyle: "short",
             kitColor: "#1abc9c", pants: "#39424e", accessory: "medic" },
  reserve: { name: "Reserve", skin: "#6a4227", hair: "#111111", hairStyle: "short", kitColor: "#7f8c8d", pants: "#2c3e50" },
  reserve2:{ name: "Reserve", skin: "#9a643a", hair: "#111111", hairStyle: "cap", accent: "#8e44ad", kitColor: "#7f8c8d", pants: "#2c3e50" },
  friend:  { name: "Friend", skin: "#7a4a2a", hair: "#111111", hairStyle: "afro", kitColor: "#e84393", pants: "#34495e" },
  reporter:{ name: "Reporter", skin: "#946235", hair: "#111111", hairStyle: "short",
             kitColor: "#2c3e50", sleeve: "#2c3e50", pants: "#1b1b1b", accessory: "mic" },
  reporter2:{ name: "Reporter", skin: "#5f3b22", hair: "#111111", hairStyle: "afro",
             kitColor: "#8e44ad", sleeve: "#8e44ad", pants: "#1b1b1b", accessory: "mic" },
  dog:     { name: "", animal: "dog" },

  // ---- Mossbridge United (story 2) ----
  // "you" in that story is the American coach; the story sets
  // graph.player = "coach_you" and Stage dresses the player slot with this.
  coach_you: { name: "You", skin: "#d9a066", hair: "#8a8a8a", hairStyle: "cap", accent: "#c0392b",
               kitColor: "#1f5f8b", sleeve: "#1f5f8b", pants: "#2b3a4a", accessory: ["whistle"] },
  maggie:  { name: "Maggie Thornfield", skin: "#f1c9a5", hair: "#7a2e1d", hairStyle: "bob",
             kitColor: "#6d1f3a", sleeve: "#6d1f3a", pants: "#1b1b1b", shoes: "#111", accessory: ["pearls"] },
  priya:   { name: "Priya", skin: "#a8693f", hair: "#0d0d0d", hairStyle: "long", accent: "#e63946",
             kitColor: "#1d3557", sleeve: "#1d3557", pants: "#1d3557", accessory: ["lanyard", "clipboard"] },
  stu:     { name: "Big Stu", skin: "#e2b48f", hair: "#5a3a22", hairStyle: "short", build: "broad",
             kitColor: "#b3202a", pants: "#f1f1f1", shoes: "#111" },
  femi:    { name: "Femi", skin: "#4a2c1a", hair: "#0e0e0e", hairStyle: "short", build: "slim",
             kitColor: "#b3202a", pants: "#f1f1f1", shoes: "#111" },
  doreen:  { name: "Doreen", skin: "#e8c4a0", hair: "#cfcfcf", hairStyle: "bun",
             kitColor: "#b0668a", pants: "#4a4a58", accessory: ["mug", "glasses"] },
  gideon:  { name: "Gideon", skin: "#f0c8a0", hair: "#3a3a3a", hairStyle: "short", build: "broad", accent: "#d4af37",
             kitColor: "#1a1a22", sleeve: "#1a1a22", pants: "#1a1a22", shoes: "#0d0d0d", accessory: ["tie"] },
  wilf:    { name: "Wilf", skin: "#e2b48f", hair: "#a8a8a8", hairStyle: "short", build: "broad",
             kitColor: "#2e9e57", sleeve: "#2e9e57", pants: "#1d1d1d", shoes: "#111", accessory: ["gloves"] },
  fan:     { name: "Local", skin: "#946235", hair: "#222222", hairStyle: "afro", accent: "#b3202a",
             kitColor: "#2b2b33", pants: "#34495e", accessory: ["scarf"] },
  fan2:    { name: "Local", skin: "#e8c4a0", hair: "#9a9a9a", hairStyle: "cap", accent: "#7f8c8d",
             kitColor: "#5d6d4a", pants: "#3b3b3b", accessory: ["scarf"] },
};

// Which story voice belongs to which cast member. The narrator IS "you".
const VOICE_TO_CAST = {
  narrator: "player", marcus: "marcus", chidi: "chidi", coach: "coach", mystery: "mystery", keeper: "keeper",
  // Mossbridge United
  maggie: "maggie", priya: "priya", stu: "stu", femi: "femi", doreen: "doreen", gideon: "gideon", wilf: "wilf",
  keith: "keith", // radio host — heard, never seen (no CAST entry on purpose, so castForNode drops him)
};

// Who is physically standing in this scene?
//  - node.cast (explicit list) wins — needed for phone calls, where
//    Marcus SPEAKS but isn't there (see node.call instead).
//  - otherwise: everyone who has a spoken line in the node.
export function castForNode(node) {
  const ids = Array.isArray(node.cast)
    ? node.cast.slice()
    : (node.lines || []).map((l) => VOICE_TO_CAST[l.voice]).filter((id) => id && id !== "player");
  return [...new Set(ids)].filter((id) => CAST[id]);
}

// Which of them are talking right now (gets the mouth/gesture animation).
export function speakingIds(node) {
  return new Set((node.lines || []).map((l) => VOICE_TO_CAST[l.voice]).filter(Boolean));
}
