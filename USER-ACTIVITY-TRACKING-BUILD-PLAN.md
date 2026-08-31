# User Activity Tracking — Build Plan

Scope note: this plan deliberately excludes device/browser fingerprinting,
IP address history, geolocation, full clickstream (every click/scroll/hover),
and "who viewed whom" logs. Those sit in POPIA's "personal information"
category and need a documented lawful basis + disclosure before they're
switched on — not a schema decision. Nothing below requires that. If a
specific abuse problem (multi-accounting, smurfing) later justifies IP/device
tracking, that's a separate, deliberate opt-in with its own privacy-notice
update — not something to bolt onto this table.

Everything here is either already visible to the user themselves (their own
matches, their own bids) or is an aggregate/timestamp, not a behavioral
surveillance feed.

---

## Phase 1 — Core append-only activity log

One table, one shape, everything writes to it. Mirrors the
`league_home_summary` pattern from the egress work: a single well-indexed
source of truth other things read from, rather than N bespoke tables.

```sql
create table if not exists user_activity_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,       -- 'login', 'ladder_challenge_sent', 'bid_placed', etc.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_activity_log_user_id_created_at
  on user_activity_log (user_id, created_at desc);

create index if not exists idx_user_activity_log_event_type
  on user_activity_log (event_type, created_at desc);

alter table user_activity_log enable row level security;

-- Users can read their own activity, nobody else's.
create policy "users read own activity"
  on user_activity_log for select
  using (auth.uid() = user_id);

-- Only written via SECURITY DEFINER functions (below), never direct
-- client inserts — same pattern as ladder_ranks' resolve trigger.
```

- [ ] Migration: create `user_activity_log` + RLS policy
- [ ] Migration: `log_user_activity(p_user_id uuid, p_event_type text, p_metadata jsonb)` — thin `SECURITY DEFINER` insert wrapper, called from triggers/RPCs, never exposed to `anon`/`authenticated` directly
- [ ] Retention job: `pg_cron` daily delete of rows older than N months (pick a number and write it down — "why 6 months" is a much easier POPIA conversation than "we keep everything forever")

## Phase 2 — Session activity (the legitimate parts only)

Keep: that a session happened, when, how long. Drop: IP, device fingerprint,
geolocation.

- [ ] `event_type = 'login'` — logged on successful Supabase auth sign-in, `metadata: {}`
- [ ] `event_type = 'logout'` — logged on explicit sign-out
- [ ] `event_type = 'session_end'` — inferred session length via last-activity timestamp, not a raw duration field (avoids needing a heartbeat ping)
- [ ] Login streak: derived view — consecutive distinct login-days per user, computed from the log, not stored separately
- [ ] Failed login attempts — log via Supabase auth's own audit log (already retained by Supabase) rather than duplicating into this table; link to it from an admin view instead of re-implementing

## Phase 3 — Feature engagement events

Everything here is an event about something the user already does openly
(challenge someone, bid on a listing) — logging it just makes the history
queryable instead of only visible as "current state."

- [ ] `ladder_challenge_sent` / `ladder_challenge_accepted` / `ladder_challenge_declined` — `metadata: {opponent_id, ladder}`
- [ ] `fixture_result_submitted` — `metadata: {fixture_id, minutes_after_due}` (response-latency signal, no verbatim content needed)
- [ ] `market_bid_placed` / `market_bid_withdrawn` / `market_outbid` — `metadata: {listing_id, amount}`
- [ ] `market_listing_created`
- [ ] Wire each into the existing resolve/insert triggers (20260827-style) as an additional `log_user_activity(...)` call in the same transaction — no new round trips

## Phase 4 — Retention & lifecycle signals

All derived from Phase 1–3 data, computed on read (or cached in a
materialized view if a dashboard hits it often) — nothing new to log.

- [ ] "Days since last activity" — `max(created_at)` per user
- [ ] Reactivation events — a login after a >14-day gap (threshold configurable), flagged via a query, not a separate stored event
- [ ] Signup → first match → first win → active-at-day-30 funnel — a reporting query over `user_activity_log` joined to `match_history` (from the earlier match-history plan), refreshed weekly for an admin dashboard

## Phase 5 — Economy signals (transfer market)

You already have bid/listing tables; this phase is about making the
*history* of balance changes queryable per-user, same append-only shape.

- [ ] `currency_earned` / `currency_spent` events — `metadata: {amount, reason}`, written wherever balance-mutating functions already run (net's credit function, bid settlement, etc.)
- [ ] Hoarder-vs-spender view: median time between an `currency_earned` row and the next `currency_spent` row per user — genuinely useful for market design, zero extra consent burden since it's the user's own transactions

## Phase 6 — Error / quality signals

Scoped to *your* app's own errors, not third-party crash/analytics SDKs
that phone data off-platform.

- [ ] `client_error` event, logged from a top-level error boundary — `metadata: {route, message}` (message only, no stack trace with PII, no user-typed form content)
- [ ] Weekly admin report: error counts by route, to catch a broken flow before support tickets pile up

## Phase 7 — Admin surface

- [ ] Admin-only view: per-user activity timeline (reuses Phase 1 table + RLS bypass via `admins` check, same pattern as `purge_inactive_ladder_members`)
- [ ] Admin-only aggregate dashboard: DAU/WAU, funnel conversion, top event types by volume

---

## Sequencing

Phase 1 → 3 → 2 → 5 → 4 → 6 → 7. Reasoning: the log table and feature
events are the payoff (challenge/bid history is immediately useful for
ladder disputes and market design); session/economy/lifecycle are cheap
once the log exists; error tracking and the admin dashboard are polish,
not core to "tracking users."
