# Weekend League admin override — required DB table

## What this is

The Weekend League spotlight (home page, both guest and signed-in) shows
"Live" from 9am–9pm SAST and "Paused" overnight, purely on the clock —
`isWeekendPauseHour` in `src/App.jsx`. Admins can now override that
schedule from the spotlight card itself ("Auto" / "Force live" /
"Force pause"), for the odd weekend that needs an early resume or an
extra-long pause. This is `weekendOverride` / `setWeekendOverride` in
`App()`, read by every visitor (guests included) and written only by
admins.

The override is a single global value — not per-league — since the
spotlight's Live/Paused badge is one shared state for every Weekend
League at once. It lives in a new single-row table, `app_settings`.

## Required database migration

Run this in the Supabase SQL editor:

```sql
create table if not exists public.app_settings (
  id smallint primary key,
  weekend_league_override text check (weekend_league_override in ('paused', 'live')),
  weekend_league_override_at timestamptz,
  weekend_league_override_by uuid references auth.users(id)
);

insert into public.app_settings (id) values (1)
on conflict (id) do nothing;

alter table public.app_settings enable row level security;

-- Everyone (including signed-out guests) needs to read this — it drives
-- the Live/Paused badge on the public home page.
create policy "app_settings readable by anyone"
  on public.app_settings for select
  using (true);

-- Only admins can change it. Mirrors whatever check your other
-- admin-only update policies use (e.g. on `leagues`) — if those use a
-- different helper (a `is_admin()` function, a JWT claim, etc.) swap
-- this `exists (...)` for that same check instead of adding a second,
-- possibly-inconsistent way of deciding who's an admin.
create policy "app_settings updatable by admins"
  on public.app_settings for update
  using (exists (select 1 from public.admins where user_id = auth.uid()))
  with check (exists (select 1 from public.admins where user_id = auth.uid()));
```

`weekend_league_override` is nullable and starts `null` — "Auto",
i.e. follow the 9pm–9am SAST schedule as before. Setting it to
`'paused'` or `'live'` forces that state until an admin clears it back
to `null`. `weekend_league_override_at` / `_by` are just a "last changed"
audit trail, not read by the app.

### If nothing shows up after running this

The app fails quiet if this table is missing (the override control just
doesn't appear, and the spotlight silently falls back to the auto
schedule) — so there's no error banner to notice. Check the browser
console after loading the home page:
- No `app_settings` errors and the Admin row appears on the Weekend
  League card → wired up correctly.
- A `42P01` (relation does not exist) error → the `create table` above
  didn't run.
- A 401/403 on the `update` when tapping a button → the admins-only
  policy's `exists (...)` check doesn't match how `admins` is actually
  structured in your project; open the `leagues` table's own admin
  update policy in Supabase → Database → Policies and copy its exact
  condition into the policy above instead of guessing it from here.

Per `WA-REMINDER-MIGRATION.md` / `FINALS-PENALTIES-MIGRATION.md`, this
repo's SQL doesn't reliably mirror what's live in Supabase, so treat the
console output above as the source of truth over anything guessed here.
