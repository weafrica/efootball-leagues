// Ad-free status — this is the one place that talks to the ad_free_status
// table and the grant_ad_free RPC (see
// supabase/migrations/20260848_ad_free_status.sql). Every screen that
// needs to decide "should this user see an ad" should go through
// isAdFree() rather than querying the table directly, so the two rules
// (a valid grant, or the new-user grace period) stay in one place.
//
// Phase 1 note: nothing calls isAdFree() yet — no ad component exists.
// This file is the foundation it'll check against once one does.

import { supabase } from "./supabaseClient";

export const AD_FREE_SOURCES = {
  purchase_permanent: "Lifetime purchase",
  subscription: "Subscription",
  referral: "Referral reward",
};

// New accounts get this many days completely ad-free, no purchase or
// referral needed — first impressions matter more than early ad revenue.
// Pure date math against the auth user's own created_at; no table needed.
export const NEW_USER_GRACE_DAYS = 3;
const GRACE_MS = NEW_USER_GRACE_DAYS * 24 * 60 * 60 * 1000;

// True if `userId` currently has a non-expired ad_free_status row —
// forever (expires_at null) or not-yet-expired. Does NOT consider the
// grace period; call isAdFree() for the full check. Exported on its own
// because it's the only half of the check that works for a user OTHER
// than the one currently signed in (e.g. an admin screen showing why a
// given user is ad-free) — the grace-period half below only ever works
// for the signed-in user, since a client can't read another user's
// auth.users.created_at.
export async function hasAdFreeGrant(userId) {
  const { data, error } = await supabase
    .from("ad_free_status")
    .select("expires_at")
    .eq("user_id", userId);

  if (error) {
    console.warn("hasAdFreeGrant failed:", error.message);
    return false;
  }

  const now = Date.now();
  return (data || []).some(
    (row) => row.expires_at === null || new Date(row.expires_at).getTime() > now
  );
}

// Full ad-free check, in order:
//   1. A valid ad_free_status grant (purchase / subscription / referral)
//   2. New-user grace period — account created less than
//      NEW_USER_GRACE_DAYS ago
//
// Defaults to the signed-in user when userId is omitted. Note: the grace
// period (step 2) can only be evaluated for the signed-in user — a client
// has no way to read another user's account-creation date. Checking a
// user other than the current session only ever runs step 1; that's a
// conservative gap (an admin view might undercount grace-period users),
// never one that grants ad-free status to someone who shouldn't have it.
export async function isAdFree(userId) {
  const { data: { session } } = await supabase.auth.getSession();
  const sessionUser = session?.user ?? null;
  const uid = userId ?? sessionUser?.id;

  if (!uid) return false; // signed-out visitors: decide at the call site

  if (await hasAdFreeGrant(uid)) return true;

  const isSelf = !userId || userId === sessionUser?.id;
  if (!isSelf || !sessionUser?.created_at) return false;

  const age = Date.now() - new Date(sessionUser.created_at).getTime();
  return age < GRACE_MS;
}

// Admin-only grant — Buy Nets-style top-up, subscription activation, or a
// referral reward. Throws on failure (not an admin, bad source, etc.);
// callers should catch and toast. Returns the new ad_free_status row id.
export async function grantAdFree(userId, source, expiresAt = null) {
  const { data, error } = await supabase.rpc("grant_ad_free", {
    p_user_id: userId,
    p_source: source,
    p_expires_at: expiresAt,
  });
  if (error) throw error;
  return data;
}
