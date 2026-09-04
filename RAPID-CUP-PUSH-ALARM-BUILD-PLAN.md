# Rapid Cup — Push Alarm Build Plan (Option 1)

Real phone notification for the league-start alarm — reaches a player even if the
app is fully closed, not just backgrounded. Builds on top of the already-shipped
Phase 9 alarm (`src/RapidCupEpicExtras.jsx` — in-page Web Audio ring + red pulsing
banner) and the already-shipped local-notification version (`public/sw.js`
`notificationclick` handler, Stop/Enter buttons). Neither of those gets replaced —
this adds a server-sent version that reaches the same notification even when
nothing is open.

---

## 1. Why this needs a server piece

The shipped version shows a notification via `registration.showNotification()`,
called from the open page itself. That only works while some tab of the app is
still alive somewhere (even backgrounded) — a fully closed app has no running JS
left to call it.

A real push notification is sent to the phone by an outside server, delivered by
the browser/OS itself, and doesn't need any tab of the app to be open at all.
That's the whole point of Option 1, and the reason it needs new backend pieces
instead of just more frontend code.

## 2. VAPID keys

Web Push requires a public/private key pair (VAPID) so the browser's push service
can verify the message really came from this app, not anyone else.

Generated for this project:
```
VITE_VAPID_PUBLIC_KEY=BO7k1pZN91uHZZ2WejJf7uWti8kX8eNKL5w_P3hZ7nsckCqzs4yQma6jA2Sj6UylU45ZxmAYdNBJe1NzZmJom3Q
```

**The private key is deliberately NOT written here.** This file lives in git —
anything in it goes to GitHub and stays in history forever, even after a later
edit deletes the line. The private key goes straight into Supabase's Edge
Function secrets when Step 3 is built (`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`),
never into a repo file. It was shared once, directly, when it was generated —
store it in a password manager or your own secrets vault if you haven't
already, since it can't be regenerated to the same value twice.

- The **public** key above is safe to commit — the browser needs it client-side
  to create a subscription, and it can't be used to forge anything on its own.
- The **private** key is what actually signs push messages — treat it like a
  password, not a config value.

## 3. New table: `push_subscriptions`

One row per subscribed device (a user can have more than one — phone + desktop,
or two phones).

- `id`, `user_id` (references `auth.users`), `endpoint` (unique), `p256dh`,
  `auth` (the two keys `PushManager.subscribe()` returns), `created_at`.
- RLS: a user can insert/select/delete only their own rows. No `update` — a
  changed subscription is a delete-and-reinsert, not a patch.
- Cleanup path: if sending to an endpoint comes back `410 Gone` (browser revoked
  it), the send function deletes that row itself rather than leaving dead rows
  to keep failing forever.

## 4. Client: asking for permission and subscribing

- Prompt once, not every time the alarm rings — natural moment is the first time
  a player joins a Rapid Cup lobby (`join_rapid_cup_lobby` success), or a
  one-time "Enable Rapid Cup alerts" toggle if that feels less naggy.
- On accept: `registration.pushManager.subscribe({ userVisibleOnly: true,
  applicationServerKey: VITE_VAPID_PUBLIC_KEY })`, then insert the resulting
  `endpoint`/`p256dh`/`auth` into `push_subscriptions` for the signed-in user.
- On decline or unsupported browser: nothing breaks — the already-shipped local
  notification and in-page alarm still work exactly as they do today.
- **`pushsubscriptionchange` handler in `sw.js`** — browsers occasionally rotate
  a subscription's endpoint on their own. Without handling this event, that
  device silently stops receiving push and nobody notices until a player
  complains the alarm didn't fire. Re-subscribe and update the stored row here.
- Logout / account deletion: delete that device's `push_subscriptions` row so a
  stale subscription doesn't linger for an account nobody's using anymore.

## 5. Trigger: when to actually send it

Chosen point: **inside `generate_rapid_cup_bracket()`**, the existing RPC that
already flips a lobby `filling` → `live` and creates the bracket the instant the
4th player joins. Adding one step at the end of that same function — call the
send function via `net.http_post` (the `pg_net` extension, already common in
Supabase projects) with the lobby's 4 `user_id`s — means the push fires from the
exact moment the thing it's announcing becomes true, with nothing polling and no
dependency on any client being open to notice the change.

Rejected alternative: a client-side trigger (whichever of the 4 players' tabs
happens to notice `status = 'live'` fires the send). Rejected because it
partially defeats the purpose — if that mechanism depends on a tab being open at
all, it's no more reliable than the local notification this is meant to improve
on.

## 6. Edge Function: `send-rapid-cup-push`

- Deno Edge Function, called with a `lobby_id` (and/or the 4 `user_id`s
  directly, decided by whichever the trigger in Section 5 finds simpler to pass).
- Looks up every `push_subscriptions` row for those users (service-role access —
  this function runs server-side, not as any of the 4 players).
- Sends each one a Web Push message via `npm:web-push` (Deno supports npm
  imports), signed with the VAPID keys from Section 2. Payload:
  ```json
  { "title": "⚡ Rapid Cup", "body": "Your league has started — tap to enter!",
    "data": { "lobbyId": "<uuid>" } }
  ```
  Same shape the already-shipped local notification uses, so both paths can
  share one `notificationclick` handler (Section 7) — no new tap-handling logic
  needed.
- Per-subscription failure handling: a `410 Gone` response deletes that row
  (Section 3); other failures are logged, not retried indefinitely.
- Returns a simple success/fail count — useful for spotting a broken VAPID key
  or a mass-expired subscription batch early, without needing to check every
  individual send.

## 7. Service worker: handling the incoming `push` event

- New `push` event listener in `public/sw.js`, alongside the existing
  `notificationclick` one (unchanged — it already reads `event.notification.data.lobbyId`
  and posts `{ type: "rapid-cup-alarm-action", ... }` to any open tab, which is
  exactly as useful whether the notification came from a push or from the local
  path).
- Parses the push payload, calls `self.registration.showNotification()` with the
  same `tag: rapid-cup-alarm-${lobbyId}`, `actions` (Enter / Stop), and
  `requireInteraction: true` the local version already uses. Same tag means a
  push notification and a local one for the same lobby collapse into a single
  notification rather than stacking two.

## 8. The real gap this build has to solve: stopping it across devices

This is the part that's easy to miss and worth designing up front rather than
patching in afterward.

The shipped Stop/Enter buttons work by `postMessage`-ing any *open tab* of the
app, which then calls the in-page `stopAlarm()` (closes the Web Audio context,
writes "stopped" to that browser's `sessionStorage`). That's fine when the
notification and the ringing tab are the same device.

It breaks the moment two devices are involved — the exact case Option 1 exists
for. Example: a player has the app open and ringing on a laptop, and also gets
the push notification on their phone (app fully closed there). Tapping "Stop" on
the phone notification has no open tab on the *phone* to notify, and has no way
to reach the laptop's tab at all — `sessionStorage` is per-browser-profile, not
shared across devices, and `postMessage` only reaches tabs on the same device.
The laptop would keep ringing.

**Fix:** move "stopped" out of `sessionStorage` and into the database — a small
`rapid_cup_lobby_players.alarm_stopped_at` column (or a new tiny table if
touching that one feels riskier), set by whichever device's Stop action fires
first. Every open tab subscribes to that row via Supabase Realtime and calls its
own `stopAlarm()` the moment it flips, regardless of which device set it. The
phone notification's own Stop handler (Section 7 / existing `notificationclick`)
writes this same column, so it works from a device with no open tab too.

This also replaces the `sessionStorage`-based "already rang" tracking in
`RapidCupEpicExtras.jsx` — worth doing that swap in the same pass rather than
running two different "has this been stopped" mechanisms side by side.

## 9. Platform caveats worth knowing before testing

- **iOS Safari:** Web Push only works if the app has been added to the Home
  Screen (installed as a standalone PWA) — it does not work for push in a
  regular Safari tab, even on iOS 16.4+. Worth a short in-app nudge ("Add to
  Home Screen for alerts") rather than a silent no-op for iPhone users who never
  installed it.
- **Android Chrome / desktop Chrome / Firefox:** push works in a regular browser
  tab, no install required.
- `requireInteraction: true` (keeps the notification on screen until acted on)
  is respected on Android Chrome, ignored (harmlessly) on iOS Safari and some
  others — already true of the shipped local notification too, not a new
  consideration, just carries over.

---

## Suggested Build Order

1. **Step 1** — VAPID keys + `push_subscriptions` table + RLS (Sections 2–3).
2. **Step 2** — Client subscribe flow + `pushsubscriptionchange` handler
   (Section 4).
3. **Step 3** — `send-rapid-cup-push` Edge Function, tested by calling it
   directly with a real subscription first, before wiring up the trigger
   (Section 6).
4. **Step 4** — Wire the trigger into `generate_rapid_cup_bracket()` (Section 5).
5. **Step 5** — `push` event handler in `sw.js` (Section 7).
6. **Step 6** — Cross-device stop sync (Section 8) — do this before calling the
   feature done, not as a follow-up; it's the actual hard part, not the push
   plumbing.

---

## Build Status

- ⬜ Step 1 — not started
- ⬜ Step 2 — not started
- ⬜ Step 3 — not started
- ⬜ Step 4 — not started
- ⬜ Step 5 — not started
- ⬜ Step 6 — not started

**Already shipped, stays as-is:** the in-page Web Audio alarm loop, the red
pulsing banner, and the local (no-server) notification with working Stop/Enter
buttons — see Phase 9 in `RAPID-CUP-BUILD-PLAN.md`. This plan adds a second,
server-sent delivery path alongside it; it doesn't touch what's already working.
