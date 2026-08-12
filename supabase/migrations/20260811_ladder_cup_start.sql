-- WEAFRICA SURVIVAL LADDER CUP — admin "Start League" step
--
-- Ladder Cup was originally built with no separate start step (see step6):
-- a club goes live on the ladder the instant its `teams` row exists. This
-- adds an optional admin-triggered lock on top of that, for admins who want
-- to close registration on their own schedule instead of waiting for the
-- cutoff. It does NOT generate fixtures — Ladder Cup never uses `fixtures`
-- at all (challenge-based, not fixture-generated). Starting a Ladder Cup
-- league only does one thing: stops new clubs from joining.
alter table leagues
  add column if not exists ladder_cup_started_at timestamptz;
  -- null: still open for joining (default/original behaviour — unchanged).
  -- non-null: admin tapped "Start League" — entryClosed() in App.jsx now
  -- treats this the same as the hard cutoff having passed, so the Join
  -- button/flow closes early. Clubs already on the ladder are unaffected;
  -- matches, second-life, walkovers, and the weekly cutoff all keep working
  -- exactly as before. Set once by startLadderCupLeague (App.jsx) and never
  -- cleared automatically.
