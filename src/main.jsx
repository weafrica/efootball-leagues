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
