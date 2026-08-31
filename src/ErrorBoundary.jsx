import React from "react";

// React only lets a class component catch render/lifecycle errors thrown by
// its children (getDerivedStateFromError + componentDidCatch have no hook
// equivalent yet) — this is the one class component in the app, kept small
// and generic on purpose so it can wrap anything.
//
// Why this exists: without an error boundary anywhere, an uncaught error
// thrown while rendering *any* screen (Shop, LeagueDetail, Ladder, a modal,
// anything) unmounts the *entire* React tree — including Home and the
// header — leaving a blank white page until the person manually reloads.
// Wrapping each screen in its own boundary (see App.jsx's <main>) means a
// crash on one screen shows a small "something went wrong" card in place of
// just that screen, while Home, the header, and the rest of the app keep
// working.
//
// `resetKey`: pass something that changes when the person navigates away
// (App.jsx passes `view`) so switching screens automatically clears a
// previous error instead of it sticking around and re-showing the fallback
// on an unrelated screen.
// Regex matches the handful of ways browsers phrase "the JS chunk this
// dynamic import() asked for isn't there anymore" — Vite's own retry
// wrapper says "failed to fetch dynamically imported module", Safari says
// "error loading dynamically imported module", and the raw MIME-type
// rejection (server fell back to index.html for a hashed filename that no
// longer exists post-deploy) shows up as "Failed to load module script...
// MIME type". All three are the exact same root cause — a tab left open
// across a new deploy, so its in-memory asset manifest points at chunk
// filenames Vercel no longer serves — and a full reload always fixes it
// by picking up the current manifest, so it's safe to reload for.
const STALE_CHUNK_ERROR = /fetch dynamically imported module|dynamically imported module|Failed to load module script/i;
// Guards against a reload loop if the reload *doesn't* fix it (e.g. the
// deploy itself is broken, not just this tab's stale manifest) — only
// auto-reload once per browser session, then fall back to the normal
// "Try again" card so the person isn't stuck in an invisible refresh loop.
const RELOAD_FLAG = "matchday_stale_chunk_reloaded";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Swap this for a real error-reporting call (Sentry, LogRocket, etc.)
    // if/when one gets wired up — for now this at least leaves a trace in
    // the browser console instead of silently going blank.
    console.error("Caught by ErrorBoundary:", error, info?.componentStack);

    if (STALE_CHUNK_ERROR.test(error?.message || "") && !sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
    }
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, () => this.setState({ error: null }));
      return (
        <div className="min-h-[40vh] flex flex-col items-center justify-center text-center gap-3 px-6 py-10 font-body">
          <div className="font-bold text-base">Something went wrong loading this page.</div>
          <div className="text-sm opacity-70 max-w-xs">The rest of the app is fine — try again, or head back home.</div>
          <div className="flex gap-2 mt-1">
            <button onClick={() => this.setState({ error: null })} className="text-sm font-semibold px-4 py-2 rounded-full border">Try again</button>
            {this.props.onGoHome && (
              <button onClick={() => { this.setState({ error: null }); this.props.onGoHome(); }} className="text-sm font-semibold px-4 py-2 rounded-full border">Back to home</button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
