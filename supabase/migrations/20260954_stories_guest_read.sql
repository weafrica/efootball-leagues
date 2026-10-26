-- Let signed-out visitors listen to stories from the guest quick actions.
-- Read-only: story list + content are already public-facing (audio lives in
-- public storage buckets). Progress stays per-user and authenticated-only.
create policy "game_stories readable by anon" on public.game_stories
  for select to anon using (true);
create policy "game_story_content readable by anon" on public.game_story_content
  for select to anon using (true);
