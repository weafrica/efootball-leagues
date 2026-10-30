import { supabase, setStaySignedInPreference, clearAllAuthStorage } from "../supabaseClient.js";

// Ludo signs in with the SAME Supabase project and the SAME Google accounts
// as Matchday, and because it lives on the same origin the session is shared:
// sign in on either one and you're signed in on both.
//
// Marker written just before the Google redirect. Normally Google sends the
// person straight back to /ludo/. But Supabase only honours a redirect URL
// that's on the project's allow-list; if /ludo/ isn't on it, Supabase falls
// back to the Site URL (the Matchday homepage) instead. This marker lets a
// tiny inline script in the main app's index.html notice "this person was
// signing in to Ludo" and bounce them to /ludo/ with their session intact,
// so sign-in works either way.
export const SIGNIN_RETURN_KEY = "ludo-signin-return";

export async function signInWithGoogle(stay = true) {
  setStaySignedInPreference(stay);
  try { localStorage.setItem(SIGNIN_RETURN_KEY, String(Date.now())); } catch { /* storage unavailable */ }
  // Clean URL only (no hash/query) — a leftover #access_token fragment in
  // redirectTo makes Supabase build an unparseable "##access_token" URL.
  const redirectTo = `${window.location.origin}/ludo/`;
  const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  if (error) throw error;
}

export async function signOut() {
  await supabase.auth.signOut();
  clearAllAuthStorage();
}

export function clearSigninReturnMarker() {
  try { localStorage.removeItem(SIGNIN_RETURN_KEY); } catch { /* storage unavailable */ }
}
