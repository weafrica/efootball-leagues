import React, { useState, useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Trophy, Search, History, ChevronDown, Check } from "lucide-react";
import {
  fmtDate, MemberAvatar, MenuTile, PlayerProfileModal, fixturePlayedDate, seasonAnchor, seasonBounds,
  currentSeason, computeGlobalLeaderboard, goalExtremes, rankLeaderboard,
  GoalExtremesBar, LEADERBOARD_MIN_PLAYED_FOR_WINRATE, medalFor,
} from "./App.jsx";

// Split out of App.jsx: the platform-wide Leaderboard is only opened by a
// signed-in user tapping into it from the header or the home screen's
// preview strip - never on first load. Lazy-loaded the same way
// Shop/Terms/Rules/LeagueDetail/ChallengesScreen/CreateLeague already are.
//
// rankLeaderboard, GoalExtremesBar, computeGlobalLeaderboard, goalExtremes,
// seasonAnchor, seasonBounds, currentSeason, fixturePlayedDate, and
// LEADERBOARD_MIN_PLAYED_FOR_WINRATE stayed behind in App.jsx (and are
// exported here) because they're also used by the home screen's
// LeaderboardStrip preview and/or StandingsPanel, both of which must stay
// in the main bundle.
//
// seasonKey, seasonLabel, daysUntilSeasonReset, listSeasons, and
// computeRecentMatches only feed this Leaderboard screen (and its
// SeasonPicker), so they moved here in full rather than being exported.

const SEASON_LENGTH_MS = 91 * 24 * 60 * 60 * 1000; // ~3 months per season

function seasonIndexForDate(date, anchor) { return Math.floor((new Date(date) - anchor) / SEASON_LENGTH_MS); }
function seasonKey(idx) { return `S${idx + 1}`; }
function seasonLabel(idx, anchor) {
  const { start, end } = seasonBounds(idx, anchor);
  const lastDay = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const fmt = { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Johannesburg" };
  return `Season ${idx + 1} · ${start.toLocaleDateString("en-ZA", fmt)} – ${lastDay.toLocaleDateString("en-ZA", fmt)}`;
}
function daysUntilSeasonReset(anchor) {
  if (!anchor) return null;
  const { end } = seasonBounds(currentSeason(anchor), anchor);
  return Math.max(1, Math.ceil((end - new Date()) / (24 * 60 * 60 * 1000)));
}

// Every season index that has at least one played fixture in it, newest
// first, plus the current season even if it's still empty — this feeds the
// Leaderboard's season picker.
function listSeasons(leagues) {
  const anchor = seasonAnchor(leagues);
  if (!anchor) return [];
  const cur = currentSeason(anchor);
  const seasons = [];
  for (let i = 0; i <= cur; i++) seasons.push(i);
  return seasons.reverse();
}

// Every played match across every league, scoped the same way the
// leaderboard standings are (pass `bounds` to limit to one season, or
// null/undefined for all-time) — newest first. Feeds the "Past matches"
// list under the rankings.
function computeRecentMatches(leagues, bounds) {
  const rows = [];
  (leagues || []).forEach((l) => {
    (l.fixtures || []).forEach((f) => {
      if (!f.played || f.away_team_id === null) return;
      const at = new Date(fixturePlayedDate(f));
      if (bounds && (at < bounds.start || at >= bounds.end)) return;
      const home = (l.teams || []).find((t) => t.id === f.home_team_id);
      const away = (l.teams || []).find((t) => t.id === f.away_team_id);
      if (!home || !away) return;
      rows.push({ id: f.id, leagueName: l.name, homeName: home.name, awayName: away.name, homeScore: f.home_score, awayScore: f.away_score, playedAt: at, round: f.round });
    });
  });
  return rows.sort((a, b) => b.playedAt - a.playedAt);
}

const LEADERBOARD_METRICS = [
  { id: "wins", label: "Wins" },
  { id: "winrate", label: "Win %" },
  { id: "goals", label: "Goals" },
];

// Dropdown for switching the Leaderboard between "this season" (the current
// 3-month window, counted from the very first match ever played — the
// default), any past season, and an all-time view. Follows the same
// open/outside-click pattern as LeagueMenu.
function SeasonPicker({ value, seasons, anchor, cur, onChange, c }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  const label = value === "all" ? "All-time" : value === seasonKey(cur) ? `This season · ${seasonLabel(cur, anchor)}` : seasonLabel(seasons.find((s) => seasonKey(s) === value) ?? cur, anchor);

  const choose = (v) => { setOpen(false); onChange(v); };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-body text-xs font-semibold" style={{ background: c.surface, color: c.text }}>
        <History size={13} style={{ color: c.textFaint }} /> {label} <ChevronDown size={13} style={{ color: c.textFaint }} />
      </button>
      {open && (
        <div className="absolute left-0 mt-2 w-64 max-h-72 overflow-y-auto rounded-xl overflow-x-hidden z-20 shadow-lg" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
          <button onClick={() => choose(seasonKey(cur))} className="w-full flex items-center justify-between gap-2 px-4 py-3 font-body text-sm text-left"
            style={{ color: value === seasonKey(cur) ? c.accent : c.text }}>
            This season · {seasonLabel(cur, anchor)} {value === seasonKey(cur) && <Check size={14} />}
          </button>
          {seasons.filter((s) => seasonKey(s) !== seasonKey(cur)).map((s) => (
            <button key={seasonKey(s)} onClick={() => choose(seasonKey(s))} className="w-full flex items-center justify-between gap-2 px-4 py-3 font-body text-sm text-left"
              style={{ color: value === seasonKey(s) ? c.accent : c.text, borderTop: `1px solid ${c.border}` }}>
              {seasonLabel(s, anchor)} {value === seasonKey(s) && <Check size={14} />}
            </button>
          ))}
          <button onClick={() => choose("all")} className="w-full flex items-center justify-between gap-2 px-4 py-3 font-body text-sm text-left"
            style={{ color: value === "all" ? c.accent : c.text, borderTop: `1px solid ${c.border}` }}>
            All-time {value === "all" && <Check size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}

// Platform-wide leaderboard — every person's record across every match
// they've played, in any league. Resets automatically every 3 months (the
// board defaults to the current calendar quarter); past quarters and an
// all-time view are one tap away via the season picker, since nothing is
// actually deleted when a season rolls over. Top 10 by default in a
// scrollable panel; typing a username searches the FULL ranked list (not
// just the top 10) so someone can find themselves — or anyone else —
// wherever they actually sit.
export default function Leaderboard({ leagues, session, memberAvatars, myAvatarUrl, onBack, embedded, quickActions, c }) {
  const [metric, setMetric] = useState("wins");
  const [query, setQuery] = useState("");
  const [profileRow, setProfileRow] = useState(null); // the ranked row currently shown in PlayerProfileModal, or null
  // memberAvatars is the same platform-wide roster the Challenges picker uses
  // (user_id + username + avatar_url) — reused here purely as a lookup so
  // ranked rows (keyed by user_id) can show a real photo instead of just an
  // initial, without the leaderboard needing to fetch anything of its own.
  // That roster only lists *other* members (see list_challengeable_members),
  // so the signed-in user's own photo is layered in separately from their
  // profile, or their own row would fall back to initials.
  const avatarByUserId = useMemo(() => {
    const map = new Map();
    (memberAvatars || []).forEach((m) => { if (m.user_id) map.set(m.user_id, m.avatar_url || null); });
    if (session && myAvatarUrl) map.set(session.user.id, myAvatarUrl);
    return map;
  }, [memberAvatars, session, myAvatarUrl]);
  const anchor = useMemo(() => seasonAnchor(leagues), [leagues]);
  const cur = currentSeason(anchor);
  const [season, setSeason] = useState(seasonKey(cur));

  const seasons = useMemo(() => listSeasons(leagues), [leagues]);
  const bounds = (season === "all" || !anchor) ? null : seasonBounds(season === seasonKey(cur) ? cur : (seasons.find((s) => seasonKey(s) === season) ?? cur), anchor);
  const scopedRows = useMemo(() => computeGlobalLeaderboard(leagues, bounds), [leagues, season]);
  const ranked = useMemo(() => rankLeaderboard(scopedRows, metric), [scopedRows, metric]);
  const { top: topScorer, least: leastScorer } = useMemo(() => goalExtremes(scopedRows), [scopedRows]);
  const pastMatches = useMemo(() => computeRecentMatches(leagues, bounds), [leagues, season]);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const results = searching ? ranked.filter((r) => (r.name || "").toLowerCase().includes(q)).slice(0, 20) : ranked.slice(0, 10);
  const myRow = session ? ranked.find((r) => r.userId === session.user.id) : null;
  const myRowVisible = myRow && results.some((r) => r.userId === myRow.userId);
  const viewingCurrent = season === seasonKey(cur);
  const daysLeft = anchor ? daysUntilSeasonReset(anchor) : null;

  const statLine = (r) => {
    if (metric === "winrate") return `${Math.round(r.winRate * 100)}% win rate · ${r.w}W ${r.d}D ${r.l}L`;
    if (metric === "goals") return `${r.gf} scored · ${r.gd >= 0 ? "+" : ""}${r.gd} GD`;
    return `${r.w}W ${r.d}D ${r.l}L · ${r.p} played`;
  };
  const row = (r) => (
    <div key={r.userId} role="button" tabIndex={0} onClick={() => setProfileRow(r)} onKeyDown={(e) => { if (e.key === "Enter") setProfileRow(r); }}
      className="flex items-center gap-3 rounded-lg px-4 py-2.5 cursor-pointer"
      style={{ background: session && r.userId === session.user.id ? c.surfaceHover : c.surface, border: session && r.userId === session.user.id ? `1px solid ${c.accent}` : "1px solid transparent" }}>
      <span className="w-6 text-center font-mono text-xs shrink-0" style={{ color: c.textFaint }}>{medalFor(r.rank) || `#${r.rank}`}</span>
      <MemberAvatar url={r.userId ? avatarByUserId.get(r.userId) : null} username={r.name} size={28} c={c} />
      <div className="min-w-0 flex-1">
        <div className="font-body text-sm truncate">{r.name}{session && r.userId === session.user.id ? " (you)" : ""}</div>
        <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{statLine(r)}</div>
      </div>
    </div>
  );

  return (
    <div className={embedded ? "" : "pt-8"}>
      {!embedded && (
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}><ArrowLeft size={15} /> All leagues</button>
      )}

      {/* Same quick-action tiles as the app-wide floating dock (App.jsx's
          QuickActionsDock), placed inline right at the top of the
          leaderboard instead of behind a separate floating button — one
          less tap to jump into a new league, the ladder, a random
          challenge, etc. straight from here. Horizontally-scrollable row
          rather than the dock's 3-col grid, since it's competing for
          space with the rest of the page instead of floating over it. */}
      {quickActions && quickActions.length > 0 && (
        <div className="flex gap-2 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
          {quickActions.map((it) => (
            <div key={it.label} className="w-20 shrink-0">
              <MenuTile icon={it.icon} label={it.label} badge={it.badge} external={it.external} onClick={it.onClick} c={c} />
            </div>
          ))}
        </div>
      )}

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a username to find them..."
          className="w-full border rounded-lg pl-9 pr-4 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      <div className="flex items-center gap-2 mb-1">
        <Trophy size={20} style={{ color: c.accent }} />
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Leaderboard</h1>
      </div>
      <div className="font-mono text-xs mb-4" style={{ color: c.textFaint }}>
        {season === "all" ? "Ranked by results across every league, all-time" : "Ranked by results across every league this season"}
        {" — "}{ranked.length} player{ranked.length === 1 ? "" : "s"} with at least one match played
        {viewingCurrent && daysLeft != null && <> · resets in {daysLeft} day{daysLeft === 1 ? "" : "s"}</>}
      </div>

      {anchor && <div className="mb-4"><SeasonPicker value={season} seasons={seasons} anchor={anchor} cur={cur} onChange={setSeason} c={c} /></div>}

      <GoalExtremesBar top={topScorer} least={leastScorer} c={c} />

      <div className="flex gap-1 mb-4 rounded-full p-1 w-fit" style={{ background: c.surface }}>
        {LEADERBOARD_METRICS.map((opt) => (
          <button key={opt.id} onClick={() => setMetric(opt.id)} className="px-3.5 py-1.5 rounded-full font-body text-xs font-semibold uppercase tracking-wide"
            style={metric === opt.id ? { background: c.text, color: c.bg } : { color: c.textDim }}>
            {opt.label}
          </button>
        ))}
      </div>
      {metric === "winrate" && (
        <div className="font-mono text-[11px] mb-4" style={{ color: c.textFaint }}>Only players with {LEADERBOARD_MIN_PLAYED_FOR_WINRATE}+ matches played are ranked here.</div>
      )}

      {results.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          {ranked.length === 0 ? (season === "all" ? "No matches played yet — the board fills in once results start coming in." : "No matches played this season yet.") : `No one matching "${query}".`}
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
          {results.map(row)}
        </div>
      )}

      {!searching && myRow && !myRowVisible && (
        <div className="mt-3">
          <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Your rank</div>
          {row(myRow)}
        </div>
      )}

      <div className="mt-8">
        <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>
          Past matches {season === "all" ? "" : "this season"} <span style={{ color: c.textFaint }}>({pastMatches.length})</span>
        </div>
        {pastMatches.length === 0 ? (
          <div className="border border-dashed rounded-xl p-6 text-center font-body text-sm" style={{ borderColor: c.borderStrong, color: c.textDim }}>
            {season === "all" ? "No matches played yet." : "No matches played this season yet."}
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
            {pastMatches.slice(0, 40).map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
                <div className="min-w-0 flex-1">
                  <div className="font-body text-sm truncate">{m.homeName} <span style={{ color: c.textFaint }}>vs</span> {m.awayName}</div>
                  <div className="font-mono text-[10px] truncate" style={{ color: c.textFaint }}>{m.leagueName} · Matchday {m.round} · {fmtDate(m.playedAt)}</div>
                </div>
                <div className="font-mono text-sm font-semibold shrink-0">{m.homeScore} – {m.awayScore}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {profileRow && (
        <PlayerProfileModal
          username={profileRow.name}
          avatarUrl={profileRow.userId ? avatarByUserId.get(profileRow.userId) : null}
          isMe={session && profileRow.userId === session.user.id}
          rank={profileRow.rank}
          stats={[
            { label: "Played", value: profileRow.p },
            { label: "Win rate", value: `${Math.round(profileRow.winRate * 100)}%` },
            { label: "W · D · L", value: `${profileRow.w} · ${profileRow.d} · ${profileRow.l}` },
            { label: "Points", value: profileRow.pts },
            { label: "Goals for", value: profileRow.gf },
            { label: "Goal diff", value: `${profileRow.gd >= 0 ? "+" : ""}${profileRow.gd}` },
          ]}
          onClose={() => setProfileRow(null)}
          c={c}
        />
      )}
    </div>
  );
}

