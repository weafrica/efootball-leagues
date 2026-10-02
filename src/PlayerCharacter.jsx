import React from "react";

// PlayerCharacter — a stylized figure built entirely from SVG shapes and
// posed with CSS keyframes on its limb groups, like a paper-cutout puppet.
// Zero images, zero video, zero external assets. One rig serves the whole
// cast: skin tone, hair, outfit and accessories are just props (see
// cast.js for who looks like what), so a new character is a few lines of
// data, never new art.
//
// Rig: head/torso/two arms/two legs, each limb a <g> whose local origin
// (after an SVG transform="translate(...)" on its wrapper) sits at the
// joint — shoulder for arms, hip for legs — so a CSS rotate() on the limb
// pivots naturally from that joint.
//
// `pose` picks the animation; unknown falls back to "idle".
const POSES = ["idle", "phone", "kick", "talking", "celebrate", "disappointed", "sleep"];

export default function PlayerCharacter({
  pose = "idle",
  size = 120,
  skin = "#8d5524",
  hair = "#1b1b1b",
  hairStyle = "short", // short | afro | cap | bald
  kitColor = "#2f6f4f",
  sleeve = null,       // arm colour; null = bare arms (short sleeves)
  pants = "#274b6e",
  shoes = "#1d1d1d",
  accessory = null,    // tie | whistle | headband | gloves | mic | medic | vest
  accent = "#c0392b",  // tie / headband / cap colour
  silhouette = false,  // unknown person: flat dark shape, no face
}) {
  const activePose = POSES.includes(pose) ? pose : "idle";
  const dark = "#0b0f16";
  const S = silhouette ? dark : skin;
  const H = silhouette ? dark : hair;
  const K = silhouette ? dark : kitColor;
  const P = silhouette ? dark : pants;
  const SL = silhouette ? dark : (sleeve || skin);
  const hand = accessory === "gloves" && !silhouette ? "#f4f4f4" : S;
  const handR = accessory === "gloves" ? 6 : 4.6;
  const suit = accessory === "tie";

  return (
    <div className="player-character" style={{ width: size, height: size * 1.3, margin: "0 auto" }}>
      <style>{`
        .player-character svg { width: 100%; height: 100%; overflow: visible; }
        .player-character .head-tilt, .player-character .arm-l, .player-character .arm-r,
        .player-character .leg-l, .player-character .leg-r, .player-character .torso-g { transform-origin: 0px 0px; }
        .player-character .eyes { transform-box: fill-box; transform-origin: center; animation: pc-blink 4.2s infinite; }
        .player-character .mouth-talk { transform-box: fill-box; transform-origin: center; animation: pc-mouth 0.32s ease-in-out infinite alternate; }
        .player-character .zzz { animation: pc-zzz 2.4s ease-in-out infinite; opacity: 0; }

        .player-character.pose-idle .torso-g { animation: pc-breathe 2.4s ease-in-out infinite; }
        .player-character.pose-phone .arm-r { animation: pc-hold-phone 1.6s ease-in-out infinite; }
        .player-character.pose-phone .head-tilt { animation: pc-listen 1.6s ease-in-out infinite; }
        .player-character.pose-kick .leg-r { animation: pc-kick 1s ease-in-out infinite; }
        .player-character.pose-kick .arm-l { animation: pc-swing 1s ease-in-out infinite; }
        .player-character.pose-kick .arm-r { animation: pc-swing-back 1s ease-in-out infinite; }
        .player-character.pose-talking .arm-r { animation: pc-gesture 1.4s ease-in-out infinite; }
        .player-character.pose-talking .head-tilt { animation: pc-nod 1.4s ease-in-out infinite; }
        .player-character.pose-celebrate .arm-l { animation: pc-arms-up-l 0.7s ease-in-out infinite alternate; }
        .player-character.pose-celebrate .arm-r { animation: pc-arms-up-r 0.7s ease-in-out infinite alternate; }
        .player-character.pose-celebrate .torso-g { animation: pc-bounce 0.7s ease-in-out infinite; }
        .player-character.pose-disappointed .torso-g { animation: pc-slump 0.8s ease-out forwards; }
        .player-character.pose-disappointed .head-tilt { animation: pc-hang 0.8s ease-out forwards; }
        .player-character.pose-disappointed .arm-l { animation: pc-droop-l 0.8s ease-out forwards; }
        .player-character.pose-disappointed .arm-r { animation: pc-droop-r 0.8s ease-out forwards; }
        .player-character.pose-sleep .head-tilt { animation: pc-sleep-head 3.2s ease-in-out infinite; }
        .player-character.pose-sleep .torso-g { animation: pc-slump 1s ease-out forwards; }

        @keyframes pc-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
        @keyframes pc-mouth { from { transform: scaleY(0.6); } to { transform: scaleY(1.8); } }
        @keyframes pc-zzz { 0% { transform: translate(0, 0); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(8px, -14px); opacity: 0; } }
        @keyframes pc-sleep-head { 0%, 100% { transform: rotate(14deg) translateY(2px); } 50% { transform: rotate(9deg) translateY(4px); } }
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
        @keyframes pc-kick { 0% { transform: rotate(0deg); } 35% { transform: rotate(-45deg); } 55% { transform: rotate(35deg); } 100% { transform: rotate(0deg); } }
        .player-character .confetti { position: relative; }
        .player-character .confetti span { position: absolute; top: 10%; width: 5px; height: 5px; opacity: 0; animation: pc-confetti 1.1s ease-out infinite; }
        @keyframes pc-confetti { 0% { transform: translate(0,0) rotate(0deg); opacity: 1; } 100% { transform: translate(var(--dx), 90px) rotate(360deg); opacity: 0; } }
      `}</style>

      <div className={`pose-${activePose}`}>
        <svg viewBox="0 0 120 156">
          {/* soft ground shadow so figures sit on the floor */}
          <ellipse cx="60" cy="140" rx="26" ry="4" fill="rgba(0,0,0,0.28)" />

          {/* legs + shoes (behind the torso) */}
          <g transform="translate(48,94)"><g className="leg-l">
            <rect x="-5" y="0" width="10" height="42" rx="5" fill={P} />
            <rect x="-7" y="37" width="14" height="7" rx="3.5" fill={silhouette ? dark : shoes} />
          </g></g>
          <g transform="translate(72,94)"><g className="leg-r">
            <rect x="-5" y="0" width="10" height="42" rx="5" fill={P} />
            <rect x="-7" y="37" width="14" height="7" rx="3.5" fill={silhouette ? dark : shoes} />
          </g></g>

          <rect x="55" y="44" width="10" height="9" fill={S} />

          <g className="torso-g" transform="translate(0,0)">
            <rect x="38" y="50" width="44" height="46" rx="10" fill={K} />
            {!suit && accessory !== "vest" && !silhouette && <rect x="55" y="50" width="10" height="46" fill="rgba(255,255,255,0.22)" />}
            {accessory === "vest" && !silhouette && (<>
              <rect x="38" y="62" width="44" height="5" fill="rgba(255,255,255,0.75)" />
              <rect x="38" y="78" width="44" height="5" fill="rgba(255,255,255,0.75)" />
            </>)}
            {accessory === "tie" && !silhouette && (<>
              <path d="M52 50 L60 62 L68 50 Z" fill="#fff" />
              <path d="M60 58 l-3.4 5 l3.4 18 l3.4 -18 z" fill={accent} />
            </>)}
            {accessory === "whistle" && !silhouette && (<>
              <path d="M54 50 L60 66 L66 50" stroke="#222" strokeWidth="1.2" fill="none" />
              <rect x="56.5" y="65" width="7" height="5.5" rx="2.5" fill="#eee" stroke="#222" strokeWidth="0.7" />
            </>)}
            {accessory === "medic" && !silhouette && (<>
              <circle cx="60" cy="68" r="7" fill="#fff" />
              <path d="M60 63.5v9M55.5 68h9" stroke="#d63031" strokeWidth="2.6" />
            </>)}

            {/* arms: sleeve + hand, so a suit reads as a suit */}
            <g transform="translate(40,56)"><g className="arm-l">
              <rect x="-4" y="0" width="8" height="36" rx="4" fill={SL} />
              <circle cx="0" cy="36" r={handR} fill={hand} stroke={accessory === "gloves" ? "#999" : "none"} strokeWidth="0.8" />
            </g></g>
            <g transform="translate(80,56)"><g className="arm-r">
              <rect x="-4" y="0" width="8" height="36" rx="4" fill={SL} />
              {activePose === "phone" && <rect x="-3" y="27" width="6" height="11" rx="1.5" fill="#1b1b1b" stroke="#6fd3ff" strokeWidth="0.8" />}
              {accessory === "mic" && !silhouette && (<><rect x="-1.6" y="30" width="3.2" height="10" rx="1.6" fill="#333" /><circle cx="0" cy="29" r="3.4" fill="#777" /></>)}
              <circle cx="0" cy="36" r={handR} fill={hand} stroke={accessory === "gloves" ? "#999" : "none"} strokeWidth="0.8" />
            </g></g>
          </g>

          {/* head, hair and face (tilts as one piece) */}
          <g className="head-tilt" transform="translate(60,30)">
            {hairStyle === "afro" && <circle cx="0" cy="-5" r="20.5" fill={H} />}
            <circle cx="0" cy="0" r="16" fill={S} />
            {hairStyle !== "bald" && hairStyle !== "cap" && <path d="M-16 -1 C-17 -20 17 -20 16 -1 C11 -9 -11 -9 -16 -1 Z" fill={H} />}
            {hairStyle === "cap" && (<>
              <path d="M-17 -2 C-17 -22 17 -22 17 -2 Z" fill={silhouette ? dark : accent} />
              <rect x="1" y="-6" width="21" height="4.5" rx="2.2" fill={silhouette ? dark : accent} />
            </>)}
            {accessory === "headband" && !silhouette && <rect x="-14.5" y="-9" width="29" height="4.2" rx="2" fill={accent} />}

            {!silhouette && (activePose === "sleep" ? (<>
              <path d="M-8.5 -0.5 h5.5 M3 -0.5 h5.5" stroke="#2a1a10" strokeWidth="1.5" strokeLinecap="round" />
              <ellipse cx="0" cy="8" rx="2.4" ry="1.7" fill="#5a2d1a" />
            </>) : (<>
              <g className="eyes"><circle cx="-5.5" cy="-0.5" r="1.8" fill="#1a1a1a" /><circle cx="5.5" cy="-0.5" r="1.8" fill="#1a1a1a" /></g>
              {activePose === "talking" && <ellipse className="mouth-talk" cx="0" cy="8" rx="3" ry="1.6" fill="#5a2d1a" />}
              {activePose === "disappointed" && <path d="M-4.2 9.5 Q0 6 4.2 9.5" stroke="#5a2d1a" strokeWidth="1.5" fill="none" strokeLinecap="round" />}
              {(activePose === "celebrate") && <path d="M-5 6 Q0 12.5 5 6 Z" fill="#5a2d1a" />}
              {!["talking", "disappointed", "celebrate"].includes(activePose) && <path d="M-4.2 7 Q0 10.2 4.2 7" stroke="#5a2d1a" strokeWidth="1.5" fill="none" strokeLinecap="round" />}
            </>))}
          </g>

          {activePose === "sleep" && (<g fill="#9ad0ff" fontFamily="sans-serif" fontWeight="700">
            <text className="zzz" x="82" y="24" fontSize="13">z</text>
            <text className="zzz" x="90" y="14" fontSize="10" style={{ animationDelay: "0.8s" }}>z</text>
            <text className="zzz" x="97" y="6" fontSize="8" style={{ animationDelay: "1.6s" }}>z</text>
          </g>)}
        </svg>
      </div>

      {activePose === "celebrate" && (
        <div className="confetti" aria-hidden="true">
          {["#ffb703", "#219ebc", "#fb8500", "#8ecae6", "#ff6b6b", "#52b788"].map((color, i) => (
            <span key={i} style={{
              left: `${15 + i * 14}%`, background: color, animationDelay: `${i * 0.12}s`,
              "--dx": `${(i % 2 === 0 ? 1 : -1) * (10 + i * 6)}px`,
            }} />
          ))}
        </div>
      )}
    </div>
  );
}
