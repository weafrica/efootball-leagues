-- Survival Ladder Cup — walkover claims were never given SELECT policies.
--
-- claim_ladder_cup_walkover (20260821) inserts via a security-definer RPC,
-- which is why claims can be created at all under RLS — but nothing was
-- ever added to let anyone read them back. If ladder_cup_walkover_claims
-- has row-level security enabled (check with the query below) and zero
-- policies, Postgres denies every ordinary client SELECT by default: the
-- claimant's own "awaiting admin review" status never loads (so the claim
-- button just resets to "Claim walkover" and looks like nothing happened,
-- even though the row is there — a resubmit then hits the
-- uq_ladder_cup_claim_per_target unique index and 409s), and the admin's
-- review queue is always empty. Same bug shape already found and fixed on
-- `challenges` in 20260883_admin_select_challenges.sql.
--
-- Before applying, confirm RLS is actually on for this table:
--   select relrowsecurity from pg_class where relname = 'ladder_cup_walkover_claims';
-- and that no SELECT policy already exists:
--   select polname, polcmd from pg_policies where tablename = 'ladder_cup_walkover_claims';
-- If RLS is off, this migration is a no-op need — the client reads were
-- never being blocked and the bug is elsewhere.

alter table ladder_cup_walkover_claims enable row level security;

-- Claimant or target team member can see their own claim (so the
-- "awaiting admin review" state actually renders instead of silently
-- reverting to the claim button).
create policy "ladder_cup_walkover_claims_participant_select"
on public.ladder_cup_walkover_claims
for select
using (
  exists (select 1 from members m where m.user_id = auth.uid() and m.team_id = claimant_team_id)
  or exists (select 1 from members m where m.user_id = auth.uid() and m.team_id = target_team_id)
);

-- Admins can see every claim, for the review queue.
create policy "ladder_cup_walkover_claims_admin_select"
on public.ladder_cup_walkover_claims
for select
using (exists (select 1 from admins a where a.user_id = auth.uid()));
