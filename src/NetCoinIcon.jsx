// NetCoinIcon — the "Nets" currency icon (embossed gold coin, option #1
// from the icon concepts review), replacing the generic lucide <Coins />
// wherever Nets specifically are shown. Coins is a plain two-tone outline
// icon that reads as "generic currency"; this is a small self-contained
// SVG with its own radial gold gradient and embossed "N" so it reads as
// an actual coin rather than a line-icon stand-in, at the small sizes
// (13-18px) it's used at throughout the app.
//
// glow (default true) adds a soft drop-shadow around the coin — subtle at
// icon sizes, meant to read as "this thing is valuable" rather than as a
// loud effect. Pass glow={false} for places where the coin sits inside
// text-dense UI (e.g. a dense list) and the glow would just add visual
// noise rather than draw the eye usefully.
//
// Usage: <NetCoinIcon size={14} /> — drop-in replacement for
// <Coins size={14} style={{ color: "#D4A017" }} />, same size prop, no
// color prop needed since the coin carries its own gold gradient.

import React, { useId } from "react";

export default function NetCoinIcon({ size = 16, glow = true, className = "" }) {
  const gradId = useId();
  const glowId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      style={{ overflow: "visible", flexShrink: 0 }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={gradId} cx="38%" cy="32%" r="70%">
          <stop offset="0%" stopColor="#FFF4CE" />
          <stop offset="35%" stopColor="#FFD166" />
          <stop offset="72%" stopColor="#D4A017" />
          <stop offset="100%" stopColor="#9c7412" />
        </radialGradient>
        {glow && (
          <filter id={glowId} x="-75%" y="-75%" width="250%" height="250%">
            <feGaussianBlur stdDeviation="1.6" result="blur" />
            <feColorMatrix in="blur" type="matrix"
              values="0 0 0 0 0.83  0 0 0 0 0.63  0 0 0 0 0.09  0 0 0 0.55 0" />
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      <circle cx="12" cy="12" r="10" fill={`url(#${gradId})`} filter={glow ? `url(#${glowId})` : undefined} />
      <circle cx="12" cy="12" r="10" fill="none" stroke="#7a5a0c" strokeOpacity="0.45" strokeWidth="0.6" />
      <text x="12" y="16.5" textAnchor="middle" fontFamily="'Barlow Condensed', 'Oswald', sans-serif"
        fontWeight="800" fontSize="13" fill="#7a5a0c">N</text>
    </svg>
  );
}

// NetsAmount — pairs a formatted Nets number with the actual NetCoinIcon
// graphic instead of the plain letter "N" that formatNets()/formatMoney()
// append as a text suffix. Anywhere a Nets figure is rendered as JSX (a
// balance, a fee, a transaction line, a button label) should use this
// instead of dropping a bare formatNets(...) string in, so the icon shows
// up in place of the "N" rather than alongside it.
//
// Not for plain-text contexts that leave the app as a string — toast
// messages (also spoken via TTS), WhatsApp/share text, clipboard content —
// those have nowhere to put an inline SVG and should keep using
// formatNets()/formatMoney() as before.
//
// Usage: <NetsAmount amount={balance} /> — renders e.g. "1,250" + coin.
// prefix lets a caller add a "+"/"–" sign in front of the number, still
// ahead of the coin: <NetsAmount amount={t.amount} prefix={credit ? "+" : ""} />
export function NetsAmount({ amount, size = 13, glow = false, prefix = "", className = "" }) {
  const n = Number(amount) || 0;
  return (
    <span className={`inline-flex items-center gap-[3px] whitespace-nowrap ${className}`}>
      {prefix}{n.toLocaleString("en-ZA")}
      <NetCoinIcon size={size} glow={glow} />
    </span>
  );
}
