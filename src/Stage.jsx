import React from "react";
import SceneBackground from "./SceneBackground.jsx";
import PlayerCharacter from "./PlayerCharacter.jsx";
import { CAST, castForNode, speakingIds } from "./cast.js";

// Stage — puts the right characters in the right place for a node, on
// the right background. This is the piece that turns "one character
// bobbing in a box" into an actual scene: everyone who has a line stands
// in it, "you" wears the app's own accent colour, and whoever's talking
// gets the talking animation while everyone else idles.
export default function Stage({ node, playerPose = "idle", accentColor = "#2f6f4f" }) {
  const ids = castForNode(node);
  const speaking = speakingIds(node);
  const hasPlayer = ids.includes("player") || (!node.cast && (node.scene?.pose ?? true));
  const others = ids.filter((id) => id !== "player");
  const everyone = hasPlayer ? ["player", ...others] : others;
  if (everyone.length === 0) everyone.push("player"); // never render an empty stage

  const size = everyone.length <= 1 ? 118 : everyone.length === 2 ? 96 : 78;

  return (
    <SceneBackground ambience={node.ambience}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: everyone.length > 2 ? -6 : 4 }}>
        {everyone.map((id) => {
          const person = CAST[id];
          if (!person) return null;
          const isPlayer = id === "player";
          const pose = isPlayer ? playerPose : (speaking.has(id) ? "talking" : "idle");
          return (
            <div key={id} style={{ textAlign: "center" }}>
              <PlayerCharacter
                pose={pose}
                size={size}
                skin={person.skin}
                hair={person.hair}
                hairStyle={person.hairStyle}
                kitColor={isPlayer ? accentColor : person.kitColor}
                sleeve={person.sleeve}
                pants={person.pants}
                accessory={person.accessory}
                accent={person.accent}
                silhouette={!!person.silhouette}
              />
              {!isPlayer && person.name && everyone.length > 1 && (
                <div style={{
                  fontSize: 10, fontWeight: 700, marginTop: -6, color: "#fff",
                  textShadow: "0 1px 3px rgba(0,0,0,0.8)", opacity: speaking.has(id) ? 1 : 0.7,
                }}>{person.name}</div>
              )}
            </div>
          );
        })}
      </div>
    </SceneBackground>
  );
}
