# League Ladder — Members panel — required DB column

## What this is

`LeagueLadderDetail.jsx` now has an admin-only **Members** section (below
the Standings table). It lists everyone currently seated in that ladder
league, lets an admin search for a specific person first, and gives each
member a WhatsApp icon that:

- Opens WhatsApp with a ready-made message that already mentions the
  member's current ladder position, the best time to play based on this
  week's opponent's timezone (when both players have one on file), a
  line asking them to call for the fastest response, and the
  weafrica.co.za link.
- Rotates through 50 different message variations — tapping the icon
  again later for the same person sends a different one, never the same
  message twice in a row (tracked per-browser in `localStorage`, key
  `ladder-wa-msg:<leagueId>:<userId>`).
- Flags that member's row red for every admin, the same "reminded"
  highlight the regular members list already has — this is
  `markLadderMemberWaReminder` / `isLadderMemberWaReminderActive` in
  `src/LeagueLadderDetail.jsx`.

The highlight works by writing a timestamp to a column on
`ladder_memberships` — if that column doesn't exist yet, the write
silently fails (caught and logged, not surfaced to the admin) and the
highlight will never appear.

## Required database migration

Run this in the Supabase SQL editor (also saved as
`supabase/migrations/20260907_ladder_memberships_wa_reminder.sql`):

```sql
alter table public.ladder_memberships
  add column if not exists wa_reminder_due_at timestamptz;
```

Nullable, no default — existing rows are unaffected.

### RLS check

Whoever taps the icon needs UPDATE permission on this column for
`ladder_memberships` rows. If admins already have an UPDATE policy on
`ladder_memberships` (e.g. for `status`), that same policy covers this
column automatically. If your policy allow-lists specific columns
instead of the whole row, add `wa_reminder_due_at` to that list.

To confirm it's wired up: open a ladder league as admin, open the
Members panel, tap a member's WhatsApp icon, and check the browser
console.
- `[ladder-wa-reminder] PATCH ok for <user_id> <date>` → column + RLS
  are fine.
- `[ladder-wa-reminder] PATCH failed <status> <body>` → the error body
  will say whether it's a missing column (`42703`) or an RLS rejection.

Per `FINALS-PENALTIES-MIGRATION.md` / `LADDER-FIXES-AND-BACKUP.md`, this
repo's SQL files don't reliably mirror what's live in Supabase, so treat
the console output as the source of truth over guessing from the schema
files.

## No migration needed for the message rotation

The "send a different message next time" rotation is tracked entirely
client-side (`localStorage`), not in the database — there's nothing to
migrate for it, and it's per-browser/per-admin by design.
