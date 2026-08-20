-- Nets — pay the participation net on a drawn knockout leg instead of
-- nothing.
--
-- Supersedes the "nothing is paid out for a level scoreline" branch in
-- 20260834_knockout_fixture_reward_crediting.sql. That branch assumed a
-- level knockout fixture never needed its own reward because whichever
-- fixture actually settled the tie would get one — true for the tie as a
-- whole, but wrong for the leg itself: a plain leg of a two-legged (home &
-- away) tie can end level on its own scoreline (only the tie's eventual
-- decider, or a single-leg/final fixture, is forced to a winner via
-- penalties — see isDeciderFixture/advanceKnockout in App.jsx), and that
-- leg is still a played fixture two clubs showed up for.
--
-- economy.js's knockout branch now treats a draw the same as a loss (0
-- base + 1 participation = 1 Net) rather than throwing "no draws" — this
-- ports that exactly: both sides get v_loss_reward instead of the
-- fixture being skipped.
--
-- Everything else about _credit_knockout_fixture_reward (eligibility,
-- win/loss amounts, the three call sites) is unchanged from 20260834 —
-- only the level-scoreline branch differs.
--
-- Safe to run more than once.

create or replace function _credit_knockout_fixture_reward(p_fixture_id uuid, p_was_already_played boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture fixtures%rowtype;
  v_league leagues%rowtype;
  v_eligible boolean;
  v_round integer;
  v_win_reward bigint;
  v_loss_reward bigint := 0 + 1;
  v_member record;
begin
  if p_was_already_played then
    return;
  end if;

  select * into v_fixture from fixtures where id = p_fixture_id;
  if not found or v_fixture.home_team_id is null or v_fixture.away_team_id is null
     or v_fixture.home_score is null or v_fixture.away_score is null then
    return;
  end if;

  select * into v_league from leagues where id = v_fixture.league_id;
  if not found then
    return;
  end if;

  v_eligible := v_league.format = 'knockout'
    or (v_league.format = 'groups_knockout' and v_fixture.stage = 2);
  if not v_eligible then
    return;
  end if;

  -- A level knockout fixture is a plain leg of a home & away tie — see the
  -- migration header above. Both sides get the participation-only net,
  -- same amount as a loss, rather than nothing.
  if v_fixture.home_score = v_fixture.away_score then
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.home_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_loss_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.home_team_id);
    end loop;
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.away_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_loss_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.away_team_id);
    end loop;
    return;
  end if;

  -- round is 1-indexed straight off the fixture, same field
  -- knockoutRoundFixtures (App.jsx) stamps it with at bracket generation.
  -- winPerRound is a whole 1/round, so this is exact integer arithmetic.
  v_round := coalesce(v_fixture.round, 1);
  v_win_reward := 3 + (v_round - 1) + 1; -- winBase + winPerRound*(round-1), +1 participation

  if v_fixture.home_score > v_fixture.away_score then
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.home_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_win_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.home_team_id);
    end loop;
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.away_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_loss_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.away_team_id);
    end loop;
  else
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.away_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_win_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.away_team_id);
    end loop;
    for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.home_team_id loop
      perform _nets_credit_internal(v_member.user_id, v_loss_reward, 'knockout_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.home_team_id);
    end loop;
  end if;
end;
$$;

-- No grant to authenticated — reachable only from the fixture-result RPCs
-- (record_fixture_result / approve_result_submission /
-- respond_to_result_submission, see 20260834), same as before. Those RPCs
-- already call _credit_knockout_fixture_reward and don't need any changes
-- here — only the function body above changed.
