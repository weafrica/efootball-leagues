// Postgres egress fix (postgres-egress-fix-plan.md Step 3) — serves the
// PLAYED/FORFEITED ladder_fixtures rows for one league+week, identical for
// every viewer of that league, so Vercel's edge CDN can cache the response
// instead of every open tab re-fetching it on every poll/mount.
//
// Deliberately narrower in scope than guest-data.js's bundle: this only
// covers the standings/results half of LeagueLadderDetail.jsx. PENDING
// fixtures are NOT included here and never will be — they drive the live
// confirm/dispute/countdown flow (see that file's `load()`), which needs
// to stay fully live. Admin corrections/cancellations on an already-played
// fixture also aren't reflected here until this cache entry expires — see
// CACHE_SECONDS below for why that window is short rather than the 1hr
// used elsewhere in this plan.
//
// CACHE_SECONDS is 300s (5 min), not the 3600s (1hr) guest-data.js and
// other Step 3/4 endpoints use — explicit tradeoff for this endpoint only:
// League Ladder results can be corrected or cancelled by an admin
// (correct_ladder_fixture_result / cancel_ladder_fixture_result), and a
// full 1hr cache would mean a correction lands in the database instantly
// but the UI keeps showing the old score for up to an hour — a visible
// bug, not just staleness. 5 minutes keeps most of the caching benefit
// (fixtures don't change every few minutes in practice) while keeping
// that lag small enough not to look broken. Any FUTURE Step 3/4 endpoint
// for data that isn't admin-correctable should default to the standard
// 1hr (CACHE_SECONDS = 3600) this plan uses everywhere else — this file's
// short window is the exception, not the new default.
import { createClient } from "@supabase/supabase-js";

const CACHE_SECONDS = 300;
const REVALIDATE_SECONDS = 600;

// Matches LADDER_FIXTURE_SELECT in src/LeagueLadderDetail.jsx — the exact
// columns that file's standings computation (computeStandings, in
// formats/leagueLadder.js) and its Results-tab rendering actually use.
// Kept as a literal string here (not imported) since this file runs in a
// separate Vercel serverless runtime, not bundled with the rest of the
// client — see guest-data.js for the same "no shared import across the
// client/serverless boundary" pattern.
const FIXTURE_SELECT = "id, home_user_id, away_user_id, home_score, away_score, status, played_at, countdown_expires_at";

export default async function handler(req, res) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const leagueId = req.query.leagueId;
  const week = Number(req.query.week);
  if (!leagueId || !Number.isInteger(week) || week < 1) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "leagueId and a positive integer week are required" });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  try {
    const { data, error } = await supabase
      .from("ladder_fixtures")
      .select(FIXTURE_SELECT)
      .eq("league_id", leagueId)
      .eq("week_number", week)
      .in("status", ["played", "forfeited"]);

    if (error) {
      // Same reasoning as guest-data.js: never cache an error response, or
      // a transient failure freezes an empty/broken standings table at the
      // CDN for everyone until the cache window expires.
      res.setHeader("Cache-Control", "no-store");
      res.status(502).json({ error: "Upstream fetch failed" });
      return;
    }

    res.setHeader(
      "Cache-Control",
      `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${REVALIDATE_SECONDS}`
    );
    res.status(200).json({ fixtures: data || [] });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "Upstream fetch failed" });
  }
}
