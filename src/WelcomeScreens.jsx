// Two small screens for signed-in people:
//  - WelcomeGate: the first thing weafrica.co.za shows each visit, even when
//    already signed in. One tap to carry on, or switch account.
//  - AppHub: where a signed-in person with no game username lands. They can
//    open the shop and the other games straight away; a username is only
//    asked for when they pick Matchday (the eFootball leagues).
import React from "react";
import { ShoppingBag, Crown, Gamepad2, Globe2, BookOpen, Trophy, Dices, LogOut, ArrowRight } from "lucide-react";

const GOLD = "#D4A017";

export function displayNameFor(session, profile) {
  const meta = session?.user?.user_metadata || {};
  return profile?.efootball_username || meta.full_name || meta.name || session?.user?.email || "your account";
}

export function WelcomeGate({ c, session, profile, onContinue, onSwitch }) {
  const name = displayNameFor(session, profile);
  const avatar = session?.user?.user_metadata?.avatar_url || session?.user?.user_metadata?.picture || null;
  return (
    <div className="min-h-screen flex items-center justify-center px-5" style={{ background: c.bg, color: c.text }} data-testid="welcome-gate">
      <div className="w-full max-w-sm text-center">
        <div className="font-mono text-[11px] uppercase tracking-[0.25em] mb-3" style={{ color: GOLD }}>WeAfrica</div>
        <h1 className="text-4xl font-extrabold uppercase tracking-tight leading-none mb-2">Welcome back</h1>
        <p className="font-body text-sm mb-7" style={{ color: c.textDim }}>Play, shop and compete, all in one place.</p>
        <div className="rounded-2xl p-5 mb-3" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
          {avatar && <img src={avatar} alt="" referrerPolicy="no-referrer" className="w-14 h-14 rounded-full mx-auto mb-3 object-cover" />}
          <div className="font-body text-xs mb-1" style={{ color: c.textFaint }}>Signed in as</div>
          <div className="font-body text-base font-semibold break-words" data-testid="welcome-name">{name}</div>
          <button onClick={onContinue} data-testid="welcome-continue"
            className="w-full mt-4 font-body text-sm font-semibold py-3 rounded-full flex items-center justify-center gap-1.5" style={{ background: GOLD, color: "#1a1200" }}>
            Continue <ArrowRight size={15} />
          </button>
        </div>
        <button onClick={onSwitch} data-testid="welcome-switch" className="font-body text-xs underline" style={{ color: c.textDim }}>Not you? Use a different account</button>
      </div>
    </div>
  );
}

const TILES = [
  { key: "shop", label: "Shop", note: "Kits, jerseys and gear", Icon: ShoppingBag },
  { key: "chess", label: "Chess", Icon: Crown },
  { key: "planetearth", label: "Planet Earth", Icon: Globe2 },
  { key: "ludo", label: "Ludo", Icon: Dices },
  { key: "sesothoMatch", label: "Language Learning", Icon: BookOpen },
  { key: "stories", label: "Stories", Icon: Gamepad2 },
];

export function AppHub({ c, session, onOpen, onMatchday, onSignOut }) {
  const name = displayNameFor(session, null);
  return (
    <div className="min-h-screen px-4 py-8" style={{ background: c.bg, color: c.text }} data-testid="app-hub">
      <div className="max-w-xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="min-w-0">
            <div className="font-mono text-[11px] uppercase tracking-[0.25em] mb-1" style={{ color: GOLD }}>WeAfrica</div>
            <h1 className="text-3xl font-extrabold uppercase tracking-tight leading-none">Where to?</h1>
            <p className="font-body text-xs mt-1.5 truncate" style={{ color: c.textDim }}>Signed in as {name}</p>
          </div>
          <button onClick={onSignOut} aria-label="Sign out" className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: c.surface, color: c.textDim }}><LogOut size={15} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          {TILES.map(({ key, label, note, Icon }) => (
            <button key={key} onClick={() => onOpen(key)} data-testid={`hub-${key}`} className="text-left rounded-2xl p-4" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
              <Icon size={22} style={{ color: GOLD }} />
              <div className="font-body text-sm font-semibold mt-2.5">{label}</div>
              {note && <div className="font-body text-[11px] mt-0.5" style={{ color: c.textFaint }}>{note}</div>}
            </button>
          ))}
        </div>

        <button onClick={onMatchday} data-testid="hub-matchday" className="w-full text-left rounded-2xl p-4 flex items-center gap-3" style={{ background: c.surface, border: `1px solid ${GOLD}` }}>
          <Trophy size={22} style={{ color: GOLD }} />
          <span className="flex-1 min-w-0">
            <span className="block font-body text-sm font-semibold">Matchday: eFootball leagues</span>
            <span className="block font-body text-[11px] mt-0.5" style={{ color: c.textFaint }}>Join leagues, challenges and the ladder. We'll ask for your eFootball username.</span>
          </span>
          <ArrowRight size={16} style={{ color: GOLD }} />
        </button>
      </div>
    </div>
  );
}
