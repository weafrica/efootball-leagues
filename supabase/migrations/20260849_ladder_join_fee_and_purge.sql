-- Ladder Battles — a real Join step, with a 5N fee, plus a cleanup RPC for
-- existing members who never actually played a ladder match.
--
-- CONTEXT: ladder_ranks (20260827) never had a client-facing "join" path —
-- its own comment says rows are written by resolve_ladder_challenge() "plus
-- whatever entry-flow already inserts a starting row," which turned out not
-- to exist anywhere in this repo (or apparently live, since myLadderRank is
-- routinely null in App.jsx — see the ladder_ranked achievement, LadderStrip,
-- etc. all branching on it). This migration is that missing entry-flow.
--
-- Safe to run more than once (join_ladder/purge_inactive_ladder_members are
-- CREATE OR REPLACE; nothing here is a one-time data change).

-- ─────────────────────────────────────────────────────────────────────────
-- join_ladder — self-service. Charges the caller LADDER_JOIN_FEE_NETS (5)
-- via nets_debit and creates their ladder_ranks row in the same
-- transaction: if the debit fails (insufficient balance) or the insert
-- fails for any reason, the whole call rolls back together, so there's no
-- way to end up charged-but-not-joined or joined-but-uncharged. This is why
-- it's a single SECURITY DEFINER function rather than the client-side
-- insert-then-debit-then-rollback-on-failure dance joinLeague uses for
-- `members` in App.jsx: that dance exists there because `members` allows a
-- direct client insert and nets_credit (the only way to refund) is
-- admin-only. ladder_ranks has no insert policy at all — every write goes
-- through a SECURITY DEFINER function — so there's no client-side insert to
-- race against in the first place; the DB's own transaction rollback is the
-- refund path.
--
-- nets_debit resolves auth.uid() itself (same JWT, same transaction), so
-- calling it from inside this function still debits the actual caller, not
-- this function's owner — same reasoning as the nets_credit_internal fix
-- (20260831), just the debit side instead of the credit side.
--
-- rank_position: new members join at the bottom on 0 points, but the
-- INSERT can't just use max(rank_position)+1 directly — two people joining
-- in the same instant could compute the same max and collide on the
-- unique constraint. Instead it inserts at a temp negative position
-- (guaranteed clear of the 1..N range everyone else occupies) and then
-- runs the exact same bump-by-1e6-then-row_number() recompute
-- resolve_ladder_challenge already uses, so the final position is always
-- correct and collision-free even under concurrent joins — concurrent
-- calls just serialize on that UPDATE like they already do for match
-- results.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function join_ladder()
returns ladder_ranks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee constant bigint := 5; -- LADDER_JOIN_FEE_NETS — keep in sync with src/economy.js
  v_user_id uuid := auth.uid();
  v_username text;
  v_avatar_url text;
  v_row ladder_ranks%rowtype;
begin
  if v_user_id is null then
    raise exception 'join_ladder: must be signed in';
  end if;

  if exists (select 1 from ladder_ranks where user_id = v_user_id) then
    raise exception 'join_ladder: already on the ladder';
  end if;

  select efootball_username, avatar_url into v_username, v_avatar_url
  from profiles where user_id = v_user_id;

  if v_username is null then
    raise exception 'join_ladder: complete your profile before joining the ladder';
  end if;

  -- Charge first — nets_debit raises its own "insufficient balance" error
  -- (matched client-side via /insufficient/i, same as the league entry fee
  -- flow) before anything about the ladder row is touched.
  perform nets_debit(v_fee, 'ladder_join', 'Joined the permanent ladder');

  insert into ladder_ranks (user_id, username, avatar_url, rank_position)
  values (v_user_id, v_username, v_avatar_url, -floor(extract(epoch from clock_timestamp()) * 1000)::integer)
  returning * into v_row;

  update ladder_ranks set rank_position = rank_position + 1000000;

  with ranked as (
    select user_id,
           row_number() over (order by points desc, wins desc, created_at asc) as new_rank
    from ladder_ranks
  )
  update ladder_ranks lr
  set rank_position = ranked.new_rank
  from ranked
  where lr.user_id = ranked.user_id;

  select * into v_row from ladder_ranks where user_id = v_user_id;
  return v_row;
end;
$$;

grant execute on function join_ladder() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- purge_inactive_ladder_members — admin-only, callable any time (not a
-- one-off migration-time DELETE) since it's irreversible and worth running
-- deliberately rather than automatically on every deploy. "Never played it"
-- = wins = 0 AND losses = 0 AND draws = 0 — a row the join fee was paid for
-- (or, for pre-fee members, created) but that's never had a single ladder
-- result recorded against it. Returns the number of rows removed so the
-- caller/admin console can show what happened.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function purge_inactive_ladder_members()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer;
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'purge_inactive_ladder_members: admin only';
  end if;

  delete from ladder_ranks
  where wins = 0 and losses = 0 and draws = 0;
  get diagnostics v_removed = row_count;

  if v_removed > 0 then
    -- Deletion leaves gaps in rank_position — recompute contiguously, same
    -- ordering resolve_ladder_challenge/join_ladder already use.
    update ladder_ranks set rank_position = rank_position + 1000000;

    with ranked as (
      select user_id,
             row_number() over (order by points desc, wins desc, created_at asc) as new_rank
      from ladder_ranks
    )
    update ladder_ranks lr
    set rank_position = ranked.new_rank
    from ranked
    where lr.user_id = ranked.user_id;
  end if;

  return v_removed;
end;
$$;

grant execute on function purge_inactive_ladder_members() to authenticated;
