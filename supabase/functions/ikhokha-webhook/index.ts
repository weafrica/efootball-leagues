// supabase/functions/create-payment-link/index.ts
//
// Creates an iKhokha payment link (Buy Button equivalent) and records a
// "pending" transaction row, so the webhook can later find it by
// externalTransactionID and credit the balance.
//
// Call this from your frontend when the user clicks "Buy" / "Top up".
//
// Deploy with:
//   supabase functions deploy create-payment-link
//
// Required secrets (same as ikhokha-webhook):
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

const IKHOKHA_APP_ID = Deno.env.get("IKHOKHA_APP_ID")!;
const IKHOKHA_SIGN_SECRET = Deno.env.get("IKHOKHA_SIGN_SECRET")!;

const API_ENDPOINT = "https://api.ikhokha.com/public-api/v1/api/payment";

// Update these to your real site URLs.
const SITE_URL = "https://weafrica.co.za";
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

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response("missing auth", { status: 401 });
  }

  // Identify the calling user from their Supabase JWT.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));

  if (userError || !user) {
    return new Response("unauthorized", { status: 401 });
  }

  const { amount, description } = await req.json(); // amount in Rand, e.g. 100.00

  if (!amount || amount <= 0) {
    return new Response("invalid amount", { status: 400 });
  }

  const amountInCents = Math.round(amount * 100);
  const externalTransactionID = crypto.randomUUID();

  // Record the pending transaction BEFORE calling iKhokha, so the
  // webhook always has something to match against.
  const { error: insertError } = await supabase.from("transactions").insert({
    user_id: user.id,
    reference: externalTransactionID,
    amount: amount,
    status: "pending",
  });

  if (insertError) {
    return new Response("failed to record transaction", { status: 500 });
  }

  const requestBody = {
    entityID: IKHOKHA_APP_ID,
    externalEntityID: user.id,
    amount: amountInCents,
    currency: "ZAR",
    requesterUrl: SITE_URL,
    mode: "live", // use "test" while testing, per iKhokha's docs
    description: description ?? "Payment",
    externalTransactionID,
    urls: {
      callbackUrl: CALLBACK_URL,
      successPageUrl: `${SITE_URL}/payment/success`,
      failurePageUrl: `${SITE_URL}/payment/failure`,
      cancelUrl: `${SITE_URL}/payment/cancel`,
    },
  };

  const requestBodyStr = JSON.stringify(requestBody);
  const payloadToSign = createPayloadToSign(API_ENDPOINT, requestBodyStr);
  const signature = await hmacSha256Hex(payloadToSign, IKHOKHA_SIGN_SECRET);

  const ikResponse = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "IK-APPID": IKHOKHA_APP_ID,
      "IK-SIGN": signature,
    },
    body: requestBodyStr,
  });

  const ikData = await ikResponse.json();

  if (ikData.responseCode !== "00") {
    await supabase
      .from("transactions")
      .update({ status: "failed" })
      .eq("reference", externalTransactionID);

    return new Response(JSON.stringify({ error: ikData.message ?? "payment link creation failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      paylinkUrl: ikData.paylinkUrl,
      paylinkID: ikData.paylinkID,
      externalTransactionID,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
