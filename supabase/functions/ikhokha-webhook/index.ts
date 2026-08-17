// supabase/functions/ikhokha-webhook/index.ts
//
// Receives payment status callbacks from iKhokha for league entry fees
// paid by card, and auto-approves the matching `members` row — no
// screenshot proof, no admin review, for card payments specifically.
//
// The externalTransactionID in the payload IS the members.id that
// create-entry-payment set when the link was created.
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

  // externalTransactionID is the members.id set by create-entry-payment.
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, payment_status")
    .eq("id", externalTransactionID)
    .single();

  if (memberError || !member) {
    return new Response("member not found", { status: 404 });
  }

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
});
