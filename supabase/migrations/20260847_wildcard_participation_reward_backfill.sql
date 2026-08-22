-- Nets — one-time backfill for 20260846_wildcard_participation_reward.sql.
--
-- That migration's trigger only fires on the *next* confirmation of an
-- open_challenges row — it can't retroactively fire for rows that were
-- already sitting at result_status = 'confirmed' before the trigger
-- existed. Every Wildcard Match played and confirmed before this
-- migration runs would otherwise never pay out. This walks every
-- already-confirmed row once and credits the 1N each participant missed.
--
-- Idempotent: for each (challenge, participant) pair, it checks
-- nets_transactions for an existing 'open_challenge_participation' row
-- with matching ref_type/ref_id/user_id before crediting — so this is
-- safe to run more than once, and safe to run regardless of exactly when
-- the trigger went live relative to this (a challenge the trigger already
-- credited is simply skipped here, no double payout).

do $$
declare
  v_challenge record;
  v_reward bigint := 1; -- matches resolve_open_challenge's v_reward
begin
  for v_challenge in
    select id, creator_id, accepted_by
    from open_challenges
    where result_status = 'confirmed'
      and creator_id is not null
      and accepted_by is not null
  loop
    if not exists (
      select 1 from nets_transactions
      where reason = 'open_challenge_participation'
        and ref_type = 'open_challenge'
        and ref_id = v_challenge.id::text
        and user_id = v_challenge.creator_id
    ) then
      perform _nets_credit_internal(v_challenge.creator_id, v_reward, 'open_challenge_participation', 'Backfilled for a Wildcard Match played before this reward existed', 'open_challenge', v_challenge.id::text, null);
    end if;

    if not exists (
      select 1 from nets_transactions
      where reason = 'open_challenge_participation'
        and ref_type = 'open_challenge'
        and ref_id = v_challenge.id::text
        and user_id = v_challenge.accepted_by
    ) then
      perform _nets_credit_internal(v_challenge.accepted_by, v_reward, 'open_challenge_participation', 'Backfilled for a Wildcard Match played before this reward existed', 'open_challenge', v_challenge.id::text, null);
    end if;
  end loop;
end;
$$;
