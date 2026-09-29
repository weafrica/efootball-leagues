-- League Ladder's own per-league comment wall — separate from `comments`
-- (used by regular leagues, FK'd to leagues(id)) and from `ladder_comments`
-- (the OLD 1v1 challenge Ladder's single global wall). Each League Ladder
-- tier (ladder_leagues row) gets its own thread here, scoped by league_id.
create table if not exists ladder_league_comments (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references ladder_leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text not null,
  body text not null default '',
  parent_comment_id uuid references ladder_league_comments(id) on delete cascade,
  voice_url text,
  voice_duration integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_league_comments_league on ladder_league_comments (league_id, created_at desc);
create index if not exists idx_ladder_league_comments_parent on ladder_league_comments (parent_comment_id);

alter table ladder_league_comments enable row level security;

-- Public read within the app — same convention as ladder_leagues_select.
drop policy if exists "ladder_league_comments_select" on ladder_league_comments;
create policy "ladder_league_comments_select" on ladder_league_comments for select
  to authenticated
  using (true);

-- Post only if you're the owner AND (an active member of that ladder
-- league OR an admin) — mirrors comments_insert's members-only rule for
-- regular leagues, using ladder_memberships instead of `members`.
drop policy if exists "ladder_league_comments_insert" on ladder_league_comments;
create policy "ladder_league_comments_insert" on ladder_league_comments for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and (
      exists (select 1 from ladder_memberships lm where lm.league_id = ladder_league_comments.league_id and lm.user_id = auth.uid() and lm.status = 'active')
      or exists (select 1 from admins a where a.user_id = auth.uid())
    )
  );

-- Delete: owner, or an admin (no "league creator" concept here — these
-- leagues are system-managed, not user-created).
drop policy if exists "ladder_league_comments_delete" on ladder_league_comments;
create policy "ladder_league_comments_delete" on ladder_league_comments for delete
  to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from admins a where a.user_id = auth.uid())
  );

-- Reactions on League Ladder comments — same shape as ladder_comment_likes.
create table if not exists ladder_league_comment_likes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references ladder_league_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);

create index if not exists idx_ladder_league_comment_likes_comment on ladder_league_comment_likes (comment_id);

alter table ladder_league_comment_likes enable row level security;

drop policy if exists "ladder_league_comment_likes_select" on ladder_league_comment_likes;
create policy "ladder_league_comment_likes_select" on ladder_league_comment_likes for select
  to authenticated
  using (true);

drop policy if exists "ladder_league_comment_likes_insert" on ladder_league_comment_likes;
create policy "ladder_league_comment_likes_insert" on ladder_league_comment_likes for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "ladder_league_comment_likes_update" on ladder_league_comment_likes;
create policy "ladder_league_comment_likes_update" on ladder_league_comment_likes for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "ladder_league_comment_likes_delete" on ladder_league_comment_likes;
create policy "ladder_league_comment_likes_delete" on ladder_league_comment_likes for delete
  to authenticated
  using (user_id = auth.uid());
