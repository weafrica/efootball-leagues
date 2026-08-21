// Nets — the site's in-app currency. This is the one place that talks to
// the nets_wallets / nets_transactions tables and the nets_credit /
// nets_debit RPCs (see supabase/migrations/20260825_nets_wallet.sql).
// Every screen that shows a balance or spends/grants Nets should go
// through these helpers rather than querying the tables directly, so the
// formatting and error-handling stay consistent everywhere Nets shows up
// (Shop, Transfer Market, entry fees, ladder cup rewards, etc.).

import { supabase } from "./supabaseClient";

export const NETS_LABEL = "Nets";
export const NETS_SYMBOL = "N";

// Buy Nets — Rand-to-Nets conversion for real-money top-ups (BuyNetsModal).
// Base rate is 1:1 (R1 = 1 Net), same as every other Rand figure in this
// app (see economy.js's ENTRY_FEE_* — those are already plain Rand
// amounts). Bigger top-ups get a bonus so there's a reason to buy more at
// once rather than repeatedly topping up the minimum; tiers line up with
// ENTRY_FEE_PRESETS in paymentConfig.js so the bonus jumps land on amounts
// people are already choosing from.
const NETS_BONUS_TIERS = [
  { min: 200, pct: 0.20 },
  { min: 150, pct: 0.15 },
  { min: 100, pct: 0.10 },
  { min: 50, pct: 0.05 },
];

// Bonus percentage (0–1) for a given Rand amount — highest tier whose
// minimum the amount meets, or 0 below the smallest tier.
export function netsBonusPct(rand) {
  const r = Number(rand) || 0;
  const tier = NETS_BONUS_TIERS.find((t) => r >= t.min);
  return tier ? tier.pct : 0;
}

// Nets a given Rand amount buys, bonus included — rounded down so a top-up
// never credits a fractional Net.
export function netsForRand(rand) {
  const r = Number(rand) || 0;
  return Math.floor(r * (1 + netsBonusPct(r)));
}

// Formats a balance for display like a currency — number first, symbol
// suffix: "1,250N" / "50N" / "0N".
export function formatNets(amount) {
  const n = Number(amount) || 0;
  return `${n.toLocaleString("en-ZA")}${NETS_SYMBOL}`;
}

// Compact form is identical here since the symbol-first style is already
// short — kept as a separate export so call sites that used the "short"
// variant for tight spaces (badges, chips) don't need to change.
export function formatNetsShort(amount) {
  return formatNets(amount);
}

// One-time balance fetch for a given user (defaults to the signed-in user).
// Returns 0 for a user who has never had a wallet row created yet — that's
// a real, valid state (nets_credit/nets_debit create the row on first use),
// not an error.
export async function getNetsBalance(userId) {
  let uid = userId;
  if (!uid) {
    const { data: { session } } = await supabase.auth.getSession();
    uid = session?.user?.id;
  }
  if (!uid) return 0;

  const { data, error } = await supabase
    .from("nets_wallets")
    .select("balance")
    .eq("user_id", uid)
    .maybeSingle();

  if (error) {
    console.warn("getNetsBalance failed:", error.message);
    return 0;
  }
  return data?.balance ?? 0;
}

// Loads the current balance immediately, then keeps it live via Supabase
// Realtime — no polling, no manual refresh needed. Mirrors the pattern
// already used for live payment-status updates elsewhere in the app.
// Returns an unsubscribe function; call it on unmount.
//
// Usage (inside a component):
//   useEffect(() => {
//     let unsub;
//     watchNetsBalance(onBalanceChange).then((fn) => { unsub = fn; });
//     return () => unsub?.();
//   }, []);
export async function watchNetsBalance(onBalanceChange, userId) {
  let uid = userId;
  if (!uid) {
    const { data: { session } } = await supabase.auth.getSession();
    uid = session?.user?.id;
  }
  if (!uid) return () => {};

  const initial = await getNetsBalance(uid);
  onBalanceChange(initial);

  const channel = supabase
    .channel(`nets-wallet-${uid}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "nets_wallets", filter: `user_id=eq.${uid}` },
      (payload) => onBalanceChange(payload.new?.balance ?? 0)
    )
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}

// Grants Nets to a wallet — rewards, refunds, admin top-ups. reason is a
// short stable code (e.g. "ladder_cup_reward", "admin_grant", "topup"),
// note is optional human-readable detail shown in transaction history.
// Returns the new balance, or throws on failure (insufficient permission,
// bad amount, etc.) — callers should catch and toast.
export async function creditNets(userId, amount, reason, { note, refType, refId } = {}) {
  const { data, error } = await supabase.rpc("nets_credit", {
    p_user_id: userId,
    p_amount: amount,
    p_reason: reason,
    p_note: note ?? null,
    p_ref_type: refType ?? null,
    p_ref_id: refId ?? null,
  });
  if (error) throw error;
  return data;
}

// Spends Nets from the signed-in user's own wallet — Shop checkout,
// Transfer Market bids, Nets-paid entry fees, etc. Always debits the
// caller; there is no way to debit someone else's wallet from the client.
// Returns the new balance, or throws (e.g. "insufficient balance") —
// callers should catch and show that message rather than a generic error.
export async function debitNets(amount, reason, { note, refType, refId } = {}) {
  const { data, error } = await supabase.rpc("nets_debit", {
    p_amount: amount,
    p_reason: reason,
    p_note: note ?? null,
    p_ref_type: refType ?? null,
    p_ref_id: refId ?? null,
  });
  if (error) throw error;
  return data;
}

// Recent transaction history for a wallet — powers a "My Nets" screen or
// a simple activity list. Defaults to the signed-in user, most recent first.
export async function getNetsHistory(userId, limit = 50) {
  let uid = userId;
  if (!uid) {
    const { data: { session } } = await supabase.auth.getSession();
    uid = session?.user?.id;
  }
  if (!uid) return [];

  const { data, error } = await supabase
    .from("nets_transactions")
    .select("*")
    .eq("user_id", uid)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn("getNetsHistory failed:", error.message);
    return [];
  }
  return data || [];
}
