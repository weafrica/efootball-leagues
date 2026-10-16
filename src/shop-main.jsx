// Entry point for the standalone shop app (shop-app/index.html).
// Separate from main.jsx on purpose: it mounts ShopApp, which does not
// import App.jsx, so the installed shop only downloads what it needs.

import React from "react";
import ReactDOM from "react-dom/client";
import ShopApp from "./ShopApp.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary fallback={() => (
      <div className="min-h-screen flex flex-col items-center justify-center text-center gap-3 px-6 font-body">
        <div className="font-bold text-lg">Something went wrong.</div>
        <div className="text-sm opacity-70 max-w-xs">Reloading the page should fix it.</div>
        <button onClick={() => window.location.reload()} className="text-sm font-semibold px-5 py-2.5 rounded-full border mt-1">Reload</button>
      </div>
    )}>
      <ShopApp />
    </ErrorBoundary>
  </React.StrictMode>
);

// Installability service worker, scoped to /shop-app/ (see
// public/shop-app/sw.js). Deferred to "load" so it never competes with the
// shop's first fetches.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/shop-app/sw.js", { scope: "/shop-app/" }).catch(() => {});
  });
}
