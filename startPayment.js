// Example: call this when your "Buy" / "Top Up" button is clicked.
// Adjust the import path for `supabase` to match your project's client setup.

import { supabase } from "./supabaseClient"; // your existing Supabase client

/**
 * Kicks off a payment: creates a unique iKhokha payment link for this
 * user/amount, then redirects them straight to iKhokha's checkout page.
 * Feels identical to clicking a static Buy Button — the difference is
 * invisible to the user.
 *
 * @param amount   Amount in Rand, e.g. 100.00
 * @param description  Optional description shown on the payment page
 */
export async function startPayment(amount, description) {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    throw new Error("User must be logged in to make a payment.");
  }

  const response = await fetch(
    "https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/create-payment-link",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ amount, description }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error ?? "Failed to create payment link");
  }

  // Redirect the user to iKhokha's secure checkout page.
  window.location.href = data.paylinkUrl;
}

// --- Usage example, e.g. on a button click handler ---
//
// <button @click="handleBuyClick">Top Up R100</button>
//
// async function handleBuyClick() {
//   try {
//     await startPayment(100, "Wallet top-up");
//   } catch (err) {
//     console.error(err);
//     alert("Something went wrong starting your payment. Please try again.");
//   }
// }
