# All accounts custom message + highlight — required DB changes

## What this is

The "All accounts" admin page now has a site-wide sibling of the per-league
custom WhatsApp message (`MemberMessageEditor` / `wa_message_template`):
admins can save their own wording (with a `{name}` placeholder) that
replaces the old hardcoded "Hi {username}, this is weAfrica admin Saul."
greeting on every account's WhatsApp icon, plus a "Notify everyone now"
button that flags every account's row red the same way `markWaReminder`
does for league members. This is `accountsMessageTemplate` /
`updateAccountsMessageTemplate` / `markAccountReminder` /
`clearAccountReminder` / `clearAllAccountReminders` / `notifyAllAccounts`
in `src/App.jsx`, and `AccountsMessageEditor` for the UI.

Unlike a league (where every member's row lives in the same `members`
table an admin already has UPDATE rights on), an account belongs to
`profiles` — a normal client write to another user's `profiles` row is
blocked by RLS (see the existing comment above `approveAccount` in
`src/App.jsx`, which is why account approval and deletion already go
through security-definer RPCs instead of direct table writes). The
highlight here follows the same pattern.

## Required database migration

Run this in the Supabase SQL editor:

```sql
-- The saved message itself lives on the same single-row app_settings
-- table (id=1) the Weekend League override already uses — see
-- APP-SETTINGS-MIGRATION.md. One value, shared by every admin, since
-- there's no per-league scope for an account.
alter table public.app_settings
  add column if not exists accounts_wa_message_template text;

-- The highlight flag itself — mirrors members.wa_reminder_due_at
-- (see WA-REMINDER-MIGRATION.md).
alter table public.profiles
  add column if not exists wa_reminder_due_at timestamptz;

-- Security-definer RPCs so an admin can set/clear another account's
-- highlight without a client-writable RLS policy on profiles. Adjust the
-- admin check inside each function to match whatever admin_set_account_approved
-- and admin_delete_account already use if it differs from `public.admins`.
create or replace function public.admin_mark_account_reminded(target_user_id uuid, due_at timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'not authorized';
  end if;
  update public.profiles set wa_reminder_due_at = due_at where user_id = target_user_id;
end;
$$;

create or replace function public.admin_clear_account_reminder(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'not authorized';
  end if;
  update public.profiles set wa_reminder_due_at = null where user_id = target_user_id;
end;
$$;

create or replace function public.admin_clear_all_account_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.admins where user_id = auth.uid()) then
    raise exception 'not authorized';
  end if;
  update public.profiles set wa_reminder_due_at = null where wa_reminder_due_at is not null;
end;
$$;

grant execute on function public.admin_mark_account_reminded(uuid, timestamptz) to authenticated;
grant execute on function public.admin_clear_account_reminder(uuid) to authenticated;
grant execute on function public.admin_clear_all_account_reminders() to authenticated;
```

### Also update `get_all_accounts()`

`get_all_accounts()` isn't tracked in this repo (per the note in
`src/App.jsx` above `loadAccounts`, it's a security-definer RPC that also
reaches into `auth.users` for each account's email) — you'll need to open
its definition in Supabase directly and add `p.wa_reminder_due_at` to its
`select` list (aliased/joined however the rest of that function already
reads from `profiles`), or the highlight will never show up even though
the column exists and the RPCs above succeed silently.

Per `WA-REMINDER-MIGRATION.md` / `APP-SETTINGS-MIGRATION.md`, this repo's
SQL doesn't reliably mirror what's live in Supabase, so treat the browser
console as the source of truth over guessing from the schema files. The
app fails quiet here too: a missing `accounts_wa_message_template` column
just means saving the message silently no-ops (the toast still shows,
since the update itself is a plain client write to `app_settings`, not an
RPC — check for a `42703` in the network tab), and a missing
`wa_reminder_due_at` column on `profiles` means the RPCs above will error
(visible as `[accounts-reminder] mark failed ...` etc. in the console,
same logging convention as `[wa-reminder] ...`).
