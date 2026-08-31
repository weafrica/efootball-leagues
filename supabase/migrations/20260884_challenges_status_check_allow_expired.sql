-- challenges_status_check only ever allowed 'pending' | 'accepted' | 'declined',
-- but adminGrantLadderWalkover (App.jsx) writes status: "expired" for a ladder
-- challenge whose 5-day accept window passed with no response — and the UI
-- (ChallengeCard, around ch.status === "expired") has read/rendered that value
-- for a while. The app-side logic clearly expects 'expired' to be a valid
-- status; the DB constraint was just never updated to match, so every walkover
-- grant has been failing outright with a check-constraint violation.
--
-- Widening the constraint to include 'expired' rather than picking a
-- different existing value, since 'expired' is already the value both the
-- write path and the read/render path agree on — the constraint was the
-- one out of sync, not the app.

alter table public.challenges drop constraint challenges_status_check;
alter table public.challenges add constraint challenges_status_check
  check (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text]));
