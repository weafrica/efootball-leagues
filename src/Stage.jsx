import React from "react";
import SceneBackground from "./SceneBackground.jsx";
import PlayerCharacter from "./PlayerCharacter.jsx";
import { CAST, castForNode, speakingIds } from "./cast.js";

// Stage — puts the right characters in the right place for a node, on
// the right background. Everyone who has a line stands in the scene, "you"
// are dressed by the story (graph.player, else the app's own accent
// colour), and whoever's talking gets the talking animation while everyone
// else idles. A node can also force a reaction for the player with
// scene.pose (confused, angry, shock, sleep, ...).
export default function Stage({ node, playerPose = "idle", accentColor = "#2f6f4f", playerId = "player" }) {
  const ids = castForNode(node);
  const speaking = speakingIds(node);
  const hasPlayer = ids.includes("player") || (!node.cast && (node.scene?.pose ?? true));
  const others = ids.filter((id) => id !== "player");
  const everyone = hasPlayer ? ["player", ...others] : others;
  if (everyone.length === 0) everyone.push("player"); // never render an empty stage

  const size = everyone.length <= 1 ? 118 : everyone.length === 2 ? 102 : everyone.length === 3 ? 90 : everyone.length === 4 ? 80 : 68;
  const playerLook = CAST[playerId] || CAST.player;

  return (
    <SceneBackground ambience={node.ambience}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "center", gap: everyone.length > 2 ? -6 : 4 }}>
        {everyone.map((id) => {
          const isPlayer = id === "player";
          const person = isPlayer ? playerLook : CAST[id];
          if (!person) return null;
          const pose = isPlayer ? playerPose : (speaking.has(id) ? "talking" : "idle");
          return (
            <div key={id} style={{ textAlign: "center" }}>
              <PlayerCharacter
                pose={pose}
                size={size}
                skin={person.skin}
                hair={person.hair}
                hairStyle={person.hairStyle}
                kitColor={isPlayer ? (person.kitColor || accentColor) : person.kitColor}
                sleeve={person.sleeve}
                pants={person.pants}
                shoes={person.shoes}
                accessory={person.accessory}
                accent={person.accent}
                build={person.build}
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
