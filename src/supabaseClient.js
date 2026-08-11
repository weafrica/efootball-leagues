import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Missing Supabase environment variables. Check your .env.local (dev) or Vercel project settings (production)."
  );
}

// "Stay signed in" preference for the login screen's checkbox. When on
// (the default), the auth session lives in localStorage and survives
// closing the tab or the whole browser — sign in once, stay signed in.
// When off, the session lives in sessionStorage instead, so it's gone the
// moment the tab or browser closes — handy on a shared or public device.
// The preference flag itself always lives in localStorage (it has to
// survive the Google OAuth redirect round-trip, which reloads the page),
// but it never holds any session data itself.
const STAY_SIGNED_IN_KEY = "efootball-stay-signed-in";

export function setStaySignedInPreference(stay) {
  try { localStorage.setItem(STAY_SIGNED_IN_KEY, stay ? "1" : "0"); } catch { /* storage unavailable, e.g. private browsing */ }
}

function staySignedIn() {
  try { return localStorage.getItem(STAY_SIGNED_IN_KEY) !== "0"; } catch { return true; }
}

// Clears any Supabase auth keys from both storages — used on sign-out so a
// leftover token in the storage the user *isn't* currently using (e.g. from
// switching the "stay signed in" choice between sign-ins) can never come
// back to life.
export function clearAllAuthStorage() {
  [localStorage, sessionStorage].forEach((store) => {
    try {
      Object.keys(store).filter((k) => k.startsWith("sb-")).forEach((k) => store.removeItem(k));
    } catch { /* storage unavailable */ }
  });
}

// Reads/writes route to localStorage or sessionStorage depending on the
// preference above, decided fresh on every call — not baked in once at
// client-creation time — so it still works correctly after the OAuth
// redirect brings the user back to a freshly-loaded page.
const dynamicStorage = {
  getItem: (key) => (staySignedIn() ? localStorage : sessionStorage).getItem(key),
  setItem: (key, value) => (staySignedIn() ? localStorage : sessionStorage).setItem(key, value),
  removeItem: (key) => (staySignedIn() ? localStorage : sessionStorage).removeItem(key),
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storage: dynamicStorage, persistSession: true, autoRefreshToken: true },
});
