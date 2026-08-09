# Wall of Fame — required DB migration

## What was actually broken

`league_champion` badges were only ever written to the shared
`achievements` table by the champion's *own* browser (see the
`syncedBadgeIdsRef` effect in `src/App.jsx` — it upserts `achievements`
rows for `myId` only, because the table's RLS presumably only lets a
user write their own `user_id`). If the champion hasn't personally
reopened the app since their league finished, no row ever gets written
— so `allAchievements` has nothing for them, `computeWallOfFame` filters
them out, and `WallOfFameStrip` renders nothing (`if (!standings ||
standings.length === 0) return null;`), same "don't show an empty
shelf" logic the Ladder/Leaderboard strips use.

The signed-in `leagues` query (`loadLeagues`) already pulls every
league on the platform with full `teams`/`fixtures`/`members`, so any
signed-in visitor's browser already has enough data to determine every
league's champion — it just couldn't write anyone else's achievement
row. The fix: a narrow SECURITY DEFINER RPC that can, plus a public
view so guests can see the result without an account.

## Required database migration

Run this in the Supabase SQL editor:

```sql
-- Lets any authenticated client backfill the league_champion badge for
-- ANY user, not just themselves — scoped to exactly this one
-- achievement_id, so it doesn't become a general "award anyone
-- anything" hole. It still doesn't re-verify the win server-side (same
-- trust model the rest of the achievements table already uses for
-- every other badge — the client decides "earned", this just removes
-- the "must be self" restriction for this one case).
create or replace function public.award_league_champion(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.achievements (user_id, achievement_id)
  values (p_user_id, 'league_champion')
  on conflict (user_id, achievement_id) do nothing;
end;
$$;

grant execute on function public.award_league_champion(uuid) to authenticated;

-- Guest-facing Wall of Fame. Mirrors computeWallOfFame's scoring (see
-- src/App.jsx TIER_WEIGHT) in SQL, restricted to users who hold
-- league_champion. Adjust the `profiles` column names below if yours
-- differ (this repo's other public_* views suggest user_id/username/
-- avatar_url, matching list_challengeable_members's shape).
create or replace view public.public_wall_of_fame as
select
  p.user_id,
  p.efootball_username as username,
  p.avatar_url,
  count(*)::int as badge_count,
  sum(case a.achievement_id
    -- platinum (5)
    when 'century' then 5 when 'wins_50' then 5 when 'streak_10' then 5
    when 'level_16' then 5 when 'level_21' then 5 when 'league_champion' then 5
    when 'ladder_no1' then 5
    -- gold (3)
    when 'matches_50' then 3 when 'wins_25' then 3 when 'clean_sheets_15' then 3
    when 'big_win' then 3 when 'unbeaten_10' then 3 when 'streak_5' then 3
    when 'level_11' then 3 when 'ladder_top10' then 3
    -- silver (2)
    when 'matches_10' then 2 when 'wins_10' then 2 when 'draws_10' then 2
    when 'clean_sheets_5' then 2 when 'streak_3' then 2 when 'level_6' then 2
    when 'join_3' then 2
    -- bronze (1) — first_match, first_win, join_league, ladder_ranked, else
    else 1
  end)::int as score
from public.achievements a
join public.profiles p on p.user_id = a.user_id
where a.user_id in (
  select user_id from public.achievements where achievement_id = 'league_champion'
)
group by p.user_id, p.efootball_username, p.avatar_url
order by score desc, badge_count desc;

grant select on public.public_wall_of_fame to anon, authenticated;
```

### RLS check

`award_league_champion` is SECURITY DEFINER so it bypasses the normal
"only your own user_id" RLS on `achievements` — that's the point, but
also means it should stay narrowly scoped to this one achievement_id
(it is, hardcoded in the function body, not a parameter).

`public_wall_of_fame` selects from `achievements` and `profiles` as the
function owner, so guests never need direct SELECT on either table —
same pattern as `public_team_avatars`. Confirmed against live schema:
`profiles` has `efootball_username`, not `username` (the view aliases it
— `list_challengeable_members` does the same alias internally). If
`avatar_url` also errors when you run this, run `select column_name
from information_schema.columns where table_name = 'profiles';` and
adjust that column name too before re-running.

Per `WA-REMINDER-MIGRATION.md`'s note, this repo's SQL docs don't
reliably mirror what's live in Supabase — treat column-name mismatches
as the first thing to check if `public_wall_of_fame` fails to create.

### Verification

1. Run the migration.
2. Open the app signed in as *any* user (doesn't need to be a
   champion) — the new effect in `Home` (see App.jsx changes) should
   silently call `award_league_champion` for every determined league
   champion not yet in `allAchievements`, then reload achievements.
3. Reload the homepage — Wall of Fame should now appear if any league
   has actually completed with a winner.
4. Reload the signed-out landing page — the new Wall of Fame strip
   there reads straight from `public_wall_of_fame`, no auth needed.
5. If it's still empty after this, that means no league has actually
   completed with a determined champion yet in your data — check that
   assumption before assuming the code is still broken.
