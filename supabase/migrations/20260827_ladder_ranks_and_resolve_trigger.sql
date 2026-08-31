-- Ladder — bring ladder_ranks and resolve_ladder_challenge into version
-- control.
--
-- CONTEXT: both of these have existed live in Supabase for a while,
-- created/edited directly through the SQL Editor, and were never
-- committed here. This migration doesn't change any behavior — it's a
-- straight capture of what's actually running in production right now,
-- pulled via pg_get_functiondef / pg_get_triggerdef / information_schema
-- on 2026-08-27, so that:
--   1. this repo's migrations are a true record of the schema again, and
--   2. any reward-crediting logic that touches ladder results (Nets,
--      etc.) has something real to build on top of instead of a trigger
--      nobody could inspect.
--
-- NOTE ON THE "UPDATE requires a WHERE clause" fix mentioned in
-- LADDER-FIXES-AND-BACKUP.md: that doc claims a `where user_id is not
-- null` clause was added to the bulk rank-shuffle statement. The live
-- function pulled just now does NOT have that clause — either it was
-- reverted by a later CREATE OR REPLACE that wasn't re-documented, or it
-- was never actually shipped. This migration reproduces the function
-- exactly as it is live today (no WHERE clause on that statement), not
-- what the doc claims. Flagging here so this discrepancy doesn't get
-- silently lost.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- ladder_ranks — one row per user with a ladder rank: points/wins/losses/
-- draws, their current rank_position, and whether they've paused incoming
-- challenges. Read directly by the client (no RPC wrapper) for the
-- leaderboard, top-5, and "my rank" views; written only by
-- resolve_ladder_challenge() below plus whatever entry-flow already
-- inserts a starting row (ladder_cup migrations, out of scope here).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ladder_ranks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  username text not null,
  avatar_url text,
  rank_position integer not null unique,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  points integer not null default 0,
  challenges_paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Redundant with the unique constraint's implicit index, but present on
-- the live table (likely predates the unique constraint) — kept as-is
-- rather than dropped, since dropping it wasn't asked for.
create index if not exists idx_ladder_ranks_user_id on ladder_ranks (user_id);

alter table ladder_ranks enable row level security;

drop policy if exists "ladder read (signed in)" on ladder_ranks;
create policy "ladder read (signed in)" on ladder_ranks for select
  to authenticated
  using (true);

-- No insert/update/delete policies exist live — all writes go through
-- resolve_ladder_challenge() (SECURITY DEFINER) or other server-side
-- paths, same no-direct-writes convention as nets_wallets/nets_transactions.

-- ─────────────────────────────────────────────────────────────────────────
-- resolve_ladder_challenge — fires after a challenges row is updated.
-- On a ladder challenge transitioning into result_status = 'confirmed'
-- (with both scores present), awards points/wins/losses/draws and
-- recomputes rank_position for the whole table by points desc, wins desc,
-- created_at asc.
-- ─────────────────────────────────────────────────────────────────────────
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
    elsif new.opponent_score > new.challenger_score then
      update public.ladder_ranks set points = points + 3, wins = wins + 1, updated_at = now() where user_id = new.opponent_id;
      update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = new.challenger_id;
    else
      -- Equal score (e.g. 0-0) = draw: both sides get 1 point, no win/loss.
      update public.ladder_ranks set points = points + 1, draws = draws + 1, updated_at = now() where user_id = new.challenger_id;
      update public.ladder_ranks set points = points + 1, draws = draws + 1, updated_at = now() where user_id = new.opponent_id;
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
