import React from "react";

// SceneBackground — a full location drawn in SVG/CSS, keyed by the same
// `ambience` tag already used for sound (see the migration history), so
// one tag now drives sound AND visuals together. No photos, no video —
// gradients, simple shapes and a little CSS motion (drifting clouds,
// flickering floodlights, dust) carry the atmosphere instead.
//
// Unknown/omitted tags fall back to a plain neutral gradient rather than
// breaking — a scene is always allowed to just not have a background yet.
const PALETTES = {
  stadium_morning:     { sky: ["#8ec9e8", "#dff1fb"], ground: "#2f7d3c", mode: "pitch", time: "dawn" },
  stadium_training:     { sky: ["#79b8e0", "#cdeaff"], ground: "#2f7d3c", mode: "pitch", time: "day" },
  canteen_chatter:      { sky: ["#3a3226", "#2a241c"], ground: "#5a4a36", mode: "room", time: "indoor" },
  locker_room:          { sky: ["#22303f", "#16202b"], ground: "#3a4a5a", mode: "lockers", time: "indoor" },
  coaches_office:       { sky: ["#2b2620", "#1c1814"], ground: "#4a3f30", mode: "office", time: "indoor" },
  street_evening:       { sky: ["#2b3a67", "#c97b4a"], ground: "#3a3a3a", mode: "street", time: "dusk" },
  street_evening_tense: { sky: ["#171d33", "#5a3a5c"], ground: "#2a2a2a", mode: "street", time: "night" },
  celebration:          { sky: ["#241a3a", "#4a2f63"], ground: "#3a4a5a", mode: "lockers", time: "party" },
  behind_shed:          { sky: ["#5a6b56", "#7f9270"], ground: "#4a3f2e", mode: "yard", time: "day" },
  kit_room_quiet:       { sky: ["#2a2f24", "#1c211a"], ground: "#3a3a2e", mode: "room", time: "indoor" },
  street_light_traffic: { sky: ["#33456b", "#6f7ea3"], ground: "#3a3a3a", mode: "street", time: "dusk" },
  press_scrum:          { sky: ["#26262e", "#1a1a20"], ground: "#3a3a3a", mode: "yard", time: "indoor" },
};

export default function SceneBackground({ ambience, children }) {
  const p = PALETTES[ambience] || { sky: ["#2a2f3a", "#1c2028"], ground: "#333", mode: "plain", time: "day" };
  const [skyTop, skyBottom] = p.sky;

  return (
    <div className="scene" style={{ position: "relative", borderRadius: 16, overflow: "hidden", minHeight: 190 }}>
      <style>{`
        .scene svg { display: block; width: 100%; height: 100%; }
        .scene .cloud { animation: scene-drift 40s linear infinite; }
        .scene .cloud2 { animation: scene-drift 55s linear infinite reverse; }
        @keyframes scene-drift { from { transform: translateX(-10%); } to { transform: translateX(10%); } }
        .scene .flood { animation: scene-flicker 3.2s ease-in-out infinite; }
        .scene .flood2 { animation: scene-flicker 3.7s ease-in-out infinite 0.4s; }
        @keyframes scene-flicker { 0%,100% { opacity: 0.9; } 50% { opacity: 1; } 92% { opacity: 0.55; } }
        .scene .star { animation: scene-twinkle 2.6s ease-in-out infinite; }
        @keyframes scene-twinkle { 0%,100% { opacity: 0.25; } 50% { opacity: 0.9; } }
        .scene .dust { animation: scene-rise 6s linear infinite; }
        @keyframes scene-rise { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: 0.5; } 100% { transform: translateY(-40px); opacity: 0; } }
      `}</style>

      <svg viewBox="0 0 400 220" preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={skyTop} /><stop offset="100%" stopColor={skyBottom} />
          </linearGradient>
        </defs>
        <rect width="400" height="220" fill="url(#sky)" />

        {p.time === "night" && [...Array(14)].map((_, i) => (
          <circle key={i} className="star" cx={(i * 53 + 20) % 390} cy={(i * 31) % 90} r="1.1" fill="#fff"
            style={{ animationDelay: `${(i % 6) * 0.4}s` }} />
        ))}

        {p.mode === "pitch" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          <ellipse cx="200" cy="150" rx="130" ry="16" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" />
          <rect x="0" y="149" width="400" height="1.5" fill="rgba(255,255,255,0.5)" />
          <rect x="18" y="20" width="6" height="110" fill="#555" /><rect x="18" y="18" width="60" height="4" fill="#e2e2e2" className="flood" />
          <rect x="376" y="20" width="6" height="110" fill="#555" /><rect x="322" y="18" width="60" height="4" fill="#e2e2e2" className="flood2" />
          <ellipse className="cloud" cx="90" cy="35" rx="30" ry="9" fill="rgba(255,255,255,0.6)" />
          <ellipse className="cloud2" cx="280" cy="25" rx="24" ry="7" fill="rgba(255,255,255,0.5)" />
        </>)}

        {p.mode === "room" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          {[60, 160, 260, 340].map((x) => <rect key={x} x={x} y="30" width="34" height="60" rx="3" fill="rgba(255,255,255,0.06)" />)}
          <circle cx="60" cy="18" r="9" fill="#ffe9b0" opacity="0.85" />
          <circle cx="280" cy="18" r="9" fill="#ffe9b0" opacity="0.85" />
        </>)}

        {p.mode === "lockers" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          {[...Array(7)].map((_, i) => (
            <rect key={i} x={20 + i * 52} y="20" width="44" height="90" rx="2" fill={i % 2 ? "#3d566e" : "#33475c"} stroke="#1c2733" />
          ))}
          <circle cx="90" cy="16" r="8" fill="#ffe9b0" opacity="0.8" /><circle cx="310" cy="16" r="8" fill="#ffe9b0" opacity="0.8" />
        </>)}

        {p.mode === "office" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          <rect x="40" y="30" width="90" height="70" rx="2" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.15)" />
          <rect x="270" y="40" width="70" height="55" rx="2" fill="rgba(120,160,200,0.18)" stroke="rgba(255,255,255,0.15)" />
          <circle cx="200" cy="20" r="10" fill="#ffcf7a" opacity="0.7" />
        </>)}

        {p.mode === "street" && (<>
          <rect x="0" y="160" width="400" height="60" fill={p.ground} />
          <rect x="0" y="158" width="400" height="2" fill="rgba(255,255,255,0.25)" />
          {[40, 150, 260, 350].map((x) => (
            <g key={x}><rect x={x} y="90" width="4" height="70" fill="#222" /><circle cx={x + 2} cy="88" r="6" fill="#ffd27a" className="flood" /></g>
          ))}
          <ellipse className="cloud" cx="120" cy="30" rx="40" ry="8" fill="rgba(255,255,255,0.35)" />
        </>)}

        {p.mode === "yard" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          <rect x="330" y="60" width="55" height="90" fill="#5a4a3a" />
          <rect x="330" y="60" width="55" height="6" fill="#463829" />
          {[...Array(6)].map((_, i) => (
            <circle key={i} className="dust" cx={200 + i * 9} cy="140" r="1.6" fill="rgba(230,230,220,0.6)" style={{ animationDelay: `${i * 0.9}s` }} />
          ))}
        </>)}

        {p.mode === "plain" && <rect x="0" y="150" width="400" height="70" fill={p.ground} />}
      </svg>

      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 8 }}>
        {children}
      </div>
    </div>
  );
}
