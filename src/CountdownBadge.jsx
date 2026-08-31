// CountdownBadge — the "Xh left" text next to a fixture, styled and animated
// like a real glowing button rather than a flat label, gamified so the
// closer the deadline gets, the more it looks and feels like it. A calm
// far-off deadline reads as a quiet outline chip; as it tightens it picks up
// a glossy gradient fill and a soft glow, a small reactive mascot appears,
// and in the final stretch it goes full alarm mode — hard pulse, shake,
// a radar-style danger ring expanding around it, and a flickering glitch on
// the text — so the last few minutes actually feel like something is about
// to go wrong, the way a real countdown clock would. Built as its own small
// self-ticking component (rather than reading a parent-supplied `now`)
// specifically so it can be dropped into any fixture row anywhere in the
// app and it'll keep itself current on its own for as long as it's
// mounted — no parent-level timer wiring needed.
//
// Tiers, by time remaining:
//   24h+     "calm"      — quiet outline chip, muted, sleepy clock. Plenty of time.
//   6h–24h   "steady"    — soft filled chip, still relaxed, a plain stopwatch.
//   1h–6h    "warm"      — starting to matter: amber gradient, gentle breathing glow.
//   15m–1h   "hot"       — genuinely urgent: orange-red gradient, flame-flicker glow, fire.
//   0–15m    "critical"  — last call: deep red, heartbeat pulse, shake, glitch text, danger ring.
//   overdue  "expired"   — flat "Overdue", no animation (it's already over).
//
// Usage: <CountdownBadge expiresAt={fixture.countdown_expires_at} />
// Renders nothing if expiresAt is falsy (mirrors the old formatCountdown()
// callers' `{countdownText && ...}` guard, just built in).

import React, { useEffect, useState } from "react";

function tierFor(msLeft) {
  if (msLeft <= 0) return "expired";
  const hours = msLeft / 3600000;
  if (hours >= 24) return "calm";
  if (hours >= 6) return "steady";
  if (hours >= 1) return "warm";
  if (hours >= 0.25) return "hot";
  return "critical";
}

// A little cast of characters so the same tier doesn't always show the
// identical face — picked once per mount per tier (not re-rolled every
// tick), so it doesn't distractingly flicker between options every time
// the timer re-renders.
const MASCOTS = {
  calm: ["🕓", "😴", "🌙"],
  steady: ["⏱️", "🙂", "👀"],
  warm: ["😅", "😬", "⏳"],
  hot: ["🔥", "😰", "⚡"],
  critical: ["🚨", "🥵", "💥"],
  expired: ["💀"],
};

function pickMascot(tier) {
  const options = MASCOTS[tier] || MASCOTS.calm;
  return options[Math.floor(Math.random() * options.length)];
}

// Each tier gets its own gradient fill, border, and layered glow (not just
// a recolor of the same flat chip) so the badge visibly escalates in
// "weight" as the deadline closes in — a quiet outline early on, building
// to a glossy filled button, ending in a hard-edged alarm.
const TIER_STYLE = {
  calm: {
    color: "#9fb0a6",
    bg: "transparent",
    border: "1px solid rgba(159,176,166,0.35)",
    boxShadow: "none",
  },
  steady: {
    color: "#9fe0c8",
    bg: "linear-gradient(180deg, rgba(143,182,168,0.22), rgba(143,182,168,0.08))",
    border: "1px solid rgba(143,182,168,0.4)",
    boxShadow: "0 0 6px rgba(143,182,168,0.25), inset 0 1px 0 rgba(255,255,255,0.08)",
  },
  warm: {
    color: "#3a2a06",
    bg: "linear-gradient(180deg, #FFE29A, #FFC24B)",
    border: "1px solid rgba(255,190,80,0.7)",
    boxShadow: "0 0 10px rgba(255,209,102,0.55), 0 1px 0 rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.5)",
  },
  hot: {
    color: "#fff",
    bg: "linear-gradient(180deg, #FF9A3C, #E8500A)",
    border: "1px solid rgba(255,140,40,0.85)",
    boxShadow: "0 0 14px rgba(255,122,0,0.65), 0 0 28px rgba(255,90,0,0.3), inset 0 1px 0 rgba(255,255,255,0.35)",
  },
  critical: {
    color: "#fff",
    bg: "linear-gradient(180deg, #FF3B3B, #7A0E0E)",
    border: "1px solid rgba(255,80,80,0.9)",
    boxShadow: "0 0 16px rgba(255,59,59,0.85), 0 0 34px rgba(180,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.25)",
  },
  expired: {
    color: "#7a8a80",
    bg: "rgba(122,138,128,0.1)",
    border: "1px solid rgba(122,138,128,0.25)",
    boxShadow: "none",
  },
};

function formatTimeLeft(msLeft) {
  const totalMinutes = Math.max(0, Math.floor(msLeft / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h left`;
  return `${minutes}m left`;
}

export default function CountdownBadge({ expiresAt, className = "" }) {
  const [now, setNow] = useState(() => Date.now());
  const [mascotByTier] = useState(() => ({
    calm: pickMascot("calm"), steady: pickMascot("steady"), warm: pickMascot("warm"),
    hot: pickMascot("hot"), critical: pickMascot("critical"), expired: pickMascot("expired"),
  }));

  useEffect(() => {
    if (!expiresAt) return;
    // Tick every second once inside the final minute, so it actually
    // visibly counts down when it matters most; a slow 30s tick everywhere
    // else is plenty and easier on battery for however long a fixture list
    // sits open.
    const msLeft = new Date(expiresAt).getTime() - now;
    const intervalMs = msLeft <= 60000 ? 1000 : 30000;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [expiresAt, now]);

  if (!expiresAt) return null;

  const msLeft = new Date(expiresAt).getTime() - now;
  const tier = tierFor(msLeft);
  const style = TIER_STYLE[tier];
  const text = tier === "expired" ? "Overdue" : formatTimeLeft(msLeft);
  const mascot = mascotByTier[tier];

  return (
    <span
      className={`countdown-badge countdown-${tier} relative inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-1 ${className}`}
      style={{
        color: style.color,
        background: style.bg,
        border: style.border,
        boxShadow: style.boxShadow,
      }}
      title={tier === "critical" ? "Time's almost up!" : tier === "hot" ? "Getting tight — better hurry" : undefined}
    >
      <span className="countdown-mascot" aria-hidden="true">{mascot}</span>
      <span className="countdown-label">{text}</span>
    </span>
  );
}
