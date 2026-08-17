// supabase/functions/create-entry-payment/index.ts
//
// Creates an iKhokha payment link for a specific league entry (a row
// already inserted into `members` with payment_status = 'pending').
// The externalTransactionID sent to iKhokha IS the member row's id,
// so the webhook can flip that exact row to 'approved' the instant
// the card payment succeeds — no proof upload, no admin review.
//
// Call this right after inserting the pending member row, when the
// user clicks "Pay by card".
//
// Deploy with:
//   supabase functions deploy create-entry-payment
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

  const { member_id } = await req.json();
  if (!member_id) {
    return new Response("missing member_id", { status: 400 });
  }

  // Fetch the pending member row and confirm it belongs to this user.
  const { data: member, error: memberError } = await supabase
    .from("members")
    .select("id, user_id, league_id, entry_fee, payment_status, leagues:league_id(name)")
    .eq("id", member_id)
    .single();

  if (memberError || !member) {
    return new Response("member not found", { status: 404 });
  }
  if (member.user_id !== user.id) {
    return new Response("forbidden", { status: 403 });
  }
  if (member.payment_status !== "pending") {
    return new Response("entry is not pending payment", { status: 409 });
  }

  const amountInCents = Math.round((member.entry_fee || 0) * 100);
  if (amountInCents <= 0) {
    return new Response("invalid entry fee", { status: 400 });
  }

  const leagueName = member.leagues?.name ?? "League entry";

  const requestBody = {
    entityID: IKHOKHA_APP_ID,
    externalEntityID: member.league_id,
    amount: amountInCents,
    currency: "ZAR",
    requesterUrl: SITE_URL,
    mode: "live", // switch to "test" while testing against iKhokha's sandbox, if available
    description: `Entry fee — ${leagueName}`,
    externalTransactionID: member.id,
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

  // Mark this row as a card-payment attempt so the UI/admin view can tell
  // it apart from the manual proof-upload flow.
  await supabase.from("members").update({ payment_method: "card" }).eq("id", member.id);

  return new Response(JSON.stringify({ paylinkUrl: ikData.paylinkUrl }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
