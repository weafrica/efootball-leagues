import React from "react";
import { LUDO_COLORS } from "./theme.js";

// The Ludo mark — a mini board (four colored yards around a white cross)
// with a die in the middle. Pure inline SVG, so it costs no network request
// and scales crisply to any size. Same artwork the app icons are drawn from
// (see scripts/ludo-icons/make_icons.py).
export default function LudoLogo({ size = 96, className = "" }) {
  const [r, g, y, b] = LUDO_COLORS;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} role="img" aria-label="Ludo">
      <rect x="2" y="2" width="96" height="96" rx="22" fill="#1A1240" />
      <rect x="12" y="12" width="34" height="34" rx="9" fill={r} />
      <rect x="54" y="12" width="34" height="34" rx="9" fill={g} />
      <rect x="54" y="54" width="34" height="34" rx="9" fill={y} />
      <rect x="12" y="54" width="34" height="34" rx="9" fill={b} />
      <rect x="35" y="35" width="30" height="30" rx="8" fill="#fff" stroke="#1A1240" strokeWidth="3" />
      {[[43, 43], [57, 43], [43, 50], [57, 50], [43, 57], [57, 57]].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="2.6" fill="#1A1240" />
      ))}
    </svg>
  );
}
