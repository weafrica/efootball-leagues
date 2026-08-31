import { useEffect, useState, useCallback } from "react";

// Backs the "Install app" menu item (see Header's menuItems in App.jsx).
//
// Android/Chrome/Edge fire a `beforeinstallprompt` event once the site
// qualifies (manifest + service worker + served over https) — we capture
// it here so it can be replayed later from a normal menu tap, since the
// browser only fires it once and won't re-fire on demand.
//
// iOS Safari never fires that event at all — there is no programmatic
// install prompt on iOS. The only path is the user manually doing
// Share -> Add to Home Screen, so for iOS this hook just tells the caller
// to show instructions instead of trying to trigger anything.
export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const standaloneMql = window.matchMedia?.("(display-mode: standalone)");
    const checkStandalone = () =>
      setIsStandalone(!!standaloneMql?.matches || window.navigator.standalone === true);
    checkStandalone();
    standaloneMql?.addEventListener?.("change", checkStandalone);

    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    const onInstalled = () => setDeferredPrompt(null);

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      standaloneMql?.removeEventListener?.("change", checkStandalone);
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  // Chrome on iOS/iPadOS also reports "CriOS" but still uses Safari's
  // WebKit under the hood, so it gets the same no-programmatic-prompt
  // treatment as Safari itself.
  const canPromptDirectly = !!deferredPrompt;

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return false;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return outcome === "accepted";
  }, [deferredPrompt]);

  return { isStandalone, isIOS, canPromptDirectly, promptInstall };
}
