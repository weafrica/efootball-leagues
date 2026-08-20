// supabase/functions/ikhokha-webhook/index.ts
//
// Receives payment status callbacks from iKhokha for card payments and
// auto-approves the matching row — no screenshot proof, no admin review,
// for card payments specifically. Two things can land here:
//   - a league entry fee (create-entry-payment), row lives in `members`
//   - a Nets top-up (create-nets-payment), row lives in `nets_purchases`
//
// The externalTransactionID in the payload IS that row's id, whichever
// table it belongs to — this handler tries `members` first, then
// `nets_purchases`, since ids from the two tables never collide.
//
// Confirmed request shape (iKhokha's official "iK Pay API Integration
// Guide"):
//
//   POST <callbackUrl>
//   Headers:
//     ik-appid: <Application Key ID>
//     ik-sign:  hash_hmac("sha256", urlPath + requestBody, AppSecret)
//   Body:
//   {
//     "paylinkID": "...",
//     "status": "SUCCESS" | "FAILURE",
//     "externalTransactionID": "<members.id>",
//     "responseCode": "00"
//   }
//
// Deploy with:
//   supabase functions deploy ikhokha-webhook
//
// Required secrets (set with `supabase secrets set ...`):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   IKHOKHA_APP_ID
//   IKHOKHA_SIGN_SECRET

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const IKHOKHA_APP_ID = Deno.env.get("IKHOKHA_APP_ID");
const IKHOKHA_SIGN_SECRET = Deno.env.get("IKHOKHA_SIGN_SECRET");

// Must match CALLBACK_URL in create-entry-payment exactly — it's part of
// what gets signed.
const CALLBACK_URL = "https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/ikhokha-webhook";

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

  // externalTransactionID is either a members.id (create-entry-payment) or
  // a nets_purchases.id (create-nets-payment) — try the league-entry table
  // first since it's the more established flow, then fall back.
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, payment_status")
    .eq("id", externalTransactionID)
    .maybeSingle();

  if (memberError) {
    return new Response("lookup failed", { status: 500 });
  }

  if (member) {
    // Idempotency guard — ignore retries once already resolved.
    if (member.payment_status !== "pending") {
      return new Response("already processed", { status: 200 });
    }

    if (status === "SUCCESS") {
      const { error } = await supabase
        .from("members")
        .update({
          payment_status: "approved",
          payment_reviewed_at: new Date().toISOString(),
          payment_reviewed_by: null, // auto-approved by card payment, not a human admin
        })
        .eq("id", externalTransactionID);

      if (error) {
        return new Response("failed to approve member", { status: 500 });
      }
    } else {
      // FAILURE — let them retry rather than permanently rejecting, since
      // no proof/admin step is involved for card payments.
      const { error } = await supabase
        .from("members")
        .update({ payment_method: null })
        .eq("id", externalTransactionID);

      if (error) {
        return new Response("failed to reset member", { status: 500 });
      }
    }

    return new Response("ok", { status: 200 });
  }

  // Not a league entry — try a Nets top-up.
  const { data: purchase, error: purchaseError } = await supabase
    .from("nets_purchases")
    .select("id, user_id, nets_amount, rand_amount, payment_status")
    .eq("id", externalTransactionID)
    .maybeSingle();

  if (purchaseError) {
    return new Response("lookup failed", { status: 500 });
  }
  if (!purchase) {
    return new Response("transaction not found", { status: 404 });
  }

  // Idempotency guard — ignore retries once already resolved.
  if (purchase.payment_status !== "pending") {
    return new Response("already processed", { status: 200 });
  }

  if (status === "SUCCESS") {
    // Running as service_role, so this can call the internal credit
    // function directly — no admin check needed, this IS the trusted
    // server-side confirmation that the money landed. Compute nothing
    // client-side: nets_amount was fixed when the purchase row was
    // created and is never re-derived here.
    const { error: creditError } = await supabase.rpc("_nets_credit_internal", {
      p_user_id: purchase.user_id,
      p_amount: purchase.nets_amount,
      p_reason: "nets_purchase",
      p_note: `Top-up — R${purchase.rand_amount}`,
      p_ref_type: "nets_purchase",
      p_ref_id: purchase.id,
      p_team_id: null,
    });

    if (creditError) {
      return new Response("failed to credit nets", { status: 500 });
    }

    const { error } = await supabase
      .from("nets_purchases")
      .update({
        payment_status: "approved",
        payment_reviewed_at: new Date().toISOString(),
        payment_reviewed_by: null, // auto-approved by card payment, not a human admin
      })
      .eq("id", externalTransactionID);

    if (error) {
      return new Response("failed to approve purchase", { status: 500 });
    }
  } else {
    // FAILURE — let them retry rather than permanently rejecting.
    const { error } = await supabase
      .from("nets_purchases")
      .update({ payment_method: null })
      .eq("id", externalTransactionID);

    if (error) {
      return new Response("failed to reset purchase", { status: 500 });
    }
  }

  return new Response("ok", { status: 200 });
});
