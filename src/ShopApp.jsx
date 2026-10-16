// Standalone shop app shell (mounted by src/shop-main.jsx at /shop-app/).
//
// Gives ShopPage what App.jsx normally hands it — theme, session, profile,
// admin flag — without pulling in App.jsx (15k lines of leagues, ladders,
// chess...). Guests can browse and check out exactly as they can in the
// main app; signing in with Google adds order history, prefilled contact
// details and, for admins, the product/order management screens.

import React, { useState, useEffect, useMemo, Suspense, lazy } from "react";
import { Sun, Moon, Download, Share } from "lucide-react";
import { supabase, setStaySignedInPreference, clearAllAuthStorage } from "./supabaseClient";

const ShopPage = lazy(() => import("./Shop.jsx"));

// Same key and dark/light values as App.jsx's THEME_KEY / THEMES (gold
// accent), so the shop looks like the rest of Matchday and a theme chosen
// in either place carries over. Copied rather than imported on purpose —
// importing from App.jsx would drag the whole league app into this bundle.
// If App.jsx's palette changes, update this too.
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

export default function ShopApp() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { return "dark"; }
  });
  const c = THEMES[theme];

  // undefined = still checking, null = signed out
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [installEvent, setInstallEvent] = useState(null);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    document.title = "Department Store";
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

  const userId = session?.user?.id;
  useEffect(() => {
    if (!userId) { setProfile(null); setIsAdmin(false); return; }
    let active = true;
    supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle()
      .then(({ data }) => { if (active) setProfile(data || null); });
    supabase.from("admins").select("user_id").eq("user_id", userId).maybeSingle()
      .then(({ data }) => { if (active) setIsAdmin(!!data); });
    return () => { active = false; };
  }, [userId]);

  // Chrome/Android fires this once the app is installable; iOS Safari never
  // does, so it gets a manual "Share → Add to Home Screen" hint instead.
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

  // Same OAuth flow as App.jsx's signInWithGoogle: clean origin+pathname
  // redirect so the user lands back in the shop app, not the league app.
  const signIn = async () => {
    setStaySignedInPreference(true);
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  };
  const signOut = async () => { await supabase.auth.signOut(); clearAllAuthStorage(); };

  const showInstall = !isStandalone() && (installEvent || isIos());
  const pillStyle = { background: c.surface, color: c.textDim, border: `1px solid ${c.border}` };

  return (
    <div className="min-h-screen font-body" style={{ background: c.bg, color: c.text }}>
      <header className="sticky top-0 z-30 border-b backdrop-blur"
        style={{ borderColor: c.border, background: `${c.bg}E6`, paddingTop: "env(safe-area-inset-top)" }}>
        <div className="max-w-3xl md:max-w-4xl lg:max-w-5xl mx-auto px-4 h-12 flex items-center justify-between gap-2">
          <div className="text-sm font-extrabold uppercase tracking-tight truncate">Department Store</div>
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
        ) : (
          <Suspense fallback={<div className="py-24 text-center text-sm" style={{ color: c.textFaint }}>Loading…</div>}>
            {/* onBack is only reachable from the shop's root-screen "Matchday"
                link — it hands off to the league app, which is a separate
                app, so it's a plain navigation rather than a router move. */}
            <ShopPage c={c} session={session} profile={profile} isAdmin={isAdmin}
              onBack={() => window.location.assign("/")} onRequireAuth={signIn} initialProductId={null} />
          </Suspense>
        )}
      </main>
    </div>
  );
}
