-- Nets — participation reward for Wildcard Match (`open_challenges`, the
-- Home-screen "random" challenge board — see WildcardMatchSpotlight in
-- App.jsx).
--
-- CONFIRMED GAP: 20260836_ladder_challenge_reward_crediting.sql's scope
-- note flagged this explicitly — "the separate `open_challenges`
-- (random/open board) table has no server-side resolution trigger at
-- all yet — no standings, no Nets, nothing runs when their result is
-- confirmed today." Results are confirmed by a plain client-side
-- `.update()` from App.jsx's confirmOpenChallengeResult /
-- adminApproveOpenChallengeResult — there's no RPC in the loop the way
-- Challenges/fixtures have, so the only place to hook a reward in is a
-- database trigger, same shape as resolve_ladder_challenge.
--
-- SCOPE: this pays only the flat participation net (1N to both players,
-- win/draw/loss alike) — not economy.js's full random_match table
-- (win=2/draw=1/loss=0, +1 participation = 3/2/1), which is what Ladder
-- Challenges already get. That's a deliberate, smaller step than parity
-- with Ladder Challenges; bumping this to the full win/draw/loss shape
-- later is a one-line change to v_reward below plus a home/away score
-- comparison, should that be wanted.
--
-- Idempotency: fires only on the transition into result_status =
-- 'confirmed' (old distinct from new), same guard resolve_ladder_challenge
-- already relies on — editing scores post-confirmation doesn't touch
-- result_status so it can't re-fire, and a disputed-then-re-confirmed
-- challenge legitimately pays again since disputing clears result_status
-- back to null first (the original confirmation is void).
--
-- Safe to run more than once.

create or replace function resolve_open_challenge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward bigint := 1; -- flat participation net, see SCOPE above
begin
  if new.result_status = 'confirmed'
     and (old.result_status is distinct from new.result_status)
     and new.creator_id is not null and new.accepted_by is not null then

    perform _nets_credit_internal(new.creator_id, v_reward, 'open_challenge_participation', null, 'open_challenge', new.id::text, null);
    perform _nets_credit_internal(new.accepted_by, v_reward, 'open_challenge_participation', null, 'open_challenge', new.id::text, null);

  end if;
  return new;
end;
$$;

drop trigger if exists trg_resolve_open_challenge on open_challenges;
create trigger trg_resolve_open_challenge
  after update on public.open_challenges
  for each row
  execute function resolve_open_challenge();
