-- Baseline schema — captures pre-migration-era manual schema changes.
--
-- CONTEXT: everything in this file already exists live in production
-- (project "weafrica Leagues") and predates this repo's migration
-- history. It was built by hand through the Supabase SQL editor /
-- table editor before `supabase/migrations/` existed, so `supabase test
-- db` (which always starts from an empty database) has never been able
-- to get past `20260811_ladder_cup.sql`, which already assumes
-- `leagues`/`teams` exist. This file is a straight capture of what's
-- actually running today, pulled via SQL introspection
-- (information_schema / pg_constraint / pg_indexes / pg_policies /
-- pg_get_functiondef / pg_get_triggerdef) against production on
-- 2026-09-05, not a redesign — it changes no behavior.
--
-- Dated before 20260811_ladder_cup.sql (the earliest real migration) so
-- it always runs first. See BASELINE-SCHEMA-MIGRATION-PLAN.md and
-- BASELINE-INVENTORY.md for how this list was produced and verified.
--
-- NOT included here (see 20260811_ladder_cup_second_life_offers_baseline.sql
-- instead): `ladder_cup_second_life_offers` and the
-- `comments.ladder_cup_match_id` foreign key. Both reference tables
-- (`ladder_cup_entries`, `ladder_cup_matches`) that are only created by
-- 20260811_ladder_cup.sql itself, which runs *after* this file — putting
-- them here would make this migration fail on a fresh database. This is
-- a real ordering constraint, not an oversight; confirmed independently
-- against the actual FK graph, not just carried over from an earlier
-- pass's notes.
--
-- Safe to run more than once (if not exists / or replace throughout).

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Extensions relied on but never explicitly created locally.
-- `plpgsql` and `pg_cron` are already handled (built-in / already
-- migrated elsewhere) and are not repeated here. `supabase_vault` is a
-- platform-managed extension (lives in its own `vault` schema, tied to
-- Supabase-managed secrets) — it is NOT created by this file; it's
-- provisioned by Supabase itself on every project. The other four are
-- commonly pre-installed on new Supabase projects too, but are declared
-- here (idempotently) since this repo relies on them and previously had
-- no record of that reliance at all.
-- ─────────────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Tables (bare columns only — constraints added in section 2, after
-- every table exists, because `leagues` and `teams` reference each other
-- circularly: teams.league_id -> leagues.id, and
-- leagues.ladder_cup_champion_team_id -> teams.id).
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists public.admins (
  user_id uuid not null
);

create table if not exists public.leagues (
  id uuid default gen_random_uuid() not null,
  name text not null,
  created_by uuid,
  created_at timestamptz default now(),
  format text default 'double_round_robin'::text not null,
  survivor_matches_per_stage int4,
  survivor_elimination_percent int4,
  survivor_target_count int4,
  survivor_final_format text,
  current_stage int4 default 1 not null,
  final_stage_started bool default false not null,
  entry_closes_at timestamptz,
  starts_at timestamptz,
  photo_url text,
  description text,
  groups_count int4,
  group_qualifiers int4,
  league_type text default 'fun'::text not null,
  knockout_legs int4 default 1 not null,
  group_size int4 default 4 not null,
  round_period_hours int4 default 48,
  group_stage_due_at timestamptz,
  created_by_admin bool default false,
  wa_message_template text,
  creator_phone text,
  ladder_cup_cutoff_at timestamptz,
  ladder_cup_finalized_at timestamptz,
  ladder_cup_champion_team_id uuid,
  ladder_cup_started_at timestamptz,
  prizes_paid_at timestamptz,
  ladder_cup_prizes_paid_at timestamptz
);

create table if not exists public.teams (
  id uuid default gen_random_uuid() not null,
  league_id uuid,
  name text not null,
  phone text,
  eliminated bool default false not null,
  group_number int4
);

create table if not exists public.app_settings (
  id int2 not null,
  weekend_league_override text,
  weekend_league_override_at timestamptz,
  weekend_league_override_by uuid,
  accounts_wa_message_template text
);

create table if not exists public.members (
  id uuid default gen_random_uuid() not null,
  league_id uuid,
  user_id uuid,
  display_name text not null,
  phone text,
  joined_at timestamptz default now(),
  team_id uuid,
  entry_fee int4,
  payment_status text,
  payment_proof_path text,
  payment_reviewed_at timestamptz,
  payment_reviewed_by uuid,
  wa_reminder_due_at timestamptz
);

create table if not exists public.profiles (
  user_id uuid not null,
  phone text not null,
  efootball_username text not null,
  created_at timestamptz default now(),
  avatar_url text,
  approved bool default false not null,
  age int4,
  wa_reminder_due_at timestamptz,
  timezone text,
  country_code text
);

create table if not exists public.fixtures (
  id uuid default gen_random_uuid() not null,
  league_id uuid,
  round int4 not null,
  home_team_id uuid,
  away_team_id uuid,
  played bool default false,
  home_score int4 default 0,
  away_score int4 default 0,
  stage int4 default 1 not null,
  due_at timestamptz,
  leg int4 default 1 not null,
  played_at timestamptz,
  ladder_points_home_at_report int4,
  ladder_points_away_at_report int4,
  pens_home int4,
  pens_away int4,
  starts_at timestamptz,
  contact_made_at timestamptz
);

create table if not exists public.comments (
  id uuid default gen_random_uuid() not null,
  league_id uuid not null,
  user_id uuid not null,
  username text not null,
  body text not null,
  created_at timestamptz default now() not null,
  parent_comment_id uuid,
  photo_url text,
  is_result bool default false not null,
  voice_url text,
  voice_duration int4,
  fixture_id uuid,
  ladder_cup_match_id uuid
);

create table if not exists public.comment_likes (
  id uuid default gen_random_uuid() not null,
  comment_id uuid not null,
  user_id uuid not null,
  created_at timestamptz default now() not null,
  reaction text default 'like'::text not null
);

create table if not exists public.challenges (
  id uuid default gen_random_uuid() not null,
  challenger_id uuid not null,
  challenger_username text not null,
  challenger_phone text not null,
  opponent_id uuid not null,
  opponent_username text not null,
  opponent_phone text,
  status text default 'pending'::text not null,
  created_at timestamptz default now() not null,
  responded_at timestamptz,
  challenger_score int4,
  opponent_score int4,
  result_status text,
  result_reported_by uuid,
  result_reported_at timestamptz,
  result_confirmed_at timestamptz,
  result_photo_path text,
  is_ladder bool default false not null,
  ladder_expiry text,
  auto_verified bool,
  ladder_points_challenger_at_send int4,
  ladder_points_opponent_at_send int4,
  result_photo_url text
);

create table if not exists public.open_challenges (
  id uuid default gen_random_uuid() not null,
  creator_id uuid not null,
  creator_username text not null,
  creator_phone text not null,
  status text default 'open'::text not null,
  accepted_by uuid,
  accepted_by_username text,
  accepted_by_phone text,
  created_at timestamptz default now() not null,
  accepted_at timestamptz,
  creator_score int4,
  accepted_by_score int4,
  result_photo_url text,
  result_submitted_by uuid,
  played_at timestamptz,
  result_status text,
  result_reported_by uuid,
  result_reported_at timestamptz,
  result_confirmed_at timestamptz,
  result_photo_path text,
  auto_verified bool,
  ladder_points_creator_at_send int4,
  ladder_points_accepted_by_at_send int4
);

create table if not exists public.challenge_messages (
  id uuid default gen_random_uuid() not null,
  challenge_id uuid not null,
  challenge_kind text not null,
  sender_id uuid not null,
  body text not null,
  created_at timestamptz default now() not null
);

create table if not exists public.challenge_board_comments (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  username text not null,
  body text not null,
  created_at timestamptz default now() not null,
  parent_comment_id uuid,
  voice_url text,
  voice_duration int4
);

create table if not exists public.challenge_board_comment_likes (
  id uuid default gen_random_uuid() not null,
  comment_id uuid not null,
  user_id uuid not null,
  reaction text not null,
  created_at timestamptz default now() not null
);

create table if not exists public.ladder_comments (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  username text not null,
  body text default ''::text not null,
  parent_comment_id uuid,
  voice_url text,
  voice_duration numeric,
  created_at timestamptz default now() not null
);

create table if not exists public.ladder_comment_likes (
  id uuid default gen_random_uuid() not null,
  comment_id uuid not null,
  user_id uuid not null,
  reaction text not null,
  created_at timestamptz default now() not null
);

create table if not exists public.result_submissions (
  id uuid default gen_random_uuid() not null,
  league_id uuid not null,
  fixture_id uuid not null,
  submitted_by uuid not null,
  submitted_by_username text not null,
  home_score int4 not null,
  away_score int4 not null,
  photo_path text not null,
  status text default 'pending'::text not null,
  review_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz default now() not null,
  ladder_points_home_at_report int4,
  ladder_points_away_at_report int4,
  pens_home int4,
  pens_away int4
);

create table if not exists public.suggestions (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  username text,
  body text not null,
  created_at timestamptz default now() not null
);

create table if not exists public.league_reactions (
  id uuid default gen_random_uuid() not null,
  league_id uuid not null,
  user_id uuid not null,
  reaction text not null,
  created_at timestamptz default now() not null
);

create table if not exists public.achievements (
  user_id uuid not null,
  achievement_id text not null,
  earned_at timestamptz default now() not null
);

create table if not exists public.balances (
  user_id uuid not null,
  amount numeric default 0 not null
);

create table if not exists public.transactions (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  reference text not null,
  amount numeric not null,
  status text default 'pending'::text not null,
  created_at timestamptz default now()
);

create table if not exists public.shop_departments (
  id uuid default gen_random_uuid() not null,
  name text not null,
  position int4 default 0 not null,
  created_at timestamptz default now() not null
);

create table if not exists public.shop_categories (
  id uuid default gen_random_uuid() not null,
  department_id uuid not null,
  name text not null,
  position int4 default 0 not null,
  created_at timestamptz default now() not null,
  parent_category_id uuid
);

create table if not exists public.shop_products (
  id uuid default gen_random_uuid() not null,
  name text not null,
  description text,
  price numeric(10,2) not null,
  image_url text,
  stock_qty int4 default 0 not null,
  active bool default true not null,
  created_by uuid,
  created_at timestamptz default now() not null,
  department_id uuid,
  category_id uuid
);

create table if not exists public.shop_orders (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  buyer_username text,
  buyer_phone text,
  checkout_method text not null,
  status text default 'pending_review'::text not null,
  subtotal numeric(10,2) not null,
  contact_phone text,
  delivery_note text,
  payment_proof_path text,
  gateway_reference text,
  admin_reviewed_by uuid,
  admin_reviewed_at timestamptz,
  created_at timestamptz default now() not null
);

create table if not exists public.shop_order_items (
  id uuid default gen_random_uuid() not null,
  order_id uuid not null,
  product_id uuid,
  product_name text not null,
  unit_price numeric(10,2) not null,
  qty int4 not null
);

create table if not exists public.ladder_result_log (
  id uuid default gen_random_uuid() not null,
  created_at timestamptz default now() not null,
  source text not null,
  source_id uuid not null,
  user_a uuid,
  user_b uuid,
  score_a int4,
  score_b int4,
  points_a int4,
  points_b int4,
  applied bool not null,
  reason text not null
);

create table if not exists public.ladder_reward_payout_queue (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  amount int8 not null,
  reason text not null,
  ref_type text,
  ref_id text,
  status text default 'pending'::text not null,
  queued_at timestamptz default now() not null,
  paid_at timestamptz
);

create table if not exists public.ladder_cup_pool_sightings (
  id uuid default gen_random_uuid() not null,
  league_id uuid not null,
  team_id uuid not null,
  opponent_team_id uuid not null,
  first_seen_at timestamptz default now() not null,
  contacted_at timestamptz
);

create table if not exists public.nets_daily_login_claims (
  user_id uuid not null,
  claim_date date not null,
  created_at timestamptz default now() not null
);

-- ─────────────────────────────────────────────────────────────────────────
-- 2a. Primary keys / unique constraints (must exist before any FK below
-- can reference them).
-- ─────────────────────────────────────────────────────────────────────────
alter table public.achievements add constraint achievements_pkey primary key (user_id, achievement_id);
alter table public.admins add constraint admins_pkey primary key (user_id);
alter table public.app_settings add constraint app_settings_pkey primary key (id);
alter table public.balances add constraint balances_pkey primary key (user_id);
alter table public.challenge_board_comment_likes add constraint challenge_board_comment_likes_pkey primary key (id);
alter table public.challenge_board_comment_likes add constraint challenge_board_comment_likes_comment_id_user_id_key unique (comment_id, user_id);
alter table public.challenge_board_comments add constraint challenge_board_comments_pkey primary key (id);
alter table public.challenge_messages add constraint challenge_messages_pkey primary key (id);
alter table public.challenges add constraint challenges_pkey primary key (id);
alter table public.comment_likes add constraint comment_likes_pkey primary key (id);
alter table public.comment_likes add constraint comment_likes_comment_id_user_id_key unique (comment_id, user_id);
alter table public.comments add constraint comments_pkey primary key (id);
alter table public.fixtures add constraint fixtures_pkey primary key (id);
alter table public.ladder_comment_likes add constraint ladder_comment_likes_pkey primary key (id);
alter table public.ladder_comment_likes add constraint ladder_comment_likes_comment_id_user_id_key unique (comment_id, user_id);
alter table public.ladder_comments add constraint ladder_comments_pkey primary key (id);
alter table public.ladder_cup_pool_sightings add constraint ladder_cup_pool_sightings_pkey primary key (id);
alter table public.ladder_cup_pool_sightings add constraint ladder_cup_pool_sightings_league_id_team_id_opponent_team_i_key unique (league_id, team_id, opponent_team_id);
alter table public.ladder_result_log add constraint ladder_result_log_pkey primary key (id);
alter table public.ladder_reward_payout_queue add constraint ladder_reward_payout_queue_pkey primary key (id);
alter table public.ladder_reward_payout_queue add constraint ladder_reward_payout_queue_reason_ref_type_ref_id_user_id_key unique (reason, ref_type, ref_id, user_id);
alter table public.league_reactions add constraint league_reactions_pkey primary key (id);
alter table public.league_reactions add constraint league_reactions_league_id_user_id_key unique (league_id, user_id);
alter table public.leagues add constraint leagues_pkey primary key (id);
alter table public.members add constraint members_pkey primary key (id);
alter table public.nets_daily_login_claims add constraint nets_daily_login_claims_pkey primary key (user_id, claim_date);
alter table public.open_challenges add constraint open_challenges_pkey primary key (id);
alter table public.profiles add constraint profiles_pkey primary key (user_id);
alter table public.result_submissions add constraint result_submissions_pkey primary key (id);
alter table public.shop_categories add constraint shop_categories_pkey primary key (id);
alter table public.shop_departments add constraint shop_departments_pkey primary key (id);
alter table public.shop_order_items add constraint shop_order_items_pkey primary key (id);
alter table public.shop_orders add constraint shop_orders_pkey primary key (id);
alter table public.shop_products add constraint shop_products_pkey primary key (id);
alter table public.suggestions add constraint suggestions_pkey primary key (id);
alter table public.teams add constraint teams_pkey primary key (id);
alter table public.transactions add constraint transactions_pkey primary key (id);
alter table public.transactions add constraint transactions_reference_key unique (reference);

-- ─────────────────────────────────────────────────────────────────────────
-- 2b. Foreign keys.
-- Excluded on purpose: comments_ladder_cup_match_id_fkey (references
-- ladder_cup_matches, created after this file — see
-- 20260811_ladder_cup_second_life_offers_baseline.sql).
-- ─────────────────────────────────────────────────────────────────────────
alter table public.achievements add constraint achievements_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.admins add constraint admins_user_id_fkey foreign key (user_id) references auth.users(id);
alter table public.app_settings add constraint app_settings_weekend_league_override_by_fkey foreign key (weekend_league_override_by) references auth.users(id);
alter table public.balances add constraint balances_user_id_fkey foreign key (user_id) references auth.users(id);
alter table public.challenge_board_comment_likes add constraint challenge_board_comment_likes_comment_id_fkey foreign key (comment_id) references challenge_board_comments(id) on delete cascade;
alter table public.challenge_board_comment_likes add constraint challenge_board_comment_likes_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.challenge_board_comments add constraint challenge_board_comments_parent_comment_id_fkey foreign key (parent_comment_id) references challenge_board_comments(id) on delete cascade;
alter table public.challenge_board_comments add constraint challenge_board_comments_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.challenge_messages add constraint challenge_messages_sender_id_fkey foreign key (sender_id) references auth.users(id) on delete cascade;
alter table public.challenges add constraint challenges_challenger_id_fkey foreign key (challenger_id) references auth.users(id) on delete cascade;
alter table public.challenges add constraint challenges_opponent_id_fkey foreign key (opponent_id) references auth.users(id) on delete cascade;
alter table public.challenges add constraint challenges_result_reported_by_fkey foreign key (result_reported_by) references auth.users(id);
alter table public.comment_likes add constraint comment_likes_comment_id_fkey foreign key (comment_id) references comments(id) on delete cascade;
alter table public.comment_likes add constraint comment_likes_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.comments add constraint comments_fixture_id_fkey foreign key (fixture_id) references fixtures(id) on delete set null;
alter table public.comments add constraint comments_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.comments add constraint comments_parent_comment_id_fkey foreign key (parent_comment_id) references comments(id) on delete cascade;
alter table public.comments add constraint comments_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.fixtures add constraint fixtures_away_team_id_fkey foreign key (away_team_id) references teams(id);
alter table public.fixtures add constraint fixtures_home_team_id_fkey foreign key (home_team_id) references teams(id);
alter table public.fixtures add constraint fixtures_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.ladder_comment_likes add constraint ladder_comment_likes_comment_id_fkey foreign key (comment_id) references ladder_comments(id) on delete cascade;
alter table public.ladder_comment_likes add constraint ladder_comment_likes_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.ladder_comments add constraint ladder_comments_parent_comment_id_fkey foreign key (parent_comment_id) references ladder_comments(id) on delete cascade;
alter table public.ladder_comments add constraint ladder_comments_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.ladder_cup_pool_sightings add constraint ladder_cup_pool_sightings_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.ladder_cup_pool_sightings add constraint ladder_cup_pool_sightings_opponent_team_id_fkey foreign key (opponent_team_id) references teams(id) on delete cascade;
alter table public.ladder_cup_pool_sightings add constraint ladder_cup_pool_sightings_team_id_fkey foreign key (team_id) references teams(id) on delete cascade;
alter table public.ladder_reward_payout_queue add constraint ladder_reward_payout_queue_user_id_fkey foreign key (user_id) references auth.users(id);
alter table public.league_reactions add constraint league_reactions_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.league_reactions add constraint league_reactions_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.leagues add constraint leagues_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.leagues add constraint leagues_ladder_cup_champion_team_id_fkey foreign key (ladder_cup_champion_team_id) references teams(id);
alter table public.members add constraint members_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.members add constraint members_payment_reviewed_by_fkey foreign key (payment_reviewed_by) references auth.users(id);
alter table public.members add constraint members_team_id_fkey foreign key (team_id) references teams(id);
alter table public.members add constraint members_user_id_fkey foreign key (user_id) references auth.users(id);
alter table public.nets_daily_login_claims add constraint nets_daily_login_claims_user_id_fkey foreign key (user_id) references auth.users(id);
alter table public.open_challenges add constraint open_challenges_accepted_by_fkey foreign key (accepted_by) references auth.users(id) on delete set null;
alter table public.open_challenges add constraint open_challenges_creator_id_fkey foreign key (creator_id) references auth.users(id) on delete cascade;
alter table public.open_challenges add constraint open_challenges_result_reported_by_fkey foreign key (result_reported_by) references auth.users(id);
alter table public.open_challenges add constraint open_challenges_result_submitted_by_fkey foreign key (result_submitted_by) references auth.users(id);
alter table public.profiles add constraint profiles_user_id_fkey foreign key (user_id) references auth.users(id);
alter table public.result_submissions add constraint result_submissions_fixture_id_fkey foreign key (fixture_id) references fixtures(id) on delete cascade;
alter table public.result_submissions add constraint result_submissions_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.result_submissions add constraint result_submissions_reviewed_by_fkey foreign key (reviewed_by) references auth.users(id);
alter table public.result_submissions add constraint result_submissions_submitted_by_fkey foreign key (submitted_by) references auth.users(id) on delete cascade;
alter table public.shop_categories add constraint shop_categories_department_id_fkey foreign key (department_id) references shop_departments(id) on delete cascade;
alter table public.shop_categories add constraint shop_categories_parent_category_id_fkey foreign key (parent_category_id) references shop_categories(id) on delete cascade;
alter table public.shop_order_items add constraint shop_order_items_order_id_fkey foreign key (order_id) references shop_orders(id) on delete cascade;
alter table public.shop_order_items add constraint shop_order_items_product_id_fkey foreign key (product_id) references shop_products(id) on delete set null;
alter table public.shop_orders add constraint shop_orders_admin_reviewed_by_fkey foreign key (admin_reviewed_by) references auth.users(id);
alter table public.shop_orders add constraint shop_orders_user_id_fkey foreign key (user_id) references auth.users(id);
alter table public.shop_products add constraint shop_products_category_id_fkey foreign key (category_id) references shop_categories(id) on delete set null;
alter table public.shop_products add constraint shop_products_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.shop_products add constraint shop_products_department_id_fkey foreign key (department_id) references shop_departments(id) on delete set null;
alter table public.suggestions add constraint suggestions_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.teams add constraint teams_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.transactions add constraint transactions_user_id_fkey foreign key (user_id) references auth.users(id);

-- ─────────────────────────────────────────────────────────────────────────
-- 2c. Check constraints.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.app_settings add constraint app_settings_weekend_league_override_check check ((weekend_league_override = any (array['paused'::text, 'live'::text])));
alter table public.challenge_board_comments add constraint challenge_board_comments_body_check check (((char_length(trim(both from body)) > 0) or (voice_url is not null)));
alter table public.challenge_messages add constraint challenge_messages_body_check check (((char_length(trim(both from body)) > 0) and (char_length(body) <= 1000)));
alter table public.challenge_messages add constraint challenge_messages_challenge_kind_check check ((challenge_kind = any (array['direct'::text, 'open'::text])));
alter table public.challenges add constraint challenges_not_self check ((challenger_id <> opponent_id));
alter table public.challenges add constraint challenges_result_status_check check ((result_status = any (array['pending'::text, 'confirmed'::text])));
alter table public.challenges add constraint challenges_status_check check ((status = any (array['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text])));
alter table public.comment_likes add constraint comment_likes_reaction_check check ((reaction = any (array['like'::text, 'love'::text, 'laugh'::text, 'fire'::text, 'wow'::text, 'skull'::text])));
alter table public.comments add constraint comments_body_check check (((char_length(trim(both from body)) > 0) or (voice_url is not null) or (photo_url is not null)));
alter table public.ladder_result_log add constraint ladder_result_log_reason_check check ((reason = any (array['applied'::text, 'missing_user'::text, 'not_on_ladder'::text, 'gap_too_large'::text, 'pair_cooldown'::text])));
alter table public.ladder_result_log add constraint ladder_result_log_source_check check ((source = any (array['challenge'::text, 'fixture'::text, 'open_challenge'::text])));
alter table public.ladder_reward_payout_queue add constraint ladder_reward_payout_queue_amount_check check ((amount > 0));
alter table public.ladder_reward_payout_queue add constraint ladder_reward_payout_queue_status_check check ((status = any (array['pending'::text, 'paid'::text, 'cancelled'::text])));
alter table public.leagues add constraint leagues_league_type_check check ((league_type = any (array['fun'::text, 'cash'::text])));
alter table public.members add constraint members_entry_fee_range check (((entry_fee is null) or ((entry_fee >= 10) and (entry_fee <= 200))));
alter table public.members add constraint members_payment_status_check check (((payment_status is null) or (payment_status = any (array['pending'::text, 'approved'::text, 'rejected'::text]))));
alter table public.open_challenges add constraint open_challenges_result_status_check check ((result_status = any (array['pending'::text, 'confirmed'::text])));
alter table public.open_challenges add constraint open_challenges_status_check check ((status = any (array['open'::text, 'accepted'::text, 'cancelled'::text, 'played'::text])));
alter table public.result_submissions add constraint result_submissions_away_score_check check ((away_score >= 0));
alter table public.result_submissions add constraint result_submissions_home_score_check check ((home_score >= 0));
alter table public.result_submissions add constraint result_submissions_status_check check ((status = any (array['pending'::text, 'approved'::text, 'rejected'::text])));
alter table public.shop_order_items add constraint shop_order_items_qty_check check ((qty > 0));
alter table public.shop_orders add constraint shop_orders_checkout_method_check check ((checkout_method = any (array['manual_proof'::text, 'gateway'::text, 'whatsapp'::text])));
alter table public.shop_orders add constraint shop_orders_status_check check ((status = any (array['pending_review'::text, 'paid'::text, 'rejected'::text, 'whatsapp_sent'::text, 'fulfilled'::text, 'cancelled'::text])));
alter table public.shop_products add constraint shop_products_price_check check ((price >= (0)::numeric));
alter table public.shop_products add constraint shop_products_stock_qty_check check ((stock_qty >= 0));

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Indexes (non-constraint-backed only; PK/UNIQUE indexes above already
-- created their own).
-- ─────────────────────────────────────────────────────────────────────────
create index if not exists achievements_user_id_idx on public.achievements using btree (user_id);
create index if not exists challenge_board_comments_parent_comment_id_idx on public.challenge_board_comments using btree (parent_comment_id);
create index if not exists challenge_messages_thread_idx on public.challenge_messages using btree (challenge_kind, challenge_id, created_at);
create index if not exists idx_challenges_challenger_id on public.challenges using btree (challenger_id);
create index if not exists idx_challenges_ladder_confirmed on public.challenges using btree (is_ladder, result_status);
create index if not exists idx_challenges_opponent_id on public.challenges using btree (opponent_id);
create index if not exists comment_likes_comment_id_idx on public.comment_likes using btree (comment_id);
create index if not exists idx_comment_likes_comment_id on public.comment_likes using btree (comment_id);
create index if not exists comments_league_id_created_at_idx on public.comments using btree (league_id, created_at);
create index if not exists comments_parent_comment_id_idx on public.comments using btree (parent_comment_id);
create index if not exists idx_comments_ladder_cup_match on public.comments using btree (ladder_cup_match_id);
create index if not exists idx_comments_league_id on public.comments using btree (league_id);
create index if not exists idx_fixtures_league_id on public.fixtures using btree (league_id);
create index if not exists ladder_comment_likes_comment_idx on public.ladder_comment_likes using btree (comment_id);
create index if not exists ladder_comments_created_idx on public.ladder_comments using btree (created_at);
create index if not exists ladder_comments_parent_idx on public.ladder_comments using btree (parent_comment_id);
create index if not exists ladder_cup_pool_sightings_team_idx on public.ladder_cup_pool_sightings using btree (league_id, team_id);
create index if not exists ladder_result_log_pair_idx on public.ladder_result_log using btree (LEAST(user_a, user_b), GREATEST(user_a, user_b), created_at desc) where (applied = true);
create index if not exists ladder_result_log_source_idx on public.ladder_result_log using btree (source, source_id, created_at desc);
create index if not exists idx_league_reactions_league_id on public.league_reactions using btree (league_id);
create index if not exists idx_members_league_id on public.members using btree (league_id);
create unique index if not exists members_league_id_user_id_key on public.members using btree (league_id, user_id);
create index if not exists idx_open_challenges_accepted_by on public.open_challenges using btree (accepted_by);
create index if not exists idx_open_challenges_creator_id on public.open_challenges using btree (creator_id);
create index if not exists open_challenges_status_idx on public.open_challenges using btree (status, created_at desc);
create unique index if not exists profiles_phone_unique_idx on public.profiles using btree (regexp_replace(phone, '\D'::text, ''::text, 'g'::text));
create index if not exists idx_result_submissions_league_id on public.result_submissions using btree (league_id);
create unique index if not exists one_pending_submission_per_fixture on public.result_submissions using btree (fixture_id) where (status = 'pending'::text);
create index if not exists result_submissions_fixture_idx on public.result_submissions using btree (fixture_id);
create index if not exists result_submissions_league_idx on public.result_submissions using btree (league_id);
create index if not exists shop_categories_department_id_idx on public.shop_categories using btree (department_id);
create index if not exists shop_categories_parent_category_id_idx on public.shop_categories using btree (parent_category_id);
create index if not exists shop_products_category_id_idx on public.shop_products using btree (category_id);
create index if not exists idx_teams_league_id on public.teams using btree (league_id);
create unique index if not exists teams_league_id_lower_name_key on public.teams using btree (league_id, lower(name));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Row level security — enable on every table, then policies.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.admins enable row level security;
alter table public.leagues enable row level security;
alter table public.teams enable row level security;
alter table public.app_settings enable row level security;
alter table public.members enable row level security;
alter table public.profiles enable row level security;
alter table public.fixtures enable row level security;
alter table public.comments enable row level security;
alter table public.comment_likes enable row level security;
alter table public.challenges enable row level security;
alter table public.open_challenges enable row level security;
alter table public.challenge_messages enable row level security;
alter table public.challenge_board_comments enable row level security;
alter table public.challenge_board_comment_likes enable row level security;
alter table public.ladder_comments enable row level security;
alter table public.ladder_comment_likes enable row level security;
alter table public.result_submissions enable row level security;
alter table public.suggestions enable row level security;
alter table public.league_reactions enable row level security;
alter table public.achievements enable row level security;
alter table public.balances enable row level security;
alter table public.transactions enable row level security;
alter table public.shop_departments enable row level security;
alter table public.shop_categories enable row level security;
alter table public.shop_products enable row level security;
alter table public.shop_orders enable row level security;
alter table public.shop_order_items enable row level security;
alter table public.ladder_result_log enable row level security;
alter table public.ladder_reward_payout_queue enable row level security;
alter table public.ladder_cup_pool_sightings enable row level security;
alter table public.nets_daily_login_claims enable row level security;

-- NOTE: the RLS-helper functions used in several `using`/`with check`
-- clauses below (is_league_admin, is_member_of_league, is_platform_admin)
-- are created in section 5, further down this same file, so they exist
-- before any policy below is evaluated at query time. Function bodies
-- are not validated against other objects at CREATE time in Postgres,
-- only at call time, so the order between section 4 and section 5 here
-- is a style choice (policies read more naturally grouped with their
-- tables) rather than a strict requirement.

create policy "achievements are viewable by everyone" on public.achievements for select to public using (true);
create policy "users can insert their own achievements" on public.achievements for insert to public with check ((auth.uid() = user_id));
create policy "users can update their own achievements" on public.achievements for update to public using ((auth.uid() = user_id));

create policy "users can check their own admin status" on public.admins for select to public using ((auth.uid() = user_id));

create policy "app_settings readable by anyone" on public.app_settings for select to public using (true);
create policy "app_settings updatable by admins" on public.app_settings for update to public
  using (exists (select 1 from admins where admins.user_id = auth.uid()))
  with check (exists (select 1 from admins where admins.user_id = auth.uid()));

create policy "Users can view their own balance" on public.balances for select to public using ((auth.uid() = user_id));

create policy "board reactions are readable by any signed-in member" on public.challenge_board_comment_likes for select to authenticated using (true);
create policy "members can change their own board reaction" on public.challenge_board_comment_likes for update to authenticated using ((user_id = auth.uid())) with check ((user_id = auth.uid()));
create policy "members can react to board comments" on public.challenge_board_comment_likes for insert to authenticated with check ((user_id = auth.uid()));
create policy "members can remove their own board reaction" on public.challenge_board_comment_likes for delete to authenticated using ((user_id = auth.uid()));

create policy "board comments are readable by any signed-in member" on public.challenge_board_comments for select to authenticated using (true);
create policy "members can delete their own board comments, admins can delete " on public.challenge_board_comments for delete to authenticated
  using (((user_id = auth.uid()) or (exists (select 1 from admins where (admins.user_id = auth.uid())))));
create policy "members can post to the challenge board" on public.challenge_board_comments for insert to authenticated with check ((user_id = auth.uid()));

create policy "participants can read challenge messages" on public.challenge_messages for select to public using (
  (((challenge_kind = 'direct'::text) and (exists (select 1 from challenges c where ((c.id = challenge_messages.challenge_id) and ((c.challenger_id = auth.uid()) or (c.opponent_id = auth.uid()))))))
  or ((challenge_kind = 'open'::text) and (exists (select 1 from open_challenges o where ((o.id = challenge_messages.challenge_id) and ((o.creator_id = auth.uid()) or (o.accepted_by = auth.uid()))))))));
create policy "participants can send challenge messages" on public.challenge_messages for insert to public with check (
  ((sender_id = auth.uid()) and (((challenge_kind = 'direct'::text) and (exists (select 1 from challenges c where ((c.id = challenge_messages.challenge_id) and (c.status = 'accepted'::text) and ((c.challenger_id = auth.uid()) or (c.opponent_id = auth.uid()))))))
  or ((challenge_kind = 'open'::text) and (exists (select 1 from open_challenges o where ((o.id = challenge_messages.challenge_id) and (o.status = 'accepted'::text) and ((o.creator_id = auth.uid()) or (o.accepted_by = auth.uid())))))))));
create policy "senders can delete their own challenge messages" on public.challenge_messages for delete to public using ((sender_id = auth.uid()));

create policy "Admins can update challenges for review" on public.challenges for update to public
  using (exists (select 1 from admins a where (a.user_id = auth.uid())))
  with check (exists (select 1 from admins a where (a.user_id = auth.uid())));
create policy "Admins can view all challenges for review" on public.challenges for select to public using (exists (select 1 from admins a where (a.user_id = auth.uid())));
create policy "Members can delete their own challenges" on public.challenges for delete to authenticated using (((auth.uid() = challenger_id) or (auth.uid() = opponent_id)));
create policy "Members can respond to or cancel their challenges" on public.challenges for update to authenticated
  using (((auth.uid() = challenger_id) or (auth.uid() = opponent_id)))
  with check (((auth.uid() = challenger_id) or (auth.uid() = opponent_id)));
create policy "Members can send challenges" on public.challenges for insert to authenticated with check ((auth.uid() = challenger_id));
create policy "Members can view their own challenges" on public.challenges for select to authenticated using (((auth.uid() = challenger_id) or (auth.uid() = opponent_id)));
create policy "challenges_report_result" on public.challenges for update to public
  using (((status = 'accepted'::text) and (result_status is null) and ((auth.uid() = challenger_id) or (auth.uid() = opponent_id))))
  with check ((result_reported_by = auth.uid()));
create policy "challenges_resolve_result" on public.challenges for update to public
  using (((status = 'accepted'::text) and (result_status = 'pending'::text) and ((auth.uid() = challenger_id) or (auth.uid() = opponent_id)) and (result_reported_by <> auth.uid())))
  with check (((auth.uid() = challenger_id) or (auth.uid() = opponent_id)));

create policy "comment_likes_delete" on public.comment_likes for delete to public using ((user_id = auth.uid()));
create policy "comment_likes_insert" on public.comment_likes for insert to public with check (
  ((user_id = auth.uid()) and (exists (select 1 from (comments cm join leagues l on ((l.id = cm.league_id)))
    where ((cm.id = comment_likes.comment_id) and ((l.created_by = auth.uid())
      or (exists (select 1 from members m where ((m.league_id = l.id) and (m.user_id = auth.uid()))))
      or (exists (select 1 from admins a where (a.user_id = auth.uid())))))))));
create policy "comment_likes_select" on public.comment_likes for select to public using (exists (select 1 from comments cm where (cm.id = comment_likes.comment_id)));
create policy "comment_likes_update" on public.comment_likes for update to public using ((user_id = auth.uid())) with check ((user_id = auth.uid()));

create policy "League creator or admin can edit comments" on public.comments for update to public
  using (((exists (select 1 from leagues l where ((l.id = comments.league_id) and (l.created_by = auth.uid())))) or (exists (select 1 from admins a where (a.user_id = auth.uid())))))
  with check (((exists (select 1 from leagues l where ((l.id = comments.league_id) and (l.created_by = auth.uid())))) or (exists (select 1 from admins a where (a.user_id = auth.uid())))));
create policy "comments_delete" on public.comments for delete to public using (
  ((user_id = auth.uid()) or (exists (select 1 from leagues l where ((l.id = comments.league_id) and ((l.created_by = auth.uid()) or (exists (select 1 from admins a where (a.user_id = auth.uid())))))))));
create policy "comments_insert" on public.comments for insert to public with check (
  ((user_id = auth.uid()) and (exists (select 1 from leagues l where ((l.id = comments.league_id) and ((l.created_by = auth.uid())
    or (exists (select 1 from members m where ((m.league_id = l.id) and (m.user_id = auth.uid()))))
    or (exists (select 1 from admins a where (a.user_id = auth.uid())))))))));
create policy "comments_select" on public.comments for select to public using (exists (select 1 from leagues l where (l.id = comments.league_id)));

create policy "Admin league fixtures visible to all authenticated users" on public.fixtures for select to authenticated
  using (league_id in (select leagues.id from leagues where is_platform_admin(leagues.created_by)));
create policy "Fixtures visible if league is visible" on public.fixtures for select to public using (
  exists (select 1 from leagues where ((leagues.id = fixtures.league_id) and ((leagues.created_by in (select admins.user_id from admins)) or (leagues.created_by = auth.uid()) or is_member_of_league(leagues.id, auth.uid())))));
create policy "League creator or admin can edit fixtures" on public.fixtures for update to public
  using (((exists (select 1 from leagues l where ((l.id = fixtures.league_id) and (l.created_by = auth.uid())))) or (exists (select 1 from admins a where (a.user_id = auth.uid())))))
  with check (((exists (select 1 from leagues l where ((l.id = fixtures.league_id) and (l.created_by = auth.uid())))) or (exists (select 1 from admins a where (a.user_id = auth.uid())))));
create policy "League creators can add fixtures" on public.fixtures for insert to authenticated with check (
  ((exists (select 1 from leagues where ((leagues.id = fixtures.league_id) and (leagues.created_by = auth.uid())))) or (auth.uid() in (select admins.user_id from admins))));

create policy "ladder_comment_likes_delete" on public.ladder_comment_likes for delete to authenticated using ((user_id = auth.uid()));
create policy "ladder_comment_likes_insert" on public.ladder_comment_likes for insert to authenticated with check ((user_id = auth.uid()));
create policy "ladder_comment_likes_select" on public.ladder_comment_likes for select to authenticated using (true);
create policy "ladder_comment_likes_update" on public.ladder_comment_likes for update to authenticated using ((user_id = auth.uid()));

create policy "ladder_comments_delete" on public.ladder_comments for delete to authenticated using (((user_id = auth.uid()) or (exists (select 1 from admins a where (a.user_id = auth.uid())))));
create policy "ladder_comments_insert" on public.ladder_comments for insert to authenticated with check ((user_id = auth.uid()));
create policy "ladder_comments_select" on public.ladder_comments for select to authenticated using (true);

create policy "ladder_result_log_select" on public.ladder_result_log for select to authenticated using (true);

create policy "league_reactions_delete" on public.league_reactions for delete to public using ((auth.uid() = user_id));
create policy "league_reactions_insert" on public.league_reactions for insert to public with check ((auth.uid() = user_id));
create policy "league_reactions_select" on public.league_reactions for select to public using (true);
create policy "league_reactions_update" on public.league_reactions for update to public using ((auth.uid() = user_id));

create policy "Admin leagues visible to all authenticated users" on public.leagues for select to authenticated using (is_platform_admin(created_by));
create policy "Admins can update any league" on public.leagues for update to authenticated using ((auth.uid() in (select admins.user_id from admins)));
create policy "Creators and admins can delete their league" on public.leagues for delete to public using (((created_by = auth.uid()) or (auth.uid() in (select admins.user_id from admins))));
create policy "League creators can update their league" on public.leagues for update to public using ((created_by = auth.uid()));
create policy "Logged in users can create leagues" on public.leagues for insert to public with check ((auth.uid() = created_by));
create policy "Public admin leagues, or your own, or joined" on public.leagues for select to public using (((created_by in (select admins.user_id from admins)) or (auth.uid() = created_by) or is_member_of_league(id, auth.uid())));
create policy "only admins can create cash leagues" on public.leagues for insert to public with check (((league_type = 'fun'::text) or (exists (select 1 from admins where (admins.user_id = auth.uid())))));

create policy "Admin league members visible to all authenticated users" on public.members for select to authenticated using (league_id in (select leagues.id from leagues where is_platform_admin(leagues.created_by)));
create policy "League admins can delete members" on public.members for delete to public using (is_league_admin(league_id));
create policy "League admins can set wa reminder" on public.members for update to public
  using (exists (select 1 from leagues l where ((l.id = members.league_id) and ((l.created_by = auth.uid()) or (exists (select 1 from admins a where (a.user_id = auth.uid())))))))
  with check (exists (select 1 from leagues l where ((l.id = members.league_id) and ((l.created_by = auth.uid()) or (exists (select 1 from admins a where (a.user_id = auth.uid())))))));
create policy "Logged in users can join a league" on public.members for insert to public with check ((auth.uid() = user_id));
create policy "Members can delete their own membership" on public.members for delete to public using ((user_id = auth.uid()));
create policy "Members can update their own membership" on public.members for update to public using ((auth.uid() = user_id));
create policy "Members can view their own league's members" on public.members for select to public using (is_member_of_league(league_id, auth.uid()));
create policy "admins can update any member" on public.members for update to public
  using (((exists (select 1 from admins a where (a.user_id = auth.uid()))) or (exists (select 1 from leagues l where ((l.id = members.league_id) and (l.created_by = auth.uid()))))));
create policy "members_update_own_payment" on public.members for update to authenticated using ((user_id = auth.uid())) with check ((user_id = auth.uid()));
create policy "members_update_payment_by_managers" on public.members for update to authenticated
  using (((exists (select 1 from admins a where (a.user_id = auth.uid()))) or (exists (select 1 from leagues l where ((l.id = members.league_id) and (l.created_by = auth.uid()))))))
  with check (((exists (select 1 from admins a where (a.user_id = auth.uid()))) or (exists (select 1 from leagues l where ((l.id = members.league_id) and (l.created_by = auth.uid()))))));

create policy "Admins can update open_challenges for review" on public.open_challenges for update to public
  using (exists (select 1 from admins a where (a.user_id = auth.uid())))
  with check (exists (select 1 from admins a where (a.user_id = auth.uid())));
create policy "open_challenges_delete" on public.open_challenges for delete to authenticated using (((creator_id = auth.uid()) or (accepted_by = auth.uid())));
create policy "open_challenges_insert" on public.open_challenges for insert to authenticated with check ((creator_id = auth.uid()));
create policy "open_challenges_report_result" on public.open_challenges for update to public
  using (((status = 'accepted'::text) and (result_status is null) and ((auth.uid() = creator_id) or (auth.uid() = accepted_by))))
  with check ((result_reported_by = auth.uid()));
create policy "open_challenges_resolve_result" on public.open_challenges for update to public
  using (((status = 'accepted'::text) and (result_status = 'pending'::text) and ((auth.uid() = creator_id) or (auth.uid() = accepted_by)) and (result_reported_by <> auth.uid())))
  with check (((auth.uid() = creator_id) or (auth.uid() = accepted_by)));
create policy "open_challenges_select" on public.open_challenges for select to authenticated using (true);
create policy "open_challenges_update" on public.open_challenges for update to authenticated
  using ((status = 'open'::text))
  with check ((((status = 'cancelled'::text) and (creator_id = auth.uid())) or ((status = 'accepted'::text) and (accepted_by = auth.uid()) and (creator_id <> auth.uid()))));

create policy "Platform admins can view all profiles" on public.profiles for select to public using (exists (select 1 from admins a where (a.user_id = auth.uid())));
create policy "Users can create own profile" on public.profiles for insert to public with check ((auth.uid() = user_id));
create policy "Users can update own profile" on public.profiles for update to public using ((auth.uid() = user_id));
create policy "Users can view own profile" on public.profiles for select to public using ((auth.uid() = user_id));
create policy "profiles_select_public_fields" on public.profiles for select to authenticated using (true);

create policy "block_locked_group_stage_result_submissions" on public.result_submissions as restrictive for insert to authenticated with check (
  (not (exists (select 1 from (fixtures f join leagues l on ((l.id = f.league_id)))
    where ((f.id = result_submissions.fixture_id) and (f.played = false) and (l.format = 'groups_knockout'::text) and (f.stage = 1) and (l.group_stage_due_at is not null) and (l.group_stage_due_at < now()))))));
create policy "result_submissions_insert" on public.result_submissions for insert to public with check (
  ((submitted_by = auth.uid()) and (exists (select 1 from members m where ((m.league_id = result_submissions.league_id) and (m.user_id = auth.uid()))))));
create policy "result_submissions_select" on public.result_submissions for select to public using (
  ((exists (select 1 from members m where ((m.league_id = result_submissions.league_id) and (m.user_id = auth.uid()))))
   or (exists (select 1 from leagues l where ((l.id = result_submissions.league_id) and (l.created_by = auth.uid()))))
   or (exists (select 1 from admins a where (a.user_id = auth.uid())))));

create policy "Admins can delete categories" on public.shop_categories for delete to authenticated using (exists (select 1 from admins where (admins.user_id = auth.uid())));
create policy "Admins can insert categories" on public.shop_categories for insert to authenticated with check (exists (select 1 from admins where (admins.user_id = auth.uid())));
create policy "Admins can update categories" on public.shop_categories for update to authenticated using (exists (select 1 from admins where (admins.user_id = auth.uid()))) with check (exists (select 1 from admins where (admins.user_id = auth.uid())));
create policy "Categories are viewable by everyone" on public.shop_categories for select to public using (true);

create policy "shop_departments_select" on public.shop_departments for select to public using (true);
create policy "shop_departments_write" on public.shop_departments for all to public using (exists (select 1 from admins where (admins.user_id = auth.uid()))) with check (exists (select 1 from admins where (admins.user_id = auth.uid())));

create policy "anyone can insert order items" on public.shop_order_items for insert to anon, authenticated with check (true);
create policy "shop_order_items_insert" on public.shop_order_items for insert to public with check (exists (select 1 from shop_orders where ((shop_orders.id = shop_order_items.order_id) and (shop_orders.user_id = auth.uid()))));
create policy "shop_order_items_select" on public.shop_order_items for select to public using (
  exists (select 1 from shop_orders where ((shop_orders.id = shop_order_items.order_id) and ((shop_orders.user_id = auth.uid()) or (exists (select 1 from admins where (admins.user_id = auth.uid())))))));

create policy "anyone can insert orders" on public.shop_orders for insert to anon, authenticated with check (((user_id is null) or (user_id = auth.uid())));
create policy "shop_orders_admin_update" on public.shop_orders for update to public using (exists (select 1 from admins where (admins.user_id = auth.uid()))) with check (exists (select 1 from admins where (admins.user_id = auth.uid())));
create policy "shop_orders_insert" on public.shop_orders for insert to public with check ((user_id = auth.uid()));
create policy "shop_orders_select" on public.shop_orders for select to public using (((user_id = auth.uid()) or (exists (select 1 from admins where (admins.user_id = auth.uid())))));

create policy "shop_products_admin_write" on public.shop_products for all to public using (exists (select 1 from admins where (admins.user_id = auth.uid()))) with check (exists (select 1 from admins where (admins.user_id = auth.uid())));
create policy "shop_products_select" on public.shop_products for select to public using (true);
create policy "shop_products_write" on public.shop_products for all to public using (exists (select 1 from admins where (admins.user_id = auth.uid()))) with check (exists (select 1 from admins where (admins.user_id = auth.uid())));

create policy "suggestions_insert" on public.suggestions for insert to public with check ((auth.uid() = user_id));
create policy "suggestions_select" on public.suggestions for select to public using (((auth.uid() = user_id) or (exists (select 1 from admins where (admins.user_id = auth.uid())))));

create policy "Admin league teams visible to all authenticated users" on public.teams for select to authenticated using (league_id in (select leagues.id from leagues where is_platform_admin(leagues.created_by)));
create policy "League admins can delete teams" on public.teams for delete to public using (is_league_admin(league_id));
create policy "League creators can add teams" on public.teams for insert to public with check (exists (select 1 from leagues where ((leagues.id = teams.league_id) and (leagues.created_by = auth.uid()))));
create policy "League creators can update team phone" on public.teams for update to authenticated using (((exists (select 1 from leagues where ((leagues.id = teams.league_id) and (leagues.created_by = auth.uid())))) or (auth.uid() in (select admins.user_id from admins))));
create policy "Members can delete their own team" on public.teams for delete to public using (exists (select 1 from members m where ((m.team_id = teams.id) and (m.user_id = auth.uid()))));
create policy "Players can self-register a team while entry is open" on public.teams for insert to authenticated with check (
  league_id in (select l.id from leagues l where (((l.entry_closes_at is null) or (l.entry_closes_at > now())) and (not (exists (select 1 from fixtures f where (f.league_id = l.id)))))));
create policy "Teams visible if league is visible" on public.teams for select to public using (
  exists (select 1 from leagues where ((leagues.id = teams.league_id) and ((leagues.created_by in (select admins.user_id from admins)) or (leagues.created_by = auth.uid()) or is_member_of_league(leagues.id, auth.uid())))));

create policy "Users can view their own transactions" on public.transactions for select to public using ((auth.uid() = user_id));

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Core RLS-helper / utility functions with no local `create function`
-- anywhere, despite being load-bearing for RLS across most tables above.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.is_league_admin(check_league_id uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.leagues l
    where l.id = check_league_id
      and (
        l.created_by = auth.uid()
        or exists (select 1 from public.admins a where a.user_id = auth.uid())
      )
  );
$function$;

create or replace function public.is_member_of_league(p_league_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from members
    where members.league_id = p_league_id
    and members.user_id = p_user_id
  );
$function$;

create or replace function public.is_platform_admin(check_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from admins where user_id = check_user_id
  );
$function$;

create or replace function public.increment_balance(p_user_id uuid, p_amount numeric)
returns void
language sql
as $function$
  update balances set amount = amount + p_amount where user_id = p_user_id;
$function$;

create or replace function public.check_comment_parent_same_league()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.parent_comment_id is not null then
    if new.parent_comment_id = new.id then
      raise exception 'a comment cannot reply to itself';
    end if;
    if not exists (
      select 1 from public.comments p
      where p.id = new.parent_comment_id and p.league_id = new.league_id
    ) then
      raise exception 'parent comment must belong to the same league';
    end if;
  end if;
  return new;
end;
$function$;

-- Event-trigger function: auto-enables RLS on every new table created in
-- `public`. Declared here with its matching `create event trigger` so the
-- behavior it's named for (every table created afterward gets RLS turned
-- on automatically) is actually wired up, not just the function sitting
-- unused. Live already; this is a capture, not a change.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

drop event trigger if exists rls_auto_enable_trigger;
create event trigger rls_auto_enable_trigger on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Triggers on fixtures/profiles with no local `create trigger`, plus
-- the trigger functions they call — those functions ALSO had no local
-- `create function` anywhere (this is beyond what BASELINE-INVENTORY.md
-- Step 1 flagged, which only listed the missing CREATE TRIGGER
-- statements; independently confirmed here via grep + live introspection
-- before writing this file). One of these (trg_resolve_ladder_fixture)
-- calls public.apply_ladder_result(text, uuid, uuid, int, int, uuid,
-- int, int) — that specific overload is also included here since the
-- trigger is meaningless without it, even though it depends on
-- `ladder_ranks` and `ladder_result_log`. CREATE FUNCTION in Postgres
-- does not validate table references inside the body, only at call
-- time, so this is safe to create now even though `ladder_ranks` isn't
-- created until 20260827_ladder_ranks_and_resolve_trigger.sql. Flagging
-- this function as a genuinely separate, previously-uncaught gap for
-- BASELINE-INVENTORY.md, not implying it belongs to the pre-20260811 era
-- the rest of this file covers.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.trg_snapshot_fixture_points()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_home_snap integer;
  v_away_snap integer;
begin
  if new.played and (old.played is distinct from new.played) then
    select ladder_points_home_at_report, ladder_points_away_at_report
      into v_home_snap, v_away_snap
      from public.result_submissions
      where fixture_id = new.id and home_score = new.home_score and away_score = new.away_score
      order by created_at desc
      limit 1;

    if found then
      new.ladder_points_home_at_report := v_home_snap;
      new.ladder_points_away_at_report := v_away_snap;
    else
      select points into new.ladder_points_home_at_report from public.ladder_ranks lr
        join public.members m on m.user_id = lr.user_id where m.team_id = new.home_team_id limit 1;
      select points into new.ladder_points_away_at_report from public.ladder_ranks lr
        join public.members m on m.user_id = lr.user_id where m.team_id = new.away_team_id limit 1;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.apply_ladder_result(p_source text, p_source_id uuid, p_user_a uuid, p_score_a integer, p_points_a_snapshot integer, p_user_b uuid, p_score_b integer, p_points_b_snapshot integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_win_points integer;
  v_draw_points integer;
  v_recent_count integer;
  v_pair_low uuid;
  v_pair_high uuid;
begin
  if p_user_a is null or p_user_b is null then
    insert into public.ladder_result_log (source, source_id, user_a, user_b, score_a, score_b, applied, reason)
    values (p_source, p_source_id, p_user_a, p_user_b, p_score_a, p_score_b, false, 'missing_user');
    return;
  end if;

  if p_points_a_snapshot is null or p_points_b_snapshot is null then
    insert into public.ladder_result_log (source, source_id, user_a, user_b, score_a, score_b, points_a, points_b, applied, reason)
    values (p_source, p_source_id, p_user_a, p_user_b, p_score_a, p_score_b, p_points_a_snapshot, p_points_b_snapshot, false, 'not_on_ladder');
    return;
  end if;

  if abs(p_points_a_snapshot - p_points_b_snapshot) > 10 then
    insert into public.ladder_result_log (source, source_id, user_a, user_b, score_a, score_b, points_a, points_b, applied, reason)
    values (p_source, p_source_id, p_user_a, p_user_b, p_score_a, p_score_b, p_points_a_snapshot, p_points_b_snapshot, false, 'gap_too_large');
    return;
  end if;

  v_pair_low := least(p_user_a, p_user_b);
  v_pair_high := greatest(p_user_a, p_user_b);
  select count(*) into v_recent_count
    from public.ladder_result_log
    where applied = true
      and created_at > now() - interval '24 hours'
      and least(user_a, user_b) = v_pair_low
      and greatest(user_a, user_b) = v_pair_high;

  if v_recent_count >= 2 then
    insert into public.ladder_result_log (source, source_id, user_a, user_b, score_a, score_b, points_a, points_b, applied, reason)
    values (p_source, p_source_id, p_user_a, p_user_b, p_score_a, p_score_b, p_points_a_snapshot, p_points_b_snapshot, false, 'pair_cooldown');
    return;
  end if;

  if p_user_a < p_user_b then
    perform 1 from public.ladder_ranks where user_id = p_user_a for update;
    perform 1 from public.ladder_ranks where user_id = p_user_b for update;
  else
    perform 1 from public.ladder_ranks where user_id = p_user_b for update;
    perform 1 from public.ladder_ranks where user_id = p_user_a for update;
  end if;

  case p_source
    when 'fixture' then v_win_points := 3; v_draw_points := 1;
    when 'challenge' then v_win_points := 2; v_draw_points := 1;
    when 'open_challenge' then v_win_points := 1; v_draw_points := 0;
    else v_win_points := 1; v_draw_points := 0;
  end case;

  if p_score_a > p_score_b then
    update public.ladder_ranks set points = points + v_win_points, wins = wins + 1, updated_at = now() where user_id = p_user_a;
    update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = p_user_b;
  elsif p_score_b > p_score_a then
    update public.ladder_ranks set points = points + v_win_points, wins = wins + 1, updated_at = now() where user_id = p_user_b;
    update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = p_user_a;
  else
    update public.ladder_ranks set points = points + v_draw_points, draws = draws + 1, updated_at = now() where user_id = p_user_a;
    update public.ladder_ranks set points = points + v_draw_points, draws = draws + 1, updated_at = now() where user_id = p_user_b;
  end if;

  update public.ladder_ranks set rank_position = rank_position + 1000000 where user_id is not null;

  with ranked as (
    select user_id, row_number() over (order by points desc, wins desc, created_at asc) as new_rank
    from public.ladder_ranks
  )
  update public.ladder_ranks lr set rank_position = ranked.new_rank
  from ranked where lr.user_id = ranked.user_id;

  insert into public.ladder_result_log (source, source_id, user_a, user_b, score_a, score_b, points_a, points_b, applied, reason)
  values (p_source, p_source_id, p_user_a, p_user_b, p_score_a, p_score_b, p_points_a_snapshot, p_points_b_snapshot, true, 'applied');
end;
$function$;

create or replace function public.trg_resolve_ladder_fixture()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_home_user uuid;
  v_away_user uuid;
begin
  if new.played
     and (old.played is distinct from new.played)
     and new.home_score is not null and new.away_score is not null
     and new.away_team_id is not null then

    select user_id into v_home_user from public.members where team_id = new.home_team_id limit 1;
    select user_id into v_away_user from public.members where team_id = new.away_team_id limit 1;

    perform public.apply_ladder_result(
      'fixture', new.id,
      v_home_user, new.home_score, new.ladder_points_home_at_report,
      v_away_user, new.away_score, new.ladder_points_away_at_report
    );

  end if;
  return new;
end;
$function$;

create or replace function public.trg_resolve_league_fixture()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  home_user uuid;
  away_user uuid;
begin
  if new.played = true
     and (old.played is distinct from new.played)
     and new.home_score is not null and new.away_score is not null
     and new.away_team_id is not null then

    select m.user_id into home_user from public.members m where m.team_id = new.home_team_id limit 1;
    select m.user_id into away_user from public.members m where m.team_id = new.away_team_id limit 1;

    if home_user is not null and away_user is not null
       and exists (select 1 from public.ladder_ranks where user_id = home_user)
       and exists (select 1 from public.ladder_ranks where user_id = away_user) then

      if new.home_score > new.away_score then
        update public.ladder_ranks set points = points + 3, wins = wins + 1, updated_at = now() where user_id = home_user;
        update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = away_user;
      elsif new.away_score > new.home_score then
        update public.ladder_ranks set points = points + 3, wins = wins + 1, updated_at = now() where user_id = away_user;
        update public.ladder_ranks set losses = losses + 1, updated_at = now() where user_id = home_user;
      else
        update public.ladder_ranks set points = points + 1, draws = draws + 1, updated_at = now() where user_id = home_user;
        update public.ladder_ranks set points = points + 1, draws = draws + 1, updated_at = now() where user_id = away_user;
      end if;

      update public.ladder_ranks set rank_position = rank_position + 1000000 where user_id is not null;

      with ranked as (
        select user_id,
               row_number() over (order by points desc, wins desc, created_at asc) as new_rank
        from public.ladder_ranks
      )
      update public.ladder_ranks lr
      set rank_position = ranked.new_rank
      from ranked
      where lr.user_id = ranked.user_id;

    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.sync_ladder_profile()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.ladder_ranks
    set username = new.efootball_username, avatar_url = new.avatar_url, updated_at = now()
    where user_id = new.user_id;
  return new;
end;
$function$;

drop trigger if exists trg_snapshot_fixture_points on public.fixtures;
create trigger trg_snapshot_fixture_points before update on public.fixtures for each row execute function trg_snapshot_fixture_points();

drop trigger if exists trg_resolve_ladder_fixture on public.fixtures;
create trigger trg_resolve_ladder_fixture after update on public.fixtures for each row execute function trg_resolve_ladder_fixture();

drop trigger if exists trg_resolve_league_fixture on public.fixtures;
create trigger trg_resolve_league_fixture after update on public.fixtures for each row execute function trg_resolve_league_fixture();

drop trigger if exists trg_sync_ladder_profile on public.profiles;
create trigger trg_sync_ladder_profile after update on public.profiles for each row execute function sync_ladder_profile();
