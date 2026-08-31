-- Admins could UPDATE any challenge for review (existing "Admins can
-- update challenges for review" policy), but there was never a matching
-- admin SELECT policy. RLS only ever granted read access to participants
-- ("Members can view their own challenges"), so an admin's client-side
-- "select every row" query was silently narrowed by Postgres to just the
-- rows they personally happened to be a participant in — no error,
-- nothing to see in the app, results just quietly missing for every
-- challenge the admin wasn't personally involved in.
--
-- This is why the escalated-review queue and Community Results' escalated
-- section were missing specific rows for a given admin: whether a row
-- showed depended on whether that particular admin happened to be a
-- participant in it, not on whether it was actually pending review.
--
-- (open_challenges was checked too — it already has an open_challenges_select
-- policy granting all authenticated users unrestricted read access, so it
-- never had this gap and needs no change here.)
--
-- PERMISSIVE policies OR together, so this simply adds "or you're an
-- admin" on top of the existing participant-only SELECT policy rather
-- than replacing it.

create policy "Admins can view all challenges for review"
on public.challenges
for select
using (exists (select 1 from admins a where a.user_id = auth.uid()));

