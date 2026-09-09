-- Diagnostic only — read-only. Shows what's ACTUALLY live in the
-- database right now for the two functions the Sunday cutoff depends on,
-- plus every currently-scheduled cron job. This is the ground truth —
-- compare it against the migration files rather than assuming they match.

select pg_get_functiondef('_ladder_close_week_internal()'::regprocedure);

select pg_get_functiondef('_ladder_open_week_internal()'::regprocedure);

select jobid, jobname, schedule, command, active
from cron.job
order by jobname;
