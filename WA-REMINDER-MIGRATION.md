# WhatsApp-reminder highlight — required DB column

## What this is

Tapping a member's WhatsApp icon (or using "Notify everyone now" on a
league with a custom member message) now flags that member's row red for
every admin, until the due date the message was about passes. This is
`markWaReminder` / `isWaReminderActive` in `src/App.jsx`.

It works by writing a timestamp to a column on `members` — if that column
doesn't exist yet, the write silently fails (caught and logged, not
surfaced to the admin) and the highlight will never appear.

## Required database migration

Run this in the Supabase SQL editor:

```sql
alter table public.members
  add column if not exists wa_reminder_due_at timestamptz;
```

Nullable, no default — existing rows are unaffected.

### RLS check

Whoever taps the icon needs UPDATE permission on this column for rows in
leagues they admin. If `members` already has an RLS policy letting admins
update other fields on a member row (e.g. `payment_status`), that same
policy covers this column automatically — no separate grant needed. If
your policy allow-lists specific columns instead of allowing the whole
row, add `wa_reminder_due_at` to that list.

To confirm it's wired up correctly: open a league as admin, tap a
member's WhatsApp icon, and check the browser console.
- `[wa-reminder] PATCH ok for <id> <date>` → column + RLS are fine.
- `[wa-reminder] PATCH failed <status> <body>` → the error body will say
  whether it's a missing column (`42703`) or an RLS rejection.

Per `FINALS-PENALTIES-MIGRATION.md` / `LADDER-FIXES-AND-BACKUP.md`, this
repo's SQL files don't reliably mirror what's live in Supabase, so treat
the console output as the source of truth over guessing from the schema
files.
