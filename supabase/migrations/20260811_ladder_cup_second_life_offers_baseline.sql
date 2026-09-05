-- Baseline follow-up — the two items from the pre-migration-era gap that
-- could NOT go in 20260810235959_baseline_schema.sql because they
-- reference tables created by 20260811_ladder_cup.sql itself
-- (ladder_cup_entries, ladder_cup_matches). This file must run after
-- that migration; the filename is deliberately chosen (starts with
-- "20260811_ladder_cup" + a letter, not an underscore, right after the
-- date) so it sorts after both `20260811_ladder_cup.sql` and
-- `20260811_ladder_cup_start.sql` under plain lexical filename
-- ordering — verified against this repo's actual sort behavior, not
-- assumed.
--
-- Both pieces already exist live in production; this is a capture, not
-- a behavior change.
--
-- Safe to run more than once.

create table if not exists public.ladder_cup_second_life_offers (
  id uuid default gen_random_uuid() not null,
  league_id uuid not null,
  entry_id uuid not null,
  team_id uuid not null,
  offered_at timestamptz not null,
  expires_at timestamptz not null,
  responded_at timestamptz,
  response_type text,
  created_at timestamptz default now() not null
);

alter table public.ladder_cup_second_life_offers add constraint ladder_cup_second_life_offers_pkey primary key (id);
alter table public.ladder_cup_second_life_offers add constraint ladder_cup_second_life_offers_league_id_team_id_key unique (league_id, team_id);

alter table public.ladder_cup_second_life_offers add constraint ladder_cup_second_life_offers_entry_id_fkey foreign key (entry_id) references ladder_cup_entries(id) on delete cascade;
alter table public.ladder_cup_second_life_offers add constraint ladder_cup_second_life_offers_league_id_fkey foreign key (league_id) references leagues(id) on delete cascade;
alter table public.ladder_cup_second_life_offers add constraint ladder_cup_second_life_offers_team_id_fkey foreign key (team_id) references teams(id) on delete cascade;

alter table public.ladder_cup_second_life_offers add constraint ladder_cup_second_life_offers_response_type_check
  check ((response_type = any (array['accepted'::text, 'declined'::text, 'expired'::text])));

create index if not exists idx_ladder_cup_second_life_offers_league on public.ladder_cup_second_life_offers using btree (league_id);

-- RLS is enabled live with zero policies (default-deny; all access goes
-- through SECURITY DEFINER functions elsewhere) — matched here exactly.
alter table public.ladder_cup_second_life_offers enable row level security;

-- The other deferred piece: comments.ladder_cup_match_id references
-- ladder_cup_matches, also created by 20260811_ladder_cup.sql.
alter table public.comments add constraint comments_ladder_cup_match_id_fkey
  foreign key (ladder_cup_match_id) references ladder_cup_matches(id) on delete set null;
-- (the ladder_cup_match_id column and its index already exist from the
-- baseline file — only the FK needed to wait for ladder_cup_matches.)
