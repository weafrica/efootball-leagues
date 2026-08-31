-- WEAFRICA SURVIVAL LADDER CUP — RLS-safe entry creation
--
-- Regular authenticated clients can't INSERT into ladder_cup_entries
-- directly (RLS rejects it — "new row violates row-level security policy
-- for table ladder_cup_entries"), the same reason 20260811ish's finalize
-- write was routed through an RPC instead of a raw client update. This
-- gives entry creation the same treatment: a SECURITY DEFINER function
-- that runs with elevated privilege, so it bypasses RLS internally, but
-- re-validates everything the client-side ensureLadderCupEntry already
-- checked (App.jsx) before it does — the team really belongs to this
-- league, and the league really is a ladder_cup — so a caller can't use it
-- to plant an entry for an arbitrary team/league pair.
--
-- on conflict matches the table's own `unique (league_id, team_id)`
-- constraint, so calling this for a team that already has an entry is a
-- safe no-op — same behaviour ensureLadderCupEntry already relies on when
-- it swallows a 23505 from a direct insert.
create or replace function ensure_ladder_cup_entry(p_league_id uuid, p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from teams t
    join leagues l on l.id = t.league_id
    where t.id = p_team_id and t.league_id = p_league_id and l.format = 'ladder_cup'
  ) then
    raise exception 'Team % is not a ladder_cup club in league %', p_team_id, p_league_id;
  end if;

  insert into ladder_cup_entries (league_id, team_id)
  values (p_league_id, p_team_id)
  on conflict (league_id, team_id) do nothing;
end;
$$;

-- Any signed-in user can call this — it's exactly as permissive as
-- registering a club already is (self-join, cash-join, pre-listing all
-- create teams client-side today) and the function's own checks above are
-- what keep it from being misused, not caller identity.
grant execute on function ensure_ladder_cup_entry(uuid, uuid) to authenticated;
