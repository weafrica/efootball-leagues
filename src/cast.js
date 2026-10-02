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
};

// Which story voice belongs to which cast member. The narrator IS "you".
const VOICE_TO_CAST = { narrator: "player", marcus: "marcus", chidi: "chidi", coach: "coach", mystery: "mystery", keeper: "keeper" };

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
