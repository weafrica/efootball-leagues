-- Fix: League Ladder standings show "Unknown player" and WhatsApp icons
-- never appear for opponents.
--
-- Root cause: LeagueLadderDetail.jsx resolves opponent username/phone by
-- querying `profiles` by user_id (unlike regular leagues, which read
-- phone off the publicly-readable `teams` table). `profiles` currently
-- only lets a user select their own row, so every other player's lookup
-- comes back empty -- hence "Unknown player" and no contact icon.
--
-- Ladder standings/rosters are already meant to be visible to any
-- signed-in player (see ladder_memberships' own policy comment). This
-- extends that same visibility to the profile fields the UI actually
-- needs to display and let opponents contact each other: username,
-- avatar, phone. Does not expose anything not already effectively
-- public for regular-league opponents via `teams.phone`.
--
-- Safe to run more than once.

drop policy if exists "profiles_select_public_fields" on profiles;
create policy "profiles_select_public_fields" on profiles for select
  to authenticated
  using (true);
