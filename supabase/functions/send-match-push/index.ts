// supabase/functions/send-match-push/index.ts
//
// "Next match" push — every league besides Rapid Cup (which keeps its own
// dedicated alarm/push path in send-rapid-cup-push, untouched by this),
// plus the random-match challenge board. Deliberately the opposite of that
// one: a single quiet notification, not a ringing loop — no sound, no
// required interaction, nothing to "stop." Meant to feel like a sudden
// little ping, not an alarm.
//
// Reuses the same push_subscriptions table and VAPID keys as
// send-rapid-cup-push (see that file's header for the Vault/secrets setup —
// nothing new needed here).
//
// Input (JSON body):
//   { "user_ids": ["<uuid>", ...], "title": "...", "body": "...", "data": {...} }
// `data` is passed straight through to the browser notification and MUST
// include { "kind": "next_match", ... } — that's what public/sw.js's push
// handler keys off to render this silent/no-action instead of the Rapid
// Cup alarm shape.
//
// Output: { sent: number, gone: number, failed: number, subscriptions: number }
//
// Required secrets (already set for send-rapid-cup-push — same project,
// same keys, nothing new to configure):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY,
//   VAPID_PRIVATE_KEY, VAPID_SUBJECT

import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  let payload: { user_ids?: string[]; title?: string; body?: string; data?: Record<string, unknown> };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const userIds = (payload.user_ids ?? []).filter(Boolean);
  if (userIds.length === 0) {
    return new Response(JSON.stringify({ error: "Provide a non-empty user_ids array" }), { status: 400 });
  }
  if (!payload.title || !payload.body) {
    return new Response(JSON.stringify({ error: "title and body are required" }), { status: 400 });
  }

  const { data: subs, error: subsError } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (subsError) {
    return new Response(JSON.stringify({ error: subsError.message }), { status: 500 });
  }

  // kind defaults to "next_match" here (rather than being required from
  // the caller) so a DB trigger can't accidentally omit it and have sw.js
  // fall through to the Rapid Cup alarm rendering instead.
  const notificationPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    data: { kind: "next_match", ...(payload.data ?? {}) },
  });

  let sent = 0;
  let gone = 0;
  let failed = 0;

  await Promise.all(
    (subs ?? []).map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          notificationPayload
        );
        sent++;
      } catch (err) {
        const statusCode = err?.statusCode ?? err?.status;
        if (statusCode === 410 || statusCode === 404) {
          gone++;
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          failed++;
          console.error("send-match-push: send failed", sub.id, statusCode, err?.message ?? err);
        }
      }
    })
  );

  return new Response(
    JSON.stringify({ sent, gone, failed, subscriptions: (subs ?? []).length }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
