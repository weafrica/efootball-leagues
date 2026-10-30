import React, { useState } from "react";
import { ArrowLeft, Check, WifiOff } from "lucide-react";
import LudoLogo from "./LudoLogo.jsx";
import { signInWithGoogle } from "./auth.js";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z" />
      <path fill="#FBBC05" d="M3.97 10.73a5.4 5.4 0 010-3.46V4.94H.96a9 9 0 000 8.12l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 00.96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

// Ludo's own sign-in page. Google only, same as Matchday (one account across
// both). Guests are first-class — signing in is never required to play.
export default function LudoLogin({ c, online, onBack, onGuest }) {
  const [stay, setStay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const go = async () => {
    setError("");
    if (!online) { setError("You're offline — sign-in needs a connection. You can still play as a guest."); return; }
    setBusy(true);
    try {
      await signInWithGoogle(stay); // navigates away to Google on success
    } catch (e) {
      setBusy(false);
      setError("Couldn't start sign-in. Please try again, or play as a guest.");
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 pt-5 pb-14">
      <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-10" style={{ color: c.textDim }}>
        <ArrowLeft size={15} /> Back
      </button>

      <div className="flex flex-col items-center text-center mb-8">
        <LudoLogo size={76} />
        <h1 className="font-display font-extrabold uppercase leading-none mt-4" style={{ fontSize: 36, letterSpacing: "0.04em", color: c.text }}>
          Sign in
        </h1>
        <p className="font-body text-sm mt-2 max-w-xs" style={{ color: c.textDim }}>
          Use the same Google account as Matchday — there's nothing new to sign up for.
        </p>
      </div>

      <button onClick={go} disabled={busy} className="w-full flex items-center justify-center gap-3 rounded-2xl py-3.5 font-body font-semibold text-sm"
        style={{ background: "#fff", color: "#1f1f1f", opacity: busy ? 0.7 : 1 }}>
        <GoogleIcon /> {busy ? "Opening Google…" : "Continue with Google"}
      </button>

      <label className="flex items-center justify-center gap-2 mt-3.5 cursor-pointer select-none">
        <span className="relative w-4 h-4 shrink-0 rounded flex items-center justify-center"
          style={{ background: stay ? c.accent : "transparent", border: `1px solid ${stay ? c.accent : c.borderStrong}` }}>
          <input type="checkbox" checked={stay} onChange={(e) => setStay(e.target.checked)} className="absolute inset-0 opacity-0 cursor-pointer" />
          {stay && <Check size={11} color={c.accentText} strokeWidth={3} />}
        </span>
        <span className="font-body text-xs" style={{ color: c.textDim }}>Stay signed in on this device</span>
      </label>

      {error && (
        <div role="alert" className="mt-4 rounded-xl px-3.5 py-2.5 font-body text-xs flex items-start gap-2" style={{ background: c.redSoft, color: c.text }}>
          {!online && <WifiOff size={14} className="shrink-0 mt-0.5" />} {error}
        </div>
      )}

      <div className="flex items-center gap-3 my-6">
        <div className="flex-1 h-px" style={{ background: c.border }} />
        <span className="font-body text-[11px]" style={{ color: c.textFaint }}>or</span>
        <div className="flex-1 h-px" style={{ background: c.border }} />
      </div>

      <button onClick={onGuest} className="w-full rounded-2xl py-3.5 font-body font-semibold text-sm"
        style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.text }}>
        Play as a guest
      </button>
      <p className="text-center font-body text-[11px] mt-3 max-w-xs mx-auto" style={{ color: c.textFaint }}>
        Guests can play everything. Signing in just links your games to your Matchday account.
      </p>
    </div>
  );
}
