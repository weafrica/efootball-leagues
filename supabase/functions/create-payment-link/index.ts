// supabase/functions/ikhokha-webhook/index.ts
//
// Receives payment status callbacks from iKhokha (iK Pay API / Buy Button)
// and updates the transactions/balances tables accordingly.
//
// Confirmed from iKhokha's official "iK Pay API Integration Guide":
//
//   POST <your callbackUrl>
//   Headers:
//     ik-appid: <your Application Key ID>
//     ik-sign:  hash_hmac("sha256", urlPath + requestBody, AppSecret)
//     Content-Type: application/json
//   Body:
//   {
//     "paylinkID": "2zh1zj6y8xpb0g3",
//     "status": "SUCCESS" | "FAILURE",
//     "externalTransactionID": "IKH_REF_CODE_9911",
//     "responseCode": "00"
//   }
//
// Signature notes (from iKhokha's own Node.js sample):
//   - urlPath is the PATH portion only of the callbackUrl you supplied
//     when creating the payment link (e.g. "/functions/v1/ikhokha-webhook"),
//     not the full URL.
//   - requestBody is JSON.stringify(parsedBody) — the received JSON body,
//     re-stringified — with backslashes, double quotes, and single quotes
//     escaped with a leading backslash, and any null byte replaced with
//     the two characters "\0".
//   - The final signature is the hex-encoded HMAC-SHA256 digest.
//
// !! Update CALLBACK_URL below to match EXACTLY the callbackUrl you pass
// !! when creating payment links — the path must match or verification
// !! will always fail.
//
// Deploy with:
//   supabase functions deploy ikhokha-webhook
//
// Required secrets (set with `supabase secrets set ...`):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   IKHOKHA_APP_ID       (Application Key ID)
//   IKHOKHA_SIGN_SECRET  (Application Key Secret)

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // service role key bypasses RLS
);

const IKHOKHA_APP_ID = Deno.env.get("IKHOKHA_APP_ID");
const IKHOKHA_SIGN_SECRET = Deno.env.get("IKHOKHA_SIGN_SECRET");

// The callback URL you configure when creating each payment link.
// Only the path portion is used in the signature, but keep this as the
// full URL so it's easy to confirm it matches what you actually send.
const CALLBACK_URL = "https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/ikhokha-webhook";

/**
 * Matches iKhokha's jsStringEscape(): escapes backslash, double quote,
 * and single quote with a leading backslash, and replaces any null byte
 * with the two literal characters \0.
 */
function jsStringEscape(str: string): string {
  return str.replace(/[\\"']/g, "\\$&").replace(/\u0000/g, "\\0");
}

function createPayloadToSign(urlPath: string, body: string): string {
  const basePath = new URL(urlPath).pathname;
  return jsStringEscape(basePath + body);
}

async function hmacSha256Hex(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  if (!IKHOKHA_SIGN_SECRET) {
    console.error("IKHOKHA_SIGN_SECRET is not set");
    return new Response("server misconfigured", { status: 500 });
  }

  const ikAppId = req.headers.get("ik-appid");
  const ikSign = req.headers.get("ik-sign");

  if (IKHOKHA_APP_ID && ikAppId !== IKHOKHA_APP_ID) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: {
    paylinkID?: string;
    status?: string;
    externalTransactionID?: string;
    responseCode?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Re-stringify exactly as iKhokha's own sample does before signing.
  const requestBodyStr = JSON.stringify(payload);
  const payloadToSign = createPayloadToSign(CALLBACK_URL, requestBodyStr);
  const computedSignature = await hmacSha256Hex(payloadToSign, IKHOKHA_SIGN_SECRET);

  if (!ikSign || computedSignature !== ikSign) {
    console.error(`Signature mismatch. Computed ${computedSignature} but got ${ikSign}`);
    return new Response("invalid signature", { status: 403 });
  }

  const { externalTransactionID, status } = payload;

  if (!externalTransactionID) {
    return new Response("missing externalTransactionID", { status: 400 });
  }

  // --- Payment failed or was cancelled ---
  if (status !== "SUCCESS") {
    await supabase
      .from("transactions")
      .update({ status: "failed" })
      .eq("reference", externalTransactionID);

    return new Response("ok", { status: 200 });
  }

  // --- Look up the pending transaction ---
  const { data: txn, error: txnError } = await supabase
    .from("transactions")
    .select("user_id, amount, status")
    .eq("reference", externalTransactionID)
    .single();

  if (txnError || !txn) {
    return new Response("transaction not found", { status: 404 });
  }

  // Idempotency guard — if iKhokha retries delivery, don't credit twice.
  if (txn.status === "paid") {
    return new Response("already processed", { status: 200 });
  }

  // --- Mark as paid and credit the balance ---
  const { error: updateError } = await supabase
    .from("transactions")
    .update({ status: "paid" })
    .eq("reference", externalTransactionID);

  if (updateError) {
    return new Response("failed to update transaction", { status: 500 });
  }

  const { error: rpcError } = await supabase.rpc("increment_balance", {
    p_user_id: txn.user_id,
    p_amount: txn.amount,
  });

  if (rpcError) {
    return new Response("failed to update balance", { status: 500 });
  }

  return new Response("ok", { status: 200 });
});
