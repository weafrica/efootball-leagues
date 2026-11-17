// Standalone Stories app shell (mounted by src/stories-main.jsx at /stories/).
//
// Same idea as ShopApp.jsx: gives the Stories screen what App.jsx normally
// hands it — theme, session, toasts — without pulling in App.jsx (15k lines of
// leagues, ladders, chess...). Same origin and same Supabase account as
// Matchday, so signing in on either signs you in on both.
//
// Stories are only readable by signed-in players (that's how the database is
// set up), so signed-out visitors get the public landing page instead.

import React, { useState, useEffect, Suspense, lazy } from "react";
import { Sun, Moon, Download, Share, BookOpen } from "lucide-react";
import { supabase, setStaySignedInPreference, clearAllAuthStorage } from "./supabaseClient";
import { StoriesLanding } from "./StoriesHome.jsx";

const StoriesPage = lazy(() => import("./Stories.jsx"));

// Same key and values as App.jsx's THEME_KEY / THEMES (copied, not imported,
// for the same reason as in ShopApp.jsx). If App.jsx's palette changes,
// update this too.
const THEME_KEY = "efootball-theme-v1";
const THEMES = {
  dark: {
    bg: "#0B1F17", surface: "rgba(241,250,238,0.045)", surfaceHover: "rgba(241,250,238,0.08)",
    border: "rgba(241,250,238,0.10)", borderStrong: "rgba(241,250,238,0.18)", text: "#F1FAEE",
    textDim: "rgba(241,250,238,0.55)", textFaint: "rgba(241,250,238,0.35)", accent: "#E9C46A",
    accentText: "#0B1F17", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.35)", greenText: "#7FC9A2",
    red: "#E63946", redSoft: "rgba(230,57,70,0.2)", toastBg: "#F1FAEE", toastText: "#0B1F17",
  },
  light: {
    bg: "#F6F5F0", surface: "rgba(14,42,32,0.04)", surfaceHover: "rgba(14,42,32,0.07)",
    border: "rgba(14,42,32,0.10)", borderStrong: "rgba(14,42,32,0.18)", text: "#0E2A20",
    textDim: "rgba(14,42,32,0.6)", textFaint: "rgba(14,42,32,0.4)", accent: "#B4802E",
    accentText: "#F6F5F0", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.15)", greenText: "#1F6B45",
    red: "#C4293A", redSoft: "rgba(196,41,58,0.12)", toastBg: "#0E2A20", toastText: "#F6F5F0",
  },
};

const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent);

export default function StoriesApp() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  const c = THEMES[theme];

  // undefined = still checking, null = signed out
  const [session, setSession] = useState(undefined);
  const [installEvent, setInstallEvent] = useState(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    document.title = "WeAfrica Stories";
    document.body.style.background = c.bg;
    document.body.style.color = c.text;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", c.bg);
  }, [c]);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) setSession(data.session || null); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s || null));
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setInstallEvent(e); };
    const onInstalled = () => setInstallEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  };

  const install = async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    setInstallEvent(null);
  };

  // Same OAuth flow as ShopApp / App.jsx: a clean origin+pathname redirect so
  // the reader lands back here, not in the league app. This exact address has
  // to be in Supabase's allowed redirect URLs (see the setup notes).
  const signIn = async () => {
    setStaySignedInPreference(true);
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  };
  const signOut = async () => { await supabase.auth.signOut(); clearAllAuthStorage(); };
  const toMatchday = () => window.location.assign("/");

  const showInstall = !isStandalone() && (installEvent || isIos());
  const pillStyle = { background: c.surface, color: c.textDim, border: `1px solid ${c.border}` };

  return (
    <div className="min-h-screen font-body" style={{ background: c.bg, color: c.text }}>
      <header className="sticky top-0 z-30 border-b backdrop-blur"
        style={{ borderColor: c.border, background: `${c.bg}E6`, paddingTop: "env(safe-area-inset-top)" }}>
        <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 h-12 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: c.accent }}>
              <BookOpen size={15} color={c.accentText} />
            </span>
            <div className="text-sm font-extrabold uppercase tracking-tight truncate">WeAfrica Stories</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {showInstall && (
              <button onClick={installEvent ? install : () => setShowIosHint((v) => !v)}
                className="flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-semibold"
                style={{ background: c.accent, color: c.accentText }}>
                <Download size={13} /> Install
              </button>
            )}
            <button onClick={toggleTheme} aria-label="Toggle theme" className="w-8 h-8 rounded-full flex items-center justify-center" style={pillStyle}>
              {theme === "dark" ? <Sun size={14} color="#F59E0B" /> : <Moon size={14} color="#6366F1" />}
            </button>
            <button onClick={toMatchday} className="px-3 h-8 rounded-full text-xs font-semibold hidden sm:block" style={pillStyle}>Matchday</button>
            {session === null && (
              <button onClick={signIn} className="px-3 h-8 rounded-full text-xs font-semibold" style={pillStyle}>Sign in</button>
            )}
            {session && (
              <button onClick={signOut} className="px-3 h-8 rounded-full text-xs font-semibold" style={pillStyle}>Sign out</button>
            )}
          </div>
        </div>
        {showIosHint && !installEvent && (
          <div className="max-w-3xl mx-auto px-4 pb-2 text-xs flex items-center gap-1.5" style={{ color: c.textDim }}>
            To install: tap <Share size={12} /> Share, then “Add to Home Screen”.
          </div>
        )}
      </header>

      <main className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 pb-24">
        {session === undefined ? (
          <div className="py-24 text-center text-sm" style={{ color: c.textFaint }}>Loading…</div>
        ) : session === null ? (
          <StoriesLanding c={c} onSignIn={signIn} onMatchday={toMatchday} />
        ) : (
          <Suspense fallback={<div className="py-24 text-center text-sm" style={{ color: c.textFaint }}>Loading…</div>}>
            <StoriesPage standalone session={session} showToast={setToast} onBack={toMatchday} c={c} />
          </Suspense>
        )}
      </main>

      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 px-4 py-2.5 rounded-full text-sm font-semibold shadow-lg max-w-[90vw] text-center"
          style={{ background: c.toastBg, color: c.toastText }}>
          {toast}
        </div>
      )}
    </div>
  );
}
