-- Supersedes the earlier draft of this fix (do not run that one if you
-- already have it queued — this replaces it). That draft was built on
-- top of 20260827's version of resolve_ladder_challenge, which predates
-- 20260836_ladder_challenge_reward_crediting.sql — running it as-is
-- would have silently deleted Nets crediting from every normal
-- (non-walkover) confirmed ladder challenge. This version is built on
-- the correct, current function (20260836's), so normal-match Nets
-- crediting is untouched.
--
-- Two changes on top of that current version:
--
-- 1. The bulk rank-shuffle statement (`update ladder_ranks set
--    rank_position = rank_position + 1000000`) still has no WHERE
--    clause, tripping Supabase's unfiltered-write guard with "Update
--    requires a WHERE clause" on any ladder result going to
--    result_status = 'confirmed' — including admin walkover grants.
--    `where user_id is not null` is always true (NOT NULL column) —
--    it's there purely to satisfy the guard, not to change which rows
--    get bumped. Same fix 20260827's own comments already flagged as
--    documented-but-never-shipped.
--
-- 2. adminGrantLadderWalkover (App.jsx) logs a walkover as a nominal
--    3-0 result, which — until now — flowed through the exact same
--    branch as a real 3-0 win: 3 ladder points, 3 Nets (2 win + 1
--    participation) to the winner, 1 participation Net to the other
--    side. Per request: a walkover should pay out less than a played
--    match. New ladder_expiry = 'walkover' branch (that column is set
--    by adminGrantLadderWalkover specifically to mark this case) awards
--    the winner 1 point and 1 Net instead of 3/3. Win/loss tallies
--    still increment normally so standings reflect it as a result.
--    ASSUMPTION (not stated in the request — flag if wrong): the
--    no-show opponent gets no Nets at all for a walkover, unlike a real
--    loss which still pays 1 participation Net.
--
-- Safe to run more than once.

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

    if new.ladder_expiry = 'walkover' then
      -- Admin-granted walkover — reduced, nominal reward since no match
      -- was actually played.
      if new.challenger_score > new.opponent_score then
        update public.ladder_ranks set points = points + 1, wins = wins + 1, updated_at = now() where user_id = new.challenger_id;
        update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = new.opponent_id;
        perform _nets_credit_internal(new.challenger_id, 1, 'ladder_walkover_reward', null, 'challenge', new.id::text, null);
      elsif new.opponent_score > new.challenger_score then
        update public.ladder_ranks set points = points + 1, wins = wins + 1, updated_at = now() where user_id = new.opponent_id;
        update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = new.challenger_id;
        perform _nets_credit_internal(new.opponent_id, 1, 'ladder_walkover_reward', null, 'challenge', new.id::text, null);
      end if;
      -- No draw case in practice (walkovers are always decisive), so no
      -- equal-score branch here.
    else
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
    end if;

    -- Ranking is purely points-based (ties -> most wins -> earliest join),
    -- so recompute the whole table every time a ladder result is
    -- confirmed. Bump every rank out of the way first to avoid colliding
    -- with the unique constraint on rank_position mid-statement.
    -- `where user_id is not null` is always true — it exists purely so
    -- this qualifies as a filtered update instead of tripping the
    -- unfiltered-write guard. See note above.
    update public.ladder_ranks set rank_position = rank_position + 1000000 where user_id is not null;

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
