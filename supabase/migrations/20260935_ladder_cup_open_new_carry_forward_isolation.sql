-- Survivor Ladder Cup — actually implement the carry-forward isolation that
-- supabase/tests/database/ladder_cup_open_new.test.sql has been asserting
-- since it was added, but that 20260922 never wrote.
--
-- 20260922 restored club/member/phone carry-forward (after it had twice been
-- silently dropped by earlier redefinitions of this function) but carried
-- each team's members over with one set-based
-- `insert into members (...) select ... from members m where ...`.
-- With no exception handling around it, a single member failing that insert
-- (a constraint violation, a bad trigger, anything) aborts that whole
-- statement — and with no savepoint anywhere in the function, that error
-- propagates out and rolls back the ENTIRE call: the new cup, every already
-- -carried-forward team, every member. One bad row was able to silently
-- cancel the month's whole auto-open.
--
-- Fix: carry each member over individually, each wrapped in its own nested
-- BEGIN/EXCEPTION block (PL/pgSQL's nested blocks are implicit savepoints),
-- so a failure there only skips that one member — logged via RAISE WARNING
-- for visibility — and both the rest of that team and every other team
-- still carry forward normally. The per-team insert gets the same isolation,
-- so a team-level failure (e.g. a duplicate-phone constraint) skips just
-- that club instead of aborting the cup for every other club too.
--
-- Second, separate bug fixed here too: ladder_cup_started_at
-- (20260811000001) was designed as an admin-only manual field — null means
-- "still open for joining," set once by the admin's "Start League" button,
-- never cleared automatically. The auto-monthly-open path never set it at
-- all, so every auto-opened cup silently sat in the "not started" state
-- until an admin happened to notice and click Start League by hand — the
-- exact "no admin click needed" auto-start this function's own comments
-- claim it does, but didn't. Setting it to now() at creation time here.
--
-- Safe to run more than once.

create or replace function _ladder_cup_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new_id uuid;
  v_name text;
  v_team record;
  v_member record;
  v_new_team_id uuid;
begin
  if exists (select 1 from leagues where format = 'ladder_cup' and ladder_cup_finalized_at is null) then
    return null; -- a cup is already live — never open a second one
  end if;

  select * into v_prev from leagues where format = 'ladder_cup' order by created_at desc limit 1;
  if not found then
    return null; -- no prior Ladder Cup to clone settings/clubs from — nothing to auto-open yet
  end if;

  -- 'FMMonth' = full month name, FM fill mode strips to_char's normal
  -- fixed-width padding. now() + 1 day = the month this cup is actually
  -- about to run through, not the instant it happens to be created.
  v_name := to_char(now() + interval '1 day', 'FMMonth') || ' Survivor Cup';

  insert into leagues (
    name, created_by, format, entry_closes_at, starts_at, description,
    round_period_hours, created_by_admin, league_type, ladder_cup_cutoff_at,
    ladder_cup_started_at
  )
  values (
    v_name, v_prev.created_by, 'ladder_cup', null, now(), v_prev.description,
    v_prev.round_period_hours, v_prev.created_by_admin, v_prev.league_type,
    _ladder_cup_last_day_of_month_2359_utc(now()),
    now()
  )
  returning id into v_new_id;

  -- Carry every real club from the cup that just finished into the new
  -- one automatically — same name, same WhatsApp number, same owner(s).
  -- Each insert into teams re-triggers trg_auto_ladder_cup_entry for its
  -- own fresh ladder_cup_entries row, exactly like a self-join would.
  for v_team in select id, name, phone from teams where league_id = v_prev.id loop
    begin
      insert into teams (league_id, name, phone)
      values (v_new_id, v_team.name, v_team.phone)
      returning id into v_new_team_id;
    exception when others then
      -- Isolate: a club that fails to carry forward must never block any
      -- other club, or the new cup itself, from carrying forward normally.
      raise warning 'ladder cup carry-forward: failed to carry club % (team %) into cup %: %',
        v_team.name, v_team.id, v_new_id, sqlerrm;
      continue;
    end;

    -- Carried one member at a time (not one set-based insert for the whole
    -- team) so a single member failing can't take the rest of the team's
    -- members down with it.
    for v_member in
      select user_id, display_name, phone from members
      where league_id = v_prev.id and team_id = v_team.id
    loop
      begin
        insert into members (league_id, team_id, user_id, display_name, phone)
        values (v_new_id, v_new_team_id, v_member.user_id, v_member.display_name, v_member.phone);
      exception when others then
        -- Isolate: a member that fails to carry forward must never block
        -- the rest of their club's members, or any other club, from
        -- carrying forward normally.
        raise warning 'ladder cup carry-forward: failed to carry member % into team % (cup %): %',
          v_member.user_id, v_new_team_id, v_new_id, sqlerrm;
      end;
    end loop;
  end loop;

  return v_new_id;
end;
$$;
