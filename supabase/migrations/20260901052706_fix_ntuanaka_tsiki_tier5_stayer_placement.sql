-- NtuanakaTsiki (255be657-3d1b-4a7d-8804-ff10f2fd8747) was Tier 5's rightful
-- rank-4 stayer for week 2 (points/GD tiebreak among the 6 week-1 members),
-- but her week-1 membership status was wrongly 'eliminated' instead of
-- 'active', so she never got carried into week 2. Backfilling her stayer
-- seat directly, mirroring the existing stayer row (06bbdb8e) — no entry
-- fee applies to a stayer carry-forward.
insert into ladder_memberships (user_id, league_id, week_number, status)
values ('255be657-3d1b-4a7d-8804-ff10f2fd8747', '481c6a60-2ac3-474e-9ab7-77d197e096c2', 2, 'active')
on conflict (user_id, week_number) do nothing;

select _ladder_sync_fixtures_internal('481c6a60-2ac3-474e-9ab7-77d197e096c2', 2);
