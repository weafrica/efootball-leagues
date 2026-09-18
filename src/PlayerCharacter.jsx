import React from "react";

// PlayerCharacter — a small, stylized football figure built entirely from
// SVG shapes (circles/rects/paths — text, not image files) and posed via
// CSS keyframe animations on its limb groups, like a paper-cutout puppet.
// Zero images, zero video, zero external assets: the whole character is
// this one component. Reused across every story rather than drawn per
// story, so adding a new story never means commissioning new art.
//
// Rig: head/torso/two arms/two legs, each limb a <g> whose own local
// origin (after an SVG `transform="translate(...)"` on its wrapper) sits
// at the joint — shoulder for arms, hip for legs — so a CSS
// `transform: rotate()` on the limb pivots naturally from that joint.
//
// `pose` selects which keyframe animation plays; unknown/omitted pose
// falls back to "idle". Story authors set an optional per-node
// `scene: { pose: "..." }` — omitting it is fine, it just stays idle.
const POSES = ["idle", "phone", "kick", "talking", "celebrate", "disappointed"];

export default function PlayerCharacter({ pose = "idle", kitColor = "#2f6f4f", size = 120 }) {
  const activePose = POSES.includes(pose) ? pose : "idle";

  return (
    <div className="player-character" style={{ width: size, height: size * 1.3, margin: "0 auto" }}>
      <style>{`
        .player-character svg { width: 100%; height: 100%; overflow: visible; }
        .player-character .head-tilt,
        .player-character .arm-l,
        .player-character .arm-r,
        .player-character .leg-l,
        .player-character .leg-r,
        .player-character .torso-g { transform-origin: 0px 0px; }

        /* idle — gentle breathing bob, arms and legs at rest */
        .player-character.pose-idle .torso-g { animation: pc-breathe 2.4s ease-in-out infinite; }

        /* phone — one arm bent up to the ear, slight attentive lean */
        .player-character.pose-phone .arm-r { animation: pc-hold-phone 1.6s ease-in-out infinite; }
        .player-character.pose-phone .head-tilt { animation: pc-listen 1.6s ease-in-out infinite; }

        /* kick — a training strike, weight shifting through the leg */
        .player-character.pose-kick .leg-r { animation: pc-kick 1s ease-in-out infinite; }
        .player-character.pose-kick .arm-l { animation: pc-swing 1s ease-in-out infinite; }
        .player-character.pose-kick .arm-r { animation: pc-swing-back 1s ease-in-out infinite; }

        /* talking — a hand gesture with an emphatic head tilt */
        .player-character.pose-talking .arm-r { animation: pc-gesture 1.4s ease-in-out infinite; }
        .player-character.pose-talking .head-tilt { animation: pc-nod 1.4s ease-in-out infinite; }

        /* celebrate — arms up, a bounce, plus a small confetti burst */
        .player-character.pose-celebrate .arm-l { animation: pc-arms-up-l 0.7s ease-in-out infinite alternate; }
        .player-character.pose-celebrate .arm-r { animation: pc-arms-up-r 0.7s ease-in-out infinite alternate; }
        .player-character.pose-celebrate .torso-g { animation: pc-bounce 0.7s ease-in-out infinite; }

        /* disappointed — a slow slump, held (no loop) */
        .player-character.pose-disappointed .torso-g { animation: pc-slump 0.8s ease-out forwards; }
        .player-character.pose-disappointed .head-tilt { animation: pc-hang 0.8s ease-out forwards; }
        .player-character.pose-disappointed .arm-l { animation: pc-droop-l 0.8s ease-out forwards; }
        .player-character.pose-disappointed .arm-r { animation: pc-droop-r 0.8s ease-out forwards; }

        @keyframes pc-breathe { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
        @keyframes pc-bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes pc-slump { from { transform: translateY(0); } to { transform: translateY(4px); } }

        @keyframes pc-listen { 0%,100% { transform: rotate(0deg); } 50% { transform: rotate(-4deg); } }
        @keyframes pc-nod { 0%,50%,100% { transform: rotate(0deg); } 25%,75% { transform: rotate(6deg); } }
        @keyframes pc-hang { from { transform: rotate(0deg) translateY(0); } to { transform: rotate(14deg) translateY(3px); } }

        @keyframes pc-hold-phone { 0%,100% { transform: rotate(-150deg); } 50% { transform: rotate(-145deg); } }
        @keyframes pc-swing { 0%,100% { transform: rotate(-20deg); } 50% { transform: rotate(30deg); } }
        @keyframes pc-swing-back { 0%,100% { transform: rotate(20deg); } 50% { transform: rotate(-30deg); } }
        @keyframes pc-gesture { 0%,100% { transform: rotate(-40deg); } 50% { transform: rotate(-70deg); } }
        @keyframes pc-arms-up-l { from { transform: rotate(-150deg); } to { transform: rotate(-170deg); } }
        @keyframes pc-arms-up-r { from { transform: rotate(150deg); } to { transform: rotate(170deg); } }
        @keyframes pc-droop-l { from { transform: rotate(-20deg); } to { transform: rotate(-70deg); } }
        @keyframes pc-droop-r { from { transform: rotate(20deg); } to { transform: rotate(70deg); } }

        @keyframes pc-kick {
          0%   { transform: rotate(0deg); }
          35%  { transform: rotate(-45deg); }
          55%  { transform: rotate(35deg); }
          100% { transform: rotate(0deg); }
        }

        /* Confetti — small colored squares that pop and fall, pure CSS,
           only mounted during the celebrate pose. */
        .player-character .confetti { position: relative; }
        .player-character .confetti span {
          position: absolute; top: 10%; width: 5px; height: 5px; opacity: 0;
          animation: pc-confetti 1.1s ease-out infinite;
        }
        @keyframes pc-confetti {
          0%   { transform: translate(0,0) rotate(0deg); opacity: 1; }
          100% { transform: translate(var(--dx), 90px) rotate(360deg); opacity: 0; }
        }
      `}</style>

      <div className={`pose-${activePose}`}>
        <svg viewBox="0 0 120 156">
          <g className="head-tilt" transform="translate(60,30)">
            <circle cx="0" cy="0" r="16" fill="#e8b98a" />
          </g>
          <rect x="55" y="44" width="10" height="8" fill="#e8b98a" />

          <g className="torso-g" transform="translate(0,0)">
            <rect x="38" y="50" width="44" height="46" rx="10" fill={kitColor} />
            <rect x="55" y="50" width="10" height="46" fill="rgba(255,255,255,0.25)" />

            <g transform="translate(40,56)"><g className="arm-l"><rect x="-4" y="0" width="8" height="36" rx="4" fill="#e8b98a" /></g></g>
            <g transform="translate(80,56)"><g className="arm-r"><rect x="-4" y="0" width="8" height="36" rx="4" fill="#e8b98a" /></g></g>

            <g transform="translate(48,94)"><g className="leg-l"><rect x="-5" y="0" width="10" height="42" rx="5" fill="#274b6e" /></g></g>
            <g transform="translate(72,94)"><g className="leg-r"><rect x="-5" y="0" width="10" height="42" rx="5" fill="#274b6e" /></g></g>
          </g>
        </svg>
      </div>

      {activePose === "celebrate" && (
        <div className="confetti" aria-hidden="true">
          {["#ffb703","#219ebc","#fb8500","#8ecae6","#ff6b6b","#52b788"].map((color, i) => (
            <span key={i} style={{
              left: `${15 + i * 14}%`,
              background: color,
              animationDelay: `${i * 0.12}s`,
              "--dx": `${(i % 2 === 0 ? 1 : -1) * (10 + i * 6)}px`,
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
