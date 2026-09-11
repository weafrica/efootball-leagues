-- Repo-drift correction (superseding this file's own earlier version).
-- Verified against pg_get_functiondef on the live production function on
-- 2026-09-11: the version previously committed here (with a v_already_seated
-- pre-check and ON CONFLICT DO NOTHING) does NOT match what's actually
-- running. Live has neither the pre-check nor DO NOTHING -- it relies
-- entirely on the upsert's DO UPDATE ... WHERE clause for idempotency.
--
-- This file now matches the live definition exactly. No production push
-- is required for this fix -- production already has this logic; only the
-- repo was behind.
--
-- Safe to run more than once.

create or replace function _ladder_fall_through_internal(p_week_number integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_already_won boolean;
  v_below_league_id uuid;
begin
  for v_row in
    select m.user_id, m.league_id, l.tier as tier
    from ladder_memberships m
    join ladder_leagues l on l.id = m.league_id
    where m.week_number = p_week_number and m.status = 'relegated'
  loop
    select exists(
      select 1 from ladder_bids
      where bidder_user_id = v_row.user_id
        and target_league_id = v_row.league_id
        and week_number = p_week_number + 1
        and status = 'won'
    ) into v_already_won;

    if v_already_won then
      continue;
    end if;

    v_below_league_id := _ensure_ladder_league_internal(v_row.tier + 1);

    insert into ladder_memberships (user_id, league_id, week_number, status)
    values (v_row.user_id, v_below_league_id, p_week_number + 1, 'active')
    on conflict (user_id, week_number) do update
      set league_id = excluded.league_id, status = 'active'
      where ladder_memberships.league_id <> excluded.league_id;
  end loop;
end;
$$;
