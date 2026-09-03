-- Rapid Cup — Phase 4a: bracket advance (round 1 -> final).
--
-- Rapid Cup only ever has 4 teams and a single shared 4hr deadline for the
-- whole cup (Section 2 of the build plan) — unlike Weekend League there's
-- no per-round timer to hand out, so this function only has one job: once
-- both round-1 (semi-final) fixtures are decided, create the final.
--
-- "Decided" mirrors the app's own single-leg rule (knockout_legs=1 for
-- Rapid Cup): normal score if it's not level, penalties if it is — same
-- as knockoutBracketWinners' final-round handling in src/App.jsx, just
-- applied to round 1 too, since Rapid Cup has no second leg to fall back
-- on for any round.
--
-- Idempotent: no-ops if the final (round 2) already exists, or if either
-- semi isn't decided yet. Safe to call repeatedly from the sweep cron.
create or replace function _rapid_cup_advance_bracket_internal(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_semis record;
  v_winners uuid[] := '{}';
  v_due timestamptz;
  v_now timestamptz := now();
  v_final_exists boolean;
begin
  select exists(select 1 from fixtures where league_id = p_league_id and round = 2 and stage = 1)
  into v_final_exists;

  if v_final_exists then
    return; -- final already generated
  end if;

  for v_semis in
    select home_team_id, away_team_id, played, home_score, away_score, pens_home, pens_away, due_at
    from fixtures
    where league_id = p_league_id and round = 1 and leg = 1 and stage = 1
    order by id
  loop
    v_due := v_semis.due_at;

    if not v_semis.played then
      return; -- this semi hasn't been played yet
    end if;

    if v_semis.home_score > v_semis.away_score then
      v_winners := v_winners || v_semis.home_team_id;
    elsif v_semis.away_score > v_semis.home_score then
      v_winners := v_winners || v_semis.away_team_id;
    elsif v_semis.pens_home is not null and v_semis.pens_away is not null and v_semis.pens_home <> v_semis.pens_away then
      v_winners := v_winners || (case when v_semis.pens_home > v_semis.pens_away then v_semis.home_team_id else v_semis.away_team_id end);
    else
      return; -- level scoreline, penalties not submitted yet
    end if;
  end loop;

  -- Unexpected shape (not exactly 2 semis found) — bail out safely rather
  -- than generate a malformed final.
  if array_length(v_winners, 1) <> 2 then
    return;
  end if;

  insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
  values (p_league_id, 2, 1, 1, v_winners[1], v_winners[2], false, 0, 0, v_due, v_now);
end;
$$;

-- Not granted to `authenticated` — only ever called from the sweep cron
-- (Phase 4b), same restricted posture as the Phase 3 payout functions.
