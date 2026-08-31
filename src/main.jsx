import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import "./index.css";

// Last-resort catch-all: App.jsx has its own per-screen ErrorBoundaries so a
// broken screen never blanks the rest of the app, but this outer one is the
// backstop for anything that goes wrong before App even gets that far
// (auth/session bootstrapping, a crash in the header, etc.) — with no
// `onGoHome` to reset into (App's own state may be what's broken), so its
// fallback offers a real page reload instead.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary fallback={(error, retry) => (
      <div className="min-h-screen flex flex-col items-center justify-center text-center gap-3 px-6 font-body" style={{ fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
        <div className="font-bold text-lg">Something went wrong.</div>
        <div className="text-sm opacity-70 max-w-xs">Reloading the page should fix it.</div>
        <button onClick={() => window.location.reload()} className="text-sm font-semibold px-5 py-2.5 rounded-full border mt-1">Reload</button>
      </div>
    )}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

// Fades out the full-bleed launch splash (see the inline #splash markup in
// index.html) once the app has actually painted, rather than the instant
// React.render() returns — render() only schedules the commit, it doesn't
// guarantee the browser has painted yet. A short minimum-display floor
// avoids an awkward one-frame flash of the splash on an already-warm cache.
const MIN_SPLASH_MS = 500;
const splashShownAt = performance.now();
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const splash = document.getElementById("splash");
    if (!splash) return;
    const elapsed = performance.now() - splashShownAt;
    const wait = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(() => {
      splash.classList.add("splash-hidden");
      splash.addEventListener("transitionend", () => splash.remove(), { once: true });
    }, wait);
  });
});

// Registers the installability service worker (see public/sw.js). Deferred
// to the window "load" event so it never competes with the app's own
// initial fetches (Supabase session bootstrap, first data load) for
// bandwidth/priority on a slow connection.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
