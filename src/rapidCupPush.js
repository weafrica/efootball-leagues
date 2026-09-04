import { supabase } from "./supabaseClient";

// Rapid Cup Push Alarm — Step 2 (see RAPID-CUP-PUSH-ALARM-BUILD-PLAN.md,
// Section 4). Everything here is additive: if push isn't supported, the key
// isn't configured yet, or the person declines the permission prompt, this
// silently no-ops and the already-shipped in-page alarm + local notification
// keep working exactly as before.

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

// PushManager wants the VAPID key as a Uint8Array, not the base64url string
// it's stored/shipped as.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Upsert on endpoint (its own unique constraint from Step 1's migration) —
// re-subscribing on a device that's already subscribed should replace that
// row's keys rather than fail on the unique conflict or create a duplicate.
async function saveSubscription(subscriptionJson) {
  const { data: { user } = {} } = await supabase.auth.getUser();
  if (!user || !subscriptionJson?.endpoint || !subscriptionJson?.keys) return;
  await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: subscriptionJson.endpoint,
      p256dh: subscriptionJson.keys.p256dh,
      auth: subscriptionJson.keys.auth,
    },
    { onConflict: "endpoint" }
  );
}

// Called once, from the natural moment the plan calls out: right after a
// successful join_rapid_cup_lobby (see RapidCupBanner.jsx's join()). Fire-
// and-forget from the caller's side — a declined prompt or an unsupported
// browser must never block or fail the actual join.
export async function subscribeToRapidCupPush() {
  if (!VAPID_PUBLIC_KEY) return; // Step 1/2 deployed but VITE_VAPID_PUBLIC_KEY not set yet in this environment
  if (
    typeof Notification === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  ) return;

  try {
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (Notification.permission !== "granted") return;

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    await saveSubscription(sub.toJSON());
  } catch {
    // Same "purely additive" reasoning as the rest of the alarm feature.
  }
}

// Bridges sw.js's `pushsubscriptionchange` listener back to a real Supabase
// write. Browsers occasionally rotate a subscription's endpoint on their
// own (Section 4's own warning: without this, that device silently stops
// receiving push and nobody notices until a player says the alarm never
// rang). The service worker has no Supabase session to authenticate a
// write with, so it posts the new subscription to any open tab instead —
// this is that tab-side half, saving it for real and clearing out the
// now-dead old endpoint.
//
// Call once (e.g. a single top-level useEffect in RapidCupBanner) — returns
// an unsubscribe function for that effect's cleanup.
export function listenForPushResubscribe() {
  if (!("serviceWorker" in navigator)) return () => {};
  const handler = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== "rapid-cup-push-resubscribed" || !msg.subscription) return;
    saveSubscription(msg.subscription);
    if (msg.oldEndpoint) {
      supabase.from("push_subscriptions").delete().eq("endpoint", msg.oldEndpoint).then(() => {});
    }
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
