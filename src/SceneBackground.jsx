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
  // Mossbridge United
  airport:              { sky: ["#b9d4ea", "#e7f1f8"], ground: "#c3c8d0", mode: "airport", time: "day" },
  rain_pitch:           { sky: ["#56606c", "#8791a0"], ground: "#2a6b36", mode: "pitch", time: "rain" },
  village_rain:         { sky: ["#46505c", "#6b7682"], ground: "#33363b", mode: "street", time: "rain" },
  pub_evening:          { sky: ["#3b2616", "#2a1a0f"], ground: "#5a3b22", mode: "pub", time: "indoor" },
  boardroom:            { sky: ["#202a38", "#141a24"], ground: "#3a3f4a", mode: "boardroom", time: "indoor" },
  radio_studio:         { sky: ["#1a1420", "#0f0b14"], ground: "#2a2230", mode: "radio", time: "indoor" },
  tea_room:             { sky: ["#4a3b2c", "#34291e"], ground: "#6b5640", mode: "room", time: "indoor" },
  hotel_room:           { sky: ["#2d3548", "#1d2333"], ground: "#4b4150", mode: "room", time: "indoor" },
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
        .scene .rain { animation: scene-rain 0.85s linear infinite; }
        @keyframes scene-rain { from { transform: translateY(-24px); } to { transform: translateY(236px); } }
        .scene .plane { animation: scene-plane 22s linear infinite; }
        @keyframes scene-plane { from { transform: translateX(-60px); } to { transform: translateX(420px); } }
        .scene .onair { animation: scene-onair 1.6s ease-in-out infinite; }
        @keyframes scene-onair { 0%,100% { opacity: 0.55; } 50% { opacity: 1; } }
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

        {p.mode === "airport" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          <rect x="0" y="149" width="400" height="2" fill="rgba(0,0,0,0.12)" />
          {[20, 150, 280].map((x) => <rect key={x} x={x} y="22" width="110" height="86" rx="3" fill="#cfe6f7" stroke="#8aa4b8" strokeWidth="2" />)}
          <g className="plane"><path d="M30 60 h34 l8 -5 h4 l-3 5 h6 l3 -4 h3 l-2 4 l2 4 h-3 l-3 -4 h-6 l3 5 h-4 l-8 -5 h-34 z" fill="#fff" stroke="#9fb4c4" strokeWidth="0.6" /></g>
          <rect x="300" y="112" width="80" height="26" rx="2" fill="#12161c" />
          {[0, 1, 2].map((i) => <rect key={i} className="flood" x="306" y={117 + i * 7} width={52 - i * 9} height="3" fill="#f5b942" />)}
          <rect x="60" y="128" width="26" height="22" rx="3" fill="#3b4a5a" /><rect x="64" y="122" width="18" height="8" rx="2" fill="#566b80" />
        </>)}

        {p.mode === "pub" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          <rect x="0" y="40" width="400" height="6" fill="#2a190d" />
          {[30, 80, 130, 330].map((x) => (<g key={x}>
            <rect x={x} y="56" width="8" height="22" rx="2" fill="#7a3b1b" /><rect x={x + 14} y="52" width="8" height="26" rx="2" fill="#2e6b4f" />
          </g>))}
          <rect x="0" y="100" width="400" height="14" fill="#6a3f1e" /><rect x="0" y="114" width="400" height="36" fill="#4a2a14" />
          {[60, 200, 330].map((x) => (<g key={x}><line x1={x} y1="0" x2={x} y2="26" stroke="#222" strokeWidth="1.5" /><circle cx={x} cy="30" r="10" fill="#ffc86b" className="flood" /></g>))}
          <circle cx="340" cy="80" r="14" fill="#1b1b1b" /><circle cx="340" cy="80" r="10" fill="#c0392b" /><circle cx="340" cy="80" r="6" fill="#f1f1f1" /><circle cx="340" cy="80" r="2" fill="#27ae60" />
        </>)}

        {p.mode === "boardroom" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          <rect x="30" y="20" width="340" height="86" rx="3" fill="#1a2a44" stroke="#3b4a66" strokeWidth="2" />
          {[40, 70, 100, 130, 160, 190, 220, 250, 280, 310, 335].map((x, i) => <rect key={x} x={x} y={80 - ((i * 13) % 34)} width="22" height={26 + ((i * 13) % 34)} fill="#0e1626" />)}
          {[...Array(10)].map((_, i) => <rect key={i} className="star" x={46 + i * 31} y={72 + ((i * 7) % 20)} width="2" height="2" fill="#ffd27a" style={{ animationDelay: `${(i % 5) * 0.5}s` }} />)}
          <path d="M20 128 L380 128 L400 150 L0 150 Z" fill="#4a2f1b" /><rect x="0" y="150" width="400" height="3" fill="#2a1a0d" />
        </>)}

        {p.mode === "radio" && (<>
          <rect x="0" y="150" width="400" height="70" fill={p.ground} />
          {[...Array(8)].map((_, i) => <rect key={i} x={14 + i * 49} y="20" width="40" height="40" rx="3" fill="#2a2132" stroke="#3a2f45" />)}
          <rect className="onair" x="150" y="68" width="100" height="30" rx="5" fill="#a31621" /><text className="onair" x="200" y="89" textAnchor="middle" fontSize="16" fontWeight="800" fill="#fff" fontFamily="sans-serif">ON AIR</text>
          <line x1="330" y1="110" x2="330" y2="150" stroke="#555" strokeWidth="3" /><rect x="324" y="104" width="12" height="8" rx="4" fill="#888" />
        </>)}

        {p.time === "rain" && (<g>
          {[...Array(30)].map((_, i) => <line key={i} className="rain" x1={(i * 14) % 400} y1="0" x2={((i * 14) % 400) - 5} y2="14" stroke="rgba(205,220,235,0.6)" strokeWidth="1.1" style={{ animationDelay: `${(i % 9) * 0.1}s` }} />)}
        </g>)}

        {p.mode === "plain" && <rect x="0" y="150" width="400" height="70" fill={p.ground} />}
      </svg>

      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 8 }}>
        {children}
      </div>
    </div>
  );
}
