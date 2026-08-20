-- Nets — groups_knockout economy: prices the format's entry fee and gives
-- its group stage (stage 1) its own reward amounts instead of sharing
-- _credit_league_fixture_reward's plain 'league' numbers (win=5, draw=2).
--
-- Entry fee: groups_knockout is now priced at 80 Nets (economy.js's
-- ENTRY_FEES_NETS.groups_knockout / entryFeeForLeagueFormat) — that's a
-- client-side change only, nothing to migrate here; debitNets already
-- reads whatever entryFeeForLeagueFormat returns.
--
-- Group-stage reward: win=4, draw=2, loss=0, +1 participation (so 5/3/1 in
-- practice) — economy.js's new 'groups_knockout_group' table. This is
-- LOWER than plain round-robin leagues' win=5, which is deliberate: a
-- groups_knockout entrant who reaches the bracket also earns 'knockout'
-- table rewards (3+/round) per fixture there on top of their group-stage
-- rewards, so the group stage alone paying as much as a whole round-robin
-- league would double-pay relative to a plain league entrant.
--
-- _credit_league_fixture_reward (20260832) is redefined here to branch by
-- format instead of using one flat win=5/draw=2 for every eligible fixture.
-- Nothing about ITS callers (record_fixture_result /
-- approve_result_submission / respond_to_result_submission) or the
-- eligibility check (single/double round robin, survivor, and
-- groups_knockout stage 1 — never the bracket stage, which
-- 20260834/20260838 already cover) changes; only the reward amount
-- computed inside it does.
--
-- Safe to run more than once.

create or replace function _credit_league_fixture_reward(p_fixture_id uuid, p_was_already_played boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture fixtures%rowtype;
  v_league leagues%rowtype;
  v_eligible boolean;
  v_win bigint;
  v_draw bigint;
  v_loss bigint;
  v_home_reward bigint;
  v_away_reward bigint;
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

  v_eligible := v_league.format in ('single_round_robin', 'double_round_robin', 'survivor')
    or (v_league.format = 'groups_knockout' and v_fixture.stage = 1);
  if not v_eligible then
    return;
  end if;

  -- economy.js: 'league' table (win=5, draw=2, loss=0) for plain
  -- round-robin/survivor leagues; 'groups_knockout_group' table
  -- (win=4, draw=2, loss=0) for groups_knockout's own group stage.
  if v_league.format = 'groups_knockout' then
    v_win := 4; v_draw := 2; v_loss := 0;
  else
    v_win := 5; v_draw := 2; v_loss := 0;
  end if;

  if v_fixture.home_score > v_fixture.away_score then
    v_home_reward := v_win + 1; v_away_reward := v_loss + 1;
  elsif v_fixture.away_score > v_fixture.home_score then
    v_home_reward := v_loss + 1; v_away_reward := v_win + 1;
  else
    v_home_reward := v_draw + 1; v_away_reward := v_draw + 1;
  end if;

  for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.home_team_id loop
    perform _nets_credit_internal(v_member.user_id, v_home_reward, 'league_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.home_team_id);
  end loop;

  for v_member in select user_id from members where league_id = v_fixture.league_id and team_id = v_fixture.away_team_id loop
    perform _nets_credit_internal(v_member.user_id, v_away_reward, 'league_match_reward', null, 'fixture', p_fixture_id::text, v_fixture.away_team_id);
  end loop;
end;
$$;

-- No grant to authenticated — same as 20260832; reachable only from the
-- three fixture-result RPCs, which already have their own grants.
