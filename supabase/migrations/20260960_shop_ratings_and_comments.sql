-- Shop: star ratings (1 to 5) and comments on products.
--
-- Comments copy Matchday's challenge-board comments: threaded replies
-- (parent_comment_id), emoji reactions, and delete by the author or an admin.
-- Anyone can read; posting, rating and reacting need a signed-in account.

-- ── Ratings: one per shopper per product ────────────────────────────────
create table if not exists public.shop_product_ratings (
  product_id uuid not null references public.shop_products(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, user_id)
);
alter table public.shop_product_ratings enable row level security;

drop policy if exists "ratings readable by everyone" on public.shop_product_ratings;
create policy "ratings readable by everyone" on public.shop_product_ratings for select using (true);
drop policy if exists "shoppers add their own rating" on public.shop_product_ratings;
create policy "shoppers add their own rating" on public.shop_product_ratings for insert with check (user_id = auth.uid());
drop policy if exists "shoppers change their own rating" on public.shop_product_ratings;
create policy "shoppers change their own rating" on public.shop_product_ratings for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "shoppers remove their own rating" on public.shop_product_ratings;
create policy "shoppers remove their own rating" on public.shop_product_ratings for delete
  using (user_id = auth.uid() or exists (select 1 from public.admins a where a.user_id = auth.uid()));

grant select on public.shop_product_ratings to anon, authenticated;
grant insert, update, delete on public.shop_product_ratings to authenticated;

-- Average and count per product, for the product cards.
create or replace view public.shop_product_rating_summary as
  select product_id, round(avg(rating)::numeric, 1) as rating_avg, count(*)::int as rating_count
  from public.shop_product_ratings group by product_id;
grant select on public.shop_product_rating_summary to anon, authenticated;

-- ── Comments ────────────────────────────────────────────────────────────
create table if not exists public.shop_product_comments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text not null,
  body text not null check (length(trim(body)) between 1 and 1000),
  parent_comment_id uuid references public.shop_product_comments(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists shop_product_comments_product_idx on public.shop_product_comments (product_id, created_at);
alter table public.shop_product_comments enable row level security;

drop policy if exists "shop comments readable by everyone" on public.shop_product_comments;
create policy "shop comments readable by everyone" on public.shop_product_comments for select using (true);
drop policy if exists "signed-in shoppers can comment" on public.shop_product_comments;
create policy "signed-in shoppers can comment" on public.shop_product_comments for insert with check (user_id = auth.uid());
drop policy if exists "authors and admins can delete shop comments" on public.shop_product_comments;
create policy "authors and admins can delete shop comments" on public.shop_product_comments for delete
  using (user_id = auth.uid() or exists (select 1 from public.admins a where a.user_id = auth.uid()));

create table if not exists public.shop_product_comment_likes (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.shop_product_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null default 'like',
  created_at timestamptz not null default now(),
  unique (comment_id, user_id)
);
alter table public.shop_product_comment_likes enable row level security;

drop policy if exists "shop reactions readable by everyone" on public.shop_product_comment_likes;
create policy "shop reactions readable by everyone" on public.shop_product_comment_likes for select using (true);
drop policy if exists "signed-in shoppers can react" on public.shop_product_comment_likes;
create policy "signed-in shoppers can react" on public.shop_product_comment_likes for insert with check (user_id = auth.uid());
drop policy if exists "shoppers change their own reaction" on public.shop_product_comment_likes;
create policy "shoppers change their own reaction" on public.shop_product_comment_likes for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "shoppers remove their own reaction" on public.shop_product_comment_likes;
create policy "shoppers remove their own reaction" on public.shop_product_comment_likes for delete using (user_id = auth.uid());

grant select on public.shop_product_comments, public.shop_product_comment_likes to anon, authenticated;
grant insert, update, delete on public.shop_product_comments, public.shop_product_comment_likes to authenticated;
