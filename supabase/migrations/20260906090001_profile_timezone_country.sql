-- Timezone-aware scheduling (roadmap 2a): adds columns to `profiles` to
-- store each player's resolved IANA timezone and ISO 3166-1 alpha-2
-- country code, so the ladder/fixtures UI (2b) can show a flag + local
-- time, and the match-time suggestion (2c) can compute a real overlap.
--
-- Resolution happens client-side (src/utils/timezone.js) — primarily via
-- the browser/device's Intl timezone (accurate, live, no permission
-- prompt), falling back to a country derived from the phone number's
-- calling code only if browser detection isn't available. Both columns
-- are nullable: older profiles (and any resolution failure) just don't
-- show a flag/local-time/suggestion until next sign-in re-resolves them.
--
-- Safe to run more than once.

alter table profiles add column if not exists timezone text;
alter table profiles add column if not exists country_code text;

comment on column profiles.timezone is
  'IANA timezone identifier (e.g. "Africa/Johannesburg"), resolved client-side from the browser. Used for local-time display and play-window-overlap suggestions.';
comment on column profiles.country_code is
  'ISO 3166-1 alpha-2 country code, resolved client-side from the timezone (or, as a fallback, from the phone number''s calling code). Used to show a flag next to a player''s name.';
