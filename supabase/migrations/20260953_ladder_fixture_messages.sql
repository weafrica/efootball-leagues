-- League Ladder — in-app messages on a fixture.
--
-- Lets the two players on a ladder_fixtures row message each other from the
-- fixture itself (arrange a time, chase a no-show, sort out a dispute)
-- without leaving the app. Mirrors challenge_messages, but keyed to a real
-- foreign key (ladder_fixtures.id) instead of a challenge_id/kind pair.
--
-- Access: only the home or away player of that fixture can read or send.
-- Senders can delete their own messages. Messages are removed automatically
-- if the fixture is (on delete cascade), e.g. when a league is deleted.
--
-- Scope: League Ladder (ladder_fixtures) only. cash_ladder_fixtures is a
-- separate table and is not covered here.
--
-- Safe to run more than once.

create table if not exists public.ladder_fixture_messages (
  id         uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.ladder_fixtures(id) on delete cascade,
  sender_id  uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_fixture_messages_fixture
  on public.ladder_fixture_messages (fixture_id, created_at);

alter table public.ladder_fixture_messages enable row level security;

drop policy if exists "fixture players can read messages" on public.ladder_fixture_messages;
create policy "fixture players can read messages"
  on public.ladder_fixture_messages for select
  using (
    exists (
      select 1 from public.ladder_fixtures f
      where f.id = ladder_fixture_messages.fixture_id
        and (f.home_user_id = (select auth.uid()) or f.away_user_id = (select auth.uid()))
    )
  );

drop policy if exists "fixture players can send messages" on public.ladder_fixture_messages;
create policy "fixture players can send messages"
  on public.ladder_fixture_messages for insert
  with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from public.ladder_fixtures f
      where f.id = ladder_fixture_messages.fixture_id
        and (f.home_user_id = (select auth.uid()) or f.away_user_id = (select auth.uid()))
    )
  );

drop policy if exists "senders can delete own fixture messages" on public.ladder_fixture_messages;
create policy "senders can delete own fixture messages"
  on public.ladder_fixture_messages for delete
  using (sender_id = (select auth.uid()));

-- Realtime, so a new message appears live on the other player's screen.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ladder_fixture_messages'
  ) then
    alter publication supabase_realtime add table public.ladder_fixture_messages;
  end if;
end $$;
