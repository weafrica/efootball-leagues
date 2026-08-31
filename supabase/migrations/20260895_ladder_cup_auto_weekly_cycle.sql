-- SURVIVAL LADDER CUP — real auto-end, Wall of Fame, and a Sunday 11:59 UTC
-- weekly finish-and-restart cycle, matching the pattern League Ladder
-- already runs (20260875: one cron tick that both closes and reopens).
--
-- WHAT WAS MISSING BEFORE THIS MIGRATION
--
-- 1. "Auto end" didn't actually exist server-side. App.jsx's finalize
--    effect (the block right after the second-life-expiry effect) only
--    fires lazily, the next time some browser happens to have the league
--    open after `ladder_cup_cutoff_at` — and it calls
--    `supabase.rpc("finalize_ladder_cup", ...)`, a function that is
--    referenced in that comment but was never actually shipped in any
--    migration (grep the whole supabase/migrations tree for `create
--    function finalize_ladder_cup(` before this file — it isn't there,
--    only its prize-pool sibling `finalize_ladder_cup_prize_pool` is). So
--    today a Ladder Cup that nobody opens after its cutoff simply never
--    finalizes, and the RPC call the client already makes would error.
--    This migration ships the missing `finalize_ladder_cup` RPC AND, more
--    importantly, a cron-driven sweep that finalizes a cup the moment its
--    cutoff passes, with nobody needing to have the app open at all.
--
-- 2. Completed Leagues already works once finalized_at is set —
--    App.jsx's `isLeagueCompleted` has a `ladder_cup` branch
--    (`!!l.ladder_cup_finalized_at`) — so making auto-end real is the only
--    thing needed there. Nothing to add for that part specifically.
--
-- 3. No Wall of Fame entry for a Ladder Cup champion. `ladder_wall_of_fame`
--    (20260865) is League Ladder-specific — one row per WEEK NUMBER,
--    foreign-keyed to `ladder_leagues` and keyed on `user_id` — none of
--    which fits a Ladder Cup champion (keyed by `league_id`/`team_id`,
--    with no week_number at all). New table below, same public-read shape.
--
-- 4. No weekly restart. The cup has always been "create one manually,
--    it runs until its cutoff, then it's just done." This migration adds
--    the same close-then-immediately-reopen shape League Ladder uses,
--    on its own cron tick at Sunday 11:59 UTC (the instant given for this
--    change — note this is different from League Ladder's own Sunday
--    21:59 UTC close/open tick; the two formats now just happen to run on
--    separate weekly clocks).
--
-- 5. "Clients join anytime" needs nothing new: 20260814's
--    `trg_auto_ladder_cup_entry` trigger already gives any team inserted
--    into a `ladder_cup` league a `ladder_cup_entries` row unconditionally,
--    regardless of when that happens in the week, and `joinLeague` in
--    App.jsx already only blocks a join once `hasLadderCupCutoffPassed`.
--    A freshly auto-opened cup is just an ordinary new `leagues` row with
--    `ladder_cup_finalized_at` still null and a future cutoff, so the
--    existing join path covers it for free.
--
-- Safe to run more than once (every function is `create or replace`,
-- every table/column/index/policy uses an `if not exists`/`drop ... if
-- exists` guard, `cron.schedule` upserts by job name, and every insert
-- below is either `on conflict do nothing/update` or guarded by a
-- not-already-finalized check).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Ladder Cup Wall of Fame — one row per cup league, its champion.
--    champion_team_id is nullable: a cup where every club was eliminated
--    before cutoff crowns no one (crownChampion/its SQL equivalent below
--    both return null in that case), and that's still worth a row —
--    "this cup happened, nobody survived it" — same spirit as
--    ladder_wall_of_fame recording nothing only when there were no
--    fixtures at all, not when there was simply no winner.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists ladder_cup_wall_of_fame (
  league_id uuid primary key references leagues(id) on delete cascade,
  champion_team_id uuid references teams(id),
  champion_pts integer,
  finalized_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

alter table ladder_cup_wall_of_fame enable row level security;

drop policy if exists "ladder_cup_wall_of_fame_select" on ladder_cup_wall_of_fame;
create policy "ladder_cup_wall_of_fame_select" on ladder_cup_wall_of_fame for select
  using (true); -- public hall of fame, same as ladder_wall_of_fame

-- No insert/update policy for authenticated — only reachable via the
-- SECURITY DEFINER functions below.

-- ─────────────────────────────────────────────────────────────────────────
-- 2. _ladder_cup_expire_stale_second_life_internal — flips any
--    `pending_second_life` entry whose 24h offer window has lapsed over to
--    `eliminated`. This is the SQL equivalent of App.jsx's client-side
--    second-life-expiry effect (the one right before the finalize effect),
--    run here synchronously, inside the same transaction as finalizing —
--    which is actually safer than the client's version: App.jsx has to
--    guard against finalizing off a stale snapshot because its expiry
--    effect and its finalize effect are two separate renders/writes that
--    can race; here there's no race to guard against, expiry always
--    happens immediately before crowning in one transaction.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_expire_stale_second_life_internal(p_league_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update ladder_cup_entries
  set status = 'eliminated', second_life_offered_at = null, second_life_expires_at = null, updated_at = now()
  where league_id = p_league_id
    and status = 'pending_second_life'
    and second_life_expires_at is not null
    and second_life_expires_at <= now();
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. _ladder_cup_crown_champion_internal — SQL port of ladderCup.js's
--    crownChampion(rankLadderCupStandings(entries)): most points among
--    every non-eliminated entry, tiebreaker chain pts desc / gd desc /
--    toughest_opponent_beaten_pts desc, same three fields in the same
--    order. One addition beyond the JS version: `team_id asc` as a final,
--    fully-deterministic tiebreak — the JS chain can leave a genuine
--    3-way tie unresolved and just takes whichever entry sorted first
--    (JS Array.sort is stable, so effectively insertion/fetch order,
--    which isn't a meaningful ranking signal); SQL has no equivalent
--    "stable input order" to lean on, so team_id gives a deterministic,
--    repeatable pick instead of leaving it to whatever order Postgres
--    happens to scan rows in.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_crown_champion_internal(p_league_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select team_id
  from ladder_cup_entries
  where league_id = p_league_id and status <> 'eliminated'
  order by pts desc, gd desc, toughest_opponent_beaten_pts desc, team_id asc
  limit 1;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. _ladder_cup_finalize_internal — the actual "auto end" work: expire
--    lapsed second-life offers, crown the champion, mark the league
--    finalized, flip the champion's own entry status to 'champion', record
--    the Wall of Fame row, and run the existing Top-20 prize pool payout
--    (finalize_ladder_cup_prize_pool, 20260841) off the SAME full standings
--    order (every entry, not just non-eliminated ones — matches the
--    comment on that function: "the client's full ranked standings
--    including eliminated clubs").
--
--    Guarded on `ladder_cup_finalized_at is null` under a row lock, so two
--    concurrent callers (the cron sweep below and the still-present
--    client-side lazy effect both hitting the same overdue league) can't
--    double-finalize — same "first one here wins" shape the old missing
--    RPC's own comment described.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_finalize_internal(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league leagues%rowtype;
  v_champion uuid;
  v_champion_pts integer;
  v_finalized_at timestamptz;
  v_ranked_ids uuid[];
begin
  select * into v_league from leagues where id = p_league_id for update;
  if not found or v_league.format <> 'ladder_cup' or v_league.ladder_cup_finalized_at is not null then
    return;
  end if;

  perform _ladder_cup_expire_stale_second_life_internal(p_league_id);

  v_champion := _ladder_cup_crown_champion_internal(p_league_id);
  v_finalized_at := now();

  update leagues
  set ladder_cup_finalized_at = v_finalized_at, ladder_cup_champion_team_id = v_champion
  where id = p_league_id;

  if v_champion is not null then
    select pts into v_champion_pts from ladder_cup_entries where league_id = p_league_id and team_id = v_champion;
    update ladder_cup_entries set status = 'champion', updated_at = v_finalized_at
    where league_id = p_league_id and team_id = v_champion;
  end if;

  insert into ladder_cup_wall_of_fame (league_id, champion_team_id, champion_pts, finalized_at)
  values (p_league_id, v_champion, v_champion_pts, v_finalized_at)
  on conflict (league_id) do update
    set champion_team_id = excluded.champion_team_id, champion_pts = excluded.champion_pts,
        finalized_at = excluded.finalized_at, recorded_at = now();

  select coalesce(array_agg(team_id order by pts desc, gd desc, toughest_opponent_beaten_pts desc, team_id asc), array[]::uuid[])
  into v_ranked_ids
  from ladder_cup_entries
  where league_id = p_league_id;

  perform finalize_ladder_cup_prize_pool(p_league_id, v_ranked_ids);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. finalize_ladder_cup — the RPC App.jsx's existing lazy-on-read effect
--    already calls (`supabase.rpc("finalize_ladder_cup", { p_league_id,
--    p_champion_team_id })`) but which never actually existed until now.
--    Kept for that call site as defense in depth (it still works exactly
--    the way its inline comment always described — any signed-in user can
--    call it, and only the narrow finalize update happens), but it no
--    longer trusts the client's computed champion: it re-derives the
--    champion itself via `_ladder_cup_finalize_internal` so the two paths
--    (this RPC, and the new cron sweep below) can never disagree.
--    `p_champion_team_id` stays in the signature purely so the existing
--    client call doesn't need to change; it's accepted and ignored.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function finalize_ladder_cup(p_league_id uuid, p_champion_team_id uuid default null)
returns setof leagues
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from leagues
    where id = p_league_id and format = 'ladder_cup'
      and ladder_cup_cutoff_at is not null and ladder_cup_cutoff_at <= now()
      and ladder_cup_finalized_at is null
  ) then
    return; -- not due, already finalized, or not a ladder_cup league — no-op, matches the old guard's intent
  end if;

  perform _ladder_cup_finalize_internal(p_league_id);

  return query select * from leagues where id = p_league_id;
end;
$$;

grant execute on function finalize_ladder_cup(uuid, uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. _ladder_cup_auto_finalize_due_sweep_internal — the real auto-end
--    driver: every ladder_cup league whose cutoff has passed and which
--    isn't finalized yet, finalized right now, with nobody needing to
--    have the app open. Each league is finalized in its own sub-block so
--    one bad row can't stop the rest of the sweep from running.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_auto_finalize_due_sweep_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league record;
begin
  for v_league in
    select id from leagues
    where format = 'ladder_cup' and ladder_cup_finalized_at is null
      and ladder_cup_cutoff_at is not null and ladder_cup_cutoff_at <= now()
  loop
    begin
      perform _ladder_cup_finalize_internal(v_league.id);
    exception when others then
      raise warning '_ladder_cup_auto_finalize_due_sweep_internal: failed to finalize league %: %', v_league.id, sqlerrm;
    end;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. _ladder_cup_next_sunday_1159_utc — the next Sunday 11:59 UTC strictly
--    after p_from (never p_from itself, even if p_from IS exactly that
--    instant — a league opened at this migration's cron tick should live
--    a full week, not zero seconds).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_next_sunday_1159_utc(p_from timestamptz default now())
returns timestamptz
language plpgsql
as $$
declare
  v_utc timestamp := p_from at time zone 'UTC';
  v_dow integer := extract(dow from v_utc)::integer; -- 0 = Sunday .. 6 = Saturday
  v_candidate timestamptz;
begin
  v_candidate := (date_trunc('day', v_utc) + ((7 - v_dow) % 7) * interval '1 day' + interval '11 hours 59 minutes')
                 at time zone 'UTC';
  if v_candidate <= p_from then
    v_candidate := v_candidate + interval '7 days';
  end if;
  return v_candidate;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. _ladder_cup_open_new_internal — starts the next cup, cloning the
--    most recently created ladder_cup league's own settings (name gets a
--    trailing "#N" bumped by one, or " #2" appended if it never had one;
--    description/round_period_hours/league_type/created_by/
--    created_by_admin all carried over as-is — "use the current one's
--    features" is exactly this: a fresh cup that inherits everything
--    about how the previous one was configured except its roster and
--    dates). No teams are copied over — same as today, every club joins
--    fresh each cup. Guarded so it never opens a second concurrent cup:
--    a no-op if some ladder_cup league is already unfinalized.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new_id uuid;
  v_base_name text;
  v_trailing_num integer;
  v_new_name text;
begin
  if exists (select 1 from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null) then
    return null; -- a cup is already live — never open a second one
  end if;

  select * into v_prev from leagues where format = 'ladder_cup' order by created_at desc limit 1;
  if not found then
    return null; -- no prior Ladder Cup to clone settings from — nothing to auto-open yet
  end if;

  v_trailing_num := substring(v_prev.name from '#(\d+)\s*$')::integer;
  if v_trailing_num is not null then
    v_base_name := regexp_replace(v_prev.name, '#\d+\s*$', '');
    v_new_name := trim(v_base_name) || ' #' || (v_trailing_num + 1);
  else
    v_new_name := trim(v_prev.name) || ' #2';
  end if;

  insert into leagues (
    name, created_by, format, entry_closes_at, starts_at, description,
    round_period_hours, created_by_admin, league_type, ladder_cup_cutoff_at
  )
  values (
    v_new_name, v_prev.created_by, 'ladder_cup', null, now(), v_prev.description,
    v_prev.round_period_hours, v_prev.created_by_admin, v_prev.league_type,
    _ladder_cup_next_sunday_1159_utc(now())
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 9. _ladder_cup_weekly_cycle_internal — the single Sunday 11:59 UTC cron
--    entry point: finish whatever cup just hit its cutoff, then
--    immediately start the next one. Same one-tick close-then-open shape
--    as _ladder_close_week_internal (20260875) for League Ladder.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function _ladder_cup_weekly_cycle_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _ladder_cup_auto_finalize_due_sweep_internal();
  perform _ladder_cup_open_new_internal();
end;
$$;

select cron.schedule(
  'ladder-cup-weekly-cycle-sunday',
  '59 11 * * 0', -- Sunday 11:59 UTC
  $$select _ladder_cup_weekly_cycle_internal();$$
);

-- ─────────────────────────────────────────────────────────────────────────
-- 10. One-time backfill: realign whatever Ladder Cup league is currently
--     live (unfinalized) onto the new Sunday 11:59 UTC clock, so this
--     migration's auto-end/auto-restart actually takes effect this coming
--     Sunday rather than waiting on whatever cutoff an admin had picked by
--     hand. Idempotent — running this migration again just recomputes the
--     same "next Sunday 11:59 UTC" instant, which no-ops once it's already
--     set to it.
-- ─────────────────────────────────────────────────────────────────────────
update leagues
set ladder_cup_cutoff_at = _ladder_cup_next_sunday_1159_utc(now())
where format = 'ladder_cup' and ladder_cup_finalized_at is null;
