-- One-off fix: the currently live Survival Ladder Cup opened with only
-- whatever club(s) were pre-listed/self-joined into it directly (WeAfrica,
-- per the live screenshot) — it did NOT inherit the roster from the prior
-- cup, either because it predates 20260898_ladder_cup_carry_clubs_forward
-- (opened before that migration ran) or was created by hand rather than
-- through the auto weekly-cycle cron. This backfills it once: every club
-- from the most recent OTHER ladder_cup league is copied into the current
-- live one, same name, same owner(s) — starting completely fresh (0
-- pts/w/l/gd/streak) via the existing trg_auto_ladder_cup_entry trigger,
-- exactly like 20260898's ongoing carry-forward does for future weeks.
--
-- Safe to run more than once: the NOT EXISTS check on team name (case-
-- insensitive) skips any club already present in the live cup, so a
-- second run is a no-op rather than a duplicate.

do $$
declare
  v_current uuid;
  v_prior uuid;
  v_team record;
  v_new_team_id uuid;
begin
  -- The currently live (unfinalized) cup — the one on screen right now.
  select id into v_current
  from leagues
  where format = 'ladder_cup' and ladder_cup_finalized_at is null
  order by created_at desc
  limit 1;

  if v_current is null then
    raise notice 'No live Ladder Cup found — nothing to backfill.';
    return;
  end if;

  -- The cup immediately before it — the "prior" cup whose clubs should
  -- carry forward.
  select id into v_prior
  from leagues
  where format = 'ladder_cup' and id <> v_current
  order by created_at desc
  limit 1;

  if v_prior is null then
    raise notice 'No prior Ladder Cup found — nothing to backfill.';
    return;
  end if;

  for v_team in select id, name from teams where league_id = v_prior loop
    if exists (
      select 1 from teams where league_id = v_current and lower(name) = lower(v_team.name)
    ) then
      continue; -- already in the live cup (e.g. WeAfrica) — skip, no duplicate
    end if;

    insert into teams (league_id, name)
    values (v_current, v_team.name)
    returning id into v_new_team_id;

    insert into members (league_id, team_id, user_id, display_name, phone)
    select v_current, v_new_team_id, m.user_id, m.display_name, m.phone
    from members m
    where m.league_id = v_prior and m.team_id = v_team.id;
  end loop;
end $$;

-- Verify: every club now on the live cup's ladder, all starting at 0.
select t.name, e.pts, e.w, e.l, e.status
from teams t
join ladder_cup_entries e on e.team_id = t.id
where t.league_id = (
  select id from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null
  order by created_at desc limit 1
)
order by t.name;
