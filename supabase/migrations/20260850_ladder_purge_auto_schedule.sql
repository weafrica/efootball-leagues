-- Ladder Battles — make the "never played" purge run on its own, not just
-- when an admin clicks the button (20260849).
--
-- Two problems with just pointing pg_cron straight at
-- purge_inactive_ladder_members() as it stood:
--
--   1. It's admin-gated (`raise exception ... admin only` if auth.uid()
--      isn't in `admins`). A cron job runs as the postgres role with no
--      JWT at all, so auth.uid() is null and every scheduled run would
--      immediately fail the admin check.
--   2. It has no grace period — it deletes every 0W/0L/0D row, full stop.
--      Fine for a deliberate admin click (they can see who they're
--      removing), but running that unconditionally on a schedule would
--      purge someone who joined 10 minutes ago and just hasn't gotten to
--      their first match yet. That's not "never plays the ladder," that's
--      "hasn't had the chance."
--
-- Fix: split the actual delete out into _purge_inactive_ladder_members_internal
-- (no auth check, same "no client grant" shape as _nets_credit_internal from
-- 20260831 — reachable only from another SECURITY DEFINER function, never
-- directly from a client) with a grace-period parameter, defaulting to 7
-- days. purge_inactive_ladder_members keeps its admin check and its old
-- signature/behavior, just delegating to the internal version with that
-- same 7-day default — so the existing admin button in Ladder.jsx doesn't
-- change behavior in any way that matters (nobody who joined this week
-- with 0 games was going to be a false positive worth arguing about either
-- way). The cron job calls the internal version directly, daily, at the
-- same default grace period.
--
-- Safe to run more than once.

-- ─────────────────────────────────────────────────────────────────────────
-- _purge_inactive_ladder_members_internal — the actual delete + rank
-- recompute (identical logic to what purge_inactive_ladder_members had
-- inline before this migration), now parameterized by a grace period and
-- with no auth.uid()-based check at all. Deliberately NOT granted to
-- authenticated/anon — only reachable from purge_inactive_ladder_members
-- (admin path) or the pg_cron job below (scheduled path), same reasoning
-- as _nets_credit_internal.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _purge_inactive_ladder_members_internal(p_grace interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer;
begin
  delete from ladder_ranks
  where wins = 0 and losses = 0 and draws = 0
    and created_at < now() - p_grace;
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

-- purge_inactive_ladder_members — same admin-only, callable-any-time RPC
-- as before; now a thin wrapper delegating the real work to the internal
-- version above with the same 7-day grace period the automatic job uses.
create or replace function purge_inactive_ladder_members()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admins a where a.user_id = auth.uid()) then
    raise exception 'purge_inactive_ladder_members: admin only';
  end if;

  return _purge_inactive_ladder_members_internal();
end;
$$;

grant execute on function purge_inactive_ladder_members() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Scheduled run — once a day at 03:00 UTC (quiet hours for a WeAfrica
-- audience), calls the internal version directly so it's never blocked by
-- the admin check. pg_cron jobs run as the database owner, not through
-- PostgREST/a JWT, so auth.uid() would be null here anyway — going
-- through the internal function sidesteps that entirely rather than
-- fighting it.
--
-- Supabase projects have pg_cron available but not always enabled by
-- default; `create extension if not exists` is safe to run repeatedly and
-- is a no-op once it's already on. If this statement errors with a
-- permissions issue on your project, enable pg_cron once from the
-- Supabase dashboard (Database → Extensions) and re-run just this
-- migration file.
create extension if not exists pg_cron with schema extensions;

-- cron.schedule upserts by job name, so re-running this migration updates
-- the existing job in place rather than creating duplicates.
select cron.schedule(
  'purge-inactive-ladder-members-daily',
  '0 3 * * *',
  $$select _purge_inactive_ladder_members_internal();$$
);
