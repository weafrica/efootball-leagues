import React from "react";

// PlayerCharacter — a stylized figure built entirely from SVG shapes and
// posed with CSS keyframes on its limb groups, like a paper-cutout puppet.
// Zero images, zero video, zero external assets. One rig serves the whole
// cast: skin tone, hair, outfit, build and props are all just props (see
// cast.js for who looks like what), so a new character is a few lines of
// data, never new art.
//
// Rig: head/torso/two arms/two legs, each limb a <g> whose local origin
// (after an SVG transform="translate(...)" on its wrapper) sits at the
// joint — shoulder for arms, hip for legs — so a CSS rotate() on the limb
// pivots naturally from that joint.
const POSES = ["idle", "phone", "kick", "talking", "celebrate", "disappointed", "sleep", "confused", "angry", "shock"];

export default function PlayerCharacter({
  pose = "idle",
  size = 120,
  skin = "#8d5524",
  hair = "#1b1b1b",
  hairStyle = "short", // short | afro | cap | bald | long | bun | bob
  kitColor = "#2f6f4f",
  sleeve = null,       // arm colour; null = bare arms (short sleeves)
  pants = "#274b6e",
  shoes = "#1d1d1d",
  accessory = null,    // string or array: tie | whistle | headband | gloves | mic | medic | vest | pearls | lanyard | glasses | scarf | mug | clipboard
  accent = "#c0392b",  // tie / headband / cap / scarf colour
  build = "normal",    // slim | normal | broad
  silhouette = false,  // unknown person: flat dark shape, no face
}) {
  const activePose = POSES.includes(pose) ? pose : "idle";
  const acc = Array.isArray(accessory) ? accessory : (accessory ? [accessory] : []);
  const has = (a) => acc.includes(a);
  const dark = "#0b0f16";
  const S = silhouette ? dark : skin;
  const H = silhouette ? dark : hair;
  const K = silhouette ? dark : kitColor;
  const P = silhouette ? dark : pants;
  const SL = silhouette ? dark : (sleeve || skin);
  const hand = has("gloves") && !silhouette ? "#f4f4f4" : S;
  const handR = has("gloves") ? 6 : 4.6;
  const suit = has("tie") || has("pearls");
  const brow = hairStyle === "bald" || hairStyle === "cap" ? "#2a1a10" : H;
  const widen = build === "broad" ? 1.16 : build === "slim" ? 0.93 : 1;

  return (
    <div className="player-character" style={{ width: size, height: size * 1.3, margin: "0 auto" }}>
      <style>{`
        .player-character svg { width: 100%; height: 100%; overflow: visible; }
        .player-character .head-tilt, .player-character .arm-l, .player-character .arm-r,
        .player-character .leg-l, .player-character .leg-r, .player-character .torso-g { transform-origin: 0px 0px; }
        .player-character .eyes { transform-box: fill-box; transform-origin: center; animation: pc-blink 4.2s infinite; }
        .player-character .mouth-talk { transform-box: fill-box; transform-origin: center; animation: pc-mouth 0.32s ease-in-out infinite alternate; }
        .player-character .fx { animation: pc-zzz 2.4s ease-in-out infinite; opacity: 0; }
        .player-character .fx-pulse { transform-box: fill-box; transform-origin: center; animation: pc-pulse 0.6s ease-in-out infinite alternate; }

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
        .player-character.pose-confused .head-tilt { animation: pc-confused-head 2.2s ease-in-out infinite; }
        .player-character.pose-confused .arm-l { animation: pc-shrug-l 2.2s ease-in-out infinite; }
        .player-character.pose-confused .arm-r { animation: pc-shrug-r 2.2s ease-in-out infinite; }
        .player-character.pose-angry .torso-g { animation: pc-shake 0.18s linear infinite; }
        .player-character.pose-angry .arm-l { animation: pc-fist-l 0.36s ease-in-out infinite alternate; }
        .player-character.pose-angry .arm-r { animation: pc-fist-r 0.36s ease-in-out infinite alternate; }
        .player-character.pose-shock .torso-g { animation: pc-recoil 0.5s ease-out forwards; }
        .player-character.pose-shock .head-tilt { animation: pc-recoil-head 0.5s ease-out forwards; }
        .player-character.pose-shock .arm-l { animation: pc-shock-l 0.5s ease-out forwards; }
        .player-character.pose-shock .arm-r { animation: pc-shock-r 0.5s ease-out forwards; }

        @keyframes pc-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
        @keyframes pc-mouth { from { transform: scaleY(0.6); } to { transform: scaleY(1.8); } }
        @keyframes pc-zzz { 0% { transform: translate(0, 0); opacity: 0; } 30% { opacity: 1; } 100% { transform: translate(8px, -14px); opacity: 0; } }
        @keyframes pc-pulse { from { transform: scale(0.85); opacity: 0.7; } to { transform: scale(1.15); opacity: 1; } }
        @keyframes pc-sleep-head { 0%, 100% { transform: rotate(14deg) translateY(2px); } 50% { transform: rotate(9deg) translateY(4px); } }
        @keyframes pc-confused-head { 0%,100% { transform: rotate(-9deg); } 50% { transform: rotate(9deg); } }
        @keyframes pc-shrug-l { 0%,100% { transform: rotate(-38deg); } 50% { transform: rotate(-28deg); } }
        @keyframes pc-shrug-r { 0%,100% { transform: rotate(38deg); } 50% { transform: rotate(28deg); } }
        @keyframes pc-shake { 0% { transform: translateX(-1px); } 50% { transform: translateX(1px); } 100% { transform: translateX(-1px); } }
        @keyframes pc-fist-l { from { transform: rotate(-30deg); } to { transform: rotate(-52deg); } }
        @keyframes pc-fist-r { from { transform: rotate(30deg); } to { transform: rotate(52deg); } }
        @keyframes pc-recoil { from { transform: translateX(0); } to { transform: translateX(-5px); } }
        @keyframes pc-recoil-head { from { transform: rotate(0deg); } to { transform: rotate(-10deg) translateX(-3px); } }
        @keyframes pc-shock-l { from { transform: rotate(0deg); } to { transform: rotate(-120deg); } }
        @keyframes pc-shock-r { from { transform: rotate(0deg); } to { transform: rotate(120deg); } }
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
          <ellipse cx="60" cy="140" rx={26 * widen} ry="4" fill="rgba(0,0,0,0.28)" />

          {/* legs + torso widen together for build; wrapper is static so it
              never fights the CSS pose transforms on the inner groups */}
          <g transform={`translate(60,0) scale(${widen},1) translate(-60,0)`}>
            <g transform="translate(48,94)"><g className="leg-l">
              <rect x="-5" y="0" width="10" height="42" rx="5" fill={P} />
              <rect x="-7" y="37" width="14" height="7" rx="3.5" fill={silhouette ? dark : shoes} />
            </g></g>
            <g transform="translate(72,94)"><g className="leg-r">
              <rect x="-5" y="0" width="10" height="42" rx="5" fill={P} />
              <rect x="-7" y="37" width="14" height="7" rx="3.5" fill={silhouette ? dark : shoes} />
            </g></g>

            <rect x="55" y="44" width="10" height="9" fill={S} />
            {!silhouette && <ellipse cx="60" cy="48.2" rx="6.2" ry="2" fill="rgba(0,0,0,0.2)" />}

            <g className="torso-g" transform="translate(0,0)">
              <rect x="38" y="50" width="44" height="46" rx="10" fill={K} />
              {!silhouette && <path d="M60 50 H72 a10 10 0 0 1 10 10 V86 a10 10 0 0 1 -10 10 H60 Z" fill="rgba(0,0,0,0.13)" />}
              {!suit && !has("vest") && !silhouette && <rect x="55" y="50" width="10" height="46" fill="rgba(255,255,255,0.2)" />}
              {!suit && !silhouette && <path d="M52.5 50 L60 58.5 L67.5 50" stroke="rgba(0,0,0,0.28)" strokeWidth="1.5" fill="none" strokeLinejoin="round" />}
              {has("vest") && !silhouette && (<>
                <rect x="38" y="62" width="44" height="5" fill="rgba(255,255,255,0.75)" />
                <rect x="38" y="78" width="44" height="5" fill="rgba(255,255,255,0.75)" />
              </>)}
              {has("tie") && !silhouette && (<>
                <path d="M52 50 L60 62 L68 50 Z" fill="#fff" />
                <path d="M60 58 l-3.4 5 l3.4 18 l3.4 -18 z" fill={accent} />
              </>)}
              {has("pearls") && !silhouette && (<>
                <path d="M52 50 L60 61 L68 50 Z" fill="#fff" />
                {[...Array(7)].map((_, t) => (
                  <circle key={t} cx={60 + (t - 3) * 2.7} cy={52.4 + (t - 3) * (t - 3) * 0.42} r="1.35" fill="#f7f3ea" stroke="#c9c2b0" strokeWidth="0.35" />
                ))}
              </>)}
              {has("whistle") && !silhouette && (<>
                <path d="M54 50 L60 66 L66 50" stroke="#222" strokeWidth="1.2" fill="none" />
                <rect x="56.5" y="65" width="7" height="5.5" rx="2.5" fill="#eee" stroke="#222" strokeWidth="0.7" />
              </>)}
              {has("lanyard") && !silhouette && (<>
                <path d="M54.5 50 L58 70 M65.5 50 L62 70" stroke={accent} strokeWidth="1.3" fill="none" />
                <rect x="55.5" y="69" width="9" height="11" rx="1.2" fill="#fff" stroke="#9aa" strokeWidth="0.6" />
                <rect x="57" y="71" width="6" height="3.2" fill="#4a6fa5" />
                <rect x="57" y="76" width="6" height="1" fill="#bbb" /><rect x="57" y="78" width="4" height="1" fill="#bbb" />
              </>)}
              {has("scarf") && !silhouette && (<>
                <path d="M49 49 Q60 57 71 49 L71 57 Q60 65 49 57 Z" fill={accent} />
                <path d="M49 52.4 Q60 60.4 71 52.4" stroke="#fff" strokeWidth="1.6" fill="none" />
                <rect x="62" y="56" width="8" height="26" rx="2" fill={accent} />
                <rect x="62" y="63" width="8" height="2.2" fill="#fff" /><rect x="62" y="71" width="8" height="2.2" fill="#fff" />
              </>)}
              {has("medic") && !silhouette && (<>
                <circle cx="60" cy="68" r="7" fill="#fff" />
                <path d="M60 63.5v9M55.5 68h9" stroke="#d63031" strokeWidth="2.6" />
              </>)}

              {/* arms: sleeve + hand, so a suit reads as a suit */}
              <g transform="translate(40,56)"><g className="arm-l">
                <rect x="-4" y="0" width="8" height="36" rx="4" fill={SL} />
                {has("clipboard") && !silhouette && (<>
                  <rect x="-7" y="26" width="14" height="17" rx="1.6" fill="#b9854f" />
                  <rect x="-5.4" y="29" width="10.8" height="12.5" fill="#fff" />
                  <path d="M-3.6 32.4h7.2M-3.6 35h7.2M-3.6 37.6h4.6" stroke="#9aa" strokeWidth="0.8" />
                </>)}
                <circle cx="0" cy="36" r={handR} fill={hand} stroke={has("gloves") ? "#999" : "none"} strokeWidth="0.8" />
              </g></g>
              <g transform="translate(80,56)"><g className="arm-r">
                <rect x="-4" y="0" width="8" height="36" rx="4" fill={SL} />
                {activePose === "phone" && <rect x="-3" y="27" width="6" height="11" rx="1.5" fill="#1b1b1b" stroke="#6fd3ff" strokeWidth="0.8" />}
                {has("mic") && !silhouette && (<><rect x="-1.6" y="30" width="3.2" height="10" rx="1.6" fill="#333" /><circle cx="0" cy="29" r="3.4" fill="#777" /></>)}
                {has("mug") && !silhouette && (<>
                  <rect x="-5" y="29" width="10" height="12" rx="1.6" fill="#fff" stroke="#9aa" strokeWidth="0.8" />
                  <path d="M5 31.5 q5 0.8 0 6" stroke="#9aa" strokeWidth="1.2" fill="none" />
                  <rect x="-5" y="29" width="10" height="3" rx="1.2" fill="#6b4226" />
                </>)}
                <circle cx="0" cy="36" r={handR} fill={hand} stroke={has("gloves") ? "#999" : "none"} strokeWidth="0.8" />
              </g></g>
            </g>
          </g>

          {/* head, hair and face (tilts as one piece) */}
          <g className="head-tilt" transform="translate(60,30)">
            {hairStyle === "afro" && <circle cx="0" cy="-5" r="20.5" fill={H} />}
            {hairStyle === "long" && <path d="M-17.5 -3 C-20.5 10 -18 22 -13 26 L13 26 C18 22 20.5 10 17.5 -3 Z" fill={H} />}
            {hairStyle === "bob" && <path d="M-17.5 -3 C-19.5 8 -17.5 16 -12 17.5 L12 17.5 C17.5 16 19.5 8 17.5 -3 Z" fill={H} />}
            {hairStyle === "bun" && <circle cx="0" cy="-19" r="6.8" fill={H} />}
            {!silhouette && <><circle cx="-16" cy="1.5" r="3.2" fill={S} /><circle cx="16" cy="1.5" r="3.2" fill={S} />
              <circle cx="-16" cy="1.5" r="1.5" fill="rgba(0,0,0,0.14)" /><circle cx="16" cy="1.5" r="1.5" fill="rgba(0,0,0,0.14)" /></>}
            <circle cx="0" cy="0" r="16" fill={S} />
            {hairStyle !== "bald" && hairStyle !== "cap" && <path d="M-16.5 0 C-18 -21 18 -21 16.5 0 C11.5 -9 -11.5 -9 -16.5 0 Z" fill={H} />}
            {hairStyle === "cap" && (<>
              <path d="M-17 -2 C-17 -22 17 -22 17 -2 Z" fill={silhouette ? dark : accent} />
              <rect x="1" y="-6" width="21" height="4.5" rx="2.2" fill={silhouette ? dark : accent} />
            </>)}
            {has("headband") && !silhouette && <rect x="-14.5" y="-9" width="29" height="4.2" rx="2" fill={accent} />}

            {!silhouette && (activePose === "sleep" ? (<>
              <path d="M-8.5 -0.5 h5.5 M3 -0.5 h5.5" stroke="#2a1a10" strokeWidth="1.5" strokeLinecap="round" />
              <ellipse cx="0" cy="8" rx="2.4" ry="1.7" fill="#5a2d1a" />
            </>) : (<>
              {/* eyebrows — their angle carries a lot of the emotion */}
              {activePose === "angry" ? (<>
                <path d="M-9 -6.8 L-3 -4.2" stroke={brow} strokeWidth="1.8" strokeLinecap="round" />
                <path d="M9 -6.8 L3 -4.2" stroke={brow} strokeWidth="1.8" strokeLinecap="round" />
              </>) : activePose === "disappointed" || activePose === "confused" ? (<>
                <path d="M-9 -4 L-3 -6.4" stroke={brow} strokeWidth="1.6" strokeLinecap="round" />
                <path d="M9 -4 L3 -6.4" stroke={brow} strokeWidth="1.6" strokeLinecap="round" />
              </>) : activePose === "shock" || activePose === "celebrate" ? (<>
                <path d="M-9 -7.4 q3 -2.4 6 0" stroke={brow} strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <path d="M3 -7.4 q3 -2.4 6 0" stroke={brow} strokeWidth="1.5" fill="none" strokeLinecap="round" />
              </>) : (<>
                <path d="M-9 -5.4 q3 -2 6 0" stroke={brow} strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <path d="M3 -5.4 q3 -2 6 0" stroke={brow} strokeWidth="1.5" fill="none" strokeLinecap="round" />
              </>)}
              <g className="eyes"><circle cx="-5.5" cy="-0.5" r="1.8" fill="#1a1a1a" /><circle cx="5.5" cy="-0.5" r="1.8" fill="#1a1a1a" /></g>
              <path d="M-1.3 3 q1.3 2.4 2.6 0" stroke="rgba(0,0,0,0.28)" strokeWidth="1" fill="none" strokeLinecap="round" />
              {has("glasses") && (<g stroke="#2a2a2a" strokeWidth="1.1" fill="rgba(255,255,255,0.1)">
                <circle cx="-5.5" cy="-0.5" r="4.4" /><circle cx="5.5" cy="-0.5" r="4.4" /><path d="M-1.1 -0.8 h2.2" fill="none" />
              </g>)}
              {activePose === "talking" && <ellipse className="mouth-talk" cx="0" cy="8" rx="3" ry="1.6" fill="#5a2d1a" />}
              {activePose === "disappointed" && <path d="M-4.2 9.5 Q0 6 4.2 9.5" stroke="#5a2d1a" strokeWidth="1.5" fill="none" strokeLinecap="round" />}
              {activePose === "angry" && <path d="M-4.6 10 Q0 6.4 4.6 10" stroke="#5a2d1a" strokeWidth="1.8" fill="none" strokeLinecap="round" />}
              {activePose === "confused" && <path d="M-4.4 8.6 q2.2 -2.4 4.4 0 t4.4 0" stroke="#5a2d1a" strokeWidth="1.4" fill="none" strokeLinecap="round" />}
              {activePose === "shock" && <ellipse cx="0" cy="9" rx="2.8" ry="3.6" fill="#5a2d1a" />}
              {activePose === "celebrate" && <path d="M-5 6 Q0 12.5 5 6 Z" fill="#5a2d1a" />}
              {!["talking", "disappointed", "celebrate", "angry", "confused", "shock"].includes(activePose) && <path d="M-4.2 7 Q0 10.2 4.2 7" stroke="#5a2d1a" strokeWidth="1.5" fill="none" strokeLinecap="round" />}
            </>))}
          </g>

          {activePose === "sleep" && (<g fill="#9ad0ff" fontFamily="sans-serif" fontWeight="700">
            <text className="fx" x="82" y="24" fontSize="13">z</text>
            <text className="fx" x="90" y="14" fontSize="10" style={{ animationDelay: "0.8s" }}>z</text>
            <text className="fx" x="97" y="6" fontSize="8" style={{ animationDelay: "1.6s" }}>z</text>
          </g>)}
          {activePose === "confused" && (<g fill="#ffd166" fontFamily="sans-serif" fontWeight="800">
            <text className="fx" x="84" y="20" fontSize="17">?</text>
            <text className="fx" x="30" y="14" fontSize="12" style={{ animationDelay: "1s" }}>?</text>
          </g>)}
          {activePose === "shock" && (<text className="fx-pulse" x="82" y="16" fontSize="22" fontFamily="sans-serif" fontWeight="900" fill="#ff6b6b">!</text>)}
          {activePose === "angry" && (<path className="fx-pulse" d="M84 12 l6 -3.5 M87 20 l7 0 M84 28 l6 3.5" stroke="#e74c3c" strokeWidth="2" strokeLinecap="round" fill="none" />)}
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
