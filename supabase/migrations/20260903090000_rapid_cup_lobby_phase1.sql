-- Rapid Cup — Phase 1: Lobby & Auto-Start
-- Self-contained lobby tables. Does NOT touch existing leagues/fixtures
-- tables — those get wired in once we confirm their column shapes
-- (see the TODO near the bottom of this file and doGenerateFixtures /
-- knockoutBracketFixtures in src/App.jsx for the existing pattern to
-- mirror).

create table if not exists rapid_cup_lobbies (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'open' check (status in ('open', 'filling', 'live', 'completed', 'expired')),
  created_at timestamptz not null default now(),
  -- 1hr fill window; lobby auto-expires if not full by this time
  reset_at timestamptz not null default (now() + interval '1 hour'),
  started_at timestamptz,
  -- set once fixtures exist for this lobby's 4 players — the client
  -- watches for this to know when to redirect everyone in
  league_id uuid,
  -- points at the lobby auto-created to replace this one once it fills
  next_lobby_id uuid references rapid_cup_lobbies(id)
);

create table if not exists rapid_cup_lobby_players (
  id uuid primary key default gen_random_uuid(),
  lobby_id uuid not null references rapid_cup_lobbies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_fee numeric not null default 0 check (entry_fee >= 0 and entry_fee <= 400),
  joined_at timestamptz not null default now(),
  unique (lobby_id, user_id)
);

create index if not exists idx_rapid_cup_lobbies_status_reset on rapid_cup_lobbies (status, reset_at);
create index if not exists idx_rapid_cup_lobby_players_lobby on rapid_cup_lobby_players (lobby_id);

alter table rapid_cup_lobbies enable row level security;
alter table rapid_cup_lobby_players enable row level security;

create policy "rapid_cup_lobbies readable by all signed-in users"
  on rapid_cup_lobbies for select
  using (auth.role() = 'authenticated');

create policy "rapid_cup_lobby_players readable by all signed-in users"
  on rapid_cup_lobby_players for select
  using (auth.role() = 'authenticated');

-- Writes only happen through the RPCs below (security definer), so no
-- direct insert/update policies are granted to regular users.

-- join_rapid_cup_lobby — finds (or creates) the current open lobby,
-- seats the caller with their chosen entry fee, and if that's the 4th
-- player: flips the lobby to "filling" (fixture generation happens
-- client-side next, see TODO) and immediately opens the next lobby so
-- there's never a dead moment.
create or replace function join_rapid_cup_lobby(p_entry_fee numeric default 0)
returns rapid_cup_lobbies
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lobby rapid_cup_lobbies;
  v_next_lobby rapid_cup_lobbies;
  v_player_count int;
begin
  if p_entry_fee < 0 or p_entry_fee > 400 then
    raise exception 'Entry fee must be between 0 and 400 Nets';
  end if;

  -- Find the current open, not-yet-expired lobby; create one if none exists.
  select * into v_lobby
  from rapid_cup_lobbies
  where status = 'open' and reset_at > now()
  order by created_at asc
  limit 1
  for update skip locked;

  if v_lobby.id is null then
    insert into rapid_cup_lobbies default values returning * into v_lobby;
  end if;

  -- Seat the player (idempotent — re-calling just returns the same lobby).
  insert into rapid_cup_lobby_players (lobby_id, user_id, entry_fee)
  values (v_lobby.id, auth.uid(), p_entry_fee)
  on conflict (lobby_id, user_id) do nothing;

  select count(*) into v_player_count
  from rapid_cup_lobby_players
  where lobby_id = v_lobby.id;

  if v_player_count >= 4 and v_lobby.status = 'open' then
    -- Auto-chain: open the next lobby immediately so it's never dead.
    insert into rapid_cup_lobbies default values returning * into v_next_lobby;

    update rapid_cup_lobbies
    set status = 'filling', started_at = now(), next_lobby_id = v_next_lobby.id
    where id = v_lobby.id
    returning * into v_lobby;
  end if;

  return v_lobby;
end;
$$;

-- expire_rapid_cup_lobbies — call this from a scheduled cron (e.g.
-- pg_cron every minute, or a Vercel cron hitting an edge function that
-- calls this RPC). Expires any lobby past its 1hr window that never
-- filled, and makes sure a fresh open lobby always exists afterward.
create or replace function expire_rapid_cup_lobbies()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open_count int;
begin
  update rapid_cup_lobbies
  set status = 'expired'
  where status = 'open' and reset_at <= now();

  select count(*) into v_open_count
  from rapid_cup_lobbies
  where status = 'open' and reset_at > now();

  if v_open_count = 0 then
    insert into rapid_cup_lobbies default values;
  end if;
end;
$$;

grant execute on function join_rapid_cup_lobby(numeric) to authenticated;
grant execute on function expire_rapid_cup_lobbies() to authenticated;

-- TODO before Phase 1 is fully wired end-to-end:
-- Once a lobby flips to 'filling' (4th player joined), the client needs
-- to actually generate the knockout bracket and set league_id + flip
-- status to 'live'. That reuses knockoutBracketFixtures() / the
-- doGenerateFixtures() pattern already in src/App.jsx — but plugging it
-- in needs the real column names on your `leagues` and `fixtures`
-- tables, which aren't in a tracked migration I could find. Send me
-- those two table shapes (or `\d leagues` / `\d fixtures` output) and
-- I'll write generateRapidCupFixtures(lobby) to match exactly, plus the
-- "first client in wins the race" claim logic so only one browser
-- generates the bracket.
