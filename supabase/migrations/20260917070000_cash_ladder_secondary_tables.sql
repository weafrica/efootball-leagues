-- cash_ladder_secondary_tables
-- Adds the 4 cash_ladder_* tables that didn't get created in the first pass:
-- comments, comment_likes, ranks, result_log. Structure + RLS mirror the
-- ladder_* originals exactly.

-- === cash_ladder_ranks (mirrors ladder_ranks) ===
create table cash_ladder_ranks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  username text not null,
  avatar_url text,
  rank_position integer not null unique,
  wins integer not null default 0,
  losses integer not null default 0,
  draws integer not null default 0,
  points integer not null default 0,
  challenges_paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_cash_ladder_ranks_user_id on cash_ladder_ranks (user_id);

-- === cash_ladder_comments (mirrors ladder_comments) ===
create table cash_ladder_comments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  username text not null,
  body text not null default '',
  parent_comment_id uuid references cash_ladder_comments(id) on delete cascade,
  voice_url text,
  voice_duration numeric,
  created_at timestamptz not null default now()
);
create index cash_ladder_comments_created_idx on cash_ladder_comments (created_at);
create index cash_ladder_comments_parent_idx on cash_ladder_comments (parent_comment_id);

-- === cash_ladder_comment_likes (mirrors ladder_comment_likes) ===
create table cash_ladder_comment_likes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references cash_ladder_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);
create index cash_ladder_comment_likes_comment_idx on cash_ladder_comment_likes (comment_id);

-- === cash_ladder_result_log (mirrors ladder_result_log) ===
create table cash_ladder_result_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null check (source = any (array['challenge','fixture','open_challenge'])),
  source_id uuid not null,
  user_a uuid,
  user_b uuid,
  score_a integer,
  score_b integer,
  points_a integer,
  points_b integer,
  applied boolean not null,
  reason text not null check (reason = any (array['applied','missing_user','not_on_ladder','gap_too_large','pair_cooldown']))
);
create index cash_ladder_result_log_source_idx on cash_ladder_result_log (source, source_id, created_at desc);
create index cash_ladder_result_log_pair_idx on cash_ladder_result_log (least(user_a, user_b), greatest(user_a, user_b), created_at desc) where (applied = true);

-- === RLS ===
alter table cash_ladder_ranks enable row level security;
alter table cash_ladder_comments enable row level security;
alter table cash_ladder_comment_likes enable row level security;
alter table cash_ladder_result_log enable row level security;

create policy "cash_ladder read (signed in)" on cash_ladder_ranks
  for select to authenticated using (true);

create policy cash_ladder_comments_select on cash_ladder_comments
  for select to authenticated using (true);
create policy cash_ladder_comments_insert on cash_ladder_comments
  for insert to authenticated with check (user_id = auth.uid());
create policy cash_ladder_comments_delete on cash_ladder_comments
  for delete to authenticated using (
    user_id = auth.uid() or exists (select 1 from admins a where a.user_id = auth.uid())
  );

create policy cash_ladder_comment_likes_select on cash_ladder_comment_likes
  for select to authenticated using (true);
create policy cash_ladder_comment_likes_insert on cash_ladder_comment_likes
  for insert to authenticated with check (user_id = auth.uid());
create policy cash_ladder_comment_likes_update on cash_ladder_comment_likes
  for update to authenticated using (user_id = auth.uid());
create policy cash_ladder_comment_likes_delete on cash_ladder_comment_likes
  for delete to authenticated using (user_id = auth.uid());

create policy cash_ladder_result_log_select on cash_ladder_result_log
  for select to authenticated using (true);
