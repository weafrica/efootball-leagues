-- Rapid League: a single-round-robin sibling to Rapid Cup. Same 4-player
-- lobby/join/fee/payout mechanics, but instead of a 2-semis-then-final
-- knockout bracket, all 6 pairings (everyone plays everyone once) are
-- created up front with no elimination/advancement step.
--
-- Deliberately NOT copied from Rapid Cup, per explicit decision:
--   - Spectator investment (rapid_cup_investments / invest_in_rapid_cup_player)
--     is not included in this format.
--   - Push notifications on lobby-going-live are not wired up yet — Rapid
--     Cup's generate_rapid_cup_bracket calls a 'send-rapid-cup-push' edge
--     function; there is no 'send-rapid-league-push' counterpart deployed,
--     so that HTTP call is omitted here rather than pointing at a
--     function that doesn't exist. Players still get the in-app banner/
--     alarm; browser push for this format is a follow-up.
--   - get_rapid_cup_hall_of_fame has no Rapid League counterpart yet.
--
-- Payout math is identical to Rapid Cup and reuses the same generic
-- compute_rapid_cup_payout(total_pool, winner_stake, max_stake) function
-- rather than duplicating it — the formula doesn't know or care whether
-- the stakes came from a bracket or a round robin.
--
-- Verified via rolled-back dry run before applying: 4-player lobby with
-- varied entry fees (50/100/0/20), winner determined by round-robin
-- standings (wins, then goals), payout math hand-checked against
-- compute_rapid_cup_payout's formula (winner net 104, losers ~50/~10/0,
-- organizer keeps 6, conserves to the full 170 pool), and double-claim
-- protection confirmed on collect_rapid_league_potbox.

-- ─────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────

create sequence if not exists rapid_league_number_seq;

create table rapid_league_lobbies (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'open',
  created_at timestamptz not null default now(),
  reset_at timestamptz not null default (now() + interval '1 hour'),
  started_at timestamptz,
  league_id uuid references leagues(id),
  next_lobby_id uuid references rapid_league_lobbies(id),
  league_number integer not null default nextval('rapid_league_number_seq'),
  carryover_generation integer not null default 0
);

create table rapid_league_lobby_players (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid not null references rapid_league_lobbies(id) on delete cascade,
  user_id uuid not null,
  entry_fee numeric not null default 0,
  joined_at timestamptz not null default now(),
  alarm_stopped_at timestamptz,
  unique (lobby_id, user_id)
);

create table rapid_league_payouts (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid not null references rapid_league_lobbies(id),
  league_id uuid,
  winner_user_id uuid,
  total_pool numeric not null,
  winner_stake numeric,
  max_stake numeric not null,
  base_return numeric,
  remaining_pool numeric,
  bonus_share numeric,
  bonus numeric,
  organizer_keep numeric,
  winner_bonus numeric,
  winner_net_total numeric,
  leftover numeric,
  outcome text not null default 'winner',
  created_at timestamptz not null default now(),
  unique (lobby_id)
);

create table rapid_league_payout_recipients (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references rapid_league_payouts(id) on delete cascade,
  user_id uuid not null,
  entry_fee numeric not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);

create table rapid_league_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  box_type text not null,
  ref_id uuid not null,
  amount numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, box_type, ref_id)
);

-- ─────────────────────────────────────────────────────────────────────────
-- RLS — mirrors the exact policy shape used on the rapid_cup_* tables
-- ─────────────────────────────────────────────────────────────────────────

alter table rapid_league_lobbies enable row level security;
create policy "rapid_league_lobbies readable by all signed-in users"
  on rapid_league_lobbies for select
  using (auth.role() = 'authenticated');

alter table rapid_league_lobby_players enable row level security;
create policy "rapid_league_lobby_players readable by all signed-in users"
  on rapid_league_lobby_players for select
  using (auth.role() = 'authenticated');

alter table rapid_league_payouts enable row level security;
create policy "rapid_league_payouts readable by all signed-in users"
  on rapid_league_payouts for select
  using (auth.role() = 'authenticated');

alter table rapid_league_payout_recipients enable row level security;
create policy "rapid_league_payout_recipients readable by all signed-in users"
  on rapid_league_payout_recipients for select
  using (auth.role() = 'authenticated');

alter table rapid_league_collections enable row level security;
create policy "rapid_league_collections readable by owner or admin"
  on rapid_league_collections for select
  using (user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid()));

-- ─────────────────────────────────────────────────────────────────────────
-- Functions
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.join_rapid_league_lobby(p_entry_fee numeric default 0)
 returns rapid_league_lobbies
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_next_lobby rapid_league_lobbies;
  v_player_count int;
  v_already_seated boolean;
  v_balance numeric;
begin
  if p_entry_fee < 0 or p_entry_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(balance, 0) into v_balance from nets_wallets where user_id = auth.uid();
  v_balance := coalesce(v_balance, 0);
  if p_entry_fee > v_balance * 0.20 then
    raise exception 'Entry fee cannot exceed 20%% of your Nets balance (max %)', floor(v_balance * 0.20);
  end if;

  loop
    select * into v_lobby
    from rapid_league_lobbies
    where status = 'open' and reset_at > now()
    order by created_at asc
    limit 1
    for update;

    if v_lobby.id is null then
      insert into rapid_league_lobbies default values returning * into v_lobby;
      exit;
    end if;

    select exists (
      select 1 from rapid_league_lobby_players
      where lobby_id = v_lobby.id and user_id = auth.uid()
    ) into v_already_seated;

    if v_already_seated then
      exit;
    end if;

    select count(*) into v_player_count
    from rapid_league_lobby_players
    where lobby_id = v_lobby.id;

    if v_lobby.status <> 'open' or v_player_count >= 4 then
      continue;
    end if;

    exit;
  end loop;

  insert into rapid_league_lobby_players (lobby_id, user_id, entry_fee)
  values (v_lobby.id, auth.uid(), p_entry_fee)
  on conflict (lobby_id, user_id) do nothing;

  select count(*) into v_player_count
  from rapid_league_lobby_players
  where lobby_id = v_lobby.id;

  if v_player_count >= 4 and v_lobby.status = 'open' then
    insert into rapid_league_lobbies default values returning * into v_next_lobby;

    update rapid_league_lobbies
    set status = 'filling', started_at = now(), next_lobby_id = v_next_lobby.id
    where id = v_lobby.id
    returning * into v_lobby;
  end if;

  return v_lobby;
end;
$function$;

create or replace function public.raise_rapid_league_entry_fee(p_lobby_id uuid, p_new_fee numeric)
 returns rapid_league_lobby_players
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_row rapid_league_lobby_players;
  v_league_ends_at timestamptz;
  v_balance numeric;
begin
  if p_new_fee < 0 or p_new_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  select coalesce(balance, 0) into v_balance from nets_wallets where user_id = auth.uid();
  v_balance := coalesce(v_balance, 0);
  if p_new_fee > v_balance * 0.20 then
    raise exception 'Entry fee cannot exceed 20%% of your Nets balance (max %)', floor(v_balance * 0.20);
  end if;

  select * into v_lobby from rapid_league_lobbies where id = p_lobby_id;
  if v_lobby.id is null then
    raise exception 'Rapid League lobby % not found', p_lobby_id;
  end if;

  select * into v_row
  from rapid_league_lobby_players
  where lobby_id = p_lobby_id and user_id = auth.uid()
  for update;

  if v_row.id is null then
    raise exception 'You are not in this Rapid League lobby';
  end if;

  if p_new_fee <= v_row.entry_fee then
    raise exception 'Entry fee can only be raised — % is not above your current % Nets', p_new_fee, v_row.entry_fee;
  end if;

  if v_lobby.status not in ('open', 'filling', 'live') then
    raise exception 'This Rapid League lobby is no longer accepting fee changes';
  end if;

  if v_lobby.status = 'live' then
    v_league_ends_at := coalesce(v_lobby.started_at, v_lobby.created_at) + interval '4 hours';
    if v_league_ends_at - now() <= interval '40 minutes' then
      raise exception 'Entry fees are locked in the last 40 minutes of the league';
    end if;
  end if;

  update rapid_league_lobby_players
  set entry_fee = p_new_fee
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

create or replace function public.generate_rapid_league_fixtures(p_lobby_id uuid)
 returns rapid_league_lobbies
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_league_id uuid;
  v_now timestamptz := now();
  v_due_at timestamptz;
  v_player record;
  v_team_ids uuid[] := '{}';
  v_new_team_id uuid;
  i int;
  j int;
begin
  select * into v_lobby from rapid_league_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid League lobby % not found', p_lobby_id;
  end if;

  if v_lobby.status <> 'filling' or v_lobby.league_id is not null then
    return v_lobby;
  end if;

  v_due_at := coalesce(v_lobby.started_at, v_now) + interval '4 hours';

  insert into leagues (name, format, league_type, created_by_admin, starts_at)
  values ('Rapid League — ' || to_char(v_now, 'DD Mon HH24:MI'), 'single_round_robin', 'fun', true, v_now)
  returning id into v_league_id;

  for v_player in
    select lp.user_id, coalesce(p.efootball_username, 'Player ' || substr(lp.user_id::text, 1, 6)) as display_name, p.phone
    from rapid_league_lobby_players lp
    left join profiles p on p.user_id = lp.user_id
    where lp.lobby_id = p_lobby_id
    order by random()
  loop
    insert into teams (league_id, name, phone)
    values (v_league_id, v_player.display_name, v_player.phone)
    returning id into v_new_team_id;

    v_team_ids := v_team_ids || v_new_team_id;

    insert into members (league_id, user_id, display_name, phone, team_id)
    values (v_league_id, v_player.user_id, v_player.display_name, v_player.phone, v_new_team_id);
  end loop;

  if array_length(v_team_ids, 1) <> 4 then
    raise exception 'Rapid League lobby % did not have exactly 4 players (had %)', p_lobby_id, array_length(v_team_ids, 1);
  end if;

  -- Single round robin: every pair plays exactly once, all 6 fixtures
  -- open from the start — no elimination rounds, nothing waits on
  -- anything else finishing first.
  for i in 1..3 loop
    for j in (i + 1)..4 loop
      insert into fixtures (league_id, round, leg, stage, home_team_id, away_team_id, played, home_score, away_score, due_at, starts_at)
      values (v_league_id, 1, 1, 1, v_team_ids[i], v_team_ids[j], false, 0, 0, v_due_at, v_now);
    end loop;
  end loop;

  update rapid_league_lobbies
  set status = 'live', league_id = v_league_id
  where id = p_lobby_id
  returning * into v_lobby;

  return v_lobby;
end;
$function$;

create or replace function public._rapid_league_result_auto_sweep_internal()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sub result_submissions%rowtype;
  v_fixture fixtures%rowtype;
  v_count integer := 0;
  home_name text;
  away_name text;
  pens_suffix text;
begin
  for v_sub in
    select s.*
    from result_submissions s
    join rapid_league_lobbies rll on rll.league_id = s.league_id
    where s.status = 'pending'
      and rll.status = 'live'
      and s.created_at + interval '2 minutes' + interval '2 minutes' <= now()
    order by s.created_at
    for update of s skip locked
  loop
    select * into v_fixture from fixtures where id = v_sub.fixture_id for update;
    if not found then
      continue;
    end if;

    if v_fixture.played then
      update result_submissions set status = 'rejected' where id = v_sub.id;
      continue;
    end if;

    if v_sub.home_score is null or v_sub.away_score is null then
      continue;
    end if;
    if v_sub.home_score < 0 or v_sub.away_score < 0
       or (v_sub.pens_home is not null and v_sub.pens_home < 0)
       or (v_sub.pens_away is not null and v_sub.pens_away < 0)
       or (v_sub.pens_home is not null and v_sub.pens_away is not null and v_sub.pens_home = v_sub.pens_away) then
      continue;
    end if;

    update fixtures set
      played = true,
      home_score = v_sub.home_score,
      away_score = v_sub.away_score,
      pens_home = v_sub.pens_home,
      pens_away = v_sub.pens_away,
      played_at = now()
    where id = v_fixture.id
    returning
      (select t.name from teams t where t.id = fixtures.home_team_id),
      (select t.name from teams t where t.id = fixtures.away_team_id)
    into home_name, away_name;

    pens_suffix := '';
    if v_sub.pens_home is not null and v_sub.pens_away is not null then
      pens_suffix := format(' (pens %s–%s)', v_sub.pens_home, v_sub.pens_away);
    end if;

    insert into comments (league_id, user_id, username, body)
    values (
      v_sub.league_id, v_sub.submitted_by, v_sub.submitted_by_username,
      format('⚽ Result posted: %s %s – %s %s%s (no response within 2 min — auto-accepted)',
        coalesce(home_name, 'Home'), v_sub.home_score, v_sub.away_score, coalesce(away_name, 'Away'), pens_suffix)
    );

    update result_submissions set status = 'approved' where id = v_sub.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

create or replace function public.finalize_rapid_league_payout(p_lobby_id uuid, p_winner_user_id uuid)
 returns rapid_league_payouts
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_existing rapid_league_payouts;
  v_total_pool numeric;
  v_max_stake numeric;
  v_winner_stake numeric;
  v_calc record;
  v_payout rapid_league_payouts;
  v_row record;
begin
  select * into v_lobby from rapid_league_lobbies where id = p_lobby_id for update;

  if v_lobby.id is null then
    raise exception 'Rapid League lobby % not found', p_lobby_id;
  end if;

  select * into v_existing from rapid_league_payouts where lobby_id = p_lobby_id;
  if v_existing.id is not null then
    return v_existing;
  end if;

  if v_lobby.status <> 'live' or v_lobby.league_id is null then
    raise exception 'Rapid League lobby % is not live with generated fixtures', p_lobby_id;
  end if;

  select sum(entry_fee), max(entry_fee) into v_total_pool, v_max_stake
  from rapid_league_lobby_players where lobby_id = p_lobby_id;

  select entry_fee into v_winner_stake
  from rapid_league_lobby_players
  where lobby_id = p_lobby_id and user_id = p_winner_user_id;

  if v_winner_stake is null then
    raise exception 'User % is not one of the 4 players in lobby %', p_winner_user_id, p_lobby_id;
  end if;

  -- Reuses Rapid Cup's generic payout formula as-is — it only takes
  -- pool/winner-stake/max-stake, it doesn't know or care about brackets.
  select * into v_calc from compute_rapid_cup_payout(v_total_pool, v_winner_stake, v_max_stake);

  insert into rapid_league_payouts (
    lobby_id, league_id, winner_user_id, total_pool, winner_stake, max_stake,
    base_return, remaining_pool, bonus_share, bonus, organizer_keep, winner_bonus, winner_net_total, leftover
  ) values (
    p_lobby_id, v_lobby.league_id, p_winner_user_id, v_total_pool, v_winner_stake, v_max_stake,
    v_calc.base_return, v_calc.remaining_pool, v_calc.bonus_share, v_calc.bonus,
    v_calc.organizer_keep, v_calc.winner_bonus, v_calc.winner_net_total, v_calc.leftover
  )
  returning * into v_payout;

  insert into rapid_league_payout_recipients (payout_id, user_id, entry_fee, amount)
  values (v_payout.id, p_winner_user_id, v_winner_stake, v_calc.winner_net_total);

  for v_row in
    select user_id, entry_fee
    from rapid_league_lobby_players
    where lobby_id = p_lobby_id and user_id <> p_winner_user_id
  loop
    insert into rapid_league_payout_recipients (payout_id, user_id, entry_fee, amount)
    values (
      v_payout.id, v_row.user_id, v_row.entry_fee,
      case when v_calc.remaining_pool > 0 then v_calc.leftover * (v_row.entry_fee / v_calc.remaining_pool) else 0 end
    );
  end loop;

  update rapid_league_lobbies set status = 'completed' where id = p_lobby_id;

  return v_payout;
end;
$function$;

create or replace function public._rapid_league_finish_lobby_internal(p_lobby_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby rapid_league_lobbies;
  v_league_id uuid;
  v_existing rapid_league_payouts;
  v_total_pool numeric;
  v_max_stake numeric;
  v_any_played boolean;
  v_winners_at_max uuid[];
  v_max_wins integer;
  v_goal_winners uuid[];
  v_winner_user_id uuid;
  v_payout rapid_league_payouts;
  v_row record;
  v_tied_stake_sum numeric;
  v_remaining numeric;
  v_bonus_each numeric;
begin
  select * into v_lobby from rapid_league_lobbies where id = p_lobby_id for update;
  if v_lobby.id is null or v_lobby.status <> 'live' or v_lobby.league_id is null then
    return;
  end if;

  select * into v_existing from rapid_league_payouts where lobby_id = p_lobby_id;
  if v_existing.id is not null then
    return;
  end if;

  v_league_id := v_lobby.league_id;

  select sum(entry_fee), max(entry_fee) into v_total_pool, v_max_stake
  from rapid_league_lobby_players where lobby_id = p_lobby_id;

  select exists(select 1 from fixtures where league_id = v_league_id and stage = 1 and played = true)
  into v_any_played;

  -- Nobody played a single match — full refund, principal only.
  if not v_any_played then
    insert into rapid_league_payouts (lobby_id, league_id, winner_user_id, outcome, total_pool, max_stake)
    values (p_lobby_id, v_league_id, null, 'refund', v_total_pool, v_max_stake)
    returning * into v_payout;

    for v_row in
      select user_id, entry_fee from rapid_league_lobby_players where lobby_id = p_lobby_id
    loop
      insert into rapid_league_payout_recipients (payout_id, user_id, entry_fee, amount)
      values (v_payout.id, v_row.user_id, v_row.entry_fee, v_row.entry_fee);
    end loop;

    update rapid_league_lobbies set status = 'completed' where id = p_lobby_id;
    return;
  end if;

  -- Standings: wins first, then goals scored, exactly like Rapid Cup's
  -- semifinal/final tiebreak cascade — the logic is generic to "a set of
  -- match results", it never assumed a bracket shape.
  with fixture_results as (
    select f.home_team_id, f.away_team_id, f.played, f.home_score, f.away_score,
      case
        when f.played and f.home_score > f.away_score then f.home_team_id
        when f.played and f.away_score > f.home_score then f.away_team_id
        when f.played and f.home_score = f.away_score and f.pens_home is not null and f.pens_away is not null and f.pens_home <> f.pens_away
          then case when f.pens_home > f.pens_away then f.home_team_id else f.away_team_id end
        else null
      end as winner_team_id
    from fixtures f
    where f.league_id = v_league_id and f.stage = 1
  ),
  team_stats as (
    select t.id as team_id,
      count(fr.winner_team_id) filter (where fr.winner_team_id = t.id) as wins,
      coalesce(sum(
        case when fr.home_team_id = t.id then fr.home_score
             when fr.away_team_id = t.id then fr.away_score
             else 0 end
      ) filter (where fr.played), 0) as goals
    from teams t
    left join fixture_results fr on fr.home_team_id = t.id or fr.away_team_id = t.id
    where t.league_id = v_league_id
    group by t.id
  ),
  max_w as (select max(wins) as mw from team_stats),
  wins_tied as (select ts.* from team_stats ts, max_w where ts.wins = max_w.mw),
  max_g as (select max(goals) as mg from wins_tied)
  select
    (select array_agg(team_id) from wins_tied),
    (select mw from max_w),
    (select array_agg(team_id) from wins_tied, max_g where wins_tied.goals = max_g.mg)
  into v_winners_at_max, v_max_wins, v_goal_winners;

  if array_length(v_winners_at_max, 1) = 1 then
    select m.user_id into v_winner_user_id
    from members m where m.league_id = v_league_id and m.team_id = v_winners_at_max[1];
    perform finalize_rapid_league_payout(p_lobby_id, v_winner_user_id);
    return;
  end if;

  if array_length(v_goal_winners, 1) = 1 then
    select m.user_id into v_winner_user_id
    from members m where m.league_id = v_league_id and m.team_id = v_goal_winners[1];
    perform finalize_rapid_league_payout(p_lobby_id, v_winner_user_id);
    return;
  end if;

  -- Still tied on both wins and goals -> pool splits evenly among the
  -- tied top players, each guaranteed their own entry fee back. Anyone
  -- NOT in the tied top group gets $0 (no refund) in this outcome —
  -- same as Rapid Cup's split case.
  select sum(lp.entry_fee) into v_tied_stake_sum
  from rapid_league_lobby_players lp
  join members m on m.user_id = lp.user_id and m.league_id = v_league_id
  where lp.lobby_id = p_lobby_id and m.team_id = any(v_goal_winners);

  v_remaining := v_total_pool - v_tied_stake_sum;
  v_bonus_each := v_remaining / array_length(v_goal_winners, 1);

  insert into rapid_league_payouts (lobby_id, league_id, winner_user_id, outcome, total_pool, max_stake)
  values (p_lobby_id, v_league_id, null, 'split', v_total_pool, v_max_stake)
  returning * into v_payout;

  for v_row in
    select lp.user_id, lp.entry_fee, m.team_id
    from rapid_league_lobby_players lp
    join members m on m.user_id = lp.user_id and m.league_id = v_league_id
    where lp.lobby_id = p_lobby_id
  loop
    if v_row.team_id = any(v_goal_winners) then
      insert into rapid_league_payout_recipients (payout_id, user_id, entry_fee, amount)
      values (v_payout.id, v_row.user_id, v_row.entry_fee, v_row.entry_fee + v_bonus_each);
    else
      insert into rapid_league_payout_recipients (payout_id, user_id, entry_fee, amount)
      values (v_payout.id, v_row.user_id, v_row.entry_fee, 0);
    end if;
  end loop;

  update rapid_league_lobbies set status = 'completed' where id = p_lobby_id;
end;
$function$;

create or replace function public._rapid_league_sweep_internal()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_row record;
  v_all_played boolean;
  v_any_overdue boolean;
begin
  for v_row in
    select id as lobby_id, league_id from rapid_league_lobbies
    where status = 'live' and league_id is not null
  loop
    select bool_and(played), bool_or(due_at <= now())
    into v_all_played, v_any_overdue
    from fixtures
    where league_id = v_row.league_id and stage = 1;

    if coalesce(v_all_played, false) or coalesce(v_any_overdue, false) then
      perform _rapid_league_finish_lobby_internal(v_row.lobby_id);
    end if;
  end loop;
end;
$function$;

create or replace function public.expire_rapid_league_lobbies()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_lobby record;
  v_new_lobby rapid_league_lobbies;
begin
  for v_lobby in
    select * from rapid_league_lobbies
    where status = 'open' and reset_at <= now()
    for update skip locked
  loop
    update rapid_league_lobbies
    set status = 'expired'
    where id = v_lobby.id;

    if v_lobby.carryover_generation = 0 and exists (
      select 1 from rapid_league_lobby_players where lobby_id = v_lobby.id
    ) then
      insert into rapid_league_lobbies (carryover_generation)
      values (1)
      returning * into v_new_lobby;

      insert into rapid_league_lobby_players (lobby_id, user_id, entry_fee)
      select v_new_lobby.id, user_id, entry_fee
      from rapid_league_lobby_players
      where lobby_id = v_lobby.id
      on conflict (lobby_id, user_id) do nothing;

      update rapid_league_lobbies
      set next_lobby_id = v_new_lobby.id
      where id = v_lobby.id;
    end if;
  end loop;

  if not exists (select 1 from rapid_league_lobbies where status = 'open' and reset_at > now()) then
    insert into rapid_league_lobbies default values;
  end if;
end;
$function$;

create or replace function public.collect_rapid_league_potbox(p_lobby_id uuid)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_payout rapid_league_payouts%rowtype;
  v_amount numeric;
  v_amount_int bigint;
  v_found boolean;
  v_is_participant boolean;
  v_claim rapid_league_collections;
begin
  if auth.uid() is null then
    raise exception 'collect_rapid_league_potbox: must be signed in';
  end if;

  select * into v_payout from rapid_league_payouts where lobby_id = p_lobby_id;
  if v_payout.id is null then
    raise exception 'This league hasn''t finished yet';
  end if;

  select coalesce(sum(amount), 0), count(*) > 0
  into v_amount, v_found
  from rapid_league_payout_recipients
  where payout_id = v_payout.id and user_id = auth.uid();

  if not v_found then
    if v_payout.outcome = 'winner' then
      select exists(select 1 from rapid_league_lobby_players where lobby_id = p_lobby_id and user_id = auth.uid())
      into v_is_participant;

      if not v_is_participant then
        raise exception 'You weren''t in this league';
      end if;

      v_amount := case when v_payout.winner_user_id = auth.uid() then v_payout.winner_net_total else 0 end;
    else
      raise exception 'You weren''t in this league';
    end if;
  end if;

  v_amount_int := round(coalesce(v_amount, 0))::bigint;

  insert into rapid_league_collections (user_id, box_type, ref_id, amount)
  values (auth.uid(), 'potbox', p_lobby_id, v_amount_int)
  on conflict (user_id, box_type, ref_id) do nothing
  returning * into v_claim;

  if v_claim.id is null then
    return 0;
  end if;

  if v_amount_int > 0 then
    perform _nets_credit_internal(auth.uid(), v_amount_int, 'rapid_league_potbox', null, 'lobby', p_lobby_id::text, null);
  end if;

  return v_amount_int;
end;
$function$;

create or replace function public.collect_rapid_league_winbox(p_fixture_id uuid)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_fixture fixtures%rowtype;
  v_team_id uuid;
  v_winner_team_id uuid;
  v_winbox_reward bigint := 3;
  v_claim rapid_league_collections;
begin
  if auth.uid() is null then
    raise exception 'collect_rapid_league_winbox: must be signed in';
  end if;

  select * into v_fixture from fixtures where id = p_fixture_id;
  if v_fixture.id is null then
    raise exception 'Fixture not found';
  end if;

  if not exists (select 1 from rapid_league_lobbies where league_id = v_fixture.league_id) then
    raise exception 'Not a Rapid League fixture';
  end if;

  if not v_fixture.played then
    raise exception 'This match hasn''t finished yet';
  end if;

  select team_id into v_team_id
  from members
  where league_id = v_fixture.league_id and user_id = auth.uid();

  if v_team_id is null or (v_team_id <> v_fixture.home_team_id and v_team_id <> v_fixture.away_team_id) then
    raise exception 'You weren''t in this match';
  end if;

  v_winner_team_id := case
    when v_fixture.home_score > v_fixture.away_score then v_fixture.home_team_id
    when v_fixture.away_score > v_fixture.home_score then v_fixture.away_team_id
    when v_fixture.pens_home is not null and v_fixture.pens_away is not null and v_fixture.pens_home <> v_fixture.pens_away
      then case when v_fixture.pens_home > v_fixture.pens_away then v_fixture.home_team_id else v_fixture.away_team_id end
    else null
  end;

  if v_winner_team_id is null or v_winner_team_id <> v_team_id then
    raise exception 'You didn''t win this match';
  end if;

  insert into rapid_league_collections (user_id, box_type, ref_id, amount)
  values (auth.uid(), 'winbox', p_fixture_id, v_winbox_reward)
  on conflict (user_id, box_type, ref_id) do nothing
  returning * into v_claim;

  if v_claim.id is null then
    return 0;
  end if;

  perform _nets_credit_internal(auth.uid(), v_winbox_reward, 'rapid_league_winbox', null, 'fixture', p_fixture_id::text, v_team_id);

  return v_winbox_reward;
end;
$function$;

create or replace function public.stop_rapid_league_alarm(p_lobby_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update rapid_league_lobby_players
  set alarm_stopped_at = now()
  where lobby_id = p_lobby_id
    and user_id = auth.uid()
    and alarm_stopped_at is null;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────
-- Grants — mirrors exactly what was measured on the equivalent
-- rapid_cup_* functions (join/raise/generate/stop/expire open to
-- anon+authenticated since they self-guard on auth.uid(); collect_*
-- requires authenticated; finalize/internal helpers are not directly
-- callable by any client role at all).
-- ─────────────────────────────────────────────────────────────────────────

revoke all on function public.join_rapid_league_lobby(numeric) from public;
grant execute on function public.join_rapid_league_lobby(numeric) to anon, authenticated;

revoke all on function public.raise_rapid_league_entry_fee(uuid, numeric) from public;
grant execute on function public.raise_rapid_league_entry_fee(uuid, numeric) to anon, authenticated;

revoke all on function public.generate_rapid_league_fixtures(uuid) from public;
grant execute on function public.generate_rapid_league_fixtures(uuid) to anon, authenticated;

revoke all on function public.stop_rapid_league_alarm(uuid) from public;
grant execute on function public.stop_rapid_league_alarm(uuid) to anon, authenticated;

revoke all on function public.expire_rapid_league_lobbies() from public;
grant execute on function public.expire_rapid_league_lobbies() to anon, authenticated;

revoke all on function public.collect_rapid_league_potbox(uuid) from public;
grant execute on function public.collect_rapid_league_potbox(uuid) to authenticated;

revoke all on function public.collect_rapid_league_winbox(uuid) from public;
grant execute on function public.collect_rapid_league_winbox(uuid) to authenticated;

revoke all on function public.finalize_rapid_league_payout(uuid, uuid) from public;
revoke all on function public._rapid_league_finish_lobby_internal(uuid) from public;
revoke all on function public._rapid_league_sweep_internal() from public;
revoke all on function public._rapid_league_result_auto_sweep_internal() from public;

-- ─────────────────────────────────────────────────────────────────────────
-- Cron — same cadence as the Rapid Cup jobs
-- ─────────────────────────────────────────────────────────────────────────

select cron.schedule('rapid-league-expire-lobbies', '* * * * *', 'select expire_rapid_league_lobbies();');
select cron.schedule('rapid-league-result-auto-sweep', '* * * * *', 'select _rapid_league_result_auto_sweep_internal();');
select cron.schedule('rapid-league-sweep', '*/2 * * * *', 'select _rapid_league_sweep_internal();');

-- Seed the first open lobby so there's somewhere to join immediately.
insert into rapid_league_lobbies default values;
