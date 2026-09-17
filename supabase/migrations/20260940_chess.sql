-- Chess — 1v1 real-time chess with optional Nets staking.
--
-- New feature, own table/RPCs, doesn't touch anything existing. Follows
-- this repo's established pattern for anything result/stake-bearing
-- (ladder_cup, rapid_cup): the client owns move legality (via chess.js —
-- reinventing a chess rules engine in PL/pgSQL isn't worth it), the
-- server only enforces *whose turn it is* and handles the money, exactly
-- the same trust boundary this app already accepts for every other
-- client-reported result (see FINALS-PENALTIES-MIGRATION.md,
-- LADDER-FIXES-AND-BACKUP.md). A malicious client could report an illegal
-- winning position, same as a malicious client could already misreport
-- an eFootball scoreline — out of scope for this pass; an admin-override
-- RPC (same shape as admin_override_ladder_fixture_result) is a natural
-- Phase 2 if that turns out to matter in practice.
--
-- Payout math is deliberately trivial (loser's stake, minus nothing, to
-- the winner; a draw refunds both) rather than Rapid Cup's organizer-fee
-- split — there's no "organizer" here, just two players, so there's
-- nothing to take a cut of. Confirmed live against project
-- jobgzxljuczzqljwavyq: _nets_credit_internal/_nets_debit_internal take
-- (p_user_id, p_amount, p_reason, p_note, p_ref_type, p_ref_id,
-- p_team_id) and are SECURITY DEFINER — safe to call directly from these
-- functions without going through the admin-only public nets_credit
-- wrapper.

create table if not exists public.chess_games (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'open'
    check (status in ('open', 'active', 'finished', 'aborted')),
  created_by uuid not null references auth.users(id),
  white_user_id uuid not null references auth.users(id),
  black_user_id uuid references auth.users(id),
  stake_nets bigint not null default 0 check (stake_nets >= 0),
  fen text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  pgn text not null default '',
  turn text not null default 'w' check (turn in ('w', 'b')),
  move_count int not null default 0,
  winner_user_id uuid references auth.users(id),
  result_reason text
    check (result_reason in ('checkmate', 'resignation', 'draw_agreed', 'stalemate',
                              'threefold', 'fifty_move', 'insufficient_material',
                              'timeout', 'aborted')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_move_at timestamptz,
  -- black can't be the same person as white, and a finished/aborted game
  -- must always carry a reason — cheap sanity backstops, not a substitute
  -- for the RPCs enforcing the real flow.
  constraint chess_games_distinct_players check (black_user_id is null or black_user_id <> white_user_id),
  constraint chess_games_result_reason_required
    check (status not in ('finished', 'aborted') or result_reason is not null)
);

create index if not exists idx_chess_games_status on public.chess_games (status, created_at desc);
create index if not exists idx_chess_games_white on public.chess_games (white_user_id);
create index if not exists idx_chess_games_black on public.chess_games (black_user_id);

alter table public.chess_games enable row level security;

-- Open games are the public lobby (anyone signed in can see what's
-- joinable); anything else is only visible to the two players in it.
-- No insert/update/delete policy at all — every write goes through the
-- SECURITY DEFINER RPCs below, same reasoning as ladder_cup_matches'
-- own direct-insert lockdown (see App.ladder-cup-rpc-fix.diff).
create policy "chess_games readable by participants or open lobby"
  on public.chess_games for select
  using (status = 'open' or auth.uid() in (white_user_id, black_user_id));

-- Realtime — board updates and the lobby list both need postgres_changes.
alter publication supabase_realtime add table public.chess_games;

-- ---------------------------------------------------------------------
-- create_chess_game — opens a lobby seat as white. Stake (if any) is
-- escrowed immediately so an open game always has its creator's stake
-- already committed, not charged only once someone joins.
create or replace function public.create_chess_game(p_stake_nets bigint default 0)
returns public.chess_games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_game public.chess_games;
begin
  if v_user is null then
    raise exception 'create_chess_game: must be signed in';
  end if;
  if p_stake_nets is null or p_stake_nets < 0 then
    raise exception 'create_chess_game: stake must be 0 or more';
  end if;

  insert into public.chess_games (created_by, white_user_id, stake_nets)
  values (v_user, v_user, p_stake_nets)
  returning * into v_game;

  if p_stake_nets > 0 then
    perform public._nets_debit_internal(v_user, p_stake_nets, 'chess_stake',
      'Chess — table stake', 'chess_game', v_game.id::text, null);
  end if;

  return v_game;
end;
$$;

grant execute on function public.create_chess_game(bigint) to authenticated;

-- ---------------------------------------------------------------------
-- join_chess_game — seats the caller as black and starts the game.
create or replace function public.join_chess_game(p_game_id uuid)
returns public.chess_games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_game public.chess_games;
begin
  if v_user is null then
    raise exception 'join_chess_game: must be signed in';
  end if;

  select * into v_game from public.chess_games where id = p_game_id for update;
  if not found then
    raise exception 'join_chess_game: game not found';
  end if;
  if v_game.status <> 'open' then
    raise exception 'join_chess_game: game is no longer open';
  end if;
  if v_game.white_user_id = v_user then
    raise exception 'join_chess_game: cannot join your own table';
  end if;

  if v_game.stake_nets > 0 then
    perform public._nets_debit_internal(v_user, v_game.stake_nets, 'chess_stake',
      'Chess — table stake', 'chess_game', p_game_id::text, null);
  end if;

  update public.chess_games
  set black_user_id = v_user, status = 'active', started_at = now(), last_move_at = now()
  where id = p_game_id
  returning * into v_game;

  return v_game;
end;
$$;

grant execute on function public.join_chess_game(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- cancel_chess_game — only while still open (nobody's joined and no
-- money but the creator's own stake is in play), creator only. Refunds
-- the creator's stake in full.
create or replace function public.cancel_chess_game(p_game_id uuid)
returns void
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
    raise exception 'cancel_chess_game: game not found';
  end if;
  if v_game.status <> 'open' then
    raise exception 'cancel_chess_game: game already started';
  end if;
  if v_game.created_by <> v_user then
    raise exception 'cancel_chess_game: not your table';
  end if;

  if v_game.stake_nets > 0 then
    perform public._nets_credit_internal(v_game.white_user_id, v_game.stake_nets, 'chess_stake_refund',
      'Chess — cancelled table refund', 'chess_game', p_game_id::text, null);
  end if;

  update public.chess_games
  set status = 'aborted', result_reason = 'aborted', finished_at = now()
  where id = p_game_id;
end;
$$;

grant execute on function public.cancel_chess_game(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- chess_submit_move — applies one already-legal (client-validated) move.
-- p_status/p_winner_user_id/p_result_reason are null for an ordinary
-- mid-game move; set together to close the game out (checkmate,
-- stalemate/draw, or any other chess.js-detected terminal state).
create or replace function public.chess_submit_move(
  p_game_id uuid,
  p_new_fen text,
  p_new_pgn text,
  p_status text default null,        -- null (still playing) or 'finished'
  p_winner_user_id uuid default null, -- null for a draw
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
  v_next_turn text;
  v_pot bigint;
begin
  select * into v_game from public.chess_games where id = p_game_id for update;
  if not found then
    raise exception 'chess_submit_move: game not found';
  end if;
  if v_game.status <> 'active' then
    raise exception 'chess_submit_move: game is not active';
  end if;
  if (v_game.turn = 'w' and v_user <> v_game.white_user_id)
     or (v_game.turn = 'b' and v_user <> v_game.black_user_id) then
    raise exception 'chess_submit_move: not your turn';
  end if;

  v_next_turn := case when v_game.turn = 'w' then 'b' else 'w' end;

  if p_status is null then
    update public.chess_games
    set fen = p_new_fen, pgn = p_new_pgn, turn = v_next_turn,
        move_count = move_count + 1, last_move_at = now()
    where id = p_game_id
    returning * into v_game;
    return v_game;
  end if;

  if p_status <> 'finished' then
    raise exception 'chess_submit_move: unexpected status %', p_status;
  end if;
  if p_winner_user_id is not null and p_winner_user_id not in (v_game.white_user_id, v_game.black_user_id) then
    raise exception 'chess_submit_move: winner must be one of the two players';
  end if;

  update public.chess_games
  set fen = p_new_fen, pgn = p_new_pgn, turn = v_next_turn, move_count = move_count + 1,
      status = 'finished', winner_user_id = p_winner_user_id, result_reason = p_result_reason,
      finished_at = now(), last_move_at = now()
  where id = p_game_id
  returning * into v_game;

  if v_game.stake_nets > 0 then
    if p_winner_user_id is not null then
      v_pot := v_game.stake_nets * 2;
      perform public._nets_credit_internal(p_winner_user_id, v_pot, 'chess_win',
        'Chess — won the table', 'chess_game', p_game_id::text, null);
    else
      -- Draw: refund both stakes, nobody's up or down.
      perform public._nets_credit_internal(v_game.white_user_id, v_game.stake_nets, 'chess_stake_refund',
        'Chess — draw, stake returned', 'chess_game', p_game_id::text, null);
      perform public._nets_credit_internal(v_game.black_user_id, v_game.stake_nets, 'chess_stake_refund',
        'Chess — draw, stake returned', 'chess_game', p_game_id::text, null);
    end if;
  end if;

  return v_game;
end;
$$;

grant execute on function public.chess_submit_move(uuid, text, text, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- resign_chess_game — either player quits; the other is credited the
-- pot (if staked) the same way a checkmate win is.
create or replace function public.resign_chess_game(p_game_id uuid)
returns public.chess_games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_game public.chess_games;
  v_winner uuid;
  v_pot bigint;
begin
  select * into v_game from public.chess_games where id = p_game_id for update;
  if not found then
    raise exception 'resign_chess_game: game not found';
  end if;
  if v_game.status <> 'active' then
    raise exception 'resign_chess_game: game is not active';
  end if;
  if v_user not in (v_game.white_user_id, v_game.black_user_id) then
    raise exception 'resign_chess_game: not your game';
  end if;

  v_winner := case when v_user = v_game.white_user_id then v_game.black_user_id else v_game.white_user_id end;

  update public.chess_games
  set status = 'finished', winner_user_id = v_winner, result_reason = 'resignation', finished_at = now()
  where id = p_game_id
  returning * into v_game;

  if v_game.stake_nets > 0 and v_winner is not null then
    v_pot := v_game.stake_nets * 2;
    perform public._nets_credit_internal(v_winner, v_pot, 'chess_win',
      'Chess — opponent resigned', 'chess_game', p_game_id::text, null);
  end if;

  return v_game;
end;
$$;

grant execute on function public.resign_chess_game(uuid) to authenticated;
