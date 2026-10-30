import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../supabaseClient.js";
import { ErrorBoundary } from "../ErrorBoundary.jsx";
import { LUDO_THEME } from "./theme.js";
import { useInstall } from "./useInstall.js";
import { clearSigninReturnMarker, signOut } from "./auth.js";
import LudoHome from "./LudoHome.jsx";
import LudoLogin from "./LudoLogin.jsx";

// The game itself is the heavy part (board, rules, sound, voice). It's loaded
// only when someone taps Play, so the homepage and sign-in page — what almost
// everyone sees first — stay tiny and fast on a slow connection.
const LudoGame = lazy(() => import("./Ludo.jsx"));

function Spinner({ c }) {
  return (
    <div className="flex items-center justify-center py-24" role="status" aria-label="Loading">
      <div className="w-9 h-9 rounded-full animate-spin" style={{ border: `3px solid ${c.border}`, borderTopColor: c.accent }} />
    </div>
  );
}

// Screens are plain state, mirrored into the History API so the phone's back
// button / swipe-back walks Game -> Home instead of leaving the app. The URL
// itself never changes (an OAuth return puts tokens in the hash, so hash
// routing would fight with it) — a refresh simply lands back on the homepage.
function readInitialScreen() {
  try {
    if (new URLSearchParams(window.location.search).get("action") === "play") return "game";
  } catch { /* ignore */ }
  return "home";
}

export default function LudoApp() {
  const c = LUDO_THEME;
  const install = useInstall();
  const [screen, setScreen] = useState(readInitialScreen);
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));

  // --- session -------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    supabase.auth.getSession()
      .then(({ data }) => { if (alive) { setSession(data.session); setAuthReady(true); } })
      .catch(() => { if (alive) setAuthReady(true); }); // offline / storage blocked: carry on as a guest
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setAuthReady(true);
      // Once supabase-js has consumed the #access_token from the OAuth
      // redirect, drop it from the address bar (same safeguard as Matchday).
      if (window.location.hash.includes("access_token")) {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      }
    });
    clearSigninReturnMarker(); // we made it back to /ludo/ — the bounce marker has done its job
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  // Display name: their Matchday username if they have one, else their Google name.
  useEffect(() => {
    const id = session?.user?.id;
    if (!id) { setProfileName(""); return; }
    let alive = true;
    supabase.from("profiles").select("efootball_username").eq("user_id", id).maybeSingle()
      .then(({ data }) => { if (alive && data?.efootball_username) setProfileName(data.efootball_username); })
      .catch(() => { /* just fall back to the Google name */ });
    return () => { alive = false; };
  }, [session?.user?.id]);

  const displayName = useMemo(() => {
    const u = session?.user;
    if (!u) return "";
    return profileName || u.user_metadata?.full_name || u.user_metadata?.name || (u.email ? u.email.split("@")[0] : "Player");
  }, [session, profileName]);

  // --- connectivity ---------------------------------------------------------
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // --- navigation (state + History API) ---------------------------------------
  useEffect(() => {
    // Seed history so there's always a "home" entry underneath whatever we start on.
    const start = readInitialScreen();
    window.history.replaceState({ ludoScreen: "home" }, "");
    if (start !== "home") window.history.pushState({ ludoScreen: start }, "");
    const onPop = (e) => setScreen(e.state?.ludoScreen || "home");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A ref (not a state updater) so the pushState side effect runs exactly once
  // per navigation — React may invoke updater functions twice in dev.
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const go = useCallback((next) => {
    if (screenRef.current === next) return;
    window.history.pushState({ ludoScreen: next }, "");
    setScreen(next);
  }, []);

  const back = useCallback(() => {
    if (window.history.state?.ludoScreen && window.history.state.ludoScreen !== "home") window.history.back();
    else setScreen("home");
  }, []);

  const handleSignOut = useCallback(async () => {
    try { await signOut(); } catch { /* the auth listener will still update us */ }
    setSession(null);
    setProfileName("");
  }, []);

  return (
    <div className="min-h-screen" style={{
      background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif",
      // keep content clear of the notch / home bar when installed full-screen
      paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)",
      paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)",
    }}>
      <ErrorBoundary resetKey={screen} onGoHome={() => setScreen("home")}>
        {screen === "home" && (
          <LudoHome c={c} session={session} authReady={authReady} displayName={displayName} online={online} install={install}
            onPlay={() => go("game")} onSignIn={() => go("login")} onSignOut={handleSignOut} />
        )}
        {screen === "login" && (
          <LudoLogin c={c} online={online} onBack={back} onGuest={() => { setScreen("game"); window.history.replaceState({ ludoScreen: "game" }, ""); }} />
        )}
        {screen === "game" && (
          <Suspense fallback={<Spinner c={c} />}>
            <LudoGame c={c} onBack={back} loggedIn={!!session}
              onRequireAuth={() => go("login")} />
          </Suspense>
        )}
      </ErrorBoundary>
    </div>
  );
}
