-- WEAFRICA SURVIVAL LADDER CUP — guarantee a ladder entry at insert time
--
-- Up to now, "a team gets a ladder_cup_entries row" was an app-code
-- responsibility: ensureLadderCupEntry (client RPC call) had to be
-- remembered at every single place a team could come into existence —
-- self-join, cash-join, admin pre-listing at league creation, claiming a
-- pre-listed club by name. It was missed in one of those paths (claiming
-- a pre-listed club never called it), which is how a club could end up
-- registered with no ladder entry and nothing left to trigger the lazy
-- self-heal backfill for it. That call site is now fixed client-side too,
-- but "remember to call this everywhere a team can be created" is exactly
-- the kind of rule that's easy to violate again the next time a new join
-- path gets added.
--
-- This trigger makes it structural instead: any INSERT into teams for a
-- ladder_cup league gets its ladder_cup_entries row created in the same
-- transaction, unconditionally, regardless of which app code path (or
-- future one) created the team. ensureLadderCupEntry / the RPC stays in
-- place as a harmless, idempotent no-op — defense in depth, not the only
-- line of defense anymore.
create or replace function trg_auto_ladder_cup_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from leagues l where l.id = new.league_id and l.format = 'ladder_cup'
  ) then
    insert into ladder_cup_entries (league_id, team_id)
    values (new.league_id, new.id)
    on conflict (league_id, team_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists auto_ladder_cup_entry on teams;
create trigger auto_ladder_cup_entry
after insert on teams
for each row
execute function trg_auto_ladder_cup_entry();

-- One-off backfill for anything already slipped through before this
-- trigger existed — safe to run repeatedly, matches the diagnostic query
-- used to confirm the gap (teams in ladder_cup leagues with no entry row).
insert into ladder_cup_entries (league_id, team_id)
select t.league_id, t.id
from teams t
join leagues l on l.id = t.league_id
where l.format = 'ladder_cup'
  and not exists (select 1 from ladder_cup_entries e where e.team_id = t.id)
on conflict (league_id, team_id) do nothing;
