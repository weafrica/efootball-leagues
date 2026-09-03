-- Rapid Cup — schedule expire_rapid_cup_lobbies() to run every minute via
-- pg_cron (already enabled on this project). Runs as the function owner
-- (security definer), so no extra grants needed here.
--
-- Unschedule any previous run of the same name first so re-applying this
-- migration (or hand-running it again) doesn't create duplicate jobs.
select cron.unschedule(jobid) from cron.job where jobname = 'rapid-cup-expire-lobbies';

select cron.schedule(
  'rapid-cup-expire-lobbies',
  '* * * * *',
  $$select expire_rapid_cup_lobbies();$$
);
