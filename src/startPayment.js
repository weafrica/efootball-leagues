// Shows the user's balance and keeps it updated live — no refresh needed.
// When ikhokha-webhook credits a payment, this fires automatically within
// a second or two.
//
// Adjust the import path for `supabase` to match your project's client setup.

import { supabase } from "./supabaseClient"; // your existing Supabase client

/**
 * Loads the current balance once, then subscribes to live updates.
 *
 * @param userId       The logged-in user's ID
 * @param onBalanceChange  Callback fired with the new balance (number)
 *                         whenever it changes — wire this to your UI state.
 * @returns  An unsubscribe function — call it when the component unmounts.
 */
export async function watchBalance(userId, onBalanceChange) {
  // 1. Load the current balance immediately.
  const { data, error } = await supabase
    .from("balances")
    .select("amount")
    .eq("user_id", userId)
    .single();

  if (!error && data) {
    onBalanceChange(data.amount);
  }

  // 2. Subscribe to live changes — fires the moment the webhook updates it.
  const channel = supabase
    .channel("balance-changes")
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "balances",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        onBalanceChange(payload.new.amount);
      }
    )
    .subscribe();

  // Return an unsubscribe function so you can clean up properly.
  return () => {
    supabase.removeChannel(channel);
  };
}

// --- Usage example (e.g. in a Vue component) ---
//
// import { ref, onMounted, onUnmounted } from "vue";
// import { watchBalance } from "./watchBalance";
//
// const balance = ref(0);
// let stopWatching;
//
// onMounted(async () => {
//   const { data: { session } } = await supabase.auth.getSession();
//   if (session) {
//     stopWatching = await watchBalance(session.user.id, (newAmount) => {
//       balance.value = newAmount;
//     });
//   }
// });
//
// onUnmounted(() => {
//   if (stopWatching) stopWatching();
// });
