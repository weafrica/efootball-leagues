// supabase/functions/create-nets-payment/index.ts
//
// Creates an iKhokha payment link for a Nets top-up (a row already
// inserted into `nets_purchases` with payment_status = 'pending'). Same
// shape as create-entry-payment, just pointed at nets_purchases instead
// of members — the externalTransactionID sent to iKhokha IS the purchase
// row's id, so ikhokha-webhook can flip that exact row to 'approved' (and
// credit the wallet) the instant the card payment succeeds.
//
// Call this right after inserting the pending nets_purchases row, when
// the user clicks "Pay by card" in BuyNetsModal.
//
// Deploy with:
//   supabase functions deploy create-nets-payment
//
// Required secrets (same as ikhokha-webhook / create-entry-payment):
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

// Must match your real domain and the webhook's deployed URL exactly —
// both are part of what gets signed.
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

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));

  if (userError || !user) {
    return new Response("unauthorized", { status: 401 });
  }

  const { purchase_id } = await req.json();
  if (!purchase_id) {
    return new Response("missing purchase_id", { status: 400 });
  }

  // Fetch the pending purchase row and confirm it belongs to this user.
  const { data: purchase, error: purchaseError } = await supabase
    .from("nets_purchases")
    .select("id, user_id, rand_amount, nets_amount, payment_status")
    .eq("id", purchase_id)
    .single();

  if (purchaseError || !purchase) {
    return new Response("purchase not found", { status: 404 });
  }
  if (purchase.user_id !== user.id) {
    return new Response("forbidden", { status: 403 });
  }
  if (purchase.payment_status !== "pending") {
    return new Response("purchase is not pending payment", { status: 409 });
  }

  const amountInCents = Math.round((purchase.rand_amount || 0) * 100);
  if (amountInCents <= 0) {
    return new Response("invalid amount", { status: 400 });
  }

  const requestBody = {
    entityID: IKHOKHA_APP_ID,
    externalEntityID: purchase.user_id,
    amount: amountInCents,
    currency: "ZAR",
    requesterUrl: SITE_URL,
    mode: "live", // switch to "test" while testing against iKhokha's sandbox, if available
    description: `Nets top-up — ${purchase.nets_amount} Nets`,
    externalTransactionID: purchase.id,
    urls: {
      callbackUrl: CALLBACK_URL,
      successPageUrl: `${SITE_URL}/?paid=success`,
      failurePageUrl: `${SITE_URL}/?paid=failure`,
      cancelUrl: `${SITE_URL}/?paid=cancel`,
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
    return new Response(JSON.stringify({ error: ikData.message ?? "payment link creation failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Mark this row as a card-payment attempt so the admin review list can
  // tell it apart from the manual proof-upload flow (mirrors members.payment_method).
  await supabase.from("nets_purchases").update({ payment_method: "card" }).eq("id", purchase.id);

  return new Response(JSON.stringify({ paylinkUrl: ikData.paylinkUrl }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
