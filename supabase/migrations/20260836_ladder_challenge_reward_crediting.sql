-- Nets — match reward crediting for Challenges (`challenges` table,
-- resolve_ladder_challenge trigger).
--
-- CONFIRMED GAP: resolve_ladder_challenge (20260827, captured verbatim
-- from what's live) updates ladder_ranks (points/wins/losses/draws,
-- rank_position) on a confirmed ladder challenge, but never calls
-- _nets_credit_internal — so a confirmed challenge result pays zero
-- Nets, same as every other confirmed-result path did before its
-- reward-crediting migration landed (league: 20260832, ladder_battle:
-- 20260833, knockout: 20260834). This is that migration for Challenges.
--
-- Reward amounts port economy.js's computeMatchNets 'random_match'
-- branch exactly: win=2, draw=1, loss=0, all +1 participation net — so
-- 3/2/1 in practice, same shape as every other format's reward table.
--
-- _credit_random_match_reward is the shared internal helper, same
-- not-exposed-to-authenticated shape as _credit_league_fixture_reward /
-- _credit_ladder_battle_match_reward / _credit_knockout_fixture_reward.
-- Challenges are individual (not club-based), so it credits the two
-- user_ids directly — no members-table fan-out needed.
--
-- Idempotency: resolve_ladder_challenge only runs the whole points/Nets
-- block on the (old.result_status is distinct from new.result_status)
-- transition into 'confirmed' — same guard that already protects
-- ladder_ranks from being double-applied, now also covering Nets. No
-- separate finalized_at-style column exists on `challenges`; this reuses
-- the same transition guard rather than inventing a new one.
--
-- SCOPE NOTE: this only covers is_ladder = true rows on the `challenges`
-- table, because that's the only branch resolve_ladder_challenge (and
-- therefore this trigger) ever runs. Non-ladder direct challenges
-- (is_ladder = false, same table) and the separate `open_challenges`
-- (random/open board) table have no server-side resolution trigger at
-- all yet — no standings, no Nets, nothing runs when their result is
-- confirmed today. That's a distinct, larger gap (client-trusted result
-- writes, not just missing Nets) and is explicitly NOT fixed here.
--
-- Safe to run more than once.

create or replace function _credit_random_match_reward(
  p_challenge_id uuid,
  p_winner_id uuid,   -- null when p_is_draw
  p_loser_id uuid,    -- null when p_is_draw
  p_is_draw boolean,
  p_challenger_id uuid,
  p_opponent_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_win_reward bigint := 2 + 1;
  v_draw_reward bigint := 1 + 1;
  v_loss_reward bigint := 0 + 1;
begin
  if p_is_draw then
    perform _nets_credit_internal(p_challenger_id, v_draw_reward, 'random_match_reward', null, 'challenge', p_challenge_id::text, null);
    perform _nets_credit_internal(p_opponent_id, v_draw_reward, 'random_match_reward', null, 'challenge', p_challenge_id::text, null);
  else
    perform _nets_credit_internal(p_winner_id, v_win_reward, 'random_match_reward', null, 'challenge', p_challenge_id::text, null);
    perform _nets_credit_internal(p_loser_id, v_loss_reward, 'random_match_reward', null, 'challenge', p_challenge_id::text, null);
  end if;
end;
$$;

create or replace function resolve_ladder_challenge()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.is_ladder
     and new.result_status = 'confirmed'
     and (old.result_status is distinct from new.result_status)
     and new.challenger_score is not null and new.opponent_score is not null then

    if new.challenger_score > new.opponent_score then
      update public.ladder_ranks set points = points + 3, wins = wins + 1, updated_at = now() where user_id = new.challenger_id;
      update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = new.opponent_id;
      perform _credit_random_match_reward(new.id, new.challenger_id, new.opponent_id, false, new.challenger_id, new.opponent_id);
    elsif new.opponent_score > new.challenger_score then
      update public.ladder_ranks set points = points + 3, wins = wins + 1, updated_at = now() where user_id = new.opponent_id;
      update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = new.challenger_id;
      perform _credit_random_match_reward(new.id, new.opponent_id, new.challenger_id, false, new.challenger_id, new.opponent_id);
    else
      -- Equal score (e.g. 0-0) = draw: both sides get 1 point, no win/loss.
      update public.ladder_ranks set points = points + 1, draws = draws + 1, updated_at = now() where user_id = new.challenger_id;
      update public.ladder_ranks set points = points + 1, draws = draws + 1, updated_at = now() where user_id = new.opponent_id;
      perform _credit_random_match_reward(new.id, null, null, true, new.challenger_id, new.opponent_id);
    end if;

    -- Ranking is now purely points-based (ties -> most wins -> earliest
    -- join) rather than a positional swap, so recompute the whole table
    -- every time a ladder result is confirmed. Bump every rank out of the
    -- way first to avoid colliding with the unique constraint on
    -- rank_position mid-statement.
    update public.ladder_ranks set rank_position = rank_position + 1000000;

    with ranked as (
      select user_id,
             row_number() over (order by points desc, wins desc, created_at asc) as new_rank
      from public.ladder_ranks
    )
    update public.ladder_ranks lr
    set rank_position = ranked.new_rank
    from ranked
    where lr.user_id = ranked.user_id;

  end if;
  return new;
end;
$function$;

drop trigger if exists trg_resolve_ladder_challenge on challenges;
create trigger trg_resolve_ladder_challenge
  after update on public.challenges
  for each row
  execute function resolve_ladder_challenge();
