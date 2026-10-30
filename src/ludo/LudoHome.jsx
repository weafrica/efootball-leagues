import React from "react";
import {
  Play, Users, Lock, Volume2, Download, Share, LogIn, LogOut, WifiOff, Wifi, Trophy,
} from "lucide-react";
import LudoLogo from "./LudoLogo.jsx";
import { LUDO_COLORS } from "./theme.js";

// Ludo's own homepage — the first thing anyone sees at weafrica.co.za/ludo.
// Pure presentation: LudoApp owns the session, install state and navigation
// and hands them in, so this file has no data fetching of its own.
export default function LudoHome({ c, session, authReady, displayName, online, install, onPlay, onSignIn, onSignOut }) {
  const signedIn = !!session;
  const initial = (displayName || "?").trim().charAt(0).toUpperCase();

  const features = [
    { icon: Users, title: "Your way", body: "2 to 4 players. Bots, pass-and-play with friends, or a mix." },
    { icon: Lock, title: "Capture & ransom", body: "Eat a token and it's a prisoner. Roll a 6 to buy your own back." },
    { icon: Trophy, title: "Rampage", body: "Double kills, killing sprees and a stadium announcer calling every one." },
    { icon: Volume2, title: "Built to be heard", body: "Layered sound effects and a victory celebration for the whole board." },
  ];

  return (
    <div className="max-w-md mx-auto px-4 pt-5 pb-14">
      <style>{`
        @keyframes ludoHomeFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
        .ludo-home-tok { animation: ludoHomeFloat 2.4s ease-in-out infinite; }
      `}</style>

      {/* top bar: back to Matchday on the left, account on the right */}
      <div className="flex items-center justify-between mb-8">
        <a href="/" className="font-body text-xs flex items-center gap-1.5" style={{ color: c.textFaint }}>
          ← WeAfrica
        </a>
        {!authReady ? (
          <div style={{ height: 32 }} aria-hidden="true" />
        ) : signedIn ? (
          <button onClick={onSignOut} className="flex items-center gap-2 rounded-full pl-1 pr-3 py-1 font-body text-xs"
            style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }} aria-label="Sign out">
            <span className="w-6 h-6 rounded-full flex items-center justify-center font-bold text-[11px]" style={{ background: c.accent, color: c.accentText }}>{initial}</span>
            <span className="max-w-[110px] truncate">{displayName}</span>
            <LogOut size={12} />
          </button>
        ) : (
          <button onClick={onSignIn} className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-body text-xs font-semibold"
            style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}>
            <LogIn size={13} /> Sign in
          </button>
        )}
      </div>

      {/* hero */}
      <div className="flex flex-col items-center text-center mb-8">
        <div className="relative mb-5">
          <LudoLogo size={104} />
          {LUDO_COLORS.map((col, i) => (
            <span key={col} className="ludo-home-tok absolute rounded-full"
              style={{
                width: 14, height: 14, background: col, border: "2px solid #fff", animationDelay: `${i * 0.25}s`,
                top: i < 2 ? -6 : "auto", bottom: i >= 2 ? -6 : "auto", left: i % 3 === 0 ? -8 : "auto", right: i % 3 !== 0 ? -8 : "auto",
              }} />
          ))}
        </div>
        <h1 className="font-display font-extrabold uppercase leading-none" style={{ fontSize: 54, letterSpacing: "0.04em", color: c.text }}>
          Ludo
        </h1>
        <p className="font-body text-sm mt-2 max-w-xs" style={{ color: c.textDim }}>
          The classic race home — with prisoners, ransoms and an announcer who never lets a kill go unnoticed.
        </p>
      </div>

      {/* primary action */}
      <button onClick={onPlay} className="w-full flex items-center justify-center gap-2.5 rounded-2xl py-4 font-display font-bold uppercase tracking-wider text-xl"
        style={{ background: c.accent, color: c.accentText, boxShadow: `0 6px 24px ${c.accent}40` }}>
        <Play size={22} fill="currentColor" /> Play now
      </button>
      {authReady && !signedIn && (
        <button onClick={onSignIn} className="w-full mt-2.5 rounded-2xl py-3 font-body text-sm"
          style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }}>
          Sign in to link your games to your account
        </button>
      )}
      {authReady && signedIn && (
        <p className="text-center font-body text-xs mt-3" style={{ color: c.textFaint }}>Signed in as {displayName}</p>
      )}

      {/* install (Android/desktop: a real button; iOS: how-to; already installed: nothing) */}
      {!install.standalone && install.canInstall && (
        <button onClick={install.install} className="w-full mt-4 flex items-center justify-center gap-2 rounded-2xl py-3 font-body text-sm font-semibold"
          style={{ background: "transparent", border: `1px dashed ${c.borderStrong}`, color: c.text }}>
          <Download size={16} style={{ color: c.accent }} /> Install Ludo on this device
        </button>
      )}
      {!install.standalone && !install.canInstall && install.isIOS && (
        <div className="mt-4 rounded-2xl px-4 py-3 font-body text-xs flex items-start gap-2.5" style={{ border: `1px dashed ${c.borderStrong}`, color: c.textDim }}>
          <Share size={16} className="shrink-0 mt-0.5" style={{ color: c.accent }} />
          <span>Install Ludo: tap <b style={{ color: c.text }}>Share</b>, then <b style={{ color: c.text }}>Add to Home Screen</b>.</span>
        </div>
      )}

      {/* connection status — the game itself needs no network */}
      <div className="mt-4 flex items-center justify-center gap-1.5 font-body text-[11px]" style={{ color: online ? c.textFaint : c.accent }}>
        {online ? <Wifi size={12} /> : <WifiOff size={12} />}
        {online ? "Online" : "Offline — you can still play"}
      </div>

      {/* what's in the game */}
      <div className="mt-8 grid grid-cols-2 gap-2.5">
        {features.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-2xl p-3.5" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            <Icon size={18} style={{ color: c.accent }} />
            <div className="font-display font-bold uppercase tracking-wide text-sm mt-2" style={{ color: c.text }}>{title}</div>
            <div className="font-body text-[11px] leading-snug mt-1" style={{ color: c.textDim }}>{body}</div>
          </div>
        ))}
      </div>

      <div className="mt-10 text-center font-body text-[11px]" style={{ color: c.textFaint }}>
        A WeAfrica game · <a href="/" style={{ color: c.textDim, textDecoration: "underline" }}>Back to Matchday</a>
      </div>
    </div>
  );
}
