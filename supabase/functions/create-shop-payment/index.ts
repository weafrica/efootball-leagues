// supabase/functions/create-shop-payment/index.ts
//
// Creates an iKhokha card-payment link for a shop order. The order row was
// already saved by place_shop_order (status 'pending_review', method
// 'ikhokha_link'). The amount is worked out HERE from the saved order, never
// taken from the browser, and the externalTransactionID sent to iKhokha is the
// order's id, so ikhokha-webhook can mark that exact order 'paid' the moment
// the card payment succeeds.
//
// Guests can pay too, so this does not need a signed-in user: the order id is
// a random UUID only the person who placed the order was given.
//
// Deploy with:
//   supabase functions deploy create-shop-payment
//
// Required secrets (already set for the Matchday payment functions):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IKHOKHA_APP_ID, IKHOKHA_SIGN_SECRET

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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let orderId: string | undefined;
  try {
    ({ order_id: orderId } = await req.json());
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: "missing order_id" }, 400);

  const { data: order, error: orderError } = await supabase
    .from("shop_orders")
    .select("id, order_number, status, checkout_method, subtotal, discount_amount, delivery_fee, buyer_email")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError || !order) return json({ error: "order not found" }, 404);
  if (order.checkout_method !== "ikhokha_link") return json({ error: "this order is not a card order" }, 409);
  if (order.status !== "pending_review") return json({ error: "this order is no longer waiting for payment" }, 409);

  const rand = Number(order.subtotal || 0) - Number(order.discount_amount || 0) + Number(order.delivery_fee || 0);
  const amountInCents = Math.round(rand * 100);
  if (!(amountInCents > 0)) return json({ error: "invalid amount" }, 400);

  const requestBody = {
    entityID: IKHOKHA_APP_ID,
    externalEntityID: order.id,
    amount: amountInCents,
    currency: "ZAR",
    requesterUrl: SITE_URL,
    mode: "live",
    description: `WeAfrica Shop order ${order.order_number}`,
    externalTransactionID: order.id,
    urls: {
      callbackUrl: CALLBACK_URL,
      successPageUrl: `${SITE_URL}/shop?paid=success&order=${encodeURIComponent(order.order_number)}`,
      failurePageUrl: `${SITE_URL}/shop?paid=failure&order=${encodeURIComponent(order.order_number)}`,
      cancelUrl: `${SITE_URL}/shop?paid=cancel&order=${encodeURIComponent(order.order_number)}`,
    },
  };

  const requestBodyStr = JSON.stringify(requestBody);
  const signature = await hmacSha256Hex(createPayloadToSign(API_ENDPOINT, requestBodyStr), IKHOKHA_SIGN_SECRET);

  const ikResponse = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "IK-APPID": IKHOKHA_APP_ID, "IK-SIGN": signature },
    body: requestBodyStr,
  });
  const ikData = await ikResponse.json().catch(() => ({}));
  if (ikData.responseCode !== "00" || !ikData.paylinkUrl) {
    return json({ error: ikData.message ?? "payment link creation failed" }, 502);
  }
  return json({ paylinkUrl: ikData.paylinkUrl });
});
