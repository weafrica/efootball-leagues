import { supabase } from "./supabaseClient";

/**
 * Fire-and-forget activity logging. Never throws, never blocks the caller —
 * a failed log write should never break the actual feature it's attached
 * to. user_id is stamped from the current session automatically.
 *
 * @param {string} eventType - short, stable name, e.g. "sign_in", "sign_out"
 * @param {object} [metadata] - anything extra worth keeping (must be JSON-safe)
 */
export async function logActivity(eventType, metadata = {}) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return; // not signed in — nothing to attribute this to yet
    const { error } = await supabase.from("user_activity_log").insert({
      user_id: userId, event_type: eventType, metadata,
    });
    if (error) console.warn("activity log write failed:", error.message);
  } catch (err) {
    console.warn("activity log write failed:", err.message);
  }
}
