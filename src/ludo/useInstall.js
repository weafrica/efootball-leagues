import { useCallback, useEffect, useState } from "react";

// "Install Ludo" support. Chrome/Edge/Android fire `beforeinstallprompt` once
// the site qualifies, and only once — and it can fire BEFORE React has
// mounted (the entry file stashes it on window.__ludoInstallPrompt for
// exactly that reason). iOS Safari never fires it at all: the only way to
// install there is Share -> Add to Home Screen, so for iOS we just report
// that, and the UI shows instructions instead of a button.

function detectStandalone() {
  try {
    return !!window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
  } catch {
    return false;
  }
}

function detectIOS() {
  const ua = window.navigator.userAgent || "";
  // iPadOS 13+ reports itself as a Mac, but a Mac has no touch points.
  return /iphone|ipad|ipod/i.test(ua) || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
}

export function useInstall() {
  const [prompt, setPrompt] = useState(() => window.__ludoInstallPrompt || null);
  const [standalone, setStandalone] = useState(detectStandalone);

  useEffect(() => {
    const onReady = () => setPrompt(window.__ludoInstallPrompt || null);
    const onInstalled = () => { window.__ludoInstallPrompt = null; setPrompt(null); setStandalone(true); };
    const mql = window.matchMedia?.("(display-mode: standalone)");
    const onMode = () => setStandalone(detectStandalone());
    window.addEventListener("ludo-installprompt", onReady);
    window.addEventListener("appinstalled", onInstalled);
    mql?.addEventListener?.("change", onMode);
    return () => {
      window.removeEventListener("ludo-installprompt", onReady);
      window.removeEventListener("appinstalled", onInstalled);
      mql?.removeEventListener?.("change", onMode);
    };
  }, []);

  const install = useCallback(async () => {
    if (!prompt) return false;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    window.__ludoInstallPrompt = null;
    setPrompt(null);
    return outcome === "accepted";
  }, [prompt]);

  return { canInstall: !!prompt, standalone, isIOS: detectIOS(), install };
}
