import React from "react";
import ReactDOM from "react-dom/client";
import LudoApp from "./LudoApp.jsx";
import { ErrorBoundary } from "../ErrorBoundary.jsx";
import "../index.css";

// ---- install prompt ----------------------------------------------------------
// Chrome fires `beforeinstallprompt` once, possibly before React has mounted.
// Catch it here, park it on window, and tell the UI (useInstall.js) it's ready.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__ludoInstallPrompt = e;
  window.dispatchEvent(new Event("ludo-installprompt"));
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary fallback={(error, retry) => (
      <div className="min-h-screen flex flex-col items-center justify-center text-center gap-3 px-6" style={{ background: "#100A2B", color: "#F6F3FF", fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
        <div className="font-bold text-lg">Something went wrong.</div>
        <div className="text-sm opacity-70 max-w-xs">Reloading should fix it.</div>
        <button onClick={() => window.location.reload()} className="text-sm font-semibold px-5 py-2.5 rounded-full border mt-1">Reload</button>
      </div>
    )}>
      <LudoApp />
    </ErrorBoundary>
  </React.StrictMode>
);

// ---- launch splash -----------------------------------------------------------
// The inline #splash in ludo/index.html shows instantly (no stylesheet to wait
// on) so an installed launch never flashes white; fade it out once painted.
const MIN_SPLASH_MS = 350;
const shownAt = performance.now();
requestAnimationFrame(() => requestAnimationFrame(() => {
  const splash = document.getElementById("splash");
  if (!splash) return;
  setTimeout(() => {
    splash.classList.add("splash-hidden");
    splash.addEventListener("transitionend", () => splash.remove(), { once: true });
  }, Math.max(0, MIN_SPLASH_MS - (performance.now() - shownAt)));
}));

// ---- offline support ----------------------------------------------------------
// Production only (the worker is generated at build time — see
// scripts/vite-plugin-ludo-pwa.js — so there is nothing to register in dev).
// Scope /ludo/ keeps it fully separate from Matchday's own worker at /sw.js.
// Deferred to "load" so it never competes with the first paint for bandwidth.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/ludo/sw.js", { scope: "/ludo/" }).catch(() => {});
  });
}
