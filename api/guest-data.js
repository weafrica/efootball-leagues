// Runs PublicHome's guest data bundle server-side, once, and lets Vercel's
// edge CDN cache the JSON response — shared across every visitor — instead
// of each guest's browser hitting Supabase/PostgREST directly.
//
// Why: the per-browser localStorage cache this replaced (guestDataCacheV1)
// still meant every new visitor, every new browser, and every cleared cache
// paid for a fresh round trip to Postgres, even though this data is
// identical for every guest on the platform. Moving the fetch here means
// Postgres is hit at most once per CACHE_SECONDS window, total, no matter
// how much guest traffic the site gets.
//
// As of migration 20260913, the 8 live queries this used to run
// (public_leagues/public_league_teams/public_league_fixtures/
// public_league_extra/public_ladder_full/public_challenge_results/
// public_team_avatars/app_settings) are precomputed hourly by pg_cron into
// league_home_summary, a single-row materialized view holding the same
// payload shape as one jsonb column. This handler is now one row read
// instead of 8 queries — same CACHE_SECONDS-bounded hit rate as before,
// cheaper per hit. See that migration for why this doesn't move the
// egress-bytes needle (it's a DB query-cost fix, not a bytes-over-the-wire
// fix) and for the refresh cadence reasoning.
//
// s-maxage is what Vercel's CDN honors for shared caching; the plain
// max-age lets a single guest's own browser also skip the network on an
// immediate refresh. stale-while-revalidate lets the CDN keep serving the
// last good response instantly while it refetches in the background, so no
// guest ever waits on a slow Postgres round trip — only the first request
// after the cache window expires triggers one, and everyone after that (up
// to REVALIDATE_SECONDS later) gets the stale-but-fine copy while it
// refreshes behind the scenes.
import { createClient } from "@supabase/supabase-js";

const CACHE_SECONDS = 3600;
const REVALIDATE_SECONDS = 7200;

export default async function handler(req, res) {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: "Server misconfigured" });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  try {
    const { data, error } = await supabase
      .from("league_home_summary")
      .select("payload")
      .eq("id", 1)
      .maybeSingle();

    if (error || !data) {
      // Don't cache a broken/partial response — same reasoning the old
      // per-query guard used: caching an error here would freeze the empty
      // state at the CDN for everyone until CACHE_SECONDS expires, masking
      // a real failure behind what looks like a fast, working page.
      res.setHeader("Cache-Control", "no-store");
      res.status(502).json({ error: "Upstream fetch failed" });
      return;
    }

    // league_home_summary.payload is already shaped exactly like this
    // handler's old hand-built object (leagues/teams/fixtures/extras/
    // ladder/results/avatarByTeamId/weekendOverride) — see migration
    // 20260913. Nothing left to assemble here.
    const payload = data.payload;

    res.setHeader(
      "Cache-Control",
      `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${REVALIDATE_SECONDS}`
    );
    res.status(200).json(payload);
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "Upstream fetch failed" });
  }
}
