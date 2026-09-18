-- Chess vs AI — adds a single-player mode to the existing chess_games
-- table (20260940_chess.sql) rather than a parallel table: same board
-- screen, same realtime plumbing, just black_user_id left null and a
-- couple of extra columns.
--
-- Nets reward, not stake: there's no second human to escrow money from,
-- so this is a flat "beat the bot" reward funded like any other reward
-- in this app (_nets_credit_internal, no debit on the other side) —
-- same shape as a daily-challenge or achievement payout, not a wager.
--
-- The elephant in the room: AI moves are computed and reported by the
-- same untrusted client that reports human moves in the PvP table, so
-- there is nothing stopping someone from patching their own client to
-- always report "I won". This repo already accepts that exact trust
-- gap for PvP (see 20260940_chess.sql's own header) — for real money
-- moving between two real people, the two players are at least a mutual
-- check on each other. A solo AI reward has no such check, so it needs
-- its own backstop: a hard daily cap (chess_ai_daily_reward_cap below)
-- on how many AI wins get paid per person per day. It doesn't stop
-- someone from cheating a single win; it stops cheating from being a
-- meaningful income source. Tighten or remove once/if this needs to be
-- airtight (e.g. a server-side chess engine validating the final PGN).

alter table public.chess_games
  add column if not exists is_vs_ai boolean not null default false,
  add column if not exists ai_difficulty text check (ai_difficulty in ('easy', 'medium', 'hard')),
  add column if not exists ai_reward_nets bigint not null default 0 check (ai_reward_nets >= 0),
  add column if not exists ai_won boolean not null default false,
  add column if not exists ai_reward_paid boolean not null default false;

alter table public.chess_games
  add constraint chess_games_ai_fields_consistent
    check (not is_vs_ai or (ai_difficulty is not null and black_user_id is null));

-- Daily cap on *rewarded* AI wins per person — playing more than this is
-- always fine, it just stops paying out past the cap for that day.
create or replace function public.chess_ai_daily_reward_cap() returns int
language sql immutable as $$ select 5 $$;

-- ---------------------------------------------------------------------
-- create_ai_chess_game — starts a solo game immediately (no lobby/join
-- step — there's no one to wait for). Reward amount is fixed at
-- creation time from the chosen difficulty so it can't be swapped
-- mid-game by re-submitting a different value later.
create or replace function public.create_ai_chess_game(p_difficulty text)
returns public.chess_games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_game public.chess_games;
  v_reward bigint;
begin
  if v_user is null then
    raise exception 'create_ai_chess_game: must be signed in';
  end if;
  if p_difficulty not in ('easy', 'medium', 'hard') then
    raise exception 'create_ai_chess_game: invalid difficulty';
  end if;

  v_reward := case p_difficulty
    when 'easy' then 3
    when 'medium' then 7
    when 'hard' then 15
  end;

  insert into public.chess_games (created_by, white_user_id, status, is_vs_ai, ai_difficulty, ai_reward_nets, started_at, last_move_at)
  values (v_user, v_user, 'active', true, p_difficulty, v_reward, now(), now())
  returning * into v_game;

  return v_game;
end;
$$;

grant execute on function public.create_ai_chess_game(text) to authenticated;

-- ---------------------------------------------------------------------
-- chess_submit_ai_move — the human's own moves AND the bot's computed
-- replies both go through this (the human is the only real session
-- here, so there's no "whose turn" ownership check the way PvP has —
-- only that the caller is this game's player and it really is an AI
-- game). p_outcome is only read when p_status = 'finished'.
create or replace function public.chess_submit_ai_move(
  p_game_id uuid,
  p_new_fen text,
  p_new_pgn text,
  p_status text default null,     -- null (still playing) or 'finished'
  p_outcome text default null,    -- 'human_win' | 'ai_win' | 'draw'
  p_result_reason text default null
)
returns public.chess_games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_game public.chess_games;
  v_wins_today int;
  v_pay boolean := false;
begin
  select * into v_game from public.chess_games where id = p_game_id for update;
  if not found then
    raise exception 'chess_submit_ai_move: game not found';
  end if;
  if not v_game.is_vs_ai then
    raise exception 'chess_submit_ai_move: not an AI game';
  end if;
  if v_game.white_user_id <> v_user then
    raise exception 'chess_submit_ai_move: not your game';
  end if;
  if v_game.status <> 'active' then
    raise exception 'chess_submit_ai_move: game is not active';
  end if;

  if p_status is null then
    update public.chess_games
    set fen = p_new_fen, pgn = p_new_pgn,
        turn = case when turn = 'w' then 'b' else 'w' end,
        move_count = move_count + 1, last_move_at = now()
    where id = p_game_id
    returning * into v_game;
    return v_game;
  end if;

  if p_status <> 'finished' then
    raise exception 'chess_submit_ai_move: unexpected status %', p_status;
  end if;
  if p_outcome not in ('human_win', 'ai_win', 'draw') then
    raise exception 'chess_submit_ai_move: invalid outcome';
  end if;

  if p_outcome = 'human_win' then
    select count(*) into v_wins_today
    from public.chess_games
    where white_user_id = v_user and is_vs_ai and ai_reward_paid
      and finished_at::date = current_date;
    v_pay := v_wins_today < public.chess_ai_daily_reward_cap();
  end if;

  update public.chess_games
  set fen = p_new_fen, pgn = p_new_pgn, move_count = move_count + 1,
      status = 'finished', result_reason = p_result_reason, finished_at = now(), last_move_at = now(),
      winner_user_id = case when p_outcome = 'human_win' then v_user else null end,
      ai_won = (p_outcome = 'ai_win'),
      ai_reward_paid = v_pay
  where id = p_game_id
  returning * into v_game;

  if v_pay and v_game.ai_reward_nets > 0 then
    perform public._nets_credit_internal(v_user, v_game.ai_reward_nets, 'chess_ai_win',
      'Chess — beat the ' || v_game.ai_difficulty || ' bot', 'chess_game', p_game_id::text, null);
  end if;

  return v_game;
end;
$$;

grant execute on function public.chess_submit_ai_move(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- resign_ai_chess_game — quitting a solo game. No reward, obviously.
create or replace function public.resign_ai_chess_game(p_game_id uuid)
returns public.chess_games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_game public.chess_games;
begin
  select * into v_game from public.chess_games where id = p_game_id for update;
  if not found then
    raise exception 'resign_ai_chess_game: game not found';
  end if;
  if not v_game.is_vs_ai or v_game.white_user_id <> v_user then
    raise exception 'resign_ai_chess_game: not your game';
  end if;
  if v_game.status <> 'active' then
    raise exception 'resign_ai_chess_game: game is not active';
  end if;

  update public.chess_games
  set status = 'finished', ai_won = true, result_reason = 'resignation', finished_at = now()
  where id = p_game_id
  returning * into v_game;

  return v_game;
end;
$$;

grant execute on function public.resign_ai_chess_game(uuid) to authenticated;
