-- Ladder Members panel (LeagueLadderDetail.jsx) — WhatsApp "reminded"
-- highlight, same pattern as WA-REMINDER-MIGRATION.md's members.wa_reminder_due_at
-- but scoped to ladder_memberships since League Ladder participants live
-- there, not in the regular-league `members` table.
--
-- Tapping a ladder member's WhatsApp icon flags their row red for every
-- admin until it auto-clears (see WA_REMINDER_WINDOW_MS in
-- LeagueLadderDetail.jsx). If this column doesn't exist yet, the write
-- silently fails (caught and logged, not surfaced to the admin) and the
-- highlight will never appear — same fallback behavior as the original.
--
-- Safe to run more than once.

alter table public.ladder_memberships
  add column if not exists wa_reminder_due_at timestamptz;

comment on column public.ladder_memberships.wa_reminder_due_at is
  'Set by LeagueLadderDetail.jsx whenever an admin taps a member''s WhatsApp icon in the Members panel. Highlights that member''s row red for every admin for WA_REMINDER_WINDOW_MS, then auto-clears.';
