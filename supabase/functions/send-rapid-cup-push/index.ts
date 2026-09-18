// supabase/functions/send-rapid-cup-push/index.ts
//
// Rapid Cup Push Alarm — Step 3 (see RAPID-CUP-PUSH-ALARM-BUILD-PLAN.md,
// Section 6). Sends a real Web Push notification ("Your league is ready —
// tap to enter!") to every subscribed device for a set of players, signed
// with this project's VAPID keys.
//
// Not wired to anything yet — Step 4 adds the pg_net call from
// generate_rapid_cup_bracket() that actually invokes this. Until then,
// call it directly (see the curl example at the bottom of this file) to
// test end-to-end with a real subscription before wiring the trigger.
//
// Input (JSON body), one of:
//   { "lobby_id": "<uuid>" }                — resolves to that lobby's
//                                              players via rapid_cup_lobby_players,
//                                              AND (once the lobby has a
//                                              league_id — i.e. the bracket's
//                                              already been generated) that
//                                              league's name, for the
//                                              notification title and the
//                                              ?league=<id> deep link in the
//                                              body (same link shareLeague()
//                                              builds in App.jsx).
//   { "user_ids": ["<uuid>", ...] }          — send directly to these users;
//                                              generic copy unless lobby_id
//                                              is ALSO given (both may be
//                                              passed together).
//
// Output: { sent: number, gone: number, failed: number, subscriptions: number }
//
// Deploy with:
//   supabase functions deploy send-rapid-cup-push
//
// Required secrets (set these before deploying — see instructions below):
//   SUPABASE_URL              (already set on every project by default)
//   SUPABASE_SERVICE_ROLE_KEY (already set on every project by default)
//   VAPID_PUBLIC_KEY          (same value as VITE_VAPID_PUBLIC_KEY in .env.example)
//   VAPID_PRIVATE_KEY         (generated alongside the public key in Step 1 —
//                               never committed to the repo, see plan Section 2)
//   VAPID_SUBJECT             (a mailto: or https: URL identifying this app,
//                               e.g. "mailto:admin@weafrica.co.za")

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

// Deployed app origin — used to build the ?league=<id> deep link below.
// Same URL the app itself is served from; no env var for this yet
// elsewhere in the project, so it's hardcoded here same as VAPID_SUBJECT.
const APP_URL = "https://efootball-leagues.vercel.app";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Same shape the already-shipped local notification uses (Phase 9 /
// public/sw.js notificationclick handler) — the new `push` handler added
// in Step 5 will read this same { title, body, data } shape, so both
// delivery paths share one notificationclick handler with no new
// tap-handling logic needed.
function buildPayload(lobbyId: string | null, leagueId: string | null, leagueName: string | null) {
  const url = leagueId ? `${APP_URL}/?league=${leagueId}` : APP_URL;
  return JSON.stringify({
    title: leagueName ? `⚡ ${leagueName}` : "⚡ Rapid Cup",
    body: `Your league is ready — tap to enter! ${url}`,
    data: { lobbyId, leagueId },
  });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  let body: { lobby_id?: string; user_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  let userIds: string[] | undefined = body.user_ids;
  let leagueId: string | null = null;
  let leagueName: string | null = null;

  if (body.lobby_id) {
    const { data: lobbyRow, error: lobbyError } = await supabase
      .from("rapid_cup_lobbies")
      .select("league_id")
      .eq("id", body.lobby_id)
      .maybeSingle();

    if (lobbyError) {
      return new Response(JSON.stringify({ error: lobbyError.message }), { status: 500 });
    }

    leagueId = lobbyRow?.league_id ?? null;

    if (leagueId) {
      const { data: leagueRow } = await supabase
        .from("leagues")
        .select("name")
        .eq("id", leagueId)
        .maybeSingle();
      leagueName = leagueRow?.name ?? null;
    }

    if (!userIds) {
      const { data: players, error } = await supabase
        .from("rapid_cup_lobby_players")
        .select("user_id")
        .eq("lobby_id", body.lobby_id);

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
      userIds = (players ?? []).map((p) => p.user_id);
    }
  }

  if (!userIds || userIds.length === 0) {
    return new Response(
      JSON.stringify({ error: "Provide lobby_id or a non-empty user_ids array" }),
      { status: 400 }
    );
  }

  const { data: subs, error: subsError } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);

  if (subsError) {
    return new Response(JSON.stringify({ error: subsError.message }), { status: 500 });
  }

  const payload = buildPayload(body.lobby_id ?? null, leagueId, leagueName);

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
          payload
        );
        sent++;
      } catch (err) {
        const statusCode = err?.statusCode ?? err?.status;
        if (statusCode === 410 || statusCode === 404) {
          // Browser revoked this subscription (410 Gone) or it no longer
          // exists (404) — stop trying and remove the dead row (plan
          // Section 3/6) rather than failing on it forever.
          gone++;
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          failed++;
          console.error("send-rapid-cup-push: send failed", sub.id, statusCode, err?.message ?? err);
        }
      }
    })
  );

  return new Response(
    JSON.stringify({ sent, gone, failed, subscriptions: (subs ?? []).length }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});

// --- Manual test (after deploying + setting secrets) ---------------------
// curl -i -X POST \
//   'https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/send-rapid-cup-push' \
//   -H "Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY or a user JWT>" \
//   -H "Content-Type: application/json" \
//   -d '{"user_ids":["<your own user_id, with a real subscription row>"]}'
//
// Expect a real notification on the subscribed device, and a response like
// {"sent":1,"gone":0,"failed":0,"subscriptions":1}.
