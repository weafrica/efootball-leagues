import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase, setStaySignedInPreference, clearAllAuthStorage } from "./supabaseClient";
import {
  Trophy, Plus, Users, Calendar, ChevronRight, X, Check,
  ArrowLeft, Settings2, Moon, Sun, LogOut, Lock, Crown, Layers, Share2, Trash2, Clock, Info,
  Wallet, Upload, Download, CheckCircle2, XCircle, ReceiptText, Shield, Copy, MessageCircle, Search, AlertTriangle,
  MoreVertical, Send, CornerDownRight, Camera, Eye, ThumbsUp, ThumbsDown, Target, ChevronDown, History, Shuffle,
  TrendingUp, Swords,
} from "lucide-react";

const THEME_KEY = "efootball-theme-v1";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

// Cash league entry fees: members choose their own amount in this range when they join.
const ENTRY_FEE_MIN = 10;
const ENTRY_FEE_MAX = 200;
const ENTRY_FEE_STEP = 10;
const ENTRY_FEE_PRESETS = [10, 20, 50, 100, 150, 200];
const formatRand = (n) => `R${Number(n).toLocaleString("en-ZA")}`;

// WeAfrica's payment details, shown wherever someone is about to pay an
// entry fee into a cash league.
const BANK_DETAILS = {
  bank: "Capitec Business",
  accountName: "We Africa",
  accountNumber: "1054081743",
  accountType: "Transact",
};

// Cash-league prize model: "the more you put in, the bigger your prize."
// A place's cut of the pool is scaled by how much of the R200 max the
// winner actually put in — someone who paid R10 into a R20,000 pool and
// finishes 1st only draws (10/200) × 25% = 1.25% of the pool directly.
// Whatever a place doesn't draw (because its winner under-paid) is pooled
// as leftover and split back out across every winner, proportional to each
// winner's own direct prize — see computeCashPrizes below.
const PRIZE_PAYOUT_PERCENTAGES = [0.25, 0.20, 0.15, 0.12, 0.10, 0.08, 0.06, 0.04]; // 1st..8th, sums to 100% at full entry
const clampFee = (n) => Math.min(ENTRY_FEE_MAX, Math.max(ENTRY_FEE_MIN, Math.round(Number(n) || 0)));

const THEMES = {
  dark: {
    bg: "#0B1F17", surface: "rgba(241,250,238,0.045)", surfaceHover: "rgba(241,250,238,0.08)",
    border: "rgba(241,250,238,0.10)", borderStrong: "rgba(241,250,238,0.18)", text: "#F1FAEE",
    textDim: "rgba(241,250,238,0.55)", textFaint: "rgba(241,250,238,0.35)", accent: "#E9C46A",
    accentText: "#0B1F17", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.35)", greenText: "#7FC9A2",
    red: "#E63946", redSoft: "rgba(230,57,70,0.2)", toastBg: "#F1FAEE", toastText: "#0B1F17",
  },
  light: {
    bg: "#F6F5F0", surface: "rgba(14,42,32,0.04)", surfaceHover: "rgba(14,42,32,0.07)",
    border: "rgba(14,42,32,0.10)", borderStrong: "rgba(14,42,32,0.18)", text: "#0E2A20",
    textDim: "rgba(14,42,32,0.6)", textFaint: "rgba(14,42,32,0.4)", accent: "#B4802E",
    accentText: "#F6F5F0", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.15)", greenText: "#1F6B45",
    red: "#C4293A", redSoft: "rgba(196,41,58,0.12)", toastBg: "#0E2A20", toastText: "#F6F5F0",
  },
};

const FORMATS = [
  { id: "single_round_robin", label: "Single Round Robin", desc: "Every club plays every other club once.", available: true },
  { id: "double_round_robin", label: "Double Round Robin", desc: "Home and away — every club plays every other club twice.", available: true },
  { id: "knockout", label: "Knockout", desc: "Single elimination. Lose and you're out.", available: true },
  { id: "survivor", label: "Survivor", desc: "Play a set number of matches, cut the bottom %, repeat until a target number remain, then finish with a round robin.", available: true },
  { id: "groups_knockout", label: "Groups + Knockout", desc: "Split into groups for a round robin, then top clubs advance to a knockout stage.", available: true },
];

// Letter labels for groups: Group A, Group B, ... Group Z, then AA, AB...
function groupLabel(n) {
  let s = "";
  let x = n;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return `Group ${s}`;
}

// Distributes team ids into `groupsCount` groups as evenly as possible (snake-shuffled first).
function assignGroups(teamIds, groupsCount) {
  const shuffled = shuffle(teamIds);
  const groups = Array.from({ length: groupsCount }, () => []);
  shuffled.forEach((id, i) => groups[i % groupsCount].push(id));
  return groups;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roundRobin(teamIds) {
  const ids = [...teamIds];
  if (ids.length % 2 !== 0) ids.push(null);
  const n = ids.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      const home = ids[i];
      const away = ids[n - 1 - i];
      if (home !== null && away !== null) round.push({ home, away });
    }
    rounds.push(round);
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

function doubleRoundRobin(teamIds) {
  const firstLeg = roundRobin(teamIds);
  const secondLeg = firstLeg.map((round) => round.map(({ home, away }) => ({ home: away, away: home })));
  return [...firstLeg, ...secondLeg];
}

function knockoutRound1(teamIds) {
  const shuffled = shuffle(teamIds);
  const pairs = [];
  for (let i = 0; i < shuffled.length; i += 2) {
    if (i + 1 < shuffled.length) pairs.push({ home: shuffled[i], away: shuffled[i + 1] });
    else pairs.push({ home: shuffled[i], away: null });
  }
  return pairs;
}

function stageSchedule(teamIds, matchesWanted) {
  const k = Math.max(1, Math.min(matchesWanted, teamIds.length - 1));
  return roundRobin(shuffle(teamIds)).slice(0, k);
}

function finalStageSchedule(teamIds, finalFormat) {
  return finalFormat === "double_round_robin" ? doubleRoundRobin(teamIds) : roundRobin(teamIds);
}

// dueBase: Date the clock starts counting from. Each round gets +2 days on top of the previous.
function toFixtureRows(leagueId, rounds, stage, dueBase, roundOffset = 0) {
  const rows = [];
  rounds.forEach((round, ri) => {
    const roundNumber = ri + 1 + roundOffset;
    const dueAt = new Date(dueBase.getTime() + roundNumber * TWO_DAYS_MS).toISOString();
    round.forEach(({ home, away }) => {
      const bye = away === null;
      rows.push({
        league_id: leagueId, round: roundNumber, stage,
        home_team_id: home, away_team_id: away,
        played: bye, home_score: bye ? 1 : 0, away_score: 0,
        due_at: dueAt,
      });
    });
  });
  return rows;
}

// Builds fixture rows for one knockout round. legs=1 is a single decisive match;
// legs=2 plays it home and away, aggregate score deciding the winner (byes are always single-leg).
function knockoutRoundFixtures(leagueId, teamIds, stage, roundNumber, dueBase, legs) {
  const pairs = knockoutRound1(teamIds);
  const leg1Due = new Date(dueBase.getTime() + roundNumber * TWO_DAYS_MS);
  const leg2Due = new Date(leg1Due.getTime() + TWO_DAYS_MS);
  const rows = [];
  pairs.forEach(({ home, away }) => {
    const bye = away === null;
    if (bye || legs !== 2) {
      rows.push({
        league_id: leagueId, round: roundNumber, leg: 1, stage,
        home_team_id: home, away_team_id: away,
        played: bye, home_score: bye ? 1 : 0, away_score: 0,
        due_at: leg1Due.toISOString(),
      });
    } else {
      rows.push({
        league_id: leagueId, round: roundNumber, leg: 1, stage,
        home_team_id: home, away_team_id: away,
        played: false, home_score: 0, away_score: 0,
        due_at: leg1Due.toISOString(),
      });
      rows.push({
        league_id: leagueId, round: roundNumber, leg: 2, stage,
        home_team_id: away, away_team_id: home,
        played: false, home_score: 0, away_score: 0,
        due_at: leg2Due.toISOString(),
      });
    }
  });
  return rows;
}

function generateOpeningFixtures(league, teamIds, dueBase) {
  const { id: leagueId, format, survivor_matches_per_stage, survivor_target_count, survivor_final_format, group_size, knockout_legs } = league;
  if (format === "single_round_robin") return { fixtureRows: toFixtureRows(leagueId, roundRobin(teamIds), 1, dueBase), startsInFinal: false, groups: null };
  if (format === "double_round_robin") return { fixtureRows: toFixtureRows(leagueId, doubleRoundRobin(teamIds), 1, dueBase), startsInFinal: false, groups: null };
  if (format === "knockout") return { fixtureRows: knockoutRoundFixtures(leagueId, teamIds, 1, 1, dueBase, knockout_legs || 1), startsInFinal: false, groups: null };
  if (format === "survivor") {
    if (teamIds.length <= survivor_target_count) {
      return { fixtureRows: toFixtureRows(leagueId, finalStageSchedule(teamIds, survivor_final_format), 1, dueBase), startsInFinal: true, groups: null };
    }
    return { fixtureRows: toFixtureRows(leagueId, stageSchedule(teamIds, survivor_matches_per_stage), 1, dueBase), startsInFinal: false, groups: null };
  }
  if (format === "groups_knockout") {
    // Groups are sized to the admin's chosen "players per group" — the number of
    // groups this actually produces depends on how many clubs are in by the time
    // the league starts, so it's worked out here rather than fixed up front.
    const desiredSize = Math.max(2, group_size || 4);
    const groupsCount = Math.max(2, Math.round(teamIds.length / desiredSize));
    const groups = assignGroups(teamIds, groupsCount);
    const fixtureRows = groups.flatMap((groupTeamIds) => toFixtureRows(leagueId, roundRobin(groupTeamIds), 1, dueBase));
    return { fixtureRows, startsInFinal: false, groups, groupsCount };
  }
  return { fixtureRows: [], startsInFinal: false, groups: null };
}

// Builds the knockout bracket fixtures from a set of already-qualified team ids.
// Knockout fixtures always live in stage 2, separate from the stage-1 group fixtures.
function knockoutBracketFixtures(leagueId, teamIds, roundOffset, dueBase, legs) {
  return knockoutRoundFixtures(leagueId, teamIds, 2, roundOffset + 1, dueBase, legs || 1);
}

function generationDueBase(league) {
  const now = new Date();
  if (league.starts_at) {
    const starts = new Date(league.starts_at);
    return starts > now ? starts : now;
  }
  return now;
}

async function insertChunked(table, rows, showToast) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + CHUNK));
    if (error) { showToast(`Couldn't save: ${error.message}`); return false; }
  }
  return true;
}

function isExpired(fixture) {
  return !fixture.played && !!fixture.due_at && new Date(fixture.due_at) < new Date();
}

// A submitted result gives the opponent 24 hours to confirm or dispute it
// (see respondToResultSubmission) before it escalates to the admin override
// queue. These three helpers are the single source of truth for that window
// so the opponent panel's countdown and the admin panel's visibility can't
// drift out of sync.
const RESULT_CONFIRM_WINDOW_HOURS = 24;
function resultConfirmDeadline(submission) {
  return new Date(new Date(submission.created_at).getTime() + RESULT_CONFIRM_WINDOW_HOURS * 60 * 60 * 1000);
}
function resultConfirmExpired(submission) {
  return Date.now() >= resultConfirmDeadline(submission).getTime();
}
function resultConfirmHoursLeft(submission) {
  const ms = resultConfirmDeadline(submission).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 60 * 1000));
}

// Expired, unplayed fixtures count as a loss for both sides once past their deadline.
function computeStandings(teams, fixtures) {
  const table = {};
  teams.forEach((t) => { table[t.id] = { id: t.id, name: t.name, eliminated: t.eliminated, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }; });
  fixtures.forEach((f) => {
    if (f.away_team_id === null) return;
    const h = table[f.home_team_id];
    const a = table[f.away_team_id];
    if (!h || !a) return;
    if (f.played) {
      h.p++; a.p++;
      h.gf += f.home_score; h.ga += f.away_score;
      a.gf += f.away_score; a.ga += f.home_score;
      if (f.home_score > f.away_score) { h.w++; h.pts += 3; a.l++; }
      else if (f.home_score < f.away_score) { a.w++; a.pts += 3; h.l++; }
      else { h.d++; a.d++; h.pts += 1; a.pts += 1; }
    } else if (isExpired(f)) {
      h.p++; a.p++; h.l++; a.l++;
    }
  });
  const rows = Object.values(table);
  rows.forEach((r) => { r.gd = r.gf - r.ga; });
  rows.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
  return rows;
}

// Points-table standings don't reflect a bracket properly — two teams that
// both lost in the semifinal are miles apart on points despite going
// exactly as far. This ranks knockout teams by the round they exited in
// instead (later round = better), tiebreaking same-round exits by aggregate
// goal difference across their exit-round leg(s) — the same aggregate rule
// advanceKnockout itself uses to decide a winner. Teams eliminated in a
// groups_knockout league's group stage (never reached the bracket) rank
// below every bracket team, ordered by their pooled group-stage record.
function computeKnockoutRanking(league) {
  const isGroupsKnockout = league.format === "groups_knockout";
  const isKnockout = league.format === "knockout" || isGroupsKnockout;
  if (!isKnockout) return computeStandings(league.teams, league.fixtures).map((r) => r.id);

  const bracketStage = isGroupsKnockout ? 2 : 1;
  const bracketFixtures = league.fixtures.filter((f) => f.stage === bracketStage);
  const bracketTeamIds = new Set();
  bracketFixtures.forEach((f) => { bracketTeamIds.add(f.home_team_id); if (f.away_team_id) bracketTeamIds.add(f.away_team_id); });
  const maxRound = bracketFixtures.length ? Math.max(...bracketFixtures.map((f) => f.round)) : 0;

  const scored = league.teams.filter((t) => bracketTeamIds.has(t.id)).map((t) => {
    const myFixtures = bracketFixtures.filter((f) => (f.home_team_id === t.id || f.away_team_id === t.id) && f.played);
    const exitRound = myFixtures.length ? Math.max(...myFixtures.map((f) => f.round)) : 0;
    const isChampion = !t.eliminated && exitRound === maxRound && exitRound > 0;
    let gf = 0, ga = 0;
    myFixtures.filter((f) => f.round === exitRound).forEach((f) => {
      if (f.home_team_id === t.id) { gf += f.home_score || 0; ga += f.away_score || 0; }
      else { gf += f.away_score || 0; ga += f.home_score || 0; }
    });
    return { id: t.id, name: t.name, isChampion, exitRound, gd: gf - ga };
  });
  scored.sort((a, b) => (b.isChampion - a.isChampion) || (b.exitRound - a.exitRound) || (b.gd - a.gd) || a.name.localeCompare(b.name));
  const rankedIds = scored.map((s) => s.id);

  if (isGroupsKnockout) {
    const groupOnlyTeams = league.teams.filter((t) => !bracketTeamIds.has(t.id));
    const groupFixtures = league.fixtures.filter((f) => f.stage === 1);
    rankedIds.push(...computeStandings(groupOnlyTeams, groupFixtures).map((r) => r.id));
  }
  return rankedIds;
}


// Seasons are 3-month windows that start from the date of the very first
// match ever played on the platform — not a fixed calendar quarter — so
// "Season 1" kicks off the moment anyone plays their first match, and
// every result from that day onward counts toward it (instead of results
// from before some arbitrary Jan/Apr/Jul/Oct boundary getting cut off).
// Nothing is ever deleted or archived to make this work: a season is just
// a date filter over fixtures that were already played, so every past
// season stays fully browsable forever via the season picker in the
// Leaderboard.
const SEASON_LENGTH_MS = 91 * 24 * 60 * 60 * 1000; // ~3 months per season

// A fixture's effective "played on" date. played_at is set going forward by
// recordResult and (once the SQL function is updated per the migration
// notes) approve_result_submission; fixtures saved before that column
// existed fall back to their row's created_at so old results still land in
// roughly the right season instead of vanishing from every season filter.
function fixturePlayedDate(f) { return f.played_at || f.created_at; }

// The date of the first match anyone ever played, across every league —
// this is what Season 1 starts from. Returns null if nothing's been played
// yet (nothing to anchor a season to).
function seasonAnchor(leagues) {
  let earliest = null;
  (leagues || []).forEach((l) => (l.fixtures || []).forEach((f) => {
    if (!f.played) return;
    const raw = fixturePlayedDate(f);
    if (!raw) return;
    const dt = new Date(raw);
    if (!earliest || dt < earliest) earliest = dt;
  }));
  return earliest;
}
function seasonIndexForDate(date, anchor) { return Math.floor((new Date(date) - anchor) / SEASON_LENGTH_MS); }
function seasonBounds(idx, anchor) {
  return { start: new Date(anchor.getTime() + idx * SEASON_LENGTH_MS), end: new Date(anchor.getTime() + (idx + 1) * SEASON_LENGTH_MS) };
}
function seasonKey(idx) { return `S${idx + 1}`; }
function seasonLabel(idx, anchor) {
  const { start, end } = seasonBounds(idx, anchor);
  const lastDay = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  const fmt = { day: "numeric", month: "short", year: "numeric" };
  return `Season ${idx + 1} · ${start.toLocaleDateString(undefined, fmt)} – ${lastDay.toLocaleDateString(undefined, fmt)}`;
}
function currentSeason(anchor) { return anchor ? seasonIndexForDate(new Date(), anchor) : 0; }
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

// Platform-wide leaderboard: aggregates every played fixture for every
// person across every league they've fielded a team in (grouped by user_id,
// not team, so someone's record follows them between leagues). Only people
// who've actually played a match show up — reactions/comments don't count
// toward this, match results do. Pass `bounds` ({start, end} Dates) to scope
// it to one season; pass null/undefined for the all-time board.
function computeGlobalLeaderboard(leagues, bounds) {
  const byUser = new Map();
  (leagues || []).forEach((l) => {
    (l.members || []).forEach((m) => {
      if (!m.team_id) return;
      const team = l.teams.find((t) => t.id === m.team_id);
      if (!team) return;
      const played = l.fixtures.filter((f) => {
        if (!f.played || f.away_team_id === null) return false;
        if (f.home_team_id !== team.id && f.away_team_id !== team.id) return false;
        if (!bounds) return true;
        const at = new Date(fixturePlayedDate(f));
        return at >= bounds.start && at < bounds.end;
      });
      if (played.length === 0) return;
      let acc = byUser.get(m.user_id);
      if (!acc) { acc = { userId: m.user_id, name: m.display_name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }; byUser.set(m.user_id, acc); }
      acc.name = m.display_name; // most recently seen display name wins
      played.forEach((f) => {
        const isHome = f.home_team_id === team.id;
        const gf = isHome ? f.home_score : f.away_score;
        const ga = isHome ? f.away_score : f.home_score;
        acc.p++; acc.gf += gf; acc.ga += ga;
        if (gf > ga) acc.w++; else if (gf < ga) acc.l++; else acc.d++;
      });
    });
  });
  return [...byUser.values()].map((r) => ({ ...r, gd: r.gf - r.ga, winRate: r.p ? r.w / r.p : 0, pts: r.w * 3 + r.d }));
}

// Picks out the top scorer and the best defensive record (fewest goals
// conceded) from a set of leaderboard/standings rows that already expose
// { name, gf, ga }. Requires at least one goal-scoring row to name a top
// scorer, and at least two qualifying rows before naming a separate
// defensive team (otherwise it would just be the same person twice). Ties
// break alphabetically so the result is stable rather than
// order-of-insertion dependent.
function goalExtremes(rows) {
  if (!rows || rows.length === 0) return { top: null, least: null };
  const byMost = [...rows].sort((a, b) => b.gf - a.gf || a.name.localeCompare(b.name));
  const byFewestConceded = [...rows].sort((a, b) => a.ga - b.ga || a.name.localeCompare(b.name));
  const top = byMost[0];
  let least = byFewestConceded[0];
  if (rows.length < 2) return { top, least: null };
  if (least === top || (least.userId !== undefined && least.userId === top.userId) || (least.id !== undefined && least.id === top.id)) {
    least = byFewestConceded[1];
  }
  return { top, least };
}


// member id -> { rank, contribution, directPrize, redistributed, total }
// for every member who actually won a place (top 8 by ranking, among
// approved/paid members only). Works off whatever fixtures currently exist,
// so callers decide whether that's a live projection or the final result —
// see memberBalance and the "started/complete" lifecycle below.
function computeCashPrizes(league) {
  const results = new Map();
  if (!league || league.league_type !== "cash") return results;
  const pool = (league.members || []).filter((m) => m.payment_status === "approved").reduce((sum, m) => sum + (m.entry_fee || 0), 0);
  if (pool <= 0) return results;
  const rankedTeamIds = computeKnockoutRanking(league);
  const approvedByTeamId = new Map((league.members || [])
    .filter((m) => m.payment_status === "approved" && m.team_id)
    .map((m) => [m.team_id, m]));

  const winners = [];
  for (const teamId of rankedTeamIds) {
    if (winners.length >= PRIZE_PAYOUT_PERCENTAGES.length) break;
    const member = approvedByTeamId.get(teamId);
    if (!member) continue; // only paid, approved members can draw a place
    const sharePercent = PRIZE_PAYOUT_PERCENTAGES[winners.length];
    const entryRatio = Math.min(member.entry_fee || 0, ENTRY_FEE_MAX) / ENTRY_FEE_MAX;
    const directPrize = sharePercent * entryRatio * pool;
    winners.push({ member, rank: winners.length + 1, directPrize });
  }
  const directTotal = winners.reduce((sum, w) => sum + w.directPrize, 0);
  const leftover = Math.max(0, pool - directTotal);
  for (const w of winners) {
    const redistributed = directTotal > 0 ? (w.directPrize / directTotal) * leftover : 0;
    results.set(w.member.id, {
      rank: w.rank,
      contribution: w.member.entry_fee || 0,
      directPrize: w.directPrize,
      redistributed,
      total: w.directPrize + redistributed,
    });
  }
  return results;
}

// A member's balance, per the WeAfrica cash-league rule: the entry fee
// shows as balance while registration is open, gets deducted (balance back
// to R0.00) once the league actually starts and the money is "in play", and
// then reflects prize winnings once the league is complete. Unapproved
// members always show R0.00 — they haven't put anything in yet.
function memberBalance(league, member) {
  if (!league || league.league_type !== "cash" || member.payment_status !== "approved") return 0;
  const started = league.fixtures.length > 0;
  if (!started) return member.entry_fee || 0;
  const complete = league.fixtures.every((f) => f.played);
  if (!complete) return 0;
  return computeCashPrizes(league).get(member.id)?.total || 0;
}

// Result posts are just rows in the `comments` table, tagged is_result:true
// when we control the insert (recordResult / approveResult / rejectResult).
// The one path we don't control — the security-definer approve_result_submission
// SQL function posting its own "under the submitter's identity" comment — predates
// that column, so this also recognises the scoreline shape it writes
// ("Home 2 – 1 Away") as a fallback, keeping older/DB-side result posts grouped
// correctly even before that function is updated to set the flag itself.
function isResultComment(body, isResultFlag) {
  if (isResultFlag) return true;
  if (!body) return false;
  if (body.includes("approved result —") || body.includes("result was rejected —")) return true;
  return /^.+\s\d+\s*–\s*\d+\s.+$/.test(body.trim());
}

// Splits a league's flat comment list into two flat lists — "results" and
// "regular" — by walking each comment up to its root and classifying by the
// root. A reply inherits its root's bucket even if the reply text itself
// doesn't look like a scoreline, so a whole results thread (and its chatter)
// stays together under the Table tab, separate from general discussion.
function splitCommentsByRoot(comments) {
  const byId = new Map(comments.map((cm) => [cm.id, cm]));
  const results = [];
  const regular = [];
  for (const cm of comments) {
    let root = cm;
    const seen = new Set();
    while (root.parent_comment_id && byId.has(root.parent_comment_id) && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.parent_comment_id);
    }
    (isResultComment(root.body, root.is_result) ? results : regular).push(cm);
  }
  return { results, regular };
}

// Given a pending result submission, finds the user_id of the player on the
// *other* side of that fixture — the one who should be confirming or
// disputing it, as opposed to the submitter or an uninvolved third party.
// Goes submission -> submitter's member row -> submitter's team_id -> the
// fixture's other team_id -> that team's member row -> its user_id. Returns
// null if any link is missing (spectator submitted it, team unclaimed, etc.),
// in which case only an admin override applies.
function findSubmissionOpponentId(league, submission) {
  const fixture = league.fixtures.find((f) => f.id === submission.fixture_id);
  if (!fixture) return null;
  const submitterMember = (league.members || []).find((m) => m.user_id === submission.submitted_by);
  const submitterTeamId = submitterMember?.team_id;
  const opponentTeamId = [fixture.home_team_id, fixture.away_team_id]
    .find((tid) => tid && tid !== submitterTeamId);
  if (!opponentTeamId) return null;
  const opponentMember = (league.members || []).find((m) => m.team_id === opponentTeamId);
  return opponentMember?.user_id || null;
}

function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Short relative timestamp for comments/replies — falls back to the full
// date once something's more than a week old, where "how many days ago"
// stops being useful and the actual date is what you want.
function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return fmtDate(iso);
}

// Deterministic avatar background per username — same person always gets the
// same color, and different people are visually distinguishable in a thread,
// the way any social feed tells commenters apart at a glance.
const AVATAR_HUES = [142, 168, 25, 45, 200, 280, 340, 10];

// Days remaining until a ladder challenge deadline (accept-by or log-by).
// The actual expiry/penalty is enforced server-side (process_stale_ladder_challenges);
// this is purely the countdown shown in the UI. Returns null once it's passed
// (server will have already resolved it by the time that's visible here).
function ladderDaysLeft(fromISO, windowDays) {
  if (!fromISO) return null;
  const deadline = new Date(fromISO).getTime() + windowDays * 24 * 60 * 60 * 1000;
  const ms = deadline - Date.now();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
function avatarColor(seed) {
  const s = seed || "?";
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  const hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  return `hsl(${hue}, 42%, 38%)`;
}

// WhatsApp's own brand green — kept constant across both themes so the button
// reads as "WhatsApp" at a glance rather than blending into the app's palette.
const WHATSAPP_GREEN = "#25D366";

// Builds a wa.me deep link with an optional prefilled message. wa.me opens
// whichever WhatsApp variant — regular or Business — is installed as the
// device's default handler for that number; there's no separate universal
// link that can force Business specifically when both apps are present, so
// this is the closest a web link can get to "open in Business WhatsApp".
function waLink(phone, text) {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

// Small pill button used anywhere we offer to message a club's registered
// number. Renders nothing if there's no usable phone number, so callers can
// place it directly after a phone number without an extra guard. With
// iconOnly, renders as a plain round icon button and drops the text label —
// used in fixtures where we show the WhatsApp entry point but not the raw
// number itself.
function WhatsAppLink({ phone, text, label, iconOnly, c }) {
  const href = waLink(phone, text);
  if (!href) return null;
  if (iconOnly) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title="Message on WhatsApp"
        className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0"
        style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
        <MessageCircle size={14} />
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title="Message on WhatsApp"
      className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold px-2 py-1 rounded-full shrink-0"
      style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
      <MessageCircle size={11} /> {label || "WhatsApp"}
    </a>
  );
}

function Loader({ c }) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 rounded-full animate-spin" style={{ border: `2px solid ${c.green}`, borderTopColor: "transparent" }} />
    </div>
  );
}

// Guards destructive admin actions (delete league, remove a club, reject a club's
// payment) behind several sequential confirmations rather than one window.confirm().
// `flow` is { steps, step, action } from the requestConfirm/advanceConfirm helpers.
function ConfirmStepModal({ flow, onCancel, onAdvance, c }) {
  if (!flow) return null;
  const { steps, step } = flow;
  const isLast = step === steps.length - 1;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.65)" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl p-5" style={{ background: c.bg, border: `1px solid ${c.borderStrong}` }}>
        <div className="flex items-center gap-2 mb-3" style={{ color: c.red }}>
          <AlertTriangle size={16} />
          <span className="font-mono text-[10px] uppercase tracking-wider">Confirm {step + 1} of {steps.length}</span>
        </div>
        <div className="font-body text-sm mb-5" style={{ color: c.text }}>{steps[step]}</div>
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 font-body text-sm font-semibold px-4 py-2.5 rounded-full" style={{ background: c.surfaceHover, color: c.text }}>
            Cancel
          </button>
          <button onClick={onAdvance} className="flex-1 font-body text-sm font-semibold px-4 py-2.5 rounded-full" style={{ background: c.red, color: "#fff" }}>
            {isLast ? "Yes, do it" : "Yes, continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Entry-fee + proof-of-payment modal for cash leagues. Used both for the initial
// join and for resubmitting after a rejected payment (when `member` is set).
function PaymentModal({ league, member, onCancel, onSubmit, c }) {
  const [fee, setFee] = useState(clampFee(member?.entry_fee || 50));
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const inputStyle = { background: c.surfaceHover, borderColor: c.border, color: c.text };
  const isResubmit = !!member;

  const submit = async () => {
    if (!file || saving) return;
    setSaving(true);
    await onSubmit(fee, file);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Wallet size={18} style={{ color: c.accent }} />
            <h2 className="text-xl font-extrabold uppercase tracking-tight">{isResubmit ? "Resubmit payment" : "Join cash league"}</h2>
          </div>
          <button onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>
        <div className="font-body text-sm mb-4" style={{ color: c.textDim }}>{league.name}</div>

        <div className="rounded-lg p-3 mb-3 font-body text-xs" style={{ background: c.surface, color: c.textDim }}>
          <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: c.textFaint }}>
            <Wallet size={11} /> Payment details
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span style={{ color: c.textFaint }}>Bank</span><span>{BANK_DETAILS.bank}</span>
            <span style={{ color: c.textFaint }}>Account name</span><span>{BANK_DETAILS.accountName}</span>
            <span style={{ color: c.textFaint }}>Account number</span><span className="font-mono">{BANK_DETAILS.accountNumber}</span>
            <span style={{ color: c.textFaint }}>Account type</span><span>{BANK_DETAILS.accountType}</span>
          </div>
        </div>
        <div className="font-body text-[11px] mb-4" style={{ color: c.textFaint }}>
          The more you put in, the bigger your prize — {formatRand(ENTRY_FEE_MAX)} is the max contribution (100% share). Your prize for a place is scaled by your entry as a fraction of {formatRand(ENTRY_FEE_MAX)}.
        </div>

        {league.description && (
          <div className="rounded-lg p-3 mb-4 font-body text-xs whitespace-pre-wrap" style={{ background: c.surface, color: c.textDim }}>
            <div className="font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: c.textFaint }}>Note from the league admin</div>
            {league.description}
          </div>
        )}

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>
          Entry fee <span style={{ color: c.textFaint }}>({formatRand(ENTRY_FEE_MIN)}–{formatRand(ENTRY_FEE_MAX)})</span>
        </label>
        <div className="flex flex-wrap gap-2 mb-2">
          {ENTRY_FEE_PRESETS.map((amt) => (
            <button key={amt} onClick={() => setFee(amt)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border"
              style={{ borderColor: fee === amt ? c.accent : c.border, background: fee === amt ? c.surfaceHover : "transparent" }}>
              {formatRand(amt)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mb-5">
          <span className="font-mono text-sm" style={{ color: c.textFaint }}>R</span>
          <input type="number" min={ENTRY_FEE_MIN} max={ENTRY_FEE_MAX} step={ENTRY_FEE_STEP} value={fee}
            onChange={(e) => setFee(e.target.value === "" ? "" : Number(e.target.value))}
            onBlur={() => setFee(clampFee(fee))}
            className="w-28 border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
          <span className="font-body text-xs" style={{ color: c.textFaint }}>custom amount</span>
        </div>

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Proof of payment</label>
        <label className="flex items-center gap-2 border border-dashed rounded-lg px-4 py-3 mb-1 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
          <Upload size={15} style={{ color: c.textFaint }} />
          {file ? file.name : "Upload a screenshot or PDF of your payment"}
          <input type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <div className="font-mono text-[11px] mb-5" style={{ color: c.textFaint }}>
          The admin reviews this before your registration is confirmed. You'll keep your club either way.
        </div>

        <button disabled={!file || saving} onClick={submit} className="w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full"
          style={file && !saving ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {saving ? "Submitting…" : `Submit ${formatRand(clampFee(fee))} for approval`}
        </button>
      </div>
    </div>
  );
}

// Lets a joined player propose a result for a fixture, same score inputs an
// admin gets, but a photo of the final scoreboard is required and the result
// doesn't count until the admin/creator approves it. If `existing` is a
// rejected submission, the score fields are pre-filled and the note is shown
// so the player knows what to fix before resubmitting.
function SubmitResultModal({ league, fixture, homeTeam, awayTeam, existing, onCancel, onSubmit, c }) {
  const [h, setH] = useState(existing ? existing.home_score : 0);
  const [a, setA] = useState(existing ? existing.away_score : 0);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!file || saving) return;
    setSaving(true);
    await onSubmit(h, a, file);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Trophy size={18} style={{ color: c.accent }} />
            <h2 className="text-xl font-extrabold uppercase tracking-tight">{existing ? "Resubmit result" : "Submit result"}</h2>
          </div>
          <button onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>
        <div className="font-body text-sm mb-4" style={{ color: c.textDim }}>{league.name}</div>

        {existing?.review_note && (
          <div className="rounded-lg p-3 mb-4 font-body text-xs" style={{ background: c.redSoft, color: c.red }}>
            <div className="font-mono text-[10px] uppercase tracking-wider mb-1">Rejected — admin's note</div>
            {existing.review_note}
          </div>
        )}

        <div className="flex items-center gap-2 mb-5">
          <div className="flex-1 min-w-0">
            <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{homeTeam?.name || "Home"}</div>
            <input type="number" min={0} value={h} onChange={(e) => setH(Number(e.target.value))}
              className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
          </div>
          <span className="self-end pb-2" style={{ color: c.textFaint }}>–</span>
          <div className="flex-1 min-w-0">
            <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{awayTeam?.name || "Away"}</div>
            <input type="number" min={0} value={a} onChange={(e) => setA(Number(e.target.value))}
              className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
          </div>
        </div>

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Photo proof (required)</label>
        <label className="flex items-center gap-2 border border-dashed rounded-lg px-4 py-3 mb-1 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
          <Camera size={15} style={{ color: c.textFaint }} />
          {file ? file.name : "Upload a screenshot of the final scoreboard"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <div className="font-mono text-[11px] mb-5" style={{ color: c.textFaint }}>
          The admin reviews this before it counts — once approved it's posted to the comments under your name automatically.
        </div>

        <button disabled={!file || saving} onClick={submit} className="w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full"
          style={file && !saving ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {saving ? "Submitting…" : "Submit for admin approval"}
        </button>
      </div>
    </div>
  );
}

// Lets either side of an accepted challenge log the final score. No photo
// proof here (unlike league results) — it's a friendly 1v1, and the other
// player has to confirm the number before it counts anyway, so a bad-faith
// score just gets disputed instead of quietly landing.
function LogChallengeResultModal({ challenge, myUsername, opponentUsername, onCancel, onSubmit, c }) {
  const [mine, setMine] = useState(0);
  const [theirs, setTheirs] = useState(0);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!file || saving) return;
    setSaving(true);
    await onSubmit(mine, theirs, file);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Trophy size={18} style={{ color: c.accent }} />
            <h2 className="text-xl font-extrabold uppercase tracking-tight">Log result</h2>
          </div>
          <button onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>
        <div className="font-body text-sm mb-4" style={{ color: c.textDim }}>vs {opponentUsername}</div>

        <div className="flex items-center gap-2 mb-5">
          <div className="flex-1 min-w-0">
            <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{myUsername} (you)</div>
            <input type="number" min={0} value={mine} onChange={(e) => setMine(Number(e.target.value))}
              className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
          </div>
          <span className="self-end pb-2" style={{ color: c.textFaint }}>–</span>
          <div className="flex-1 min-w-0">
            <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{opponentUsername}</div>
            <input type="number" min={0} value={theirs} onChange={(e) => setTheirs(Number(e.target.value))}
              className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
          </div>
        </div>

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Photo proof (required)</label>
        <label className="flex items-center gap-2 border border-dashed rounded-lg px-4 py-3 mb-1 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
          <Camera size={15} style={{ color: c.textFaint }} />
          {file ? file.name : "Upload a screenshot of the final scoreboard"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <div className="font-mono text-[11px] mb-5" style={{ color: c.textFaint }}>
          {opponentUsername} will see this photo and needs to confirm the score before it counts.
        </div>

        <button disabled={!file || saving} onClick={submit} className="w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full"
          style={file && !saving ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {saving ? "Logging…" : "Log result"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [leagues, setLeagues] = useState(null);
  const [view, setView] = useState("home");
  const [activeLeagueId, setActiveLeagueId] = useState(null);
  const [toast, setToast] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || "dark");
  const [handledDeepLink, setHandledDeepLink] = useState(false);
  const [paymentModal, setPaymentModal] = useState(null); // { league, member } — member set only when resubmitting
  const [resultModal, setResultModal] = useState(null); // { league, fixture, homeTeam, awayTeam, existing } — existing set only when resubmitting a rejected result
  const [challengeResultModal, setChallengeResultModal] = useState(null); // { kind: "challenge" | "open", challenge } — logging a score for an accepted challenge
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [accounts, setAccounts] = useState(null); // admin-only: every profile on the platform
  const [challengeMembers, setChallengeMembers] = useState(null); // every other member, for the challenge picker
  const [challenges, setChallenges] = useState(null); // every challenge involving the signed-in member, either side
  const [openChallenges, setOpenChallenges] = useState(null); // broadcast "random challenge" pool — open to whoever accepts first
  const [recentResults, setRecentResults] = useState(null); // last 100 confirmed challenge results, platform-wide (community feed)
  const [boardComments, setBoardComments] = useState(null); // platform-wide comment wall shown under Challenges
  const [ladder, setLadder] = useState(null); // the whole permanent ladder, ordered by rank_position — never resets
  const [ladderChallengeOpen, setLadderChallengeOpen] = useState(false); // the "who can I challenge" sheet
  const [confirmFlow, setConfirmFlow] = useState(null); // { steps: string[], step: number, action: () => void }
  const c = THEMES[theme];

  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 3200); }, []);

  // Guards the three destructive admin actions (delete league, remove a club, reject a
  // club's payment) behind 5 sequential, increasingly explicit confirmations instead of a
  // single window.confirm() — makes an accidental tap or misclick far less likely to
  // destroy data. Pass an array of up to 5 messages (last one is shown right before the
  // action fires) and the action to run once the admin has confirmed every step.
  const requestConfirm = useCallback((steps, action) => setConfirmFlow({ steps, step: 0, action }), []);
  const cancelConfirm = useCallback(() => setConfirmFlow(null), []);
  const advanceConfirm = useCallback(() => {
    setConfirmFlow((prev) => {
      if (!prev) return prev;
      if (prev.step >= prev.steps.length - 1) {
        prev.action();
        return null;
      }
      return { ...prev, step: prev.step + 1 };
    });
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
  };

  // `stay` is set right before the redirect fires, not baked into the
  // client at load time — the Google sign-in flow leaves the page and
  // comes back, so the preference has to already be sitting in
  // localStorage by the time the returning page reads the session back out.
  const signInWithGoogle = async (stay = true) => {
    setStaySignedInPreference(stay);
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.href } });
  };

  const signOut = async () => { await supabase.auth.signOut(); clearAllAuthStorage(); setView("home"); };

  const loadLeagues = useCallback(async () => {
    const { data, error } = await supabase
      .from("leagues")
      .select("*, teams(*), fixtures(*), members(*), comments(*, comment_likes(*)), result_submissions(*), league_reactions(*)")
      .order("created_at", { ascending: false });
    if (error) { showToast("Couldn't load leagues."); setLeagues([]); return; }
    setLeagues(data || []);
  }, [showToast]);

  // Admin-only — every account on the platform, for the Accounts screen.
  // Calls a SECURITY DEFINER function (get_all_accounts) rather than
  // selecting from `profiles` directly, since that's what lets us also pull
  // each account's Google sign-in email from auth.users — a table normal
  // client queries can't reach. The function itself checks the caller is an
  // admin and returns nothing otherwise, so this is safe even if someone
  // calls it directly.
  const loadAccounts = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_all_accounts");
    if (error) { showToast("Couldn't load accounts."); setAccounts([]); return; }
    setAccounts(data || []);
  }, [showToast]);

  // Admin-only — permanently deletes an account (login, profile, phone,
  // membership rows) via the admin_delete_account() SQL function. Anything a
  // running league already shows — club names, fixtures, results — is
  // untouched, since those are stored as their own snapshotted text, not
  // looked up live from the account. Leagues the account created keep
  // running too; the function just hands them off to platform admins to
  // manage instead of deleting them.
  const deleteAccount = async (account, leagueCounts) => {
    const label = account.efootball_username || account.email || "this account";
    const createdWarning = leagueCounts.created > 0
      ? ` They created ${leagueCounts.created} league${leagueCounts.created === 1 ? "" : "s"} — ${leagueCounts.created === 1 ? "it" : "those"} will keep running exactly as-is, just manageable only by platform admins from now on.`
      : "";
    const joinedWarning = leagueCounts.joined > 0
      ? ` They're a member of ${leagueCounts.joined} league${leagueCounts.joined === 1 ? "" : "s"} — their club name and results stay in those leagues, just no longer linked to a live account.`
      : "";
    if (!window.confirm(`Permanently delete ${label}'s account? This removes their login, phone number and profile for good and can't be undone.${createdWarning}${joinedWarning}`)) return;
    const { error } = await supabase.rpc("admin_delete_account", { target_user_id: account.user_id });
    if (error) { showToast(`Couldn't delete account: ${error.message}`); return; }
    setAccounts((prev) => (prev || []).filter((a) => a.user_id !== account.user_id));
    await loadLeagues();
    showToast(`${label} deleted.`);
  };

  // Admin-only — marks an account approved via a security-definer function
  // (a normal client update to another user's profiles row would be blocked
  // by RLS, same reasoning as admin_delete_account above).
  const approveAccount = async (account) => {
    const { error } = await supabase.rpc("admin_set_account_approved", { target_user_id: account.user_id, is_approved: true });
    if (error) { showToast(`Couldn't approve account: ${error.message}`); return; }
    setAccounts((prev) => (prev || []).map((a) => (a.user_id === account.user_id ? { ...a, approved: true } : a)));
  };

  // Every other member on the platform, for the "who do you want to challenge"
  // picker — just enough to browse and pick someone (username + photo), never
  // phone numbers. Calls a SECURITY DEFINER function since normal client
  // queries can only read the signed-in member's own profiles row.
  const loadChallengeMembers = useCallback(async () => {
    const { data, error } = await supabase.rpc("list_challengeable_members");
    if (error) { showToast("Couldn't load members."); setChallengeMembers([]); return; }
    setChallengeMembers(data || []);
  }, [showToast]);

  // Every challenge the signed-in member is involved in, either as the one who
  // sent it or the one who received it.
  const loadChallenges = useCallback(async () => {
    if (!session) return;
    await supabase.rpc("process_stale_ladder_challenges");
    const { data, error } = await supabase.from("challenges")
      .select("*")
      .or(`challenger_id.eq.${session.user.id},opponent_id.eq.${session.user.id}`)
      .order("created_at", { ascending: false });
    if (error) { showToast("Couldn't load challenges."); setChallenges([]); return; }
    setChallenges(data || []);
  }, [session, showToast]);

  // The permanent ladder — every member, ordered by rank_position. Never
  // resets (that's the whole point), unlike seasons/leagues elsewhere in the
  // app. RLS only allows reading this while signed in; the login screen
  // shows its own top-5 public view instead (see PublicLadderPreview).
  const loadLadder = useCallback(async () => {
    await supabase.rpc("process_stale_ladder_challenges");
    const { data, error } = await supabase.from("ladder_ranks").select("*").order("rank_position", { ascending: true });
    if (error) { console.error("Couldn't load the ladder:", error.message); setLadder([]); return; }
    setLadder(data || []);
  }, []);

  // The only people the signed-in member is allowed to send a ladder
  // challenge to: the (up to) 3 names directly above them. Ordered closest
  // rank first, since that's the one worth trying first.
  const ladderTargets = useMemo(() => {
    if (!ladder || !session) return [];
    const mine = ladder.find((r) => r.user_id === session.user.id);
    if (!mine) return [];
    return ladder
      .filter((r) => r.rank_position < mine.rank_position && r.rank_position >= mine.rank_position - 3)
      .sort((a, b) => b.rank_position - a.rank_position);
  }, [ladder, session]);
  const myLadderRank = useMemo(() => (ladder && session ? ladder.find((r) => r.user_id === session.user.id) : null), [ladder, session]);

  // Sends a challenge to another member. Snapshots the challenger's own
  // username/phone onto the row right away (same pattern used everywhere
  // else in the app — a team's display_name/phone are snapshotted at join
  // time too) — the opponent's phone stays off the row entirely until they
  // accept, so nobody's number is exposed before they've agreed to it.
  // `isLadder` tags it so that, if it's ever confirmed as a win, the
  // ladder-promotion trigger in Supabase actually moves the two of them.
  const sendChallenge = async (opponent, isLadder = false) => {
    const { error } = await supabase.from("challenges").insert({
      challenger_id: session.user.id,
      challenger_username: profile.efootball_username,
      challenger_phone: profile.phone,
      opponent_id: opponent.user_id,
      opponent_username: opponent.username,
      is_ladder: isLadder,
    });
    if (error) { showToast(`Couldn't send challenge: ${error.message}`); return; }
    await loadChallenges();
    showToast(isLadder ? `Ladder challenge sent to ${opponent.username} — win it and their spot is yours.` : `Challenge sent to ${opponent.username}.`);
  };

  // Accepting fills in the opponent's own phone right at the moment they agree
  // to it — the only way their number ever lands on the row. Declining just
  // flips the status so the challenger can see it was seen and passed on.
  const respondChallenge = async (challenge, accept) => {
    const update = accept
      ? { status: "accepted", opponent_phone: profile.phone, responded_at: new Date().toISOString() }
      : { status: "declined", responded_at: new Date().toISOString() };
    const { error } = await supabase.from("challenges").update(update).eq("id", challenge.id);
    if (error) { showToast(`Couldn't respond: ${error.message}`); return; }
    await loadChallenges();
    showToast(accept ? `Challenge accepted — say hi on WhatsApp.` : "Challenge declined.");
  };

  // Withdraws a still-pending challenge (challenger's side), or clears a
  // declined/accepted one off the list once it's been seen — either way just
  // removes the row for both sides.
  const removeChallenge = async (challenge) => {
    const { error } = await supabase.from("challenges").delete().eq("id", challenge.id);
    if (error) { showToast(`Couldn't remove challenge: ${error.message}`); return; }
    setChallenges((prev) => (prev || []).filter((ch) => ch.id !== challenge.id));
  };

  // Either side of an accepted challenge can log the score first — it lands as
  // "pending" until the other player confirms it (see confirmChallengeResult).
  // Scores are stored from the challenger's perspective (challenger_score /
  // opponent_score) regardless of who reports them, so the row has one
  // unambiguous scoreline no matter which side typed it in.
  const reportChallengeResult = async (challenge, myScore, theirScore, file) => {
    if (!file) { showToast("Attach a photo of the final scoreboard before logging a result."); return; }
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${session.user.id}/challenge-${challenge.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("result-proofs").upload(path, file);
    if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return; }

    const iAmChallenger = challenge.challenger_id === session.user.id;
    const update = {
      challenger_score: iAmChallenger ? myScore : theirScore,
      opponent_score: iAmChallenger ? theirScore : myScore,
      result_status: "pending",
      result_reported_by: session.user.id,
      result_reported_at: new Date().toISOString(),
      result_photo_path: path,
    };
    const { error } = await supabase.from("challenges").update(update).eq("id", challenge.id);
    if (error) { showToast(`Couldn't log result: ${error.message}`); return; }
    await loadChallenges();
    showToast("Result logged — waiting for them to confirm.");
  };

  // The player who *didn't* report the score confirms it — this is enforced
  // both here (only offered to the other side in the UI) and should be
  // enforced again in RLS (result_reported_by <> auth.uid()) so a reporter
  // can't just confirm their own number.
  const confirmChallengeResult = async (challenge) => {
    const { error } = await supabase.from("challenges")
      .update({ result_status: "confirmed", result_confirmed_at: new Date().toISOString() })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't confirm result: ${error.message}`); return; }
    await loadChallenges();
    if (challenge.is_ladder) await loadLadder();
    showToast(challenge.is_ladder ? "Result confirmed — the ladder just updated." : "Result confirmed.");
  };

  // Same signed-URL pattern as downloadResultProof, but for a challenge/open
  // challenge row's result_photo_path rather than a league submission.
  const viewChallengeResultProof = async (challenge) => {
    if (!challenge.result_photo_path) return;
    const { data, error } = await supabase.storage.from("result-proofs").createSignedUrl(challenge.result_photo_path, 120);
    if (error || !data) { showToast("Couldn't generate a download link."); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  // Rejects a reported score and clears it back to no-result, so either side
  // can log a fresh (hopefully accurate) one.
  const disputeChallengeResult = async (challenge) => {
    const { error } = await supabase.from("challenges")
      .update({ challenger_score: null, opponent_score: null, result_status: null, result_reported_by: null, result_reported_at: null, result_photo_path: null })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't dispute result: ${error.message}`); return; }
    await loadChallenges();
    showToast("Result disputed — ask them to re-log it.");
  };

  // The "random challenge" pool: broadcasts open to every other member, plus
  // whatever the signed-in member has posted or grabbed themselves (so their
  // own history sticks around even after it resolves).
  const loadOpenChallenges = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.from("open_challenges")
      .select("*")
      .or(`status.eq.open,creator_id.eq.${session.user.id},accepted_by.eq.${session.user.id}`)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) { showToast("Couldn't load random challenges."); setOpenChallenges([]); return; }
    setOpenChallenges(data || []);
  }, [session, showToast]);

  // Community feed at the bottom of the Challenges screen: the last 100
  // logged results from every member on the platform — both confirmed and
  // still-awaiting-confirmation, direct challenges and random challenges
  // combined. Reads from the public_challenge_results view (see README) so
  // it isn't limited to the signed-in member's own rows the way
  // loadChallenges/loadOpenChallenges are. Logged to the console (not a
  // toast — this feed is a nice-to-have, not worth interrupting anyone) so
  // a missing/misconfigured view is easy to spot while debugging instead of
  // just silently showing an empty feed.
  const loadRecentResults = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.from("public_challenge_results")
      .select("*")
      .order("result_confirmed_at", { ascending: false })
      .limit(100);
    if (error) { console.error("Couldn't load community results:", error.message); setRecentResults([]); return; }
    setRecentResults(data || []);
  }, [session]);

  // Comment wall shown under Challenges — a single platform-wide board (not
  // tied to any one league or challenge) for banter, callouts, and general
  // chat. Backed by its own tables so it's independent of the per-league
  // comments system: open to any signed-in member, no join/membership
  // concept applies here the way it does inside a league.
  const loadBoardComments = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.from("challenge_board_comments")
      .select("*, challenge_board_comment_likes(*)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) { console.error("Couldn't load the challenge board:", error.message); setBoardComments([]); return; }
    setBoardComments(data || []);
  }, [session]);

  const postBoardComment = async (body, parentComment = null) => {
    const trimmed = (body || "").trim();
    if (!trimmed) return false;
    const username = profile?.efootball_username || session.user.email;
    const { error } = await supabase.from("challenge_board_comments").insert({
      user_id: session.user.id, username, body: trimmed,
      parent_comment_id: parentComment?.id || null,
    });
    if (error) { showToast(`Couldn't post ${parentComment ? "reply" : "comment"}: ${error.message}`); return false; }
    await loadBoardComments();
    return true;
  };

  // A comment with replies underneath it warns about taking those replies
  // down with it — replies nest to unlimited depth, so this counts every
  // descendant, not just direct children.
  const deleteBoardComment = (comment) => {
    const all = boardComments || [];
    const countDescendants = (id) => {
      const direct = all.filter((cm) => cm.parent_comment_id === id);
      return direct.reduce((sum, d) => sum + 1 + countDescendants(d.id), 0);
    };
    const replyCount = countDescendants(comment.id);
    const message = comment.parent_comment_id
      ? "Delete this reply? This can't be undone."
      : replyCount > 0
        ? `Delete this comment and its ${replyCount} repl${replyCount === 1 ? "y" : "ies"}? This can't be undone.`
        : "Delete this comment? This can't be undone.";
    requestConfirm([message], async () => {
      const { error } = await supabase.from("challenge_board_comments").delete().eq("id", comment.id);
      if (error) { showToast(`Couldn't delete comment: ${error.message}`); return; }
      await loadBoardComments();
      showToast(comment.parent_comment_id ? "Reply deleted." : "Comment deleted.");
    });
  };

  const toggleBoardCommentReaction = async (comment, reaction) => {
    const mine = (comment.challenge_board_comment_likes || []).find((l) => l.user_id === session.user.id);
    if (reaction === null) {
      if (!mine) return true;
      const { error } = await supabase.from("challenge_board_comment_likes").delete().eq("id", mine.id);
      if (error) { showToast(`Couldn't remove reaction: ${error.message}`); return false; }
    } else if (mine) {
      const { error } = await supabase.from("challenge_board_comment_likes").update({ reaction }).eq("id", mine.id);
      if (error) { showToast(`Couldn't update reaction: ${error.message}`); return false; }
    } else {
      const { error } = await supabase.from("challenge_board_comment_likes").insert({ comment_id: comment.id, user_id: session.user.id, reaction });
      if (error) { showToast(`Couldn't react: ${error.message}`); return false; }
    }
    await loadBoardComments();
    return true;
  };

  // Fires one challenge open to every other member. Anyone can grab it —
  // whoever does first wins it and it's gone for the rest.
  const sendRandomChallenge = async () => {
    const { error } = await supabase.from("open_challenges").insert({
      creator_id: session.user.id,
      creator_username: profile.efootball_username,
      creator_phone: profile.phone,
    });
    if (error) { showToast(`Couldn't send random challenge: ${error.message}`); return; }
    await loadOpenChallenges();
    showToast("Random challenge sent to everyone.");
  };

  // Accepts an open broadcast. The update only matches a row that's still
  // 'open', so if two people tap Accept at the same instant, Postgres's
  // row lock lets exactly one of these UPDATEs through — the loser gets 0
  // rows back and finds out someone else already grabbed it.
  const acceptOpenChallenge = async (challenge) => {
    const { data, error } = await supabase.from("open_challenges")
      .update({ status: "accepted", accepted_by: session.user.id, accepted_by_username: profile.efootball_username, accepted_by_phone: profile.phone, accepted_at: new Date().toISOString() })
      .eq("id", challenge.id).eq("status", "open")
      .select();
    if (error) { showToast(`Couldn't accept challenge: ${error.message}`); return; }
    if (!data || data.length === 0) { showToast("Too slow — someone else already accepted that one."); await loadOpenChallenges(); return; }
    await loadOpenChallenges();
    showToast(`Challenge accepted — say hi on WhatsApp.`);
  };

  // Withdraws your own still-open broadcast before anyone's grabbed it.
  const cancelOpenChallenge = async (challenge) => {
    const { error } = await supabase.from("open_challenges").update({ status: "cancelled" }).eq("id", challenge.id).eq("status", "open");
    if (error) { showToast(`Couldn't cancel: ${error.message}`); return; }
    await loadOpenChallenges();
  };

  // Dismisses a resolved (accepted/cancelled) broadcast off your own list.
  const removeOpenChallenge = async (challenge) => {
    const { error } = await supabase.from("open_challenges").delete().eq("id", challenge.id);
    if (error) { showToast(`Couldn't remove: ${error.message}`); return; }
    setOpenChallenges((prev) => (prev || []).filter((ch) => ch.id !== challenge.id));
  };

  // Same report → confirm/dispute flow as reportChallengeResult, on the
  // open_challenges table instead — scores are stored from the creator's
  // perspective (creator_score / accepted_by_score) regardless of who logs it.
  const reportOpenChallengeResult = async (challenge, myScore, theirScore, file) => {
    if (!file) { showToast("Attach a photo of the final scoreboard before logging a result."); return; }
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${session.user.id}/open-challenge-${challenge.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("result-proofs").upload(path, file);
    if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return; }

    const iAmCreator = challenge.creator_id === session.user.id;
    const update = {
      creator_score: iAmCreator ? myScore : theirScore,
      accepted_by_score: iAmCreator ? theirScore : myScore,
      result_status: "pending",
      result_reported_by: session.user.id,
      result_reported_at: new Date().toISOString(),
      result_photo_path: path,
    };
    const { error } = await supabase.from("open_challenges").update(update).eq("id", challenge.id);
    if (error) { showToast(`Couldn't log result: ${error.message}`); return; }
    await loadOpenChallenges();
    showToast("Result logged — waiting for them to confirm.");
  };

  const confirmOpenChallengeResult = async (challenge) => {
    const { error } = await supabase.from("open_challenges")
      .update({ result_status: "confirmed", result_confirmed_at: new Date().toISOString() })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't confirm result: ${error.message}`); return; }
    await loadOpenChallenges();
    showToast("Result confirmed.");
  };

  const disputeOpenChallengeResult = async (challenge) => {
    const { error } = await supabase.from("open_challenges")
      .update({ creator_score: null, accepted_by_score: null, result_status: null, result_reported_by: null, result_reported_at: null, result_photo_path: null })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't dispute result: ${error.message}`); return; }
    await loadOpenChallenges();
    showToast("Result disputed — ask them to re-log it.");
  };

  useEffect(() => {
    if (session === undefined) return;
    if (!session) { setProfile(undefined); setLeagues(null); setIsAdmin(false); return; }
    supabase.from("profiles").select("*").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setProfile(data || null));
  }, [session]);

  useEffect(() => {
    if (!session || !profile) return;
    supabase.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
    loadLeagues();
    loadChallenges();
    loadOpenChallenges();
    loadLadder();
  }, [session, profile, loadLeagues, loadChallenges, loadOpenChallenges, loadLadder]);

  // The ladder never resets, but ranks can move any time someone else's
  // challenge gets confirmed — so refresh it quietly while Home is open,
  // the same way the random-challenge pool refreshes itself.
  useEffect(() => {
    if (view !== "home" || !profile) return;
    const id = setInterval(loadLadder, 8000);
    return () => clearInterval(id);
  }, [view, profile, loadLadder]);

  // While the Challenges screen — or Home, where the random-challenge
  // notification banner lives — is open, poll the random-challenge pool
  // every few seconds. It's a race to accept, so members want to see it
  // move without having to manually refresh.
  useEffect(() => {
    if (view !== "challenges" && view !== "home") return;
    const id = setInterval(loadOpenChallenges, 4000);
    return () => clearInterval(id);
  }, [view, loadOpenChallenges]);

  // Same idea for the community results feed, on a slower clock — new
  // confirmed results trickle in rather than needing a race-to-accept refresh.
  useEffect(() => {
    if (view !== "challenges") return;
    loadRecentResults();
    const id = setInterval(loadRecentResults, 20000);
    return () => clearInterval(id);
  }, [view, loadRecentResults]);

  useEffect(() => {
    if (view !== "challenges") return;
    loadBoardComments();
    const id = setInterval(loadBoardComments, 15000);
    return () => clearInterval(id);
  }, [view, loadBoardComments]);

  // Handle a shared deep link like ?league=<id> once leagues have loaded.
  useEffect(() => {
    if (handledDeepLink || leagues === null) return;
    const params = new URLSearchParams(window.location.search);
    const linkedId = params.get("league");
    if (linkedId) {
      const found = leagues.find((l) => l.id === linkedId);
      if (found) { setActiveLeagueId(found.id); setView("league"); }
      else showToast("That league link isn't accessible — you may need to be added as a member first.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    setHandledDeepLink(true);
  }, [leagues, handledDeepLink, showToast]);

  const completeProfile = async (phone, username, photoFile) => {
    const { data, error } = await supabase.from("profiles")
      .insert({ user_id: session.user.id, phone, efootball_username: username })
      .select().single();
    if (error) {
      if (error.code === "23505" && error.message.toLowerCase().includes("phone")) {
        showToast("That phone number is already linked to another account — double-check it, or use a different number.");
      } else {
        showToast("Couldn't save your details — try again.");
      }
      return;
    }
    setProfile(data);
    if (photoFile) await updateProfilePhoto(photoFile);
  };

  // Uploads (or replaces) the signed-in member's own profile photo to the public
  // "avatars" bucket and saves the resulting URL onto their profiles row. Same
  // upload-then-link pattern as league/comment photos elsewhere in the app.
  const updateProfilePhoto = async (file) => {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${session.user.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("avatars").upload(path, file, { upsert: true });
    if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return; }
    const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
    const { data, error } = await supabase.from("profiles")
      .update({ avatar_url: pub.publicUrl }).eq("user_id", session.user.id)
      .select().single();
    if (error) { showToast(`Couldn't save photo: ${error.message}`); return; }
    setProfile(data);
    showToast("Profile photo updated.");
  };

  // Lets a signed-in member fix their own phone/username later — the only way to
  // resolve a "phone already registered to another account" situation, since phone
  // numbers are unique platform-wide (one number = one account, across all leagues).
  const updateProfile = async (phone, username) => {
    const { data, error } = await supabase.from("profiles")
      .update({ phone, efootball_username: username })
      .eq("user_id", session.user.id)
      .select().single();
    if (error) {
      if (error.code === "23505" && error.message.toLowerCase().includes("phone")) {
        showToast("That phone number is already linked to another account — double-check it, or use a different number.");
      } else {
        showToast(`Couldn't save your details: ${error.message}`);
      }
      return false;
    }
    setProfile(data);
    showToast("Profile updated.");
    return true;
  };

  const activeLeague = useMemo(() => (leagues || []).find((l) => l.id === activeLeagueId) || null, [leagues, activeLeagueId]);
  const incomingPendingCount = useMemo(() =>
    (challenges || []).filter((ch) => session && ch.opponent_id === session.user.id && ch.status === "pending").length,
    [challenges, session]);

  const myMembership = (league) => (session ? (league.members || []).find((m) => m.user_id === session.user.id) : null);
  const isMemberOf = (league) => !!myMembership(league);
  // null for fun leagues / non-members; "pending" | "approved" | "rejected" for cash league members.
  const myPaymentStatus = (league) => myMembership(league)?.payment_status || null;
  // Creating a league or being a platform admin gives management rights,
  // but doesn't by itself count as having joined — the creator/admin can
  // still choose to register a club and join like any other player.
  const canManageLeague = (league) => !!session && (isAdmin || league.created_by === session.user.id);
  const myTeam = (league) => {
    const m = myMembership(league);
    if (!m || !m.team_id) return null;
    return league.teams.find((t) => t.id === m.team_id) || null;
  };
  const canSeePhones = (league) => {
    if (canManageLeague(league)) return true;
    if (!isMemberOf(league)) return false;
    const t = myTeam(league);
    return !(t && t.eliminated);
  };
  const entryClosed = (league) => league.entry_closes_at && new Date(league.entry_closes_at) < new Date();

  // Persists which group each team landed in. Supabase doesn't support per-row
  // bulk updates with different values in one call, so we fire them in parallel.
  const persistGroupAssignments = async (groups) => {
    const updates = groups.flatMap((groupTeamIds, gi) =>
      groupTeamIds.map((teamId) => supabase.from("teams").update({ group_number: gi }).eq("id", teamId)));
    const results = await Promise.all(updates);
    const failed = results.find((r) => r.error);
    if (failed) { showToast(`Couldn't assign groups: ${failed.error.message}`); return false; }
    return true;
  };

  const createLeague = async (input) => {
    const { name, teamNames, format, survivor, groups, knockoutLegs, entryClosesAt, startsAt, description, leagueType } = input;
    const insertPayload = {
      name, created_by: session.user.id, format,
      entry_closes_at: entryClosesAt, starts_at: startsAt,
      description: description || null,
      // Only an admin can actually create a cash league — enforced again here
      // (not just in the CreateLeague UI) since input is client-supplied.
      // The database's own check constraint / RLS policy is the real backstop.
      league_type: isAdmin && leagueType === "cash" ? "cash" : "fun",
    };
    if (format === "knockout" || format === "groups_knockout") {
      insertPayload.knockout_legs = knockoutLegs;
    }
    if (format === "survivor") {
      insertPayload.survivor_matches_per_stage = survivor.matchesPerStage;
      insertPayload.survivor_elimination_percent = survivor.eliminationPercent;
      insertPayload.survivor_target_count = survivor.targetCount;
      insertPayload.survivor_final_format = survivor.finalFormat;
    }
    if (format === "groups_knockout") {
      insertPayload.group_size = groups.groupSize;
      insertPayload.group_qualifiers = groups.qualifiersPerGroup;
      // Provisional value, overwritten once fixtures are actually generated
      // (when the admin clicks "Start league") with the real count.
      insertPayload.groups_count = teamNames.length >= 2 ? Math.max(2, Math.round(teamNames.length / groups.groupSize)) : 2;
    }

    const { data: league, error } = await supabase.from("leagues").insert(insertPayload).select().single();
    if (error) { showToast(`Couldn't create league: ${error.message}`); return; }

    // Pre-listed clubs are added as registered teams, but fixtures are NOT
    // generated yet — the league stays open for registration so the admin
    // gets a chance to remove any club (pre-listed or self-joined) before
    // starting. Starting/generating fixtures happens via generateFixtures,
    // triggered by the "Start league & generate fixtures" button.
    if (teamNames.length >= 2) {
      const { error: teamErr } = await supabase.from("teams")
        .insert(teamNames.map((n) => ({ league_id: league.id, name: n }))).select();
      if (teamErr) { showToast(`Couldn't add clubs: ${teamErr.message}`); return; }
      showToast(`League created — ${teamNames.length} club${teamNames.length === 1 ? "" : "s"} pre-listed. Review the list, then start the league when ready.`);
    } else {
      showToast("League created — open for registration. Players can join, then you can start it.");
    }

    await loadLeagues();
    setActiveLeagueId(league.id);
    setView("league");
  };

  const generateFixtures = async (league) => {
    if (league.teams.length < 2) { showToast("Need at least 2 registered clubs to start the league."); return; }
    if (league.format === "groups_knockout" && league.teams.length < 4) {
      showToast("Need at least 4 clubs to form groups."); return;
    }
    const { fixtureRows, startsInFinal, groups: groupAssignments, groupsCount } = generateOpeningFixtures(league, league.teams.map((t) => t.id), generationDueBase(league));
    if (groupAssignments) {
      const ok = await persistGroupAssignments(groupAssignments);
      if (!ok) return;
      await supabase.from("leagues").update({ groups_count: groupsCount }).eq("id", league.id);
    }
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;
    if (startsInFinal) await supabase.from("leagues").update({ final_stage_started: true }).eq("id", league.id);
    await loadLeagues();
    showToast(`League started — ${fixtureRows.length} fixtures generated for ${league.teams.length} clubs${groupAssignments ? ` across ${groupAssignments.length} groups` : ""}.`);
  };

  const advanceGroupsToKnockout = async (league) => {
    const groupFixtures = league.fixtures.filter((f) => f.stage === 1);
    const unplayed = groupFixtures.filter((f) => !f.played);
    if (unplayed.length > 0) { showToast(`${unplayed.length} group match(es) still need a result.`); return; }

    const groupsCount = league.groups_count;
    const qualifiers = [];
    const eliminatedIds = [];
    for (let g = 0; g < groupsCount; g++) {
      const groupTeams = league.teams.filter((t) => t.group_number === g);
      if (groupTeams.length === 0) continue;
      const groupFx = groupFixtures.filter((f) => groupTeams.some((t) => t.id === f.home_team_id));
      const standings = computeStandings(groupTeams, groupFx);
      const n = Math.min(league.group_qualifiers, standings.length);
      standings.slice(0, n).forEach((r) => qualifiers.push(r.id));
      standings.slice(n).forEach((r) => eliminatedIds.push(r.id));
    }
    if (qualifiers.length < 2) { showToast("Not enough qualifying clubs to start a knockout stage."); return; }

    if (eliminatedIds.length > 0) {
      const { error } = await supabase.from("teams").update({ eliminated: true }).in("id", eliminatedIds);
      if (error) { showToast(`Couldn't finalize groups: ${error.message}`); return; }
    }

    const fixtureRows = knockoutBracketFixtures(league.id, shuffle(qualifiers), 0, new Date(), league.knockout_legs);
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;

    const { error: updErr } = await supabase.from("leagues")
      .update({ current_stage: 2, final_stage_started: true }).eq("id", league.id);
    if (updErr) { showToast(`Couldn't update league: ${updErr.message}`); return; }

    await loadLeagues();
    showToast(`Knockout stage started — ${qualifiers.length} clubs through.`);
  };

  const joinInFlight = useRef(new Set());
  const joinLeague = async (leagueId) => {
    if (joinInFlight.current.has(leagueId)) return;
    joinInFlight.current.add(leagueId);
    try {
    const league = (leagues || []).find((l) => l.id === leagueId);
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return; }

    if (league.league_type === "fun") {
      const activeFunLeague = (leagues || []).find((l) => {
        if (l.id === leagueId || l.league_type !== "fun") return false;
        const membership = l.members.find((m) => m.user_id === session.user.id);
        if (!membership || !membership.team_id) return false;
        const myTeamInL = l.teams.find((t) => t.id === membership.team_id);
        if (!myTeamInL || myTeamInL.eliminated) return false;
        const leagueComplete = l.fixtures.length > 0 && l.fixtures.every((f) => f.played);
        return !leagueComplete;
      });
      if (activeFunLeague) {
        showToast(`You're still active in "${activeFunLeague.name}" — join another fun league once your club there is eliminated, or that league finishes.`);
        return;
      }
    }

    const started = league.fixtures.length > 0;
    let match = league?.teams.find((t) => t.name.trim().toLowerCase() === profile.efootball_username.trim().toLowerCase());

    if (match) {
      const alreadyClaimed = league.members.some((m) => m.team_id === match.id);
      if (alreadyClaimed) {
        showToast(`"${match.name}" is already claimed by another member in this league — contact the league admin.`);
        return;
      }
    } else if (!started) {
      const { data: newTeam, error: teamErr } = await supabase.from("teams")
        .insert({ league_id: leagueId, name: profile.efootball_username, phone: profile.phone })
        .select().single();
      if (teamErr) {
        if (teamErr.code === "23505") {
          showToast(`"${profile.efootball_username}" is already registered in this league — contact the league admin if that's a mistake.`);
        } else {
          showToast(`Couldn't register your club: ${teamErr.message}`);
        }
        return;
      }
      match = newTeam;
    }

    const { error } = await supabase.from("members").insert({
      league_id: leagueId, user_id: session.user.id,
      display_name: profile.efootball_username, phone: profile.phone,
      team_id: match ? match.id : null,
    });
    if (error) { showToast("Couldn't join — you may already be a member."); return; }
    await loadLeagues();
    showToast(match ? `Joined — you're playing as ${match.name}.` : "Joined as a spectator — your username isn't on this league's team list.");
    } finally {
      joinInFlight.current.delete(leagueId);
    }
  };

  // Cash leagues route through this instead of joinLeague directly: fun leagues join
  // immediately, cash leagues open the entry-fee + proof-of-payment modal first.
  const startJoin = (leagueId) => {
    const league = (leagues || []).find((l) => l.id === leagueId);
    if (!league) return;
    if (league.league_type === "cash") { setPaymentModal({ league, member: null }); return; }
    joinLeague(leagueId);
  };

  const openResubmitPayment = (league, member) => setPaymentModal({ league, member });

  // Same team-claiming logic as joinLeague, shared by the cash-join flow below.
  const claimOrRegisterTeam = async (league) => {
    const started = league.fixtures.length > 0;
    let match = league.teams.find((t) => t.name.trim().toLowerCase() === profile.efootball_username.trim().toLowerCase());
    if (match) {
      const alreadyClaimed = league.members.some((m) => m.team_id === match.id);
      if (alreadyClaimed) {
        showToast(`"${match.name}" is already claimed by another member in this league — contact the league admin.`);
        return { error: true };
      }
      return { team: match };
    }
    if (started) return { team: null };
    const { data: newTeam, error: teamErr } = await supabase.from("teams")
      .insert({ league_id: league.id, name: profile.efootball_username, phone: profile.phone })
      .select().single();
    if (teamErr) {
      if (teamErr.code === "23505") {
        showToast(`"${profile.efootball_username}" is already registered in this league — contact the league admin if that's a mistake.`);
      } else {
        showToast(`Couldn't register your club: ${teamErr.message}`);
      }
      return { error: true };
    }
    return { team: newTeam };
  };

  // Joins a cash league: registers/claims the club, uploads the proof of payment to
  // private storage, and creates the member row with payment_status "pending" —
  // it only becomes a confirmed registration once an admin approves it.
  const joinCashLeague = async (league, fee, file) => {
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return false; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return false; }
    if (!file) { showToast("Attach your proof of payment before submitting."); return false; }

    const result = await claimOrRegisterTeam(league);
    if (result.error) return false;

    const feeNum = clampFee(fee);
    const ext = (file.name.split(".").pop() || "dat").toLowerCase();
    const path = `${session.user.id}/${league.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("payment-proofs").upload(path, file);
    if (uploadErr) { showToast(`Couldn't upload proof of payment: ${uploadErr.message}`); return false; }

    const { error } = await supabase.from("members").insert({
      league_id: league.id, user_id: session.user.id,
      display_name: profile.efootball_username, phone: profile.phone,
      team_id: result.team ? result.team.id : null,
      entry_fee: feeNum, payment_status: "pending", payment_proof_path: path,
    });
    if (error) { showToast("Couldn't submit registration — you may already be a member."); return false; }

    await loadLeagues();
    showToast(`Registration submitted — ${formatRand(feeNum)} pending admin approval.`);
    return true;
  };

  // Lets a member with a rejected payment upload fresh proof without losing their club.
  const resubmitCashPayment = async (league, member, fee, file) => {
    if (!file) { showToast("Attach your proof of payment before submitting."); return false; }
    const feeNum = clampFee(fee);
    const ext = (file.name.split(".").pop() || "dat").toLowerCase();
    const path = `${session.user.id}/${league.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("payment-proofs").upload(path, file);
    if (uploadErr) { showToast(`Couldn't upload proof of payment: ${uploadErr.message}`); return false; }

    const { error } = await supabase.from("members").update({
      entry_fee: feeNum, payment_status: "pending", payment_proof_path: path,
      payment_reviewed_at: null, payment_reviewed_by: null,
    }).eq("id", member.id);
    if (error) { showToast(`Couldn't resubmit: ${error.message}`); return false; }

    await loadLeagues();
    showToast(`Resubmitted — ${formatRand(feeNum)} pending admin approval.`);
    return true;
  };

  const handlePaymentModalSubmit = async (fee, file) => {
    if (!paymentModal) return;
    const { league, member } = paymentModal;
    const ok = member
      ? await resubmitCashPayment(league, member, fee, file)
      : await joinCashLeague(league, fee, file);
    if (ok) setPaymentModal(null);
  };

  // Admin/creator only — downloads via a short-lived signed URL since the bucket is private.
  const downloadPaymentProof = async (member) => {
    if (!member.payment_proof_path) { showToast("No proof of payment on file for this member."); return; }
    const { data, error } = await supabase.storage.from("payment-proofs").createSignedUrl(member.payment_proof_path, 120);
    if (error || !data) { showToast("Couldn't generate a download link."); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const applyPaymentReview = async (member, status) => {
    const { error } = await supabase.from("members").update({
      payment_status: status, payment_reviewed_at: new Date().toISOString(), payment_reviewed_by: session.user.id,
    }).eq("id", member.id);
    if (error) { showToast(`Couldn't update payment status: ${error.message}`); return; }
    await loadLeagues();
    showToast(status === "approved" ? `Payment approved — ${member.display_name} is confirmed.` : `Payment marked as rejected for ${member.display_name}.`);
  };

  const reviewPayment = (member, status) => {
    if (status !== "rejected") { applyPaymentReview(member, status); return; }
    requestConfirm([
      `Reject ${member.display_name}'s club? They'll need to resubmit proof of payment to join.`,
      `Are you sure? Their registration will be marked as rejected.`,
      `Really sure you want to reject ${member.display_name}?`,
      `Last check before rejecting ${member.display_name} — still want to continue?`,
      `Final confirmation — click to reject ${member.display_name}'s club.`,
    ], () => applyPaymentReview(member, status));
  };

  // Admin/creator entering a result directly (no approval step needed, it's
  // their own call) — but a photo of the final scoreboard is required here
  // too, same as submitMatchResult's rule for regular players. Once saved,
  // it's posted to the comments as scoreline + photo, same as an approved
  // player submission, so the evidence is visible to the whole league either way.
  const recordResult = async (league, fixture, homeScore, awayScore, file = null) => {
    if (!file) { showToast("Attach a photo of the final scoreboard before saving."); return; }
    const { error } = await supabase.from("fixtures")
      .update({ played: true, home_score: homeScore, away_score: awayScore, played_at: new Date().toISOString() }).eq("id", fixture.id);
    if (error) { showToast("Couldn't save result."); return; }

    const inKnockoutBracket = league.format === "knockout" || (league.format === "groups_knockout" && league.final_stage_started);
    if (inKnockoutBracket && fixture.away_team_id) {
      const tieFixtures = league.fixtures
        .filter((f) => f.stage === fixture.stage && f.round === fixture.round &&
          ((f.home_team_id === fixture.home_team_id && f.away_team_id === fixture.away_team_id) ||
           (f.home_team_id === fixture.away_team_id && f.away_team_id === fixture.home_team_id)))
        .map((f) => (f.id === fixture.id ? { ...f, played: true, home_score: homeScore, away_score: awayScore } : f));
      if (tieFixtures.every((f) => f.played)) {
        const totals = {};
        tieFixtures.forEach((f) => {
          totals[f.home_team_id] = (totals[f.home_team_id] || 0) + f.home_score;
          totals[f.away_team_id] = (totals[f.away_team_id] || 0) + f.away_score;
        });
        const [teamA, teamB] = Object.keys(totals);
        if (totals[teamA] !== totals[teamB]) {
          const loserId = totals[teamA] > totals[teamB] ? teamB : teamA;
          await supabase.from("teams").update({ eliminated: true }).eq("id", loserId);
        }
      }
    }
    const homeName = league.teams.find((t) => t.id === fixture.home_team_id)?.name || "Home";
    const awayName = league.teams.find((t) => t.id === fixture.away_team_id)?.name || "Away";
    await postComment(league, `Matchday ${fixture.round} — ${homeName} ${homeScore} – ${awayScore} ${awayName}`, null, file, null, true);
    await loadLeagues();
    showToast(`Saved: ${homeName} ${homeScore} – ${awayScore} ${awayName}`);
  };

  // A joined, non-managing player's version of recordResult: same score
  // entry, but it lands as a pending row instead of writing the fixture
  // directly, and a photo of the scoreboard is mandatory. The fixture itself
  // is only updated once an admin/creator approves it (see approveResult).
  const submitMatchResult = async (league, fixture, homeScore, awayScore, file) => {
    if (!file) { showToast("Attach a photo of the final scoreboard before submitting."); return false; }
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${session.user.id}/${fixture.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("result-proofs").upload(path, file);
    if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return false; }

    const { error } = await supabase.from("result_submissions").insert({
      league_id: league.id, fixture_id: fixture.id, submitted_by: session.user.id,
      submitted_by_username: profile?.efootball_username || session.user.email,
      home_score: homeScore, away_score: awayScore, photo_path: path,
    });
    if (error) {
      if (error.code === "23505") showToast("Someone already submitted a result for this match — it's waiting on their opponent (or an admin) to review.");
      else showToast(`Couldn't submit result: ${error.message}`);
      return false;
    }
    await loadLeagues();
    showToast("Result submitted — pending admin approval.");
    return true;
  };

  const handleResultModalSubmit = async (homeScore, awayScore, file) => {
    if (!resultModal) return;
    const ok = await submitMatchResult(resultModal.league, resultModal.fixture, homeScore, awayScore, file);
    if (ok) setResultModal(null);
  };

  // Admin/creator only — downloads a submitted result's photo proof via a
  // short-lived signed URL, same pattern as downloadPaymentProof.
  const downloadResultProof = async (submission) => {
    const { data, error } = await supabase.storage.from("result-proofs").createSignedUrl(submission.photo_path, 120);
    if (error || !data) { showToast("Couldn't generate a download link."); return; }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  // Approving/rejecting both go through security-definer SQL functions —
  // approval needs to atomically update the fixture and post the comment
  // under the player's own identity, which a plain client-side update can't
  // do (see supabase-results-feature.sql). That function predates photo
  // support though, so its own auto-posted comment is text-only — this adds
  // a second comment carrying the photo (long-lived signed URL, same trick
  // rejectResult uses, since result-proofs is a private bucket).
  const approveResult = async (league, submission) => {
    const { error } = await supabase.rpc("approve_result_submission", { p_submission_id: submission.id });
    if (error) { showToast(`Couldn't approve: ${error.message}`); return; }

    if (submission.photo_path) {
      const fixture = league.fixtures.find((f) => f.id === submission.fixture_id);
      const homeName = league.teams.find((t) => t.id === fixture?.home_team_id)?.name || "Home";
      const awayName = league.teams.find((t) => t.id === fixture?.away_team_id)?.name || "Away";
      const { data } = await supabase.storage.from("result-proofs")
        .createSignedUrl(submission.photo_path, 60 * 60 * 24 * 365 * 5); // ~5 years
      if (data?.signedUrl) {
        await postComment(
          league,
          `Photo proof for ${submission.submitted_by_username}'s approved result — Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName}`,
          null, null, data.signedUrl, true,
        );
      }
    }

    await loadLeagues();
    showToast(`Result approved — posted to comments as ${submission.submitted_by_username}.`);
  };

  const rejectResult = (league, submission) => {
    requestConfirm([
      `Reject this result submitted by ${submission.submitted_by_username}? They'll be able to resubmit.`,
      `Are you sure? The match will stay unplayed until someone resubmits.`,
    ], async () => {
      const { error } = await supabase.rpc("reject_result_submission", { p_submission_id: submission.id, p_note: null });
      if (error) { showToast(`Couldn't reject: ${error.message}`); return; }

      // Post it to comments too, so the league can see the rejected claim and
      // photo — not just the admin. result-proofs is a private bucket (unlike
      // comment-photos), so this signs the existing file with a long expiry
      // instead of re-uploading it, and reuses that URL as the comment's photo.
      const fixture = league.fixtures.find((f) => f.id === submission.fixture_id);
      const homeName = league.teams.find((t) => t.id === fixture?.home_team_id)?.name || "Home";
      const awayName = league.teams.find((t) => t.id === fixture?.away_team_id)?.name || "Away";
      let photoUrl = null;
      if (submission.photo_path) {
        const { data } = await supabase.storage.from("result-proofs")
          .createSignedUrl(submission.photo_path, 60 * 60 * 24 * 365 * 5); // ~5 years
        photoUrl = data?.signedUrl || null;
      }
      await postComment(
        league,
        `${submission.submitted_by_username}'s result was rejected — Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName}`,
        null, null, photoUrl, true,
      );

      await loadLeagues();
      showToast("Result rejected — posted to comments.");
    });
  };

  // The opponent's side of a pending submission — same two outcomes as the
  // admin approve/reject above, but scoped so only the player on the other
  // side of that specific fixture can act (enforced server-side in
  // respond_to_result_submission, not just by which button the UI shows).
  // Confirming behaves like approveResult (fixture gets updated, photo proof
  // gets posted to comments); disputing behaves like rejectResult. Either
  // way the confirmation/dispute comment posts under the opponent's own
  // identity — since they're the one actually clicking the button, that
  // doesn't need the security-definer identity trick approveResult uses.
  const respondToResultSubmission = (league, submission, accept) => {
    const post = async () => {
      const { error } = await supabase.rpc("respond_to_result_submission", {
        p_submission_id: submission.id, p_accept: accept,
      });
      if (error) { showToast(`Couldn't ${accept ? "confirm" : "dispute"} result: ${error.message}`); return; }

      const fixture = league.fixtures.find((f) => f.id === submission.fixture_id);
      const homeName = league.teams.find((t) => t.id === fixture?.home_team_id)?.name || "Home";
      const awayName = league.teams.find((t) => t.id === fixture?.away_team_id)?.name || "Away";
      let photoUrl = null;
      if (submission.photo_path) {
        const { data } = await supabase.storage.from("result-proofs")
          .createSignedUrl(submission.photo_path, 60 * 60 * 24 * 365 * 5); // ~5 years
        photoUrl = data?.signedUrl || null;
      }
      await postComment(
        league,
        accept
          ? `Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName} (confirmed by opponent)`
          : `${submission.submitted_by_username}'s result was disputed by their opponent — Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName}`,
        null, null, photoUrl, true,
      );

      await loadLeagues();
      showToast(accept ? "Result confirmed — posted to comments." : "Result disputed — they'll need to resubmit.");
    };

    if (accept) { post(); return; }
    requestConfirm([
      `Dispute this result submitted by ${submission.submitted_by_username}? They'll be able to resubmit.`,
      `Are you sure? The match will stay unplayed until someone resubmits.`,
    ], post);
  };

  const advanceKnockout = async (league) => {
    // Pure knockout leagues run their whole bracket in stage 1; groups_knockout
    // leagues only enter the bracket once the group stage (stage 1) is done,
    // and the bracket itself lives in stage 2.
    const bracketStage = league.format === "groups_knockout" ? 2 : 1;
    const bracketFixtures = league.fixtures.filter((f) => f.stage === bracketStage);
    const maxRound = Math.max(...bracketFixtures.map((f) => f.round));
    const currentRoundFixtures = bracketFixtures.filter((f) => f.round === maxRound);
    const unplayed = currentRoundFixtures.filter((f) => !f.played);
    if (unplayed.length > 0) { showToast(`${unplayed.length} match(es) still need a result.`); return; }

    const ties = {};
    currentRoundFixtures.forEach((f) => {
      const key = f.away_team_id === null ? `bye-${f.home_team_id}` : [f.home_team_id, f.away_team_id].sort().join("~");
      (ties[key] = ties[key] || []).push(f);
    });

    const winners = [];
    let undecided = 0;
    Object.values(ties).forEach((legs) => {
      if (legs[0].away_team_id === null) { winners.push(legs[0].home_team_id); return; }
      const totals = {};
      legs.forEach((f) => {
        totals[f.home_team_id] = (totals[f.home_team_id] || 0) + f.home_score;
        totals[f.away_team_id] = (totals[f.away_team_id] || 0) + f.away_score;
      });
      const [teamA, teamB] = Object.keys(totals);
      if (totals[teamA] === totals[teamB]) { undecided++; return; }
      winners.push(totals[teamA] > totals[teamB] ? teamA : teamB);
    });
    if (undecided > 0) { showToast(`${undecided} tie${undecided === 1 ? " is" : "s are"} level on aggregate — edit a leg's score to break it (no away-goals rule).`); return; }
    if (winners.length <= 1) { showToast("This league already has a champion."); return; }

    const fixtureRows = knockoutRoundFixtures(league.id, winners, bracketStage, maxRound + 1, new Date(), league.knockout_legs || 1);
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;
    await loadLeagues();
    showToast(`Round ${maxRound + 1} created.`);
  };

  const advanceSurvivor = async (league) => {
    const currentStage = league.current_stage;
    const stageFixtures = league.fixtures.filter((f) => f.stage === currentStage);
    const unplayed = stageFixtures.filter((f) => !f.played);
    if (unplayed.length > 0) { showToast(`${unplayed.length} match(es) in this stage still need a result.`); return; }

    if (league.final_stage_started) { showToast("This is the final stage — check the table for the champion."); return; }

    const activeTeams = league.teams.filter((t) => !t.eliminated);
    const standings = computeStandings(activeTeams, stageFixtures);
    let toEliminate = Math.max(1, Math.round(activeTeams.length * (league.survivor_elimination_percent / 100)));
    if (activeTeams.length - toEliminate < league.survivor_target_count) {
      toEliminate = activeTeams.length - league.survivor_target_count;
    }
    const eliminatedIds = standings.slice(standings.length - toEliminate).map((r) => r.id);

    if (eliminatedIds.length > 0) {
      const { error } = await supabase.from("teams").update({ eliminated: true }).in("id", eliminatedIds);
      if (error) { showToast(`Couldn't eliminate teams: ${error.message}`); return; }
    }

    const remainingIds = activeTeams.map((t) => t.id).filter((id) => !eliminatedIds.includes(id));
    const nextStage = currentStage + 1;
    const goingFinal = remainingIds.length <= league.survivor_target_count;

    const rounds = goingFinal
      ? finalStageSchedule(remainingIds, league.survivor_final_format)
      : stageSchedule(remainingIds, league.survivor_matches_per_stage);
    const fixtureRows = toFixtureRows(league.id, rounds, nextStage, new Date());
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;

    const { error: updErr } = await supabase.from("leagues")
      .update({ current_stage: nextStage, final_stage_started: goingFinal }).eq("id", league.id);
    if (updErr) { showToast(`Couldn't update league: ${updErr.message}`); return; }

    await loadLeagues();
    showToast(goingFinal ? `Final stage started — ${remainingIds.length} clubs remain.` : `Stage ${nextStage} started — ${remainingIds.length} clubs remain.`);
  };

  const advanceStage = async (league) => {
    if (league.format === "knockout") return advanceKnockout(league);
    if (league.format === "survivor") return advanceSurvivor(league);
    if (league.format === "groups_knockout") {
      return league.final_stage_started ? advanceKnockout(league) : advanceGroupsToKnockout(league);
    }
  };

  const updateTeamPhone = async (teamId, phone) => {
    const { error } = await supabase.from("teams").update({ phone }).eq("id", teamId);
    if (error) { showToast("Couldn't save number."); return; }
    await loadLeagues();
  };

  const removeTeam = (team) => {
    requestConfirm([
      `Remove ${team.name} from this league? This can't be undone.`,
      `Are you sure? ${team.name}'s results and standings will be deleted too.`,
      `Really sure you want ${team.name} gone for good?`,
      `Last check before removing ${team.name} — still want to continue?`,
      `Final confirmation — click to permanently remove ${team.name}.`,
    ], async () => {
      await supabase.from("members").delete().eq("team_id", team.id);
      const { error } = await supabase.from("teams").delete().eq("id", team.id);
      if (error) { showToast(`Couldn't remove club: ${error.message}`); return; }
      await loadLeagues();
      showToast(`${team.name} removed from the league.`);
    });
  };

  // Self-service version of removeTeam, for a regular member leaving on their own.
  // Always deletes their own membership row. Only also deletes their club if the
  // league hasn't started yet (fixtures.length === 0) — once fixtures exist, wiping
  // the team would blow away results/standings for everyone else, so post-start we
  // just drop their membership and leave the (now unclaimed) club record in place.
  const leaveLeague = async (league) => {
    const membership = myMembership(league);
    if (!membership) return;
    if (!window.confirm(`Leave "${league.name}"? This can't be undone.`)) return;
    const team = membership.team_id ? league.teams.find((t) => t.id === membership.team_id) : null;
    const { error } = await supabase.from("members").delete().eq("id", membership.id);
    if (error) { showToast(`Couldn't leave: ${error.message}`); return; }
    if (team && league.fixtures.length === 0) {
      await supabase.from("teams").delete().eq("id", team.id);
    }
    if (activeLeagueId === league.id) { setView("home"); setActiveLeagueId(null); }
    await loadLeagues();
    showToast(`You left ${league.name}.`);
  };

  const updateLeaguePhoto = async (league, file) => {
    const ext = file.name.split(".").pop();
    const path = `${league.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("league-photos").upload(path, file, { upsert: true });
    if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return; }
    const { data: pub } = supabase.storage.from("league-photos").getPublicUrl(path);
    const { error } = await supabase.from("leagues").update({ photo_url: pub.publicUrl }).eq("id", league.id);
    if (error) { showToast(`Couldn't save photo: ${error.message}`); return; }
    await loadLeagues();
    showToast("League photo updated.");
  };

  const updateLeagueDescription = async (league, text) => {
    const { error } = await supabase.from("leagues").update({ description: text || null }).eq("id", league.id);
    if (error) { showToast(`Couldn't save description: ${error.message}`); return; }
    await loadLeagues();
    showToast("Description updated.");
  };

  // Comments live on every league regardless of stage — still filling up (pending)
  // or already generated fixtures (created/active) — so members can talk trash,
  // coordinate, or ask questions in one place. Anyone who can see the league can
  // read comments; only members/creator/admins can post (enforced by RLS too).
  // A comment or reply can optionally carry one photo — normally a fresh upload
  // to the public "comment-photos" bucket (same pattern as league photos), but
  // photoUrl lets a caller pass an already-resolved URL instead (used when
  // rejecting a result: it reuses the submission's existing photo rather than
  // re-uploading it).
  const postComment = async (league, body, parentComment = null, file = null, photoUrl = null, isResult = false) => {
    const trimmed = (body || "").trim();
    if (!trimmed) return;
    const username = profile?.efootball_username || session.user.email;
    let photo_url = photoUrl || null;
    if (!photo_url && file) {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("comment-photos").upload(path, file);
      if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return false; }
      const { data: pub } = supabase.storage.from("comment-photos").getPublicUrl(path);
      photo_url = pub.publicUrl;
    }
    const { error } = await supabase.from("comments").insert({
      league_id: league.id, user_id: session.user.id, username, body: trimmed,
      parent_comment_id: parentComment?.id || null, photo_url, is_result: isResult,
    });
    if (error) { showToast(`Couldn't post ${parentComment ? "reply" : "comment"}: ${error.message}`); return false; }
    await loadLeagues();
    return true;
  };

  const deleteComment = (comment, league) => {
    const replyCount = (league?.comments || []).filter((c) => c.parent_comment_id === comment.id).length;
    const message = comment.parent_comment_id
      ? `Delete this reply? This can't be undone.`
      : replyCount > 0
        ? `Delete this comment and its ${replyCount} repl${replyCount === 1 ? "y" : "ies"}? This can't be undone.`
        : `Delete this comment? This can't be undone.`;
    requestConfirm([message], async () => {
      const { error } = await supabase.from("comments").delete().eq("id", comment.id);
      if (error) { showToast(`Couldn't delete comment: ${error.message}`); return; }
      await loadLeagues();
      showToast(comment.parent_comment_id ? "Reply deleted." : "Comment deleted.");
    });
  };

  // Likes are a simple toggle backed by a unique (comment_id, user_id) row —
  // insert to like, delete your own row to unlike. No optimistic local state:
  // this app already reloads the full league tree after every mutation, so
  // liking follows the same pattern as everything else here.
  // Reactions are one row per (comment, user) same as before, but now carry
  // which emoji was picked. Tapping your current reaction removes it;
  // picking a different emoji updates the existing row instead of a
  // delete+insert, so it stays a single round trip either way.
  const toggleCommentReaction = async (comment, reaction) => {
    const mine = (comment.comment_likes || []).find((l) => l.user_id === session.user.id);
    if (reaction === null) {
      if (!mine) return true;
      const { error } = await supabase.from("comment_likes").delete().eq("id", mine.id);
      if (error) { showToast(`Couldn't remove reaction: ${error.message}`); return false; }
    } else if (mine) {
      const { error } = await supabase.from("comment_likes").update({ reaction }).eq("id", mine.id);
      if (error) { showToast(`Couldn't update reaction: ${error.message}`); return false; }
    } else {
      const { error } = await supabase.from("comment_likes").insert({ comment_id: comment.id, user_id: session.user.id, reaction });
      if (error) { showToast(`Couldn't react: ${error.message}`); return false; }
    }
    await loadLeagues();
    return true;
  };

  // Reacting to the league itself works exactly like reacting to a comment
  // (same toggle/switch/remove semantics, one row per (league, user)), but
  // it's open to anyone signed in — not gated by canComment — since the
  // general public should be able to react to a league without joining it.
  const toggleLeagueReaction = async (league, reaction) => {
    const mine = (league.league_reactions || []).find((l) => l.user_id === session.user.id);
    if (reaction === null) {
      if (!mine) return true;
      const { error } = await supabase.from("league_reactions").delete().eq("id", mine.id);
      if (error) { showToast(`Couldn't remove reaction: ${error.message}`); return false; }
    } else if (mine) {
      const { error } = await supabase.from("league_reactions").update({ reaction }).eq("id", mine.id);
      if (error) { showToast(`Couldn't update reaction: ${error.message}`); return false; }
    } else {
      const { error } = await supabase.from("league_reactions").insert({ league_id: league.id, user_id: session.user.id, reaction });
      if (error) { showToast(`Couldn't react: ${error.message}`); return false; }
    }
    await loadLeagues();
    return true;
  };

  // Suggestion box — open to anyone signed in, regardless of whether they've
  // joined or created any league. Write-only from the app's side; suggestions
  // are just read from the Supabase table editor.
  const postSuggestion = async (text) => {
    const trimmed = (text || "").trim();
    if (!trimmed) return false;
    const { error } = await supabase.from("suggestions").insert({
      user_id: session.user.id, username: profile?.efootball_username || session.user.email, body: trimmed,
    });
    if (error) { showToast(`Couldn't send suggestion: ${error.message}`); return false; }
    showToast("Thanks — suggestion sent!");
    return true;
  };

  const deleteLeague = (league) => {
    requestConfirm([
      `Delete "${league.name}"? This removes all clubs, fixtures and members permanently.`,
      `Are you sure? Every result and standing in "${league.name}" will be gone for good.`,
      `Really sure? ${league.members.length} member${league.members.length === 1 ? "" : "s"} will lose access to this league.`,
      `This can't be undone once it's done. Still want to delete "${league.name}"?`,
      `Last check — click to permanently delete "${league.name}".`,
    ], async () => {
      const { error } = await supabase.from("leagues").delete().eq("id", league.id);
      if (error) { showToast(`Couldn't delete: ${error.message}`); return; }
      setView("home");
      setActiveLeagueId(null);
      await loadLeagues();
      showToast("League deleted.");
    });
  };

  const shareLeague = (league) => {
    const url = `${window.location.origin}${window.location.pathname}?league=${league.id}`;
    navigator.clipboard?.writeText(url);
    showToast("Invite link copied — share it with members who already have access.");
  };

  if (session === undefined) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: THEMES.dark.bg }}><Loader c={THEMES.dark} /></div>;
  }
  if (!session) return <LoginScreen c={c} theme={theme} toggleTheme={toggleTheme} onSignIn={(stay) => signInWithGoogle(stay)} />;
  if (profile === undefined) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: c.bg }}><Loader c={c} /></div>;
  }
  if (profile === null) return <ProfileGate c={c} theme={theme} toggleTheme={toggleTheme} onSubmit={completeProfile} />;

  const openChallengesScreen = () => { setView("challenges"); loadChallengeMembers(); loadChallenges(); loadOpenChallenges(); loadRecentResults(); loadBoardComments(); };

  return (
    <div className="min-h-screen transition-colors duration-200" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <Header view={view} setView={setView} activeLeague={activeLeague} theme={theme} toggleTheme={toggleTheme} c={c} onSignOut={signOut} userEmail={session.user.email}
        avatarUrl={profile?.avatar_url}
        onEditProfile={() => setEditProfileOpen(true)} isAdmin={isAdmin} onOpenAccounts={() => { setView("accounts"); loadAccounts(); }}
        onOpenChallenges={openChallengesScreen}
        challengeBadge={incomingPendingCount}
        onOpenSuggestion={() => setSuggestionOpen(true)} onOpenLeaderboard={() => setView("leaderboard")} />
      <main className="max-w-3xl mx-auto px-4 pb-24">
        {view === "accounts" && isAdmin ? (
          <AccountsPanel accounts={accounts} leagues={leagues} session={session} onDelete={deleteAccount} onApprove={approveAccount} onBack={() => setView("home")} c={c} />
        ) : view === "challenges" ? (
          <ChallengesScreen session={session} members={challengeMembers} challenges={challenges} openChallenges={openChallenges} recentResults={recentResults}
            boardComments={boardComments} isAdmin={isAdmin} myUsername={profile?.efootball_username || session.user.email}
            onPostBoardComment={postBoardComment} onDeleteBoardComment={deleteBoardComment} onToggleBoardCommentReaction={toggleBoardCommentReaction}
            onSendChallenge={sendChallenge} onAccept={(ch) => respondChallenge(ch, true)} onDecline={(ch) => respondChallenge(ch, false)}
            onRemove={removeChallenge}
            onOpenLogResult={(ch) => setChallengeResultModal({ kind: "challenge", challenge: ch })}
            onConfirmResult={confirmChallengeResult} onDisputeResult={disputeChallengeResult}
            onOpenLogResultOpen={(ch) => setChallengeResultModal({ kind: "open", challenge: ch })}
            onConfirmResultOpen={confirmOpenChallengeResult} onDisputeResultOpen={disputeOpenChallengeResult}
            onViewResultProof={viewChallengeResultProof}
            onSendRandom={sendRandomChallenge} onAcceptOpen={acceptOpenChallenge} onCancelOpen={cancelOpenChallenge} onRemoveOpen={removeOpenChallenge}
            onBack={() => setView("home")} c={c} />
        ) : leagues === null ? <Loader c={c} /> : (
          <>
            {view === "home" && (
              <Home leagues={leagues} isAdmin={isAdmin} isMemberOf={isMemberOf} entryClosed={entryClosed} myPaymentStatus={myPaymentStatus}
                canManageLeague={canManageLeague} session={session} onToggleLeagueReaction={toggleLeagueReaction}
                openChallenges={openChallenges} onOpenChallenges={openChallengesScreen}
                ladder={ladder} myLadderRank={myLadderRank} onOpenLadderChallenge={() => setLadderChallengeOpen(true)}
                onOpen={(id) => { setActiveLeagueId(id); setView("league"); }}
                onCreate={() => setView("create")} onJoin={startJoin} c={c} />
            )}
            {view === "create" && <CreateLeague onCancel={() => setView("home")} onCreate={createLeague} isAdmin={isAdmin} c={c} />}
            {view === "league" && activeLeague && (
              <LeagueDetail league={activeLeague} session={session} isAdmin={isAdmin} joined={isMemberOf(activeLeague)}
                myUsername={profile?.efootball_username || session.user.email}
                canSeePhones={canSeePhones(activeLeague)} myTeam={myTeam(activeLeague)} entryClosed={entryClosed(activeLeague)}
                myPaymentStatus={myPaymentStatus(activeLeague)}
                onBack={() => setView("home")} onJoin={() => startJoin(activeLeague.id)}
                onResubmitPayment={(member) => openResubmitPayment(activeLeague, member)}
                onDownloadProof={downloadPaymentProof} onReviewPayment={reviewPayment}
                onRecordResult={recordResult} onUpdateTeamPhone={updateTeamPhone} onRemoveTeam={removeTeam} onUpdatePhoto={updateLeaguePhoto} onUpdateDescription={updateLeagueDescription}
                onAdvance={advanceStage} onGenerateFixtures={generateFixtures}
                onDelete={deleteLeague} onShare={shareLeague} onLeave={leaveLeague}
                onOpenSubmitResult={(fixture, homeTeam, awayTeam, existing) => setResultModal({ league: activeLeague, fixture, homeTeam, awayTeam, existing })}
                onDownloadResultProof={downloadResultProof} onApproveResult={approveResult} onRejectResult={rejectResult}
                onRespondToResultSubmission={respondToResultSubmission}
                onPostComment={postComment} onDeleteComment={deleteComment} onToggleReaction={toggleCommentReaction}
                onToggleLeagueReaction={toggleLeagueReaction} c={c} />
            )}
            {view === "leaderboard" && (
              <Leaderboard leagues={leagues} session={session} onBack={() => setView("home")} c={c} />
            )}
          </>
        )}
      </main>
      {paymentModal && (
        <PaymentModal league={paymentModal.league} member={paymentModal.member}
          onCancel={() => setPaymentModal(null)} onSubmit={handlePaymentModalSubmit} c={c} />
      )}
      {resultModal && (
        <SubmitResultModal league={resultModal.league} fixture={resultModal.fixture} homeTeam={resultModal.homeTeam} awayTeam={resultModal.awayTeam} existing={resultModal.existing}
          onCancel={() => setResultModal(null)} onSubmit={handleResultModalSubmit} c={c} />
      )}
      {challengeResultModal && (() => {
        const { kind, challenge: ch } = challengeResultModal;
        const iAmFirst = kind === "open" ? ch.creator_id === session.user.id : ch.challenger_id === session.user.id;
        const myUsername = kind === "open"
          ? (iAmFirst ? ch.creator_username : ch.accepted_by_username)
          : (iAmFirst ? ch.challenger_username : ch.opponent_username);
        const opponentUsername = kind === "open"
          ? (iAmFirst ? ch.accepted_by_username : ch.creator_username)
          : (iAmFirst ? ch.opponent_username : ch.challenger_username);
        const submit = kind === "open" ? reportOpenChallengeResult : reportChallengeResult;
        return (
          <LogChallengeResultModal challenge={ch} myUsername={myUsername} opponentUsername={opponentUsername}
            onCancel={() => setChallengeResultModal(null)}
            onSubmit={async (mine, theirs, file) => { await submit(ch, mine, theirs, file); setChallengeResultModal(null); }}
            c={c} />
        );
      })()}
      {editProfileOpen && (
        <EditProfileModal profile={profile} onCancel={() => setEditProfileOpen(false)}
          onSubmit={async (phone, username) => { const ok = await updateProfile(phone, username); if (ok) setEditProfileOpen(false); }}
          onUpdatePhoto={updateProfilePhoto} c={c} />
      )}
      {suggestionOpen && (
        <SuggestionModal onCancel={() => setSuggestionOpen(false)}
          onSubmit={async (text) => { const ok = await postSuggestion(text); if (ok) setSuggestionOpen(false); }} c={c} />
      )}
      {ladderChallengeOpen && (
        <LadderChallengeSheet myRank={myLadderRank} targets={ladderTargets}
          onChallenge={async (target) => { await sendChallenge(target, true); setLadderChallengeOpen(false); }}
          onCancel={() => setLadderChallengeOpen(false)} c={c} />
      )}
      <ConfirmStepModal flow={confirmFlow} onCancel={cancelConfirm} onAdvance={advanceConfirm} c={c} />
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full font-body text-sm font-medium shadow-lg z-50 max-w-[90vw] text-center" style={{ background: c.toastBg, color: c.toastText }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function LoginScreen({ c, theme, toggleTheme, onSignIn }) {
  const [staySignedIn, setStaySignedIn] = useState(true);
  return (
    <div className="min-h-screen flex flex-col items-center px-6 py-10" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <style>{`
        @keyframes medallionGlow { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.85; } }
        .medallion-glow { animation: medallionGlow 4.5s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .medallion-glow { animation: none; opacity: 0.7; } }
      `}</style>

      <div className="w-full flex items-center justify-between max-w-md">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded flex items-center justify-center" style={{ background: c.green }}><Trophy size={14} color={c.accent} /></div>
          <span className="font-extrabold text-sm uppercase tracking-wider">Matchday</span>
        </div>
        <button onClick={toggleTheme} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center min-h-[70vh] w-full">
        <div className="font-mono text-[11px] uppercase tracking-[0.35em] mb-6" style={{ color: c.accent }}>Season 2026</div>

        <div className="relative w-64 h-64 sm:w-72 sm:h-72 mb-8">
          <div className="medallion-glow absolute -inset-6 rounded-full" style={{ background: `radial-gradient(circle, ${c.accent}55 0%, ${c.accent}00 70%)`, filter: "blur(18px)" }} />
          <div className="absolute inset-0 rounded-full overflow-hidden" style={{ boxShadow: `0 0 0 1px ${c.accent}66, 0 20px 60px -10px rgba(0,0,0,0.5)` }}>
            <img src="/hero-emblem.png" alt="" className="w-full h-full object-cover" style={{ transform: "scale(1.12)" }} />
            <div className="absolute inset-0" style={{ background: `radial-gradient(circle, transparent 45%, ${c.bg}CC 92%)` }} />
            <div className="absolute inset-0 rounded-full" style={{ boxShadow: `inset 0 0 40px 10px ${c.bg}` }} />
          </div>
        </div>

        <h1 className="text-4xl sm:text-5xl font-extrabold uppercase tracking-tight text-center leading-[0.95] mb-3">
          Run your table.<br />Own your league.
        </h1>
        <p className="font-body text-center max-w-xs mb-6" style={{ color: c.textDim }}>Create an eFootball league, invite people to join, log results — the table updates itself.</p>

        <PublicLadderPreview c={c} />

        <label className="flex items-center gap-2 mb-5 mt-2 cursor-pointer select-none">
          <span className="relative w-4 h-4 shrink-0 rounded flex items-center justify-center" style={{ background: staySignedIn ? c.accent : "transparent", border: `1px solid ${staySignedIn ? c.accent : c.borderStrong}` }}>
            <input type="checkbox" checked={staySignedIn} onChange={(e) => setStaySignedIn(e.target.checked)} className="absolute inset-0 opacity-0 cursor-pointer" />
            {staySignedIn && <Check size={11} color={c.accentText} strokeWidth={3} />}
          </span>
          <span className="font-body text-xs" style={{ color: c.textDim }}>Stay signed in on this device</span>
        </label>

        <button onClick={() => onSignIn(staySignedIn)} className="flex items-center gap-3 font-body font-semibold px-6 py-3 rounded-full" style={{ background: c.accent, color: c.accentText }}>
          <GoogleIcon /> Continue with Google
        </button>
        {!staySignedIn && (
          <p className="font-mono text-[10px] text-center max-w-xs mt-3" style={{ color: c.textFaint }}>You'll be signed out automatically once you close this tab or browser.</p>
        )}
      </div>
      <PublicLeaguePreview c={c} />
    </div>
  );
}

// The ladder's top 5, for people who haven't signed in yet — reads from the
// public_ladder_top view (granted to anon in Supabase). Deliberately styled
// as a plain scrollable line, not a card, so it sits naturally under the
// headline rather than looking like a separate widget.
function PublicLadderPreview({ c }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let cancelled = false;
    supabase.from("public_ladder_top").select("*").order("rank_position", { ascending: true })
      .then(({ data }) => { if (!cancelled) setRows(data || []); });
    return () => { cancelled = true; };
  }, []);

  if (!rows || rows.length === 0) return null;

  return (
    <div className="w-full max-w-md mb-2">
      <div className="font-mono text-[10px] tracking-[0.25em] uppercase text-center mb-2 flex items-center justify-center gap-1.5" style={{ color: c.textFaint }}>
        <TrendingUp size={11} /> The Ladder — everyone's fighting for #1
      </div>
      <div className="no-scrollbar flex items-center justify-center gap-4 overflow-x-auto px-2">
        {rows.map((row, i) => (
          <div key={row.username + i} className="flex items-center gap-1.5 shrink-0"
            style={{ borderRight: i < rows.length - 1 ? `1px solid ${c.border}` : "none", paddingRight: i < rows.length - 1 ? 16 : 0 }}>
            {i === 0 ? <Crown size={14} style={{ color: c.accent }} /> : (
              <span className="font-mono text-[11px] font-semibold" style={{ color: c.textFaint }}>#{i + 1}</span>
            )}
            <span className="font-body font-semibold text-xs truncate max-w-[90px]">{row.username}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Shows standings for admin-created leagues to visitors who haven't signed in yet.
// Reads from public_leagues / public_league_teams / public_league_fixtures views,
// which must be granted SELECT access for the `anon` role in Supabase.
function PublicLeaguePreview({ c }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [leaguesRes, teamsRes, fixturesRes] = await Promise.all([
        supabase.from("public_leagues").select("*"),
        supabase.from("public_league_teams").select("*"),
        supabase.from("public_league_fixtures").select("*"),
      ]);
      if (cancelled) return;
      setData({
        leagues: leaguesRes.data || [],
        teams: teamsRes.data || [],
        fixtures: fixturesRes.data || [],
      });
    })();
    return () => { cancelled = true; };
  }, []);

  if (!data || data.leagues.length === 0) return null;

  return (
    <div className="w-full max-w-md mt-4 space-y-6">
      <div className="font-mono text-xs uppercase tracking-[0.2em] text-center" style={{ color: c.textFaint }}>Current tables</div>
      {data.leagues.map((l) => {
        const leagueTeams = data.teams.filter((t) => t.league_id === l.id);
        const isStaged = l.format === "survivor" || l.format === "groups_knockout";
        const leagueFixtures = data.fixtures.filter((f) => f.league_id === l.id && (!isStaged || f.stage === l.current_stage));
        const inGroupStage = l.format === "groups_knockout" && !l.final_stage_started;

        if (inGroupStage) {
          if (leagueTeams.length === 0) return null;
          return (
            <div key={l.id} className="rounded-xl border p-4" style={{ borderColor: c.border, background: c.surface }}>
              <div className="font-semibold text-sm mb-3">{l.name}</div>
              <GroupTables league={{ ...l, teams: leagueTeams }} groupStageFixtures={leagueFixtures} c={c} />
            </div>
          );
        }

        const activeTeams = l.format === "survivor" ? leagueTeams.filter((t) => !t.eliminated) : leagueTeams;
        const standings = computeStandings(activeTeams, leagueFixtures);
        if (standings.length === 0) return null;
        const n = standings.length;
        const zoneFor = (idx) => {
          if (idx === 0 && n > 4) return c.accent;
          if (idx < Math.ceil(n / 3) && n > 6) return c.green;
          if (idx >= n - Math.max(1, Math.floor(n / 4)) && n > 6) return c.red;
          return "transparent";
        };
        return (
          <div key={l.id} className="rounded-xl border p-4" style={{ borderColor: c.border, background: c.surface }}>
            <div className="font-semibold text-sm mb-3">{l.name}</div>
            <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={leagueFixtures}
              isSurvivor={l.format === "survivor"} league={l} c={c} />
          </div>
        );
      })}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z" />
      <path fill="#FBBC05" d="M3.97 10.73a5.4 5.4 0 010-3.46V4.94H.96a9 9 0 000 8.12l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 00.96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

function ProfileGate({ c, theme, toggleTheme, onSubmit }) {
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);
  const usernameTrimmed = username.trim();
  const usernameIsOneWord = usernameTrimmed.length > 0 && !/\s/.test(usernameTrimmed);
  const valid = phone.trim().startsWith("+") && phone.trim().length >= 8 && usernameTrimmed.length >= 2 && usernameIsOneWord;

  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  const submit = async () => {
    setSubmitting(true);
    await onSubmit(phone.trim(), usernameTrimmed, photoFile);
    setSubmitting(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <button onClick={toggleTheme} className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
        {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-5" style={{ background: c.green }}><Lock size={24} color={c.accent} /></div>
      <h1 className="text-3xl font-extrabold uppercase tracking-tight text-center leading-none mb-2">One more step</h1>
      <p className="font-body text-center max-w-sm mb-6" style={{ color: c.textDim }}>
        Confirm your phone number and eFootball username before you can access leagues. Other players use these to reach you for matches.
      </p>
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-5">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhoto} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()}
            className="relative w-20 h-20 rounded-full overflow-hidden flex items-center justify-center mb-2"
            style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            {photoPreview ? <img src={photoPreview} alt="" className="w-full h-full object-cover" /> : <Camera size={20} style={{ color: c.textFaint }} />}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>
            {photoPreview ? "Change photo" : "Add profile photo (optional)"}
          </span>
        </div>
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>eFootball username <span style={{ color: c.textFaint }}>(one word, exactly as it appears in-game)</span></label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. Ndosi_123"
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        {usernameTrimmed.length > 0 && !usernameIsOneWord && (
          <p className="font-body text-xs mb-1.5" style={{ color: c.red }}>No spaces — use one word, like your actual in-game username (e.g. "Bounce_Academy" not "Bounce Academy").</p>
        )}
        <div className="mb-4" />
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Phone number <span style={{ color: c.textFaint }}>(with country code)</span></label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+27 82 123 4567" type="tel"
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <p className="font-body text-xs mb-5" style={{ color: c.textFaint }}>Must start with + and your country code, e.g. +27, +234, +1.</p>
        <button disabled={!valid || submitting} onClick={submit}
          className="w-full font-body font-semibold px-4 py-3 rounded-full"
          style={valid ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {submitting ? "Saving..." : "Continue to Matchday"}
        </button>
      </div>
    </div>
  );
}

// Lets an already-onboarded member update their phone/username later — mainly the
// self-service fix for "this phone number is already linked to another account"
// (phone numbers are unique platform-wide), but also covers the ordinary case of
// a changed number or in-game name.
function EditProfileModal({ profile, onCancel, onSubmit, onUpdatePhoto, c }) {
  const [phone, setPhone] = useState(profile?.phone || "");
  const [username, setUsername] = useState(profile?.efootball_username || "");
  const [submitting, setSubmitting] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const fileInputRef = useRef(null);
  const usernameTrimmed = username.trim();
  const usernameIsOneWord = usernameTrimmed.length > 0 && !/\s/.test(usernameTrimmed);
  const valid = phone.trim().startsWith("+") && phone.trim().length >= 8 && usernameTrimmed.length >= 2 && usernameIsOneWord;

  const submit = async () => {
    setSubmitting(true);
    await onSubmit(phone.trim(), usernameTrimmed);
    setSubmitting(false);
  };

  // Photo changes save immediately on selection (same pattern as league
  // photos) rather than waiting for the "Save changes" button below, which
  // only covers phone/username.
  const handlePhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingPhoto(true);
    await onUpdatePhoto(file);
    setUploadingPhoto(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="w-full max-w-sm rounded-xl p-6" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-extrabold uppercase tracking-tight">Edit your details</h2>
          <button onClick={onCancel} className="p-1" style={{ color: c.textFaint }}><X size={18} /></button>
        </div>
        <div className="flex flex-col items-center mb-5">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhoto} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} disabled={uploadingPhoto}
            className="relative w-20 h-20 rounded-full overflow-hidden flex items-center justify-center mb-2"
            style={{ background: c.surface, border: `1px solid ${c.border}`, opacity: uploadingPhoto ? 0.6 : 1 }}>
            {profile?.avatar_url ? <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" /> : <Camera size={20} style={{ color: c.textFaint }} />}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>
            {uploadingPhoto ? "Uploading…" : profile?.avatar_url ? "Change photo" : "Add profile photo"}
          </span>
        </div>
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>eFootball username <span style={{ color: c.textFaint }}>(one word, exactly as it appears in-game)</span></label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. Ndosi_123"
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        {usernameTrimmed.length > 0 && !usernameIsOneWord && (
          <p className="font-body text-xs mb-1.5" style={{ color: c.red }}>No spaces — use one word, like your actual in-game username.</p>
        )}
        <div className="mb-4" />
        <label className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Phone number <span style={{ color: c.textFaint }}>(with country code)</span></label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+27 82 123 4567" type="tel"
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <p className="font-body text-xs mb-5" style={{ color: c.textFaint }}>Must start with + and your country code, e.g. +27, +234, +1. Each number can only be linked to one account.</p>
        <button disabled={!valid || submitting} onClick={submit}
          className="w-full font-body font-semibold px-4 py-3 rounded-full"
          style={valid ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {submitting ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  );
}

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Admin-only: every account on the platform, with username + phone.
// Search, copy-to-clipboard, one-tap WhatsApp, a CSV export for offline record
// keeping, and a visible flag for any account still carrying a leftover
// "(DUPLICATE-n)" marker from the phone-uniqueness cleanup so it's easy to see
// who still needs to update their number.
function AccountsPanel({ accounts, leagues, session, onDelete, onApprove, onBack, c }) {
  const [query, setQuery] = useState("");

  if (accounts === null) return <div className="pt-8"><Loader c={c} /></div>;

  const sorted = [...accounts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const leagueCountsFor = (userId) => {
    const list = leagues || [];
    const created = list.filter((l) => l.created_by === userId).length;
    const joined = list.filter((l) => (l.members || []).some((m) => m.user_id === userId)).length;
    return { created, joined };
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? sorted.filter((a) =>
        (a.efootball_username || "").toLowerCase().includes(q) ||
        (a.phone || "").toLowerCase().includes(q) ||
        (a.email || "").toLowerCase().includes(q))
    : sorted;
  const flaggedCount = accounts.filter((a) => (a.phone || "").includes("(DUPLICATE-")).length;
  const pendingCount = accounts.filter((a) => !a.approved).length;

  const exportCsv = () => {
    const rows = [["Username", "Phone", "Google account", "Joined"], ...filtered.map((a) => [a.efootball_username, a.phone, a.email, a.created_at])];
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `matchday-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="pt-8">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}><ArrowLeft size={15} /> All leagues</button>
        <button onClick={exportCsv} disabled={filtered.length === 0} className="flex items-center gap-1.5 font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.surface, color: c.textDim, opacity: filtered.length ? 1 : 0.4 }}>
          <Download size={13} /> Export CSV
        </button>
      </div>

      <div className="flex items-center gap-2 mb-1">
        <Shield size={20} style={{ color: c.accent }} />
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">All accounts</h1>
      </div>
      <div className="font-mono text-xs mb-5" style={{ color: c.textFaint }}>
        {accounts.length} account{accounts.length === 1 ? "" : "s"} on the platform
        {pendingCount > 0 && <span style={{ color: "#B8860B" }}> · {pendingCount} pending approval</span>}
        {flaggedCount > 0 && <span style={{ color: c.red }}> · {flaggedCount} still need{flaggedCount === 1 ? "s" : ""} a phone number fixed</span>}
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by username, phone, or Google account..."
          className="w-full border rounded-lg pl-9 pr-4 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      {filtered.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          {accounts.length === 0 ? "No accounts yet." : `No accounts match "${query}".`}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((a) => (
            <AccountRow key={a.user_id} account={a} leagueCounts={leagueCountsFor(a.user_id)}
              isSelf={session && a.user_id === session.user.id}
              onDelete={() => onDelete(a, leagueCountsFor(a.user_id))} onApprove={() => onApprove(a)} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

const LEADERBOARD_METRICS = [
  { id: "wins", label: "Wins" },
  { id: "winrate", label: "Win %" },
  { id: "goals", label: "Goals" },
];
const LEADERBOARD_MIN_PLAYED_FOR_WINRATE = 3; // guards against one lucky match topping the win-rate view

function rankLeaderboard(rows, metric) {
  const pool = metric === "winrate" ? rows.filter((r) => r.p >= LEADERBOARD_MIN_PLAYED_FOR_WINRATE) : rows;
  const sorted = [...pool].sort((a, b) => {
    if (metric === "winrate") return b.winRate - a.winRate || b.w - a.w || b.gd - a.gd;
    if (metric === "goals") return b.gf - a.gf || b.gd - a.gd || b.w - a.w;
    return b.w - a.w || b.winRate - a.winRate || b.gd - a.gd;
  });
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

// Small two-up card row highlighting the top scorer and the player/club
// with the best defensive record (fewest goals conceded) out of whatever
// rows were handed in — reused by both the platform-wide Leaderboard and
// each league's own Table tab, just scoped to a different set of rows.
function GoalExtremesBar({ top, least, c }) {
  if (!top) return null;
  return (
    <div className={`grid ${least ? "grid-cols-2" : "grid-cols-1"} gap-2 mb-4`}>
      <div className="rounded-lg px-3 py-2.5 flex items-center gap-2.5 border" style={{ background: c.surface, borderColor: c.border }}>
        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}><Target size={13} /></div>
        <div className="min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>Top scorer</div>
          <div className="font-body text-xs font-semibold truncate" title={top.name}>{top.name} <span className="font-mono font-normal" style={{ color: c.textDim }}>· {top.gf}⚽</span></div>
        </div>
      </div>
      {least && (
        <div className="rounded-lg px-3 py-2.5 flex items-center gap-2.5 border" style={{ background: c.surface, borderColor: c.border }}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, color: c.textDim }}><Shield size={13} /></div>
          <div className="min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>Defensive team</div>
            <div className="font-body text-xs font-semibold truncate" title={least.name}>{least.name} <span className="font-mono font-normal" style={{ color: c.textDim }}>· {least.ga} conceded</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

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
function Leaderboard({ leagues, session, onBack, embedded, c }) {
  const [metric, setMetric] = useState("wins");
  const [query, setQuery] = useState("");
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
  const medal = (rank) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null);

  const row = (r) => (
    <div key={r.userId} className="flex items-center gap-3 rounded-lg px-4 py-2.5"
      style={{ background: session && r.userId === session.user.id ? c.surfaceHover : c.surface, border: session && r.userId === session.user.id ? `1px solid ${c.accent}` : "1px solid transparent" }}>
      <span className="w-6 text-center font-mono text-xs shrink-0" style={{ color: c.textFaint }}>{medal(r.rank) || `#${r.rank}`}</span>
      <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{r.name?.[0]?.toUpperCase() || "?"}</div>
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

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a username to find them..."
          className="w-full border rounded-lg pl-9 pr-4 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

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
    </div>
  );
}

function AccountRow({ account, leagueCounts, isSelf, onDelete, onApprove, c }) {
  const [copiedField, setCopiedField] = useState(null); // "phone" | "username" | null
  const isFlagged = (account.phone || "").includes("(DUPLICATE-");
  const digitsOnly = (account.phone || "").replace(/\D/g, "");

  const copy = (field, value) => {
    navigator.clipboard?.writeText(value || "");
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <div className="rounded-lg px-4 py-2.5 flex items-center gap-3" style={{ background: c.surface }}>
      <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>
        {(account.efootball_username || "?")[0]?.toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-body text-sm truncate flex items-center gap-1.5">
          <span className="truncate">{account.efootball_username || "—"}</span>
          {account.efootball_username && (
            <button onClick={() => copy("username", account.efootball_username)} title="Copy username" className="shrink-0" style={{ color: copiedField === "username" ? c.greenText : c.textFaint }}>
              <Copy size={11} />
            </button>
          )}
        </div>
        <div className="font-mono text-xs flex items-center gap-1" style={{ color: isFlagged ? c.red : c.textFaint }}>
          {isFlagged && <AlertTriangle size={11} />} {account.phone || "No number"}
        </div>
        {account.email && <div className="font-mono text-[11px] truncate" style={{ color: c.textFaint }}>{account.email}</div>}
        {(leagueCounts.created > 0 || leagueCounts.joined > 0) && (
          <div className="font-mono text-[10px] mt-0.5" style={{ color: c.textFaint }}>
            {leagueCounts.created > 0 && `Created ${leagueCounts.created}`}
            {leagueCounts.created > 0 && leagueCounts.joined > 0 && " · "}
            {leagueCounts.joined > 0 && `Joined ${leagueCounts.joined}`}
          </div>
        )}
      </div>
      {account.approved ? (
        <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded shrink-0 flex items-center gap-1" style={{ background: c.greenSoft, color: c.greenText }}>
          <CheckCircle2 size={11} /> Approved
        </span>
      ) : (
        <button onClick={onApprove} className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded shrink-0" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>
          Pending approval
        </button>
      )}
      <button onClick={() => copy("phone", account.phone)} title="Copy phone number" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: copiedField === "phone" ? c.greenText : c.textFaint }}>
        <Copy size={13} />
      </button>
      {!isFlagged && digitsOnly && (
        <a href={waLink(account.phone, `Hi ${account.efootball_username || "there"}, this is weAfrica admin Saul.`)} target="_blank" rel="noopener noreferrer" title="Message on WhatsApp"
          className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: WHATSAPP_GREEN }}>
          <MessageCircle size={13} />
        </a>
      )}
      {!isSelf && (
        <button onClick={onDelete} title="Delete account" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.red }}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

// Small round avatar used on the Challenges screen — a photo if the member
// has one, otherwise the same colored-initial fallback used for comments.
function MemberAvatar({ url, username, size = 32, c }) {
  if (url) {
    return <img src={url} alt="" style={{ width: size, height: size }} className="rounded-full object-cover shrink-0" />;
  }
  return (
    <div className="rounded-full flex items-center justify-center font-body font-bold shrink-0"
      style={{ width: size, height: size, background: avatarColor(username || "?"), color: "#fff", fontSize: size * 0.4 }}>
      {(username || "?")[0]?.toUpperCase()}
    </div>
  );
}

// Lets any member challenge any other member to a friendly match, and manage
// the challenges they've sent or received. A challenge starts as "pending" —
// visible to both sides, actionable only by whoever received it. Once they
// accept, both people's WhatsApp icon becomes visible to the other; nobody's
// number is exposed before that. Declining just tells the sender it was seen.
function ChallengesScreen({ session, members, challenges, openChallenges, recentResults, boardComments, isAdmin, myUsername, onPostBoardComment, onDeleteBoardComment, onToggleBoardCommentReaction, onSendChallenge, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onOpenLogResultOpen, onConfirmResultOpen, onDisputeResultOpen, onViewResultProof, onSendRandom, onAcceptOpen, onCancelOpen, onRemoveOpen, onBack, c }) {
  const [query, setQuery] = useState("");
  const [sendingTo, setSendingTo] = useState(null);
  const [sendingRandom, setSendingRandom] = useState(false);
  const [resultsQuery, setResultsQuery] = useState("");

  if (members === null || challenges === null) return <div className="pt-8"><Loader c={c} /></div>;

  const myId = session.user.id;
  const activeUserIds = new Set(
    challenges.filter((ch) => ch.status === "pending" || ch.status === "accepted")
      .map((ch) => (ch.challenger_id === myId ? ch.opponent_id : ch.challenger_id))
  );

  const q = query.trim().toLowerCase();
  const results = q ? members.filter((m) => (m.username || "").toLowerCase().includes(q)) : [];

  const send = async (member) => {
    setSendingTo(member.user_id);
    await onSendChallenge(member);
    setSendingTo(null);
    setQuery("");
  };

  const sorted = [...challenges].sort((a, b) => {
    const rank = (ch) => (ch.status === "pending" && ch.opponent_id === myId ? 0 : ch.status === "accepted" ? 1 : ch.status === "pending" ? 2 : 3);
    return rank(a) - rank(b) || new Date(b.created_at) - new Date(a.created_at);
  });

  // My own broadcast still up for grabs, if I have one — only one at a time.
  const myOpenBroadcast = (openChallenges || []).find((ch) => ch.creator_id === myId && ch.status === "open");
  // Everyone else's open broadcasts, oldest-first exception aside — newest first, ready to grab.
  const grabbable = (openChallenges || []).filter((ch) => ch.status === "open" && ch.creator_id !== myId);
  // My own resolved broadcasts (sent or grabbed) worth keeping visible briefly.
  const myResolvedOpen = (openChallenges || [])
    .filter((ch) => ch.status !== "open" && (ch.creator_id === myId || ch.accepted_by === myId))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const fireRandom = async () => {
    setSendingRandom(true);
    await onSendRandom();
    setSendingRandom(false);
  };

  // Community results feed: last 100 confirmed results platform-wide. Filter
  // client-side by username, and flag which rows involve the signed-in
  // member so their own results stand out scrolling past everyone else's.
  const rq = resultsQuery.trim().toLowerCase();
  const filteredResults = (recentResults || []).filter((r) => {
    if (!rq) return true;
    return (r.player_one || "").toLowerCase().includes(rq) || (r.player_two || "").toLowerCase().includes(rq);
  });
  const resultsToday = (recentResults || []).filter((r) => {
    const d = new Date(r.result_confirmed_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;

  return (
    <div className="pt-6">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><ArrowLeft size={16} /></button>
        <h1 className="text-2xl font-extrabold uppercase tracking-tight">Challenges</h1>
      </div>

      <div className="rounded-xl p-4 border mb-6" style={{ background: c.surface, borderColor: c.border }}>
        <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Random challenge</div>
        <div className="font-body text-xs mb-3" style={{ color: c.textDim }}>
          Fire one challenge open to every other player — whoever accepts it first gets it, then it's gone for everyone else.
        </div>
        {myOpenBroadcast ? (
          <div className="flex items-center gap-2.5 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: c.accent, color: c.accentText }}><Shuffle size={14} /></div>
            <div className="flex-1 min-w-0 font-body text-xs" style={{ color: c.textDim }}>Waiting for someone to accept your open challenge…</div>
            <button onClick={() => onCancelOpen(myOpenBroadcast)} title="Cancel" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textFaint }}><X size={14} /></button>
          </div>
        ) : (
          <button onClick={fireRandom} disabled={sendingRandom}
            className="w-full flex items-center justify-center gap-2 font-body text-sm font-semibold px-3 py-2.5 rounded-lg"
            style={{ background: c.accent, color: c.accentText, opacity: sendingRandom ? 0.6 : 1 }}>
            <Shuffle size={15} /> {sendingRandom ? "Sending…" : "Send random challenge to everyone"}
          </button>
        )}
      </div>

      {grabbable.length > 0 && (
        <>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Open challenges — grab one</div>
          <div className="flex flex-col gap-2 mb-6">
            {grabbable.map((ch) => <OpenChallengeRow key={ch.id} challenge={ch} onAccept={onAcceptOpen} c={c} />)}
          </div>
        </>
      )}

      {myResolvedOpen.length > 0 && (
        <>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Your random challenges</div>
          <div className="flex flex-col gap-2 mb-6">
            {myResolvedOpen.map((ch) => <ResolvedOpenChallengeRow key={ch.id} challenge={ch} myId={myId} onRemove={onRemoveOpen}
              onOpenLogResult={onOpenLogResultOpen} onConfirmResult={onConfirmResultOpen} onDisputeResult={onDisputeResultOpen} onViewResultProof={onViewResultProof} c={c} />)}
          </div>
        </>
      )}

      <div className="rounded-xl p-4 border mb-6" style={{ background: c.surface, borderColor: c.border }}>
        <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Challenge someone</div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by eFootball username"
            className="w-full border rounded-lg pl-9 pr-3 py-2 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        </div>
        {q && (
          <div className="mt-2 max-h-56 overflow-y-auto flex flex-col gap-1.5">
            {results.length === 0 && <div className="font-body text-xs py-2" style={{ color: c.textFaint }}>No members match "{query}".</div>}
            {results.map((m) => {
              const already = activeUserIds.has(m.user_id);
              return (
                <div key={m.user_id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2" style={{ background: c.surfaceHover }}>
                  <MemberAvatar url={m.avatar_url} username={m.username} size={30} c={c} />
                  <div className="flex-1 min-w-0 font-body text-sm truncate">{m.username}</div>
                  <button onClick={() => send(m)} disabled={already || sendingTo === m.user_id}
                    className="font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0"
                    style={already ? { background: c.surface, color: c.textFaint } : { background: c.accent, color: c.accentText, opacity: sendingTo === m.user_id ? 0.6 : 1 }}>
                    {already ? "Already active" : sendingTo === m.user_id ? "Sending…" : "Challenge"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Your challenges</div>
      {sorted.length === 0 ? (
        <div className="border border-dashed rounded-xl p-6 text-center font-body text-sm" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          No challenges yet — search above for someone to challenge.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((ch) => <ChallengeRow key={ch.id} challenge={ch} myId={myId} onAccept={onAccept} onDecline={onDecline} onRemove={onRemove}
            onOpenLogResult={onOpenLogResult} onConfirmResult={onConfirmResult} onDisputeResult={onDisputeResult} onViewResultProof={onViewResultProof} c={c} />)}
        </div>
      )}

      <div className="mt-8 flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>
          <History size={12} /> Community results
        </div>
        {recentResults && recentResults.length > 0 && (
          <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>
            {resultsToday > 0 ? `${resultsToday} today` : `${recentResults.length} shown`}
          </div>
        )}
      </div>
      <div className="font-body text-xs mb-3" style={{ color: c.textDim }}>
        The last 100 logged results across Matchday — direct and random challenges, everyone included.
      </div>

      {recentResults === null ? (
        <Loader c={c} />
      ) : recentResults.length === 0 ? (
        <div className="border border-dashed rounded-xl p-6 text-center font-body text-sm" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          No results logged yet — once someone logs a challenge score, it'll show up here for everyone.
        </div>
      ) : (
        <>
          <div className="relative mb-2.5">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
            <input value={resultsQuery} onChange={(e) => setResultsQuery(e.target.value)} placeholder="Filter by username"
              className="w-full border rounded-lg pl-8 pr-3 py-1.5 font-body text-xs outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
          </div>
          {filteredResults.length === 0 ? (
            <div className="font-body text-xs py-2 text-center" style={{ color: c.textFaint }}>No results match "{resultsQuery}".</div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-[28rem] overflow-y-auto pr-0.5">
              {filteredResults.map((r) => <CommunityResultRow key={`${r.kind}-${r.id}`} result={r} myId={myId} c={c} />)}
            </div>
          )}
        </>
      )}

      <ChallengeBoard session={session} comments={boardComments} isAdmin={isAdmin} myUsername={myUsername}
        onPost={onPostBoardComment} onDelete={onDeleteBoardComment} onToggleReaction={onToggleBoardCommentReaction} c={c} />
    </div>
  );
}

// One row in the platform-wide "Community results" feed at the bottom of the
// Challenges screen — every confirmed result from every member, not just the
// signed-in member's own. Winner's name is bolded, loser's dimmed, draws
// stay neutral; rows the signed-in member played in get a subtle highlight
// so their own results are easy to spot scrolling past everyone else's.
function CommunityResultRow({ result: r, myId, c }) {
  const p1Wins = r.score_one > r.score_two;
  const p2Wins = r.score_two > r.score_one;
  const involvesMe = myId && (r.player_one_id === myId || r.player_two_id === myId);
  const nameStyle = (isWinner) => ({ fontWeight: isWinner ? 700 : 500, color: isWinner ? c.text : c.textFaint });

  return (
    <div className="flex items-center gap-2.5 rounded-lg px-3 py-2.5" style={{ background: involvesMe ? c.surfaceHover : "transparent", border: `1px solid ${involvesMe ? c.borderStrong : c.border}`, opacity: r.confirmed ? 1 : 0.75 }}>
      <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}>
        {r.kind === "open" ? <Shuffle size={12} /> : <Trophy size={12} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-body text-sm flex items-center gap-1.5 min-w-0">
          <span className="truncate" style={nameStyle(p1Wins)}>{r.player_one}</span>
          <span className="font-mono text-xs shrink-0" style={{ color: c.textFaint }}>{r.score_one}–{r.score_two}</span>
          <span className="truncate" style={nameStyle(p2Wins)}>{r.player_two}</span>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>
          {r.kind === "open" ? "Random challenge" : "Challenge"} · {timeAgo(r.result_confirmed_at)}{!r.confirmed && " · Awaiting confirmation"}
        </div>
      </div>
    </div>
  );
}

const BOARD_PAGE_SIZE = 8;
const BOARD_MAX_INDENT_DEPTH = 4;

// A single platform-wide comment wall at the very bottom of the Challenges
// screen — banter, callouts, "who's on tonight" — open to any signed-in
// member regardless of which challenges they're personally involved in.
// Threads nest to unlimited depth, same as the per-league comments system —
// a reply can be replied to, and so on, with no cap on how many levels deep
// a conversation under one root comment can go. Indentation stops growing
// past a few levels purely for legibility on a phone; that's cosmetic only.
function ChallengeBoard({ session, comments, isAdmin, myUsername, onPost, onDelete, onToggleReaction, c }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [visibleCount, setVisibleCount] = useState(BOARD_PAGE_SIZE);
  const [pending, setPending] = useState([]); // optimistic comments/replies, cleared once the real row lands
  const textareaRef = useRef(null);
  const source = comments || [];

  useEffect(() => {
    if (pending.length === 0) return;
    setPending((prev) => prev.filter((p) => !source.some((real) =>
      real.user_id === p.user_id && real.body === p.body && real.parent_comment_id === p.parent_comment_id
      && Math.abs(new Date(real.created_at) - new Date(p.created_at)) < 15000
    )));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Build the full reply tree (unlimited depth) from the flat list, same
  // approach as the per-league comment thread: every comment becomes a node
  // with a children array, parented by walking parent_comment_id.
  const { roots, totalCount } = useMemo(() => {
    const all = [...source, ...pending];
    const byId = new Map(all.map((cm) => [cm.id, { ...cm, children: [] }]));
    const topLevel = [];
    for (const node of byId.values()) {
      if (node.parent_comment_id && byId.has(node.parent_comment_id)) {
        byId.get(node.parent_comment_id).children.push(node);
      } else if (!node.parent_comment_id) {
        topLevel.push(node);
      }
      // A reply whose parent isn't in byId (parent already deleted) falls
      // back to top-level rather than vanishing.
    }
    const sortChildren = (node) => {
      node.children.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      node.children.forEach(sortChildren);
      return node;
    };
    topLevel.forEach(sortChildren);
    const sortedRoots = [...topLevel].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { roots: sortedRoots, totalCount: all.length };
  }, [source, pending]);

  const visibleRoots = roots.slice(0, visibleCount);
  const hiddenCount = roots.length - visibleRoots.length;

  const submit = async (parentComment = null, body = text) => {
    const trimmed = body.trim();
    if (!trimmed || posting) return false;
    setPosting(true);
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId, user_id: session.user.id, username: myUsername,
      body: trimmed, created_at: new Date().toISOString(),
      parent_comment_id: parentComment?.id || null,
      challenge_board_comment_likes: [], pending: true,
    };
    setPending((prev) => [...prev, optimistic]);
    if (!parentComment) {
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    }
    const ok = await onPost(trimmed, parentComment);
    setPosting(false);
    if (!ok) { setPending((prev) => prev.filter((p) => p.id !== tempId)); if (!parentComment) setText(trimmed); }
    return ok;
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="mt-8 pt-6 border-t" style={{ borderColor: c.border }}>
      <style>{`
        @keyframes boardPopIn { 0% { opacity: 0; transform: translateY(4px); } 100% { opacity: 1; transform: translateY(0); } }
        .board-pop-in { animation: boardPopIn 0.22s ease-out; }
        @keyframes boardReactPop { 0% { transform: scale(1); } 35% { transform: scale(1.4); } 100% { transform: scale(1); } }
        .board-react-pop { animation: boardReactPop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1); display: inline-block; }
        @keyframes boardPickerIn { 0% { opacity: 0; transform: scale(0.85) translateY(2px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
        .board-reaction-picker { animation: boardPickerIn 0.12s ease-out; }
        .board-textarea:focus { border-color: ${c.accent} !important; }
        .board-reaction-emoji-btn:hover { transform: scale(1.3); }
        @media (prefers-reduced-motion: reduce) {
          .board-pop-in, .board-react-pop, .board-reaction-picker { animation: none; }
          .board-reaction-emoji-btn:hover { transform: none; }
        }
      `}</style>

      <div className="flex items-center gap-2 mb-3 font-mono text-xs uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>
        <MessageCircle size={13} /> Challenge board {totalCount > 0 && `(${totalCount})`}
      </div>

      {comments === null ? (
        <Loader c={c} />
      ) : (
        <>
          {roots.length === 0 ? (
            <div className="border border-dashed rounded-xl p-6 text-center mb-4" style={{ borderColor: c.borderStrong, color: c.textDim }}>
              <MessageCircle size={20} className="mx-auto mb-2" style={{ color: c.textFaint }} />
              <div className="font-body text-sm">No comments yet — say something to get things going.</div>
            </div>
          ) : (
            <div className="space-y-2.5 mb-3">
              {visibleRoots.map((cm) => (
                <BoardCommentNode key={cm.id} comment={cm} session={session} isAdmin={isAdmin}
                  onPost={submit} onDelete={onDelete} onToggleReaction={onToggleReaction} c={c} depth={0} />
              ))}
            </div>
          )}

          {hiddenCount > 0 && (
            <button onClick={() => setVisibleCount((v) => v + BOARD_PAGE_SIZE)}
              className="mb-4 font-mono text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-full transition-colors"
              style={{ background: c.surface, color: c.textDim }}>
              Show {Math.min(hiddenCount, BOARD_PAGE_SIZE)} more comment{Math.min(hiddenCount, BOARD_PAGE_SIZE) === 1 ? "" : "s"}
            </button>
          )}

          <div className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center font-body font-bold text-xs shrink-0"
              style={{ background: avatarColor(myUsername || "?"), color: "#fff" }}>
              {(myUsername || "?")[0]?.toUpperCase()}
            </div>
            <textarea ref={textareaRef} value={text}
              onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
              onKeyDown={onKeyDown}
              placeholder="Say something…" rows={1} maxLength={1000}
              className="board-textarea flex-1 font-body text-sm rounded-xl px-3 py-2.5 resize-none outline-none transition-colors"
              style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
            <button onClick={() => submit()} disabled={!text.trim() || posting}
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-full transition-transform active:scale-90"
              style={text.trim() && !posting ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              <Send size={15} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// A single comment on the challenge board, its reaction/reply row, and —
// recursively — every reply underneath it, no matter how deep. Each node
// owns its own "reply box open?" / "replies expanded?" state independently
// of its siblings and ancestors, exactly like the per-league CommentNode.
function BoardCommentNode({ comment: cm, session, isAdmin, onPost, onDelete, onToggleReaction, c, depth }) {
  const isOwn = session && cm.user_id === session.user.id;
  const realReactions = cm.challenge_board_comment_likes || [];
  const children = cm.children || [];
  const indent = Math.min(depth + 1, BOARD_MAX_INDENT_DEPTH) * 36;

  const [pendingReaction, setPendingReaction] = useState(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const [replyOpen, setReplyOpen] = useState(false);
  const [repliesShown, setRepliesShown] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const pickerRef = useRef(null);
  const replyRef = useRef(null);

  // A reply that's still in flight should already be visible under this
  // thread, so expand it the moment the optimistic reply is queued rather
  // than waiting for the round trip to finish.
  useEffect(() => {
    if (children.some((r) => r.pending)) setRepliesShown(true);
  }, [children]);

  const myRealReaction = session ? (realReactions.find((l) => l.user_id === session.user.id)?.reaction || null) : null;
  useEffect(() => {
    if (pendingReaction !== undefined && pendingReaction === myRealReaction) setPendingReaction(undefined);
  }, [myRealReaction]); // eslint-disable-line react-hooks/exhaustive-deps

  const reactions = useMemo(() => {
    if (pendingReaction === undefined) return realReactions;
    const others = realReactions.filter((l) => !(session && l.user_id === session.user.id));
    return pendingReaction === null ? others : [...others, { user_id: session.user.id, reaction: pendingReaction }];
  }, [realReactions, pendingReaction, session]);

  const myReaction = pendingReaction !== undefined ? pendingReaction : myRealReaction;
  const summary = useMemo(() => {
    const counts = new Map();
    for (const r of reactions) counts.set(r.reaction, (counts.get(r.reaction) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [reactions]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onOutside = (e) => { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false); };
    const onEscape = (e) => { if (e.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onOutside); document.removeEventListener("keydown", onEscape); };
  }, [pickerOpen]);

  const react = async (emoji) => {
    if (!session || cm.pending) return;
    setPickerOpen(false);
    setPendingReaction(emoji);
    setPopKey((k) => k + 1);
    const ok = await onToggleReaction(cm, emoji);
    if (!ok) setPendingReaction(undefined);
  };

  const handleMainClick = async () => {
    if (!session || cm.pending) return;
    if (myReaction) {
      setPendingReaction(null);
      const ok = await onToggleReaction(cm, null);
      if (!ok) setPendingReaction(undefined);
    } else {
      setPickerOpen((v) => !v);
    }
  };

  const canReply = !!session && !cm.pending;

  const submitReply = async () => {
    const trimmed = replyText.trim();
    if (!trimmed || replying) return;
    setReplying(true);
    setReplyText("");
    setReplyOpen(false);
    const ok = await onPost(cm, trimmed);
    setReplying(false);
    if (!ok) setReplyText(trimmed);
  };

  const onReplyKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitReply(); }
    if (e.key === "Escape") { setReplyOpen(false); setReplyText(""); }
  };

  return (
    <div className={cm.pending ? "opacity-60" : "board-pop-in"}>
      <div className="flex items-start gap-2.5 group" style={{ marginLeft: indent }}>
        <div className="rounded-full flex items-center justify-center font-body font-bold shrink-0"
          style={{ background: avatarColor(cm.username), color: "#fff", width: 28, height: 28, fontSize: 12 }}>
          {cm.username?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="flex-1 min-w-0 rounded-xl px-3 py-2 transition-colors" style={{ background: c.surface }}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-body font-semibold text-xs truncate">{cm.username}</span>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>
                {cm.pending ? "sending…" : timeAgo(cm.created_at)}
              </span>
              {!cm.pending && (isOwn || isAdmin) && (
                <button onClick={() => onDelete(cm)} title="Delete"
                  className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: c.textFaint }}>
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          </div>
          <div className="font-body text-sm mt-0.5 whitespace-pre-wrap break-words">{cm.body}</div>
          {!cm.pending && (
            <div className="flex items-center gap-3 mt-1.5">
              <div className="relative" ref={pickerRef}>
                <button onClick={handleMainClick} disabled={!session}
                  className="flex items-center gap-1 font-mono text-[10px] transition-colors"
                  style={{ color: myReaction ? c.accent : c.textFaint }}>
                  <span key={popKey} className={popKey > 0 ? "board-react-pop" : ""} style={{ fontSize: 12, lineHeight: 1 }}>
                    {myReaction ? REACTION_EMOJI[myReaction] : "🤍"}
                  </span>
                  {reactions.length > 0 && (
                    <span>{summary.slice(0, 3).map(([key]) => REACTION_EMOJI[key]).join("")} {reactions.length}</span>
                  )}
                </button>

                {pickerOpen && (
                  <div className="board-reaction-picker absolute top-full left-0 mt-1.5 flex items-center gap-0.5 rounded-full px-1.5 py-1 shadow-lg z-10"
                    style={{ background: c.surfaceHover, border: `1px solid ${c.borderStrong}` }}>
                    {REACTIONS.map((r) => (
                      <button key={r.key} onClick={() => react(r.key)} title={r.key}
                        className="board-reaction-emoji-btn px-1 transition-transform" style={{ fontSize: 16, lineHeight: 1 }}>
                        {r.emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {canReply && (
                <button onClick={() => setReplyOpen((v) => !v)}
                  className="font-mono text-[10px] uppercase tracking-wider transition-colors"
                  style={{ color: c.textFaint }}>
                  Reply
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {children.length > 0 && (
        <button onClick={() => setRepliesShown((v) => !v)}
          className="mt-1 font-mono text-[10px] uppercase tracking-wider flex items-center gap-1"
          style={{ color: c.textFaint, marginLeft: indent + 38 }}>
          <CornerDownRight size={11} />
          {repliesShown ? "Hide" : "Show"} {children.length} repl{children.length === 1 ? "y" : "ies"}
        </button>
      )}

      {repliesShown && (
        <div className="mt-2 space-y-2">
          {children.map((r) => (
            <BoardCommentNode key={r.id} comment={r} session={session} isAdmin={isAdmin}
              onPost={onPost} onDelete={onDelete} onToggleReaction={onToggleReaction} c={c} depth={depth + 1} />
          ))}
        </div>
      )}

      {replyOpen && (
        <div className="mt-2" style={{ marginLeft: indent + 38 }}>
          <div className="flex items-center gap-1.5 mb-1.5 font-mono text-[10px]" style={{ color: c.textFaint }}>
            <CornerDownRight size={11} />
            Replying to {cm.username}
            <button onClick={() => { setReplyOpen(false); setReplyText(""); }} className="ml-0.5" style={{ color: c.textFaint }}>
              <X size={11} />
            </button>
          </div>
          <div className="flex items-end gap-2">
            <textarea ref={replyRef} value={replyText}
              onChange={(e) => { setReplyText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
              onKeyDown={onReplyKeyDown}
              placeholder={`Reply to ${cm.username}…`} rows={1} maxLength={1000} autoFocus
              className="board-textarea flex-1 font-body text-sm rounded-xl px-3 py-2 resize-none outline-none transition-colors"
              style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
            <button onClick={submitReply} disabled={!replyText.trim() || replying}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-transform active:scale-90"
              style={replyText.trim() && !replying ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              <Send size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// One grabbable row in the open-challenge pool — anyone but the creator can
// accept it. The accept button locally disables itself the instant it's
// tapped so a slow network round-trip can't look like nothing happened,
// and the row simply vanishes (via the next reload) once it's taken.
function OpenChallengeRow({ challenge: ch, onAccept, c }) {
  const [accepting, setAccepting] = useState(false);
  const accept = async () => {
    setAccepting(true);
    await onAccept(ch);
    setAccepting(false);
  };
  return (
    <div className="rounded-xl p-3.5 border flex items-center gap-3" style={{ background: c.surface, borderColor: c.border }}>
      <MemberAvatar url={null} username={ch.creator_username} size={34} c={c} />
      <div className="flex-1 min-w-0">
        <div className="font-body text-sm font-semibold truncate">{ch.creator_username}</div>
        <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.accent }}>Open to anyone — first to accept wins it</div>
      </div>
      <button onClick={accept} disabled={accepting}
        className="font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0"
        style={{ background: c.accent, color: c.accentText, opacity: accepting ? 0.6 : 1 }}>
        {accepting ? "Accepting…" : "Accept"}
      </button>
    </div>
  );
}

// A resolved (accepted/cancelled) broadcast, shown to whichever side is
// looking at it — the creator or whoever grabbed it.
function ResolvedOpenChallengeRow({ challenge: ch, myId, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onViewResultProof, c }) {
  const [resolving, setResolving] = useState(false);
  const iAmCreator = ch.creator_id === myId;
  const counterpartUsername = iAmCreator ? ch.accepted_by_username : ch.creator_username;
  const counterpartPhone = iAmCreator ? ch.accepted_by_phone : ch.creator_phone;

  // Scores are stored from the creator's perspective — flip for display when
  // the signed-in member is the one who accepted it.
  const myScore = iAmCreator ? ch.creator_score : ch.accepted_by_score;
  const theirScore = iAmCreator ? ch.accepted_by_score : ch.creator_score;
  const iReported = ch.result_reported_by === myId;

  const resolve = async (fn) => {
    setResolving(true);
    await fn(ch);
    setResolving(false);
  };

  return (
    <div className="rounded-xl p-3.5 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="flex items-center gap-3">
        <MemberAvatar url={null} username={counterpartUsername || ch.creator_username} size={34} c={c} />
        <div className="flex-1 min-w-0">
          <div className="font-body text-sm font-semibold truncate">{counterpartUsername || "Random challenge"}</div>
          {ch.status === "accepted" && ch.result_status === "confirmed" && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.greenText }}>Final: you {myScore} – {theirScore} {counterpartUsername}</div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && iReported && (
            <div className="font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.textFaint }}><Clock size={10} /> You {myScore} – {theirScore} them · waiting for confirmation</div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && !iReported && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.accent }}>They reported you {myScore} – {theirScore} them</div>
          )}
          {ch.status === "accepted" && !ch.result_status && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.greenText }}>Accepted — say hi and set a time</div>}
          {ch.status === "cancelled" && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>Cancelled</div>}
        </div>
        {ch.status === "accepted" && !ch.result_status && (
          <div className="flex items-center gap-1.5 shrink-0">
            <WhatsAppLink phone={counterpartPhone} iconOnly text={`Hi, it's a random challenge match on Matchday — when are you free?`} c={c} />
            <button onClick={() => onRemove(ch)} title="Remove" className="w-7 h-7 flex items-center justify-center rounded-full" style={{ color: c.textFaint }}><Trash2 size={12} /></button>
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "pending" && iReported && (
          <div className="flex items-center gap-1.5 shrink-0">
            <WhatsAppLink phone={counterpartPhone} iconOnly text={`Hi, it's a random challenge match on Matchday — when are you free?`} c={c} />
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "pending" && !iReported && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => resolve(onConfirmResult)} disabled={resolving} title="Confirm result" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.accent, color: c.accentText }}><Check size={14} /></button>
            <button onClick={() => resolve(onDisputeResult)} disabled={resolving} title="Dispute result" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "confirmed" && (
          <button onClick={() => onRemove(ch)} title="Remove" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}><Trash2 size={12} /></button>
        )}
        {ch.status === "cancelled" && (
          <button onClick={() => onRemove(ch)} title="Dismiss" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}><X size={13} /></button>
        )}
      </div>
      {ch.status === "accepted" && !ch.result_status && (
        <button onClick={() => onOpenLogResult(ch)}
          className="w-full mt-3 flex items-center justify-center gap-1.5 font-body text-sm font-semibold px-3 py-2.5 rounded-lg"
          style={{ background: c.accent, color: c.accentText }}>
          <Trophy size={14} /> Log result
        </button>
      )}
      {ch.status === "accepted" && ch.result_status === "pending" && (
        <button onClick={() => onViewResultProof(ch)}
          className="w-full mt-3 flex items-center justify-center gap-1.5 font-body text-xs font-semibold px-3 py-2 rounded-lg border"
          style={{ borderColor: c.borderStrong, color: c.textDim }}>
          <Camera size={13} /> View photo proof
        </button>
      )}
    </div>
  );
}

function ChallengeRow({ challenge: ch, myId, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onViewResultProof, c }) {
  const [responding, setResponding] = useState(false);
  const [resolving, setResolving] = useState(false);
  const iAmChallenger = ch.challenger_id === myId;
  const counterpartUsername = iAmChallenger ? ch.opponent_username : ch.challenger_username;
  const counterpartPhone = iAmChallenger ? ch.opponent_phone : ch.challenger_phone;

  // Scores are stored from the challenger's perspective — flip them for
  // display when the signed-in member is the opponent, so "my score" always
  // reads on the left regardless of who challenged whom.
  const myScore = iAmChallenger ? ch.challenger_score : ch.opponent_score;
  const theirScore = iAmChallenger ? ch.opponent_score : ch.challenger_score;
  const iReported = ch.result_reported_by === myId;

  const respond = async (accept) => {
    setResponding(true);
    await (accept ? onAccept(ch) : onDecline(ch));
    setResponding(false);
  };

  const resolve = async (fn) => {
    setResolving(true);
    await fn(ch);
    setResolving(false);
  };

  return (
    <div className="rounded-xl p-3.5 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="flex items-center gap-3">
        <MemberAvatar url={null} username={counterpartUsername} size={34} c={c} />
        <div className="flex-1 min-w-0">
          <div className="font-body text-sm font-semibold truncate flex items-center gap-1.5">
            {counterpartUsername}
            {ch.is_ladder && (
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 flex items-center gap-1" style={{ background: c.surfaceHover, color: c.textFaint }}>
                <Swords size={9} /> Ladder
              </span>
            )}
          </div>
          {ch.status === "pending" && !iAmChallenger && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.accent }}>Challenged you</div>}
          {ch.status === "pending" && iAmChallenger && <div className="font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.textFaint }}><Clock size={10} /> Waiting for them to accept</div>}
          {ch.status === "pending" && ch.is_ladder && (() => { const d = ladderDaysLeft(ch.created_at, 7); return d !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: d <= 2 ? c.red : c.textFaint }}>
              {iAmChallenger ? `Walkover in ${d}d if they don't respond` : `Accept within ${d}d or you forfeit the spot`}
            </div>
          ); })()}
          {ch.status === "accepted" && ch.result_status === "confirmed" && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.greenText }}>Final: you {myScore} – {theirScore} {counterpartUsername}</div>
          )}
          {ch.status === "accepted" && ch.result_status === "expired" && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.red }}>Expired, no result logged — you both dropped a spot</div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && iReported && (
            <div className="font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.textFaint }}><Clock size={10} /> You {myScore} – {theirScore} them · waiting for confirmation</div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && !iReported && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.accent }}>They reported you {myScore} – {theirScore} them</div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && ch.is_ladder && (() => { const d = ladderDaysLeft(ch.result_reported_at, 2); return d !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: d <= 1 ? c.red : c.textFaint }}>
              {iReported ? `Auto-confirms in ${d}d if they don't respond` : `Confirm within ${d}d or it auto-confirms`}
            </div>
          ); })()}
          {ch.status === "accepted" && !ch.result_status && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.greenText }}>Accepted — say hi and set a time</div>}
          {ch.status === "accepted" && !ch.result_status && ch.is_ladder && (() => { const d = ladderDaysLeft(ch.responded_at, 7); return d !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: d <= 2 ? c.red : c.textFaint }}>{d}d left to log a result, or you both drop a spot</div>
          ); })()}
          {ch.status === "declined" && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.red }}>{iAmChallenger ? "They declined" : "You declined"}</div>}
          {ch.status === "expired" && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.red }}>{iAmChallenger ? "Walkover — they didn't respond in time" : "Expired — you didn't respond in time"}</div>}
        </div>
        {ch.status === "pending" && !iAmChallenger && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => respond(true)} disabled={responding} title="Accept" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.accent, color: c.accentText }}><Check size={14} /></button>
            <button onClick={() => respond(false)} disabled={responding} title="Decline" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
          </div>
        )}
        {ch.status === "pending" && iAmChallenger && (
          <button onClick={() => onRemove(ch)} title="Cancel challenge" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
        )}
        {ch.status === "accepted" && !ch.result_status && (
          <div className="flex items-center gap-1.5 shrink-0">
            <WhatsAppLink phone={counterpartPhone} iconOnly text={`Hi, it's a challenge match on Matchday — when are you free?`} c={c} />
            <button onClick={() => onRemove(ch)} title="Remove" className="w-7 h-7 flex items-center justify-center rounded-full" style={{ color: c.textFaint }}><Trash2 size={12} /></button>
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "pending" && iReported && (
          <div className="flex items-center gap-1.5 shrink-0">
            <WhatsAppLink phone={counterpartPhone} iconOnly text={`Hi, it's a challenge match on Matchday — when are you free?`} c={c} />
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "pending" && !iReported && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => resolve(onConfirmResult)} disabled={resolving} title="Confirm result" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.accent, color: c.accentText }}><Check size={14} /></button>
            <button onClick={() => resolve(onDisputeResult)} disabled={resolving} title="Dispute result" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "confirmed" && (
          <button onClick={() => onRemove(ch)} title="Remove" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}><Trash2 size={12} /></button>
        )}
        {ch.status === "accepted" && ch.result_status === "expired" && (
          <button onClick={() => onRemove(ch)} title="Dismiss" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}><X size={13} /></button>
        )}
        {ch.status === "declined" && (
          <button onClick={() => onRemove(ch)} title="Dismiss" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}><X size={13} /></button>
        )}
        {ch.status === "expired" && (
          <button onClick={() => onRemove(ch)} title="Dismiss" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: c.textFaint }}><X size={13} /></button>
        )}
      </div>
      {ch.status === "accepted" && !ch.result_status && (
        <button onClick={() => onOpenLogResult(ch)}
          className="w-full mt-3 flex items-center justify-center gap-1.5 font-body text-sm font-semibold px-3 py-2.5 rounded-lg"
          style={{ background: c.accent, color: c.accentText }}>
          <Trophy size={14} /> Log result
        </button>
      )}
      {ch.status === "accepted" && ch.result_status === "pending" && (
        <button onClick={() => onViewResultProof(ch)}
          className="w-full mt-3 flex items-center justify-center gap-1.5 font-body text-xs font-semibold px-3 py-2 rounded-lg border"
          style={{ borderColor: c.borderStrong, color: c.textDim }}>
          <Camera size={13} /> View photo proof
        </button>
      )}
    </div>
  );
}

function Header({ view, setView, activeLeague, theme, toggleTheme, c, onSignOut, userEmail, avatarUrl, onEditProfile, isAdmin, onOpenAccounts, onOpenChallenges, challengeBadge, onOpenSuggestion, onOpenLeaderboard }) {
  return (
    <header className="border-b sticky top-0 backdrop-blur z-40" style={{ borderColor: c.border, background: `${c.bg}F2` }}>
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
        <button onClick={() => setView("home")} className="flex items-center gap-2">
          <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: c.green }}><Trophy size={16} color={c.accent} /></div>
          <div className="text-lg font-extrabold tracking-tight uppercase">Matchday</div>
        </button>
        {view === "league" && activeLeague && (
          <div className="hidden sm:block font-mono text-xs uppercase tracking-wider" style={{ color: c.textFaint }}>
            {activeLeague.teams.length} clubs · {activeLeague.fixtures.filter((f) => f.played).length}/{activeLeague.fixtures.length} played
          </div>
        )}
        <div className="flex items-center gap-2">
          <button onClick={onOpenSuggestion} title="Suggest something" className="flex items-center gap-1.5 px-3 h-8 rounded-full font-body text-xs font-semibold" style={{ background: c.accent, color: c.accentText }}>
            <MessageCircle size={13} /> <span className="hidden sm:inline">Suggest</span>
          </button>
          <button onClick={onOpenLeaderboard} title="Leaderboard" className="w-8 h-8 flex items-center justify-center rounded-full" style={view === "leaderboard" ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}><Trophy size={14} /></button>
          <button onClick={onOpenChallenges} title="Challenges" className="relative w-8 h-8 flex items-center justify-center rounded-full" style={view === "challenges" ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
            <Target size={14} />
            {challengeBadge > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center font-mono text-[8px] font-bold" style={{ background: c.red, color: "#fff" }}>{challengeBadge}</span>
            )}
          </button>
          {isAdmin && (
            <button onClick={onOpenAccounts} title="All accounts" className="w-8 h-8 flex items-center justify-center rounded-full" style={view === "accounts" ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}><Shield size={14} /></button>
          )}
          <button onClick={toggleTheme} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button onClick={onEditProfile} title="Edit profile" className="w-8 h-8 flex items-center justify-center rounded-full overflow-hidden" style={{ background: c.surface, color: c.textDim }}>
            {avatarUrl ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" /> : <Settings2 size={14} />}
          </button>
          <button onClick={onSignOut} title={userEmail} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><LogOut size={14} /></button>
        </div>
      </div>
    </header>
  );
}

// Global feedback box, reachable from the header on every screen ("top of
// the website"). Open to any signed-in user — doesn't require joining or
// managing any particular league.
function SuggestionModal({ onCancel, onSubmit, c }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const submit = async () => {
    if (!text.trim() || posting) return;
    setPosting(true);
    await onSubmit(text.trim());
    setPosting(false);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onCancel}>
      <div className="w-full max-w-sm rounded-xl p-5 border" style={{ background: c.bg, borderColor: c.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="font-body font-bold text-base">Suggest something</div>
          <button onClick={onCancel} style={{ color: c.textFaint }}><X size={16} /></button>
        </div>
        <div className="font-body text-xs mb-3" style={{ color: c.textDim }}>
          Got an idea for a feature, or found something broken? Tell us here.
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={1000} autoFocus
          placeholder="What should we build or fix?"
          className="w-full font-body text-sm rounded-xl px-3 py-2.5 resize-none outline-none mb-3"
          style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
        <button onClick={submit} disabled={!text.trim() || posting}
          className="w-full font-body text-sm font-semibold px-4 py-2.5 rounded-full"
          style={text.trim() && !posting ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
          {posting ? "Sending…" : "Send suggestion"}
        </button>
      </div>
    </div>
  );
}

function Home({ leagues, isAdmin, isMemberOf, entryClosed, myPaymentStatus, canManageLeague, onOpen, onCreate, onJoin, session, onToggleLeagueReaction, openChallenges, onOpenChallenges, ladder, myLadderRank, onOpenLadderChallenge, c }) {
  const cashLeagues = leagues.filter((l) => l.league_type === "cash");
  const funLeagues = leagues.filter((l) => l.league_type !== "cash");

  // Open random challenges anyone but the signed-in member can still grab —
  // same "unaccepted and up for grabs" definition ChallengesScreen uses.
  const grabbableChallenges = (openChallenges || []).filter((ch) => ch.status === "open" && ch.creator_id !== session?.user?.id);

  // Leagues that need the viewer's attention (something to review, or their
  // own payment needs sorting out) float to the top of each section; the
  // rest stay newest-first.
  const attentionScore = (l) => {
    const pendingCount = l.league_type === "cash" ? (l.members || []).filter((m) => m.payment_status === "pending").length : 0;
    const pendingResultsCount = (l.result_submissions || []).filter((s) => s.status === "pending" && resultConfirmExpired(s)).length;
    const myStatus = l.league_type === "cash" ? myPaymentStatus(l) : null;
    let score = 0;
    if (canManageLeague(l) && (pendingCount > 0 || pendingResultsCount > 0)) score += 2;
    if (myStatus === "rejected" || myStatus === "pending") score += 1;
    return score;
  };
  const sortLeagues = (list) => [...list].sort((a, b) => attentionScore(b) - attentionScore(a) || new Date(b.created_at) - new Date(a.created_at));

  return (
    <div>
      <LadderStrip ladder={ladder} myLadderRank={myLadderRank} onOpenLadderChallenge={onOpenLadderChallenge} c={c} />

      {grabbableChallenges.length > 0 && (
        <button onClick={onOpenChallenges} className="animate-flicker w-full flex items-center gap-2.5 mt-4 px-4 py-2.5 rounded-full font-body text-xs font-semibold text-left"
          style={{ background: c.accent, color: c.accentText }}>
          <Shuffle size={14} className="shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            {grabbableChallenges.length === 1 ? "1 random challenge" : `${grabbableChallenges.length} random challenges`} waiting — first to accept gets it!
          </span>
          <ChevronRight size={14} className="shrink-0" />
        </button>
      )}

      <section className="pt-10 pb-6">
        <div className="font-mono text-xs tracking-[0.2em] uppercase mb-2" style={{ color: c.accent }}>Season 2026</div>
        <h1 className="text-4xl sm:text-5xl font-extrabold uppercase tracking-tight leading-[0.95]">Run your table.<br />Own your league.</h1>
        <p className="font-body mt-3 max-w-md" style={{ color: c.textDim }}>
          {isAdmin ? "Leagues you create here are public. " : ""}Create an eFootball league, invite people to join, log results — the table updates itself.
        </p>
        <div className="flex flex-wrap items-center gap-2.5 mt-5">
          <button onClick={onCreate} className="inline-flex items-center gap-2 font-body font-semibold px-5 py-2.5 rounded-full" style={{ background: c.accent, color: c.accentText }}>
            <Plus size={16} strokeWidth={2.5} /> New league
          </button>
          <button onClick={onOpenChallenges} title="Send or grab a random challenge" className="inline-flex items-center gap-2 font-body font-semibold px-5 py-2.5 rounded-full border" style={{ borderColor: c.borderStrong, color: c.text }}>
            <Shuffle size={16} strokeWidth={2.5} /> Random challenge
          </button>
        </div>
      </section>

      {leagues.length === 0 && (
        <section>
          <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>Start the first one — it takes about a minute.</div>
        </section>
      )}

      <LeagueSection title="Fun leagues" icon="🎮" leagues={sortLeagues(funLeagues)} isAdmin={isAdmin} isMemberOf={isMemberOf}
        entryClosed={entryClosed} myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
        session={session} onToggleLeagueReaction={onToggleLeagueReaction} onCreate={onCreate} c={c} />

      {cashLeagues.length > 0 && (
        <LeagueSection title="Cash leagues" icon="💰" leagues={sortLeagues(cashLeagues)} isAdmin={isAdmin} isMemberOf={isMemberOf}
          entryClosed={entryClosed} myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
          session={session} onToggleLeagueReaction={onToggleLeagueReaction} c={c} />
      )}

      <section className="mt-10 pt-8" style={{ borderTop: `1px solid ${c.border}` }}>
        <Leaderboard leagues={leagues} session={session} embedded c={c} />
      </section>
    </div>
  );
}

// The permanent ladder, sitting in front of everything else on Home — a
// horizontally-scrolling strip, not a boxed-off card, so it reads as part of
// the page rather than a widget bolted onto it. Shows the top 5 by
// rank_position (which never resets) plus, if the viewer has a spot on it
// themselves, a quiet "you're #N" line that opens the challenge picker.
function LadderStrip({ ladder, myLadderRank, onOpenLadderChallenge, c }) {
  if (!ladder || ladder.length === 0) return null;
  const top5 = ladder.slice(0, 5);
  return (
    <section className="pt-5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="font-mono text-[11px] tracking-[0.25em] uppercase flex items-center gap-1.5" style={{ color: c.textFaint }}>
          <TrendingUp size={12} /> The Ladder
        </div>
        {myLadderRank && (
          <button onClick={onOpenLadderChallenge} className="font-mono text-[11px] uppercase tracking-wider flex items-center gap-1 shrink-0" style={{ color: c.accent }}>
            You're #{myLadderRank.rank_position} <ChevronRight size={12} />
          </button>
        )}
      </div>
      <div className="no-scrollbar flex items-stretch gap-4 overflow-x-auto -mx-4 px-4 pb-1">
        {top5.map((row, i) => (
          <div key={row.user_id} className="flex items-center gap-2 shrink-0"
            style={{ borderRight: i < top5.length - 1 ? `1px solid ${c.border}` : "none", paddingRight: i < top5.length - 1 ? 16 : 0 }}>
            {i === 0 ? <Crown size={16} style={{ color: c.accent }} /> : (
              <span className="font-mono text-xs font-semibold" style={{ color: c.textFaint }}>#{i + 1}</span>
            )}
            <div className="flex flex-col leading-tight">
              <span className="font-body font-semibold text-sm truncate max-w-[110px]">{row.username}</span>
              <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{row.wins}W–{row.losses}L</span>
            </div>
          </div>
        ))}
        {myLadderRank && myLadderRank.rank_position > 5 && (
          <button onClick={onOpenLadderChallenge} className="flex items-center gap-1.5 shrink-0 font-mono text-[11px]" style={{ color: c.textFaint, paddingLeft: 2 }}>
            <Swords size={13} /> Climb it
          </button>
        )}
      </div>
    </section>
  );
}

// The picker for who a member is allowed to send a ladder challenge to —
// always just the (up to) 3 names directly above them, closest first.
function LadderChallengeSheet({ myRank, targets, onChallenge, onCancel, c }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onCancel}>
      <div className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5" style={{ background: c.bg, color: c.text }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="font-extrabold uppercase tracking-tight text-lg flex items-center gap-2"><Swords size={18} /> Climb the ladder</div>
          <button onClick={onCancel} className="w-7 h-7 flex items-center justify-center rounded-full" style={{ background: c.surface }}><X size={14} /></button>
        </div>
        <p className="font-body text-xs mb-4" style={{ color: c.textDim }}>
          {myRank ? `You're #${myRank.rank_position}. Beat one of these and their spot is yours.` : "You'll get a ladder spot once your profile is set up."}
        </p>
        {targets.length === 0 ? (
          <div className="font-body text-sm text-center py-6" style={{ color: c.textFaint }}>
            {myRank && myRank.rank_position === 1 ? "You're #1 — nobody left to challenge." : "No one directly above you yet."}
          </div>
        ) : (
          <div className="space-y-2">
            {targets.map((t) => (
              <div key={t.user_id} className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: c.surface }}>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs font-semibold shrink-0" style={{ color: c.textFaint }}>#{t.rank_position}</span>
                  <span className="font-body font-semibold text-sm truncate">{t.username}</span>
                </div>
                <button onClick={() => onChallenge(t)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}>
                  Challenge
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LeagueSection({ title, icon, leagues, isAdmin, isMemberOf, entryClosed, myPaymentStatus, canManageLeague, onOpen, onJoin, session, onToggleLeagueReaction, onCreate, c }) {
  const pendingReviewCount = leagues.filter(canManageLeague).reduce((sum, l) =>
    sum + (l.members || []).filter((m) => m.payment_status === "pending").length, 0);
  if (leagues.length === 0 && !onCreate) return null;
  return (
    <section className="mt-8 first:mt-0">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-xs uppercase tracking-[0.2em] flex items-center gap-2" style={{ color: c.textFaint }}>
          <span>{icon}</span> {title} <span style={{ color: c.textFaint }}>({leagues.length})</span>
        </div>
        {pendingReviewCount > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: c.redSoft, color: c.red }}>
            {pendingReviewCount} payment{pendingReviewCount === 1 ? "" : "s"} to review
          </span>
        )}
      </div>
      <div className="space-y-2">
        {leagues.map((l) => (
          <LeagueCard key={l.id} league={l} isAdmin={isAdmin} joined={isMemberOf(l)} closed={entryClosed(l)}
            myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
            session={session} onToggleLeagueReaction={onToggleLeagueReaction} c={c} />
        ))}
        {onCreate && (
          <button onClick={onCreate} className="w-full flex items-center justify-center gap-2 border border-dashed rounded-xl px-4 py-4 font-body text-sm font-semibold"
            style={{ borderColor: c.borderStrong, color: c.textDim }}>
            <Plus size={16} strokeWidth={2.5} /> Create your own league
          </button>
        )}
      </div>
    </section>
  );
}

function LeagueCard({ league: l, isAdmin, joined, closed, myPaymentStatus, canManageLeague, onOpen, onJoin, session, onToggleLeagueReaction, c }) {
  const played = l.fixtures.filter((f) => f.played).length;
  const paymentStatus = l.league_type === "cash" ? myPaymentStatus(l) : null;
  const isCash = l.league_type === "cash";
  const canSeePool = canManageLeague(l) || paymentStatus === "approved";
  const approvedMembers = isCash ? (l.members || []).filter((m) => m.payment_status === "approved") : [];
  const pool = approvedMembers.reduce((sum, m) => sum + (m.entry_fee || 0), 0);
  const pendingCount = isCash ? (l.members || []).filter((m) => m.payment_status === "pending").length : 0;
  const pendingResultsCount = (l.result_submissions || []).filter((s) => s.status === "pending" && resultConfirmExpired(s)).length;
  const isStaged = l.format === "survivor" || l.format === "groups_knockout";
  const activeTeams = l.format === "survivor" ? l.teams.filter((t) => !t.eliminated) : l.teams;
  const leader = computeStandings(activeTeams, l.fixtures.filter((f) => !isStaged || f.stage === l.current_stage))[0];
  const formatLabel = FORMATS.find((f) => f.id === l.format)?.label || l.format;
  const stageLabel = l.format === "survivor" ? (l.final_stage_started ? " · Final stage" : ` · Stage ${l.current_stage}`)
    : l.format === "groups_knockout" ? (l.final_stage_started ? " · Knockout stage" : " · Group stage") : "";
  return (
    <div onClick={() => onOpen(l.id)} className="rounded-xl p-4 flex items-center justify-between cursor-pointer border"
      style={{ background: c.surface, borderColor: c.border, borderLeft: isCash ? "3px solid #B8860B" : `1px solid ${c.border}` }}>
      <div className="flex items-center gap-3 min-w-0">
        {l.photo_url && (
          <img src={l.photo_url} alt="" className="w-11 h-11 rounded-lg object-cover shrink-0" style={{ border: `1px solid ${c.border}` }} />
        )}
        <div className="min-w-0">
          <div className="font-semibold text-lg leading-tight truncate flex items-center gap-2">
            <span className="truncate">{l.name}</span>
            {isAdmin && pendingCount > 0 && (
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: c.redSoft, color: c.red }}>{pendingCount} pending</span>
            )}
            {canManageLeague(l) && pendingResultsCount > 0 && (
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded flex items-center gap-1" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>
                <Camera size={9} /> {pendingResultsCount} result{pendingResultsCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>
            {l.fixtures.length === 0
              ? `${formatLabel} · Registration open · ${l.teams.length} club${l.teams.length === 1 ? "" : "s"} joined`
              : `${formatLabel}${stageLabel} · ${l.teams.length} clubs · ${played}/${l.fixtures.length} played${leader && leader.p > 0 ? ` · ${leader.name} leads` : ""}`}
            {isCash && canSeePool && ` · Pool ${formatRand(pool)} (${approvedMembers.length}/${(l.members || []).length} paid)`}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <LeagueReactionBar league={l} session={session} onToggle={onToggleLeagueReaction} c={c} compact />
        {joined ? (
          paymentStatus === "pending" ? (
            <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>Payment pending</span>
          ) : paymentStatus === "rejected" ? (
            <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.redSoft, color: c.red }}>Payment rejected</span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.greenSoft, color: c.greenText }}>Joined</span>
          )
        ) : closed ? (
          <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.redSoft, color: c.red }}>Entry closed</span>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); onJoin(l.id); }} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border" style={{ borderColor: c.borderStrong }}>Join</button>
        )}
        <ChevronRight size={18} style={{ color: c.textFaint }} />
      </div>
    </div>
  );
}

function CreateLeague({ onCancel, onCreate, isAdmin, c }) {
  const [name, setName] = useState("");
  const [teamsText, setTeamsText] = useState("");
  const [leagueType, setLeagueType] = useState("fun");
  const [format, setFormat] = useState("double_round_robin");
  const [matchesPerStage, setMatchesPerStage] = useState(10);
  const [eliminationPercent, setEliminationPercent] = useState(50);
  const [targetCount, setTargetCount] = useState(20);
  const [finalFormat, setFinalFormat] = useState("double_round_robin");
  const [groupSize, setGroupSize] = useState(4);
  const [qualifiersPerGroup, setQualifiersPerGroup] = useState(2);
  const [knockoutLegs, setKnockoutLegs] = useState(1);
  const [entryClosesAt, setEntryClosesAt] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [description, setDescription] = useState("");

  const teamNames = teamsText.split("\n").map((t) => t.trim()).filter(Boolean);
  const teamNameDupes = (() => {
    const seen = new Set(); const dupes = new Set();
    for (const n of teamNames) {
      const key = n.toLowerCase();
      if (seen.has(key)) dupes.add(n); else seen.add(key);
    }
    return [...dupes];
  })();
  const teamNameMultiWord = teamNames.filter((n) => /\s/.test(n));
  const survivorValid = format !== "survivor" || (matchesPerStage >= 1 && eliminationPercent >= 1 && eliminationPercent <= 99 && targetCount >= 2);
  const groupsValid = format !== "groups_knockout" || (groupSize >= 2 && qualifiersPerGroup >= 1 && qualifiersPerGroup <= groupSize && (teamNames.length === 0 || teamNames.length >= 4));
  const groupsTooFewTeams = format === "groups_knockout" && teamNames.length > 0 && teamNames.length < 4;
  const canCreate = name.trim().length > 0 && (teamNames.length === 0 || teamNames.length >= 2) && teamNameDupes.length === 0 && teamNameMultiWord.length === 0 && survivorValid && groupsValid && entryClosesAt && startsAt;
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };

  const submit = () => {
    onCreate({
      name: name.trim(), teamNames, format,
      survivor: format === "survivor" ? { matchesPerStage: Number(matchesPerStage), eliminationPercent: Number(eliminationPercent), targetCount: Number(targetCount), finalFormat } : null,
      groups: format === "groups_knockout" ? { groupSize: Number(groupSize), qualifiersPerGroup: Number(qualifiersPerGroup) } : null,
      knockoutLegs: (format === "knockout" || format === "groups_knockout") ? Number(knockoutLegs) : 1,
      entryClosesAt: new Date(entryClosesAt).toISOString(),
      startsAt: new Date(startsAt).toISOString(),
      description: description.trim(),
      leagueType: isAdmin ? leagueType : "fun",
    });
  };

  return (
    <div className="pt-10">
      <button onClick={onCancel} className="flex items-center gap-1.5 font-body text-sm mb-6" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>
      <h1 className="text-3xl font-extrabold uppercase tracking-tight mb-1">New league</h1>
      <p className="font-body mb-6 text-sm" style={{ color: c.textDim }}>Fixtures are generated automatically based on the format you pick. Each match gets 2 days to be played once it opens.</p>

      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Friday Night eFootball Cup" className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-5" style={inputStyle} />

      {isAdmin && (
        <div className="mb-5">
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League type</label>
          <div className="flex gap-2">
            {[{ id: "fun", label: "Fun league" }, { id: "cash", label: "Cash league" }].map((opt) => (
              <button key={opt.id} type="button" onClick={() => setLeagueType(opt.id)}
                className="flex-1 text-left rounded-lg px-4 py-3 border font-body"
                style={{
                  borderColor: leagueType === opt.id ? c.accent : c.border,
                  background: leagueType === opt.id ? c.surfaceHover : "transparent",
                }}>
                <div className="font-semibold text-sm">{opt.label}</div>
              </button>
            ))}
          </div>
          <div className="font-mono text-xs mt-1.5" style={{ color: c.textFaint }}>
            Cash league members choose their own entry fee ({formatRand(ENTRY_FEE_MIN)}–{formatRand(ENTRY_FEE_MAX)}) and upload proof of payment when they join — you review and approve or reject each one.
          </div>
        </div>
      )}

      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Description <span style={{ color: c.textFaint }}>(optional — rules, prize, payment details, WhatsApp group link, etc.)</span></label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder={leagueType === "cash" ? "e.g. Pay to EFT: Acc 12345678, Bank ABC. Winner takes the pot." : "e.g. Winner takes the pot. Join the WhatsApp group: ..."} className="w-full border rounded-lg px-4 py-2.5 font-body outline-none resize-none mb-5" style={inputStyle} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <div>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Entry closes</label>
          <input type="datetime-local" value={entryClosesAt} onChange={(e) => setEntryClosesAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
        </div>
        <div>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League starts</label>
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
        </div>
      </div>

      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Format</label>
      <div className="space-y-2 mb-2">
        {FORMATS.map((f) => (
          <button key={f.id} disabled={!f.available} onClick={() => setFormat(f.id)}
            className="w-full text-left rounded-lg px-4 py-3 border flex items-start justify-between gap-3"
            style={{
              borderColor: format === f.id ? c.accent : c.border,
              background: format === f.id ? c.surfaceHover : "transparent",
              opacity: f.available ? 1 : 0.5,
              cursor: f.available ? "pointer" : "not-allowed",
            }}>
            <div>
              <div className="font-body font-semibold text-sm">{f.label}</div>
              <div className="font-body text-xs mt-0.5" style={{ color: c.textFaint }}>{f.desc}</div>
            </div>
            {!f.available && <span className="font-mono text-[10px] uppercase tracking-wider shrink-0 px-2 py-1 rounded" style={{ background: c.surface, color: c.textFaint }}>Coming soon</span>}
          </button>
        ))}
      </div>

      {format === "survivor" && (
        <div className="rounded-lg p-4 border mb-5" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.textFaint }}><Layers size={12} /> Survivor settings</div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Matches per stage</label>
              <input type="number" min={1} value={matchesPerStage} onChange={(e) => setMatchesPerStage(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            </div>
            <div>
              <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Eliminate bottom %</label>
              <input type="number" min={1} max={99} value={eliminationPercent} onChange={(e) => setEliminationPercent(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            </div>
          </div>
          <div className="mb-3">
            <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Stop cutting once this many clubs remain</label>
            <input type="number" min={2} value={targetCount} onChange={(e) => setTargetCount(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
          </div>
          <div>
            <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Final stage format</label>
            <div className="flex gap-2">
              {[{ id: "single_round_robin", label: "Single RR" }, { id: "double_round_robin", label: "Double RR" }].map((opt) => (
                <button key={opt.id} onClick={() => setFinalFormat(opt.id)}
                  className="flex-1 font-body text-xs font-semibold px-3 py-2 rounded-lg border"
                  style={{ borderColor: finalFormat === opt.id ? c.accent : c.border, background: finalFormat === opt.id ? c.surfaceHover : "transparent" }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {(format === "knockout" || format === "groups_knockout") && (
        <div className="rounded-lg p-4 border mb-5" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.textFaint }}><Layers size={12} /> Knockout ties</div>
          <div className="flex gap-2">
            {[{ v: 1, label: "One match" }, { v: 2, label: "Home & away" }].map((opt) => (
              <button key={opt.v} onClick={() => setKnockoutLegs(opt.v)}
                className="flex-1 font-body text-xs font-semibold px-3 py-2 rounded-lg border"
                style={{ borderColor: knockoutLegs === opt.v ? c.accent : c.border, background: knockoutLegs === opt.v ? c.surfaceHover : "transparent" }}>
                {opt.label}
              </button>
            ))}
          </div>
          <div className="font-body text-xs mt-2" style={{ color: c.textFaint }}>
            {knockoutLegs === 2
              ? "Each tie is played twice — once at each club's home. Aggregate score decides the winner; a level aggregate needs a manual edit to break it (no away-goals rule)."
              : "Each tie is a single, decisive match."}
          </div>
        </div>
      )}

      {format === "groups_knockout" && (
        <div className="rounded-lg p-4 border mb-5" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.textFaint }}><Layers size={12} /> Group settings</div>
          <div className="grid grid-cols-2 gap-3 mb-2">
            <div>
              <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Players per group</label>
              <input type="number" min={2} value={groupSize} onChange={(e) => setGroupSize(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            </div>
            <div>
              <label className="block font-body text-xs mb-1" style={{ color: c.textDim }}>Qualifiers per group</label>
              <input type="number" min={1} value={qualifiersPerGroup} onChange={(e) => setQualifiersPerGroup(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            </div>
          </div>
          <div className="font-body text-xs" style={{ color: groupsTooFewTeams ? c.red : c.textFaint }}>
            {groupsTooFewTeams
              ? `Need at least 4 clubs to form groups — add more clubs or leave the list blank for open registration.`
              : teamNames.length > 0
              ? `${teamNames.length} clubs ÷ ~${groupSize} per group → ${Math.max(2, Math.round(teamNames.length / groupSize))} group${Math.max(2, Math.round(teamNames.length / groupSize)) === 1 ? "" : "s"} · top ${qualifiersPerGroup} from each advance to a single-elimination knockout.`
              : `Groups of about ${groupSize} players each — the exact number of groups is worked out once clubs have joined. Top ${qualifiersPerGroup} from each group advance to a single-elimination knockout.`}
          </div>
        </div>
      )}

      <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Clubs <span style={{ color: c.textFaint }}>(optional — leave blank for open registration)</span></label>
      <textarea value={teamsText} onChange={(e) => setTeamsText(e.target.value)} rows={8} placeholder={"Leave blank for open registration, or pre-list usernames:\nNdosi_123\nAsonele2k\nAshozi_10\nTheAnimal5"} className="w-full border rounded-lg px-4 py-2.5 font-body outline-none resize-none" style={inputStyle} />
      <div className="font-mono text-xs mt-1.5" style={{ color: (teamNameDupes.length || teamNameMultiWord.length) ? c.red : c.textFaint }}>
        {teamNameDupes.length > 0
          ? `Duplicate name${teamNameDupes.length === 1 ? "" : "s"}: ${teamNameDupes.join(", ")} — each club needs a unique username.`
          : teamNameMultiWord.length > 0
          ? `Usernames must be one word — fix: ${teamNameMultiWord.join(", ")}`
          : teamNames.length === 0 ? "Open registration — fixtures generate once you start the league." : `${teamNames.length} club${teamNames.length === 1 ? "" : "s"} pre-listed — review and remove any before you start the league, then fixtures generate.`}
      </div>

      <button disabled={!canCreate} onClick={submit} className="mt-6 w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full" style={canCreate ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
        <Trophy size={16} /> Create league
      </button>
    </div>
  );
}

const STANDINGS_ROW_HEIGHT = 42;
const STANDINGS_VISIBLE_ROWS = 5;

// Standings rows are per-club (gf, ga, p, ...); this maps a club back to
// the member managing it so the top-scorer/defensive-team cards can show a
// username rather than a club name, and only considers clubs that have
// actually played (a club sitting at 0 goals conceded because it hasn't
// played yet shouldn't win "defensive team").
function leagueGoalExtremes(standings, league) {
  const played = standings.filter((r) => r.p > 0);
  const named = played.map((r) => ({ ...r, name: (league.members || []).find((m) => m.team_id === r.id)?.display_name || r.name }));
  return goalExtremes(named);
}

function StandingsPanel({ standings, zoneFor, stageFixtures, isSurvivor, league, c }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const ranked = standings.map((r, i) => ({ ...r, rank: i + 1 }));
  const filtered = q ? ranked.filter((r) => r.name.toLowerCase().includes(q)) : ranked;
  const scrolls = filtered.length > STANDINGS_VISIBLE_ROWS;
  const { top: leagueTopScorer, least: leagueLeastScorer } = useMemo(() => leagueGoalExtremes(standings, league), [standings, league]);

  // In an active (non-final) survivor stage, work out exactly which clubs
  // are currently sitting in the cut zone for this stage.
  const showsCutLine = isSurvivor && !league.final_stage_started && standings.length > 0;
  let atRiskCount = 0;
  if (showsCutLine) {
    atRiskCount = Math.max(1, Math.round(standings.length * (league.survivor_elimination_percent / 100)));
    if (standings.length - atRiskCount < league.survivor_target_count) {
      atRiskCount = standings.length - league.survivor_target_count;
    }
    atRiskCount = Math.max(0, atRiskCount);
  }
  const cutoffRank = showsCutLine && atRiskCount > 0 ? standings.length - atRiskCount + 1 : null;

  return (
    <div className="-mx-4 px-4">
      <div className="flex items-center justify-between gap-3 mb-3 px-2">
        <div className="font-mono text-xs" style={{ color: c.textFaint }}>
          {stageFixtures.filter((f) => f.played).length} of {stageFixtures.length} matches played
          {isSurvivor ? ` · ${league.final_stage_started ? "final stage" : `stage ${league.current_stage}`}` : ""}
        </div>
        {standings.length > STANDINGS_VISIBLE_ROWS && (
          <div className="font-mono text-[11px]" style={{ color: c.textFaint }}>{filtered.length} club{filtered.length === 1 ? "" : "s"}</div>
        )}
      </div>

      {cutoffRank && (
        <div className="flex items-center gap-1.5 mb-3 px-2 font-mono text-[11px]" style={{ color: c.red }}>
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.redSoft, border: `1px solid ${c.red}` }} />
          Bottom {league.survivor_elimination_percent}% ({atRiskCount} club{atRiskCount === 1 ? "" : "s"}) eliminated when this stage ends
        </div>
      )}

      <GoalExtremesBar top={leagueTopScorer} least={leagueLeastScorer} c={c} />

      <div className="relative mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a club..."
          className="w-full border rounded-lg pl-9 pr-3 py-2 font-body text-sm outline-none"
          style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.textFaint} strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
      </div>

      <div className="overflow-x-auto rounded-xl border" style={{ borderColor: c.border }}>
        <div className="overflow-y-auto" style={{ maxHeight: scrolls ? STANDINGS_ROW_HEIGHT * STANDINGS_VISIBLE_ROWS + 34 : undefined }}>
          <table className="w-full font-mono text-sm min-w-[500px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider border-b sticky top-0 z-10" style={{ color: c.textFaint, borderColor: c.border, background: c.bg }}>
                <th className="text-left py-2 pl-2 font-medium">#</th><th className="text-left py-2 font-medium">Club</th>
                <th className="text-center py-2 font-medium">P</th>
                <th className="text-center py-2 font-medium">W</th><th className="text-center py-2 font-medium">D</th>
                <th className="text-center py-2 font-medium">L</th><th className="text-center py-2 font-medium">GD</th>
                <th className="text-center py-2 pr-2 font-medium">Pts</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="py-8 text-center font-body text-sm" style={{ color: c.textFaint }}>No club matches "{query}".</td></tr>
              ) : filtered.map((r) => {
                const atRisk = cutoffRank !== null && r.rank >= cutoffRank && !r.eliminated;
                return (
                  <tr key={r.id} className="border-b" style={{ borderColor: c.border, opacity: r.eliminated ? 0.4 : 1, height: STANDINGS_ROW_HEIGHT, background: atRisk ? c.redSoft : "transparent" }}>
                    <td className="py-2.5 pl-2 relative"><span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: atRisk ? c.red : zoneFor(r.rank - 1) }} /><span style={{ color: c.textFaint }}>{r.rank}</span></td>
                    <td className="py-2.5 font-body font-medium">
                      {r.name}
                      {r.eliminated ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>OUT</span> : atRisk ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>AT RISK</span> : ""}
                    </td>
                    <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.p}</td>
                    <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.w}</td>
                    <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.d}</td>
                    <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.l}</td>
                    <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                    <td className="text-center py-2.5 pr-2 font-bold">{r.pts}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {scrolls && (
        <div className="font-mono text-[10px] text-center mt-2" style={{ color: c.textFaint }}>Scroll for more — showing {STANDINGS_VISIBLE_ROWS} of {filtered.length}</div>
      )}
    </div>
  );
}

// Renders one standings table per group during the group stage of a
// groups_knockout league, each scoped to that group's own teams and fixtures.
function aggregateFor(legs, teamId) {
  return legs.reduce((sum, f) => sum + (f.home_team_id === teamId ? f.home_score : f.away_score), 0);
}

// A single fixture row: shows the scoreline (read-only) or, for anyone who can
// manage the league, editable score inputs plus a required photo attach and a
// Save button (disabled until a photo is attached — same proof requirement as
// regular players). A joined non-manager instead gets a "Submit result" button
// that opens the photo + score modal — their result lands as pending until an
// admin approves it, or shows a pending/rejected tag if one's already in flight.
// Used by both the group-stage and knockout full fixtures lists below.
function FixtureScoreRow({ fixture, homeTeam, awayTeam, canManage, onSave, legLabel, joined, submission, onOpenSubmitResult, c }) {
  const [h, setH] = useState(fixture.home_score);
  const [a, setA] = useState(fixture.away_score);
  const [saveState, setSaveState] = useState("idle");
  const [photo, setPhoto] = useState(null); // photo proof, required before saving — same rule as regular players
  const photoInputRef = useRef(null);

  useEffect(() => { setH(fixture.home_score); setA(fixture.away_score); setSaveState("idle"); setPhoto(null); }, [fixture.id, fixture.played, fixture.home_score, fixture.away_score]);

  if (!homeTeam || !awayTeam) return null;

  const save = async () => {
    if (!photo) return;
    setSaveState("saving");
    await onSave(fixture, h, a, photo);
    setPhoto(null);
    setSaveState("saved");
  };

  return (
    <div className="flex items-center gap-2 py-2">
      {legLabel && <span className="font-mono text-[10px] uppercase tracking-wide shrink-0 w-12" style={{ color: c.textFaint }}>{legLabel}</span>}
      <span className="flex-1 min-w-0 truncate font-body text-sm text-right">{homeTeam.name}</span>
      {canManage ? (
        <>
          <input type="number" min={0} value={h} onChange={(e) => { setH(Number(e.target.value)); setSaveState("idle"); }}
            className="w-11 text-center rounded font-mono text-sm px-1 py-1 outline-none shrink-0" style={{ background: c.surfaceHover, color: c.text }} />
          <span className="shrink-0" style={{ color: c.textFaint }}>–</span>
          <input type="number" min={0} value={a} onChange={(e) => { setA(Number(e.target.value)); setSaveState("idle"); }}
            className="w-11 text-center rounded font-mono text-sm px-1 py-1 outline-none shrink-0" style={{ background: c.surfaceHover, color: c.text }} />
        </>
      ) : (
        <span className="font-mono text-sm w-14 text-center shrink-0" style={{ color: c.text }}>
          {fixture.played ? `${fixture.home_score} – ${fixture.away_score}` : "– : –"}
        </span>
      )}
      <span className="flex-1 min-w-0 truncate font-body text-sm">{awayTeam.name}</span>
      <span className="shrink-0 font-mono text-[10px] w-20 text-right" style={{ color: isExpired(fixture) ? c.red : c.textFaint }}>
        {fixture.played ? "" : isExpired(fixture) ? "Expired" : fmtDate(fixture.due_at)}
      </span>
      {canManage && (
        <>
          <input ref={photoInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { setPhoto(e.target.files?.[0] || null); setSaveState("idle"); }} />
          <button onClick={() => photoInputRef.current?.click()} title={photo ? photo.name : "Attach photo proof (required)"}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full"
            style={photo ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
            <Camera size={12} />
          </button>
          <button onClick={save} disabled={saveState === "saving" || !photo} title={!photo ? "Attach a photo proof to save" : undefined}
            className="shrink-0 font-body text-xs font-semibold px-2.5 py-1 rounded-full"
            style={{ background: saveState === "saved" ? c.greenSoft : c.accent, color: saveState === "saved" ? c.greenText : c.accentText, opacity: (saveState === "saving" || !photo) ? 0.5 : 1 }}>
            {saveState === "saved" ? <Check size={12} /> : saveState === "saving" ? "…" : "Save"}
          </button>
        </>
      )}
      {!canManage && joined && !fixture.played && (
        submission?.status === "pending" ? (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded flex items-center gap-1" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>
            <Clock size={11} /> Pending
          </span>
        ) : (
          <button onClick={() => onOpenSubmitResult(fixture, homeTeam, awayTeam, submission?.status === "rejected" ? submission : null)}
            className="shrink-0 font-body text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"
            style={submission?.status === "rejected" ? { background: c.redSoft, color: c.red } : { background: c.accent, color: c.accentText }}>
            <Camera size={12} /> {submission?.status === "rejected" ? "Resubmit" : "Submit result"}
          </button>
        )
      )}
    </div>
  );
}

// Full listing of every group-stage fixture, organized by group then matchday.
// Small enough (unlike full round-robin leagues) that a plain list beats search.
function GroupFixturesList({ league, groupStageFixtures, canManage, joined, getSubmission, onOpenSubmitResult, onRecordResult, c }) {
  const groupsCount = league.groups_count || 0;
  const groupNumbers = Array.from({ length: groupsCount }, (_, i) => i);

  return (
    <div className="space-y-6">
      <div className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>All group fixtures</div>
      {groupNumbers.map((g) => {
        const groupTeams = league.teams.filter((t) => t.group_number === g);
        if (groupTeams.length === 0) return null;
        const groupFx = groupStageFixtures.filter((f) => groupTeams.some((t) => t.id === f.home_team_id));
        const roundsMap = {};
        groupFx.forEach((f) => { (roundsMap[f.round] ||= []).push(f); });
        const roundNumbers = Object.keys(roundsMap).map(Number).sort((a, b) => a - b);
        return (
          <div key={g}>
            <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>{groupLabel(g)}</div>
            <div className="rounded-xl border divide-y" style={{ borderColor: c.border, background: c.surface }}>
              {roundNumbers.map((r) => (
                <div key={r} className="px-4 py-2.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: c.textFaint }}>Matchday {r}</div>
                  <div className="divide-y" style={{ borderColor: c.border }}>
                    {roundsMap[r].map((f) => {
                      const home = league.teams.find((t) => t.id === f.home_team_id);
                      const away = f.away_team_id ? league.teams.find((t) => t.id === f.away_team_id) : null;
                      if (!away) {
                        return <div key={f.id} className="py-2 font-body text-xs" style={{ color: c.textFaint }}>{home?.name} — bye this round</div>;
                      }
                      return <FixtureScoreRow key={f.id} fixture={f} homeTeam={home} awayTeam={away} canManage={canManage} onSave={onRecordResult}
                        joined={joined} submission={getSubmission?.(f.id)} onOpenSubmitResult={onOpenSubmitResult} c={c} />;
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Full listing of every knockout-bracket fixture, organized by round. Legs of the
// same tie (home & away) are grouped together with an aggregate score shown.
function KnockoutFixturesList({ league, bracketFixtures, canManage, joined, getSubmission, onOpenSubmitResult, onRecordResult, c }) {
  const rounds = {};
  bracketFixtures.forEach((f) => { (rounds[f.round] ||= []).push(f); });
  const roundNumbers = Object.keys(rounds).map(Number).sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <div className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>All knockout fixtures</div>
      {roundNumbers.map((r) => {
        const fx = rounds[r];
        const ties = [];
        const seen = new Set();
        fx.forEach((f) => {
          const key = f.away_team_id === null ? `bye-${f.id}` : [f.home_team_id, f.away_team_id].slice().sort().join("_");
          if (seen.has(key)) return;
          seen.add(key);
          const legs = f.away_team_id === null
            ? [f]
            : fx.filter((g) => g.away_team_id !== null && [g.home_team_id, g.away_team_id].slice().sort().join("_") === key).sort((a, b) => (a.leg || 1) - (b.leg || 1));
          ties.push(legs);
        });
        return (
          <div key={r}>
            <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Round {r}</div>
            <div className="rounded-xl border divide-y" style={{ borderColor: c.border, background: c.surface }}>
              {ties.map((legs) => {
                const f0 = legs[0];
                const home = league.teams.find((t) => t.id === f0.home_team_id);
                if (f0.away_team_id === null) {
                  return <div key={f0.id} className="px-4 py-2.5 font-body text-xs" style={{ color: c.textFaint }}>{home?.name} — bye, advances automatically</div>;
                }
                const away = league.teams.find((t) => t.id === f0.away_team_id);
                const twoLegged = legs.length > 1;
                return (
                  <div key={f0.id} className="px-4 py-2.5">
                    {legs.map((f) => {
                      const legHome = league.teams.find((t) => t.id === f.home_team_id);
                      const legAway = league.teams.find((t) => t.id === f.away_team_id);
                      return <FixtureScoreRow key={f.id} fixture={f} homeTeam={legHome} awayTeam={legAway} canManage={canManage}
                        onSave={onRecordResult} legLabel={twoLegged ? `Leg ${f.leg || 1}` : null}
                        joined={joined} submission={getSubmission?.(f.id)} onOpenSubmitResult={onOpenSubmitResult} c={c} />;
                    })}
                    {twoLegged && (
                      <div className="font-mono text-[10px] mt-1" style={{ color: c.textDim }}>
                        Aggregate: {home?.name} {aggregateFor(legs, f0.home_team_id)} – {aggregateFor(legs, f0.away_team_id)} {away?.name}
                        {legs.every((f) => f.played) && aggregateFor(legs, f0.home_team_id) === aggregateFor(legs, f0.away_team_id) && (
                          <span style={{ color: c.red }}> · level on aggregate, needs a decisive edit</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GroupTables({ league, groupStageFixtures, c }) {
  const groupsCount = league.groups_count || 0;
  const groupNumbers = Array.from({ length: groupsCount }, (_, i) => i);

  return (
    <div className="space-y-6">
      {groupNumbers.map((g) => {
        const groupTeams = league.teams.filter((t) => t.group_number === g);
        if (groupTeams.length === 0) return null;
        const groupFx = groupStageFixtures.filter((f) => groupTeams.some((t) => t.id === f.home_team_id));
        const standings = computeStandings(groupTeams, groupFx);
        const qualifiers = league.group_qualifiers || 0;
        const n = standings.length;
        const zoneFor = (idx) => (idx < qualifiers ? c.greenText : "transparent");
        return (
          <div key={g}>
            <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2 flex items-center gap-2" style={{ color: c.textFaint }}>
              {groupLabel(g)}
              {qualifiers > 0 && n > 0 && (
                <span className="normal-case font-body text-[11px]" style={{ color: c.greenText }}>· top {Math.min(qualifiers, n)} advance</span>
              )}
            </div>
            <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={groupFx} isSurvivor={false} league={league} c={c} />
          </div>
        );
      })}
    </div>
  );
}

function LeaguePhotoBanner({ league, canManage, onUpdatePhoto, c }) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    await onUpdatePhoto(league, file);
    setUploading(false);
  };

  if (!league.photo_url && !canManage) return null;

  return (
    <div className="relative mb-5 rounded-xl overflow-hidden" style={{ background: c.surface, border: `1px solid ${c.border}` }}>
      {league.photo_url ? (
        <img src={league.photo_url} alt="" className="w-full h-40 sm:h-48 object-cover" />
      ) : (
        <div className="w-full h-28 flex items-center justify-center font-body text-sm" style={{ color: c.textFaint }}>No league photo yet</div>
      )}
      {canManage && (
        <>
          <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} className="hidden" />
          <button onClick={() => inputRef.current?.click()} disabled={uploading}
            className="absolute bottom-2 right-2 flex items-center gap-1.5 font-body text-xs font-semibold px-3 py-1.5 rounded-full"
            style={{ background: c.bg, color: c.text, opacity: uploading ? 0.6 : 0.92 }}>
            <Settings2 size={12} /> {uploading ? "Uploading…" : league.photo_url ? "Change photo" : "Add photo"}
          </button>
        </>
      )}
    </div>
  );
}

function LeagueDescriptionBlock({ league, canManage, joined, onUpdateDescription, descOpen, setDescOpen, c }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(league.description || "");
  const [saving, setSaving] = useState(false);
  const autoOpened = useRef(false);

  useEffect(() => { setText(league.description || ""); }, [league.description]);
  useEffect(() => {
    if (!autoOpened.current && league.description && !joined) { setDescOpen(true); autoOpened.current = true; }
  }, [league.description, joined, setDescOpen]);

  const save = async () => {
    setSaving(true);
    await onUpdateDescription(league, text.trim());
    setSaving(false);
    setEditing(false);
    setDescOpen(true);
  };

  return (
    <div className="mb-3">
      <button onClick={() => setDescOpen((v) => !v)}
        className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider px-3 py-1.5 rounded-full"
        style={{ background: c.surface, color: c.textDim }}>
        <Info size={12} /> {descOpen ? "Hide description" : league.description ? "League description" : "Add description"}
      </button>
      {descOpen && (
        editing ? (
          <div className="mt-2 rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
              placeholder="Rules, prize info, WhatsApp group link — anything players should know."
              className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none resize-none mb-2" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
            <div className="flex items-center gap-2 justify-end">
              <button onClick={() => { setText(league.description || ""); setEditing(false); }} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ color: c.textFaint }}>Cancel</button>
              <button onClick={save} disabled={saving} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.accent, color: c.accentText, opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        ) : (
          <div className="mt-2 rounded-xl p-4 border font-body text-sm whitespace-pre-wrap" style={{ background: c.surface, borderColor: c.border, color: c.textDim }}>
            {league.description || <span style={{ color: c.textFaint }}>No description yet.</span>}
            {canManage && (
              <button onClick={() => setEditing(true)} className="block mt-2 font-mono text-[11px] uppercase tracking-wide" style={{ color: c.accent }}>
                {league.description ? "Edit" : "Add description"}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}

// One row for a joined member — team, and (for cash leagues) payment status with
// admin download/approve/reject controls. Shared between the pre-start registration
// list and the Members tab so payments can be reviewed at any stage of the league.
// Admin/creator-only queue of player-submitted results awaiting review.
// Each row shows the proposed score, who submitted it, a way to pull up
// their photo proof, and Approve/Reject actions. Approving locks in the
// fixture score and auto-posts a comment under the player's name (handled
// server-side); rejecting just leaves the fixture open for a resubmission.
function PendingResultsPanel({ league, submissions, onDownloadProof, onApprove, onReject, c,
  title = `${submissions.length} result${submissions.length === 1 ? "" : "s"} awaiting your review`,
  approveLabel = "Approve", rejectLabel = "Reject", showDeadline = false }) {
  return (
    <div className="rounded-xl p-4 border mb-5" style={{ background: "rgba(217,164,6,0.08)", borderColor: c.border }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: "#B8860B" }}>
        <Camera size={13} /> {title}
      </div>
      <div className="space-y-2">
        {submissions.map((s) => {
          const fixture = league.fixtures.find((f) => f.id === s.fixture_id);
          const home = fixture ? league.teams.find((t) => t.id === fixture.home_team_id) : null;
          const away = fixture ? league.teams.find((t) => t.id === fixture.away_team_id) : null;
          return (
            <div key={s.id} className="rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>
                  {s.submitted_by_username[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-body text-sm truncate">{home?.name || "Home"} {s.home_score} – {s.away_score} {away?.name || "Away"}</div>
                  <div className="font-mono text-[11px]" style={{ color: c.textFaint }}>Submitted by {s.submitted_by_username}{fixture ? ` · Matchday ${fixture.round}` : ""} · {timeAgo(s.created_at)}</div>
                  {showDeadline && (
                    <div className="font-mono text-[11px] mt-0.5" style={{ color: resultConfirmHoursLeft(s) <= 3 ? c.red : "#B8860B" }}>
                      {resultConfirmHoursLeft(s) > 0
                        ? `${resultConfirmHoursLeft(s)}h left to respond — after that it goes to the admin`
                        : "Confirmation window passed — this has been sent to the admin"}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t" style={{ borderColor: c.border }}>
                <button onClick={() => onDownloadProof(s)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border flex items-center gap-1.5" style={{ borderColor: c.borderStrong }}>
                  <Eye size={12} /> View photo proof
                </button>
                <button onClick={() => onApprove(league, s)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.greenSoft, color: c.greenText }}>
                  <ThumbsUp size={12} /> {approveLabel}
                </button>
                <button onClick={() => onReject(league, s)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.redSoft, color: c.red }}>
                  <ThumbsDown size={12} /> {rejectLabel}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MemberPaymentRow({ m, t, league, isCash, canManage, allowRemove = false, isOwnRow = false, onRemoveTeam, onLeave, onDownloadProof, onReviewPayment, c }) {
  return (
    <div className="rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{m.display_name[0]?.toUpperCase()}</div>
        <span className="font-body text-sm flex-1">{m.display_name}</span>
        {t && <span className="font-mono text-xs" style={{ color: t.eliminated ? c.red : c.textFaint }}>{t.name}{t.eliminated ? " (out)" : ""}</span>}
        {isCash && (
          <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded shrink-0" style={{ background: c.surfaceHover, color: c.textDim }}>
            Balance {formatRand(memberBalance(league, m))}
          </span>
        )}
        {isCash && m.payment_status === "pending" && (
          <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded flex items-center gap-1 shrink-0" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}><Clock size={10} /> Pending</span>
        )}
        {isCash && m.payment_status === "approved" && (
          <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded flex items-center gap-1 shrink-0" style={{ background: c.greenSoft, color: c.greenText }}><CheckCircle2 size={10} /> Approved</span>
        )}
        {isCash && m.payment_status === "rejected" && (
          <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded flex items-center gap-1 shrink-0" style={{ background: c.redSoft, color: c.red }}><XCircle size={10} /> Rejected</span>
        )}
        {!isCash && canManage && allowRemove && t && (
          <button onClick={() => onRemoveTeam(t)} className="p-1.5 rounded-full shrink-0" style={{ color: c.textFaint }} title={`Remove ${t.name}`}><X size={14} /></button>
        )}
        {!canManage && isOwnRow && (
          <button onClick={onLeave} className="p-1.5 rounded-full shrink-0" style={{ color: c.textFaint }} title="Leave league"><LogOut size={14} /></button>
        )}
      </div>
      {isCash && canManage && (
        <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t" style={{ borderColor: c.border }}>
          <span className="font-mono text-xs" style={{ color: c.textDim }}>{m.entry_fee ? `Contribution ${formatRand(m.entry_fee)}` : "No fee recorded"}</span>
          <button onClick={() => onDownloadProof(m)} disabled={!m.payment_proof_path} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border flex items-center gap-1.5"
            style={{ borderColor: c.borderStrong, opacity: m.payment_proof_path ? 1 : 0.4 }}>
            <Download size={12} /> Download proof
          </button>
          {m.payment_status === "pending" && (
            <>
              <button onClick={() => onReviewPayment(m, "approved")} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.greenSoft, color: c.greenText }}>
                <CheckCircle2 size={12} /> Approve
              </button>
              <button onClick={() => onReviewPayment(m, "rejected")} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5" style={{ background: c.redSoft, color: c.red }}>
                <XCircle size={12} /> Reject
              </button>
            </>
          )}
          {allowRemove && t && (
            <button onClick={() => onRemoveTeam(t)} className="ml-auto font-body text-xs px-2 py-1.5 rounded-full shrink-0" style={{ color: c.textFaint }} title={`Remove ${t.name}`}><X size={13} /></button>
          )}
        </div>
      )}
    </div>
  );
}

// Contribution → direct prize → redistributed → total balance, for every
// approved member, per the WeAfrica payout rule. Ranked live off current
// standings, so it's a running projection until the league is complete.
function PrizeBreakdownPanel({ league, c }) {
  const prizes = computeCashPrizes(league);
  const complete = league.fixtures.length > 0 && league.fixtures.every((f) => f.played);
  const rows = (league.members || [])
    .filter((m) => m.payment_status === "approved")
    .map((m) => ({ m, prize: prizes.get(m.id) }))
    .sort((a, b) => (a.prize?.rank || 99) - (b.prize?.rank || 99));
  const pool = rows.reduce((sum, r) => sum + (r.m.entry_fee || 0), 0);

  return (
    <div className="rounded-xl border mt-4" style={{ borderColor: c.border }}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>Prize breakdown</div>
        <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: complete ? c.greenSoft : "rgba(217,164,6,0.18)", color: complete ? c.greenText : "#B8860B" }}>
          {complete ? "Final" : "Projected"}
        </span>
      </div>
      <div className="px-4 pb-3 font-mono text-[11px]" style={{ color: c.textFaint }}>
        Pool {formatRand(pool)} · top {Math.min(8, rows.length)} place{Math.min(8, rows.length) === 1 ? "" : "s"} paid{!complete ? " · updates live as results come in" : ""}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full font-mono text-xs">
          <thead>
            <tr style={{ color: c.textFaint }}>
              <th className="text-left font-normal px-4 pb-2">Member</th>
              <th className="text-right font-normal px-2 pb-2">Contribution</th>
              <th className="text-right font-normal px-2 pb-2">Direct prize</th>
              <th className="text-right font-normal px-2 pb-2">Redistributed</th>
              <th className="text-right font-normal px-4 pb-2">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, prize }) => (
              <tr key={m.id} className="border-t" style={{ borderColor: c.border }}>
                <td className="px-4 py-2">{prize ? `#${prize.rank} ` : ""}{m.display_name}</td>
                <td className="text-right px-2 py-2">{formatRand(m.entry_fee || 0)}</td>
                <td className="text-right px-2 py-2">{prize ? formatRand(Math.round(prize.directPrize)) : "—"}</td>
                <td className="text-right px-2 py-2">{prize ? formatRand(Math.round(prize.redistributed)) : "—"}</td>
                <td className="text-right px-4 py-2 font-semibold" style={{ color: prize ? c.greenText : c.text }}>{formatRand(Math.round(prize?.total || 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Kebab menu on the league page for admin/creator actions — keeps "Delete league"
// tucked away behind a deliberate open-then-tap, rather than a bare trash icon
// sitting next to the back button where it's easy to hit by accident.
function LeagueMenu({ league, onShare, onDelete, c }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} title="League menu" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-52 rounded-xl overflow-hidden z-20 shadow-lg" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
          <button onClick={() => { setOpen(false); onShare(league); }}
            className="w-full flex items-center gap-2 px-4 py-3 font-body text-sm text-left" style={{ color: c.text }}>
            <Share2 size={14} /> Copy invite link
          </button>
          <div style={{ borderTop: `1px solid ${c.border}` }} />
          <button onClick={() => { setOpen(false); onDelete(league); }}
            className="w-full flex items-center gap-2 px-4 py-3 font-body text-sm text-left" style={{ color: c.red }}>
            <Trash2 size={14} /> Delete league
          </button>
        </div>
      )}
    </div>
  );
}

function LeagueDetail({ league, session, isAdmin, joined, canSeePhones, myTeam, entryClosed, myPaymentStatus, myUsername, onBack, onJoin, onResubmitPayment, onDownloadProof, onReviewPayment, onRecordResult, onUpdateTeamPhone, onRemoveTeam, onUpdatePhoto, onUpdateDescription, onAdvance, onGenerateFixtures, onDelete, onShare, onLeave, onOpenSubmitResult, onDownloadResultProof, onApproveResult, onRejectResult, onRespondToResultSubmission, onPostComment, onDeleteComment, onToggleReaction, onToggleLeagueReaction, c }) {
  const [tab, setTab] = useState("table");
  const [descOpen, setDescOpen] = useState(false);
  const isCreator = session && league.created_by === session.user.id;
  const canManage = isCreator || isAdmin;
  // Results (auto-posted scorelines/photo-proof rows) live under the Table
  // tab; everything else stays under Fixtures as regular chat. Both are
  // still just rows in `comments` — this only decides which panel shows them.
  const { results: resultComments, regular: regularComments } = useMemo(
    () => splitCommentsByRoot(league.comments || []), [league.comments]);
  const myMembership = session ? league.members.find((m) => m.user_id === session.user.id) : null;
  // Pending review takes priority over a stale rejected one; approved
  // submissions don't matter here since the fixture itself flips to played.
  const submissionForFixture = (fixtureId) => {
    const subs = (league.result_submissions || []).filter((s) => s.fixture_id === fixtureId);
    const pending = subs.find((s) => s.status === "pending");
    if (pending) return pending;
    return subs.filter((s) => s.status === "rejected").sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
  };
  const pendingResults = (league.result_submissions || []).filter((s) => s.status === "pending");
  // The subset of those where the signed-in member is specifically the
  // opponent (not the submitter, not an uninvolved member) — these get their
  // own confirm/dispute panel, separate from the admin override panel below.
  const myPendingResults = session
    ? pendingResults.filter((s) => s.submitted_by !== session.user.id && findSubmissionOpponentId(league, s) === session.user.id)
    : [];
  // The opponent has 24 hours to confirm or dispute a submission themselves
  // (see resultConfirmDeadline). Only once that window has passed without a
  // response does it escalate into the admin's override queue — before that,
  // it's still the opponent's to act on, so admins see it as a heads-up only.
  const escalatedResults = pendingResults.filter((s) => resultConfirmExpired(s));
  const awaitingOpponentResults = pendingResults.filter((s) => !resultConfirmExpired(s));
  const isKnockout = league.format === "knockout";
  const isSurvivor = league.format === "survivor";
  const isGroupsKnockout = league.format === "groups_knockout";
  const inGroupStage = isGroupsKnockout && !league.final_stage_started;
  const inKnockoutBracket = isKnockout || (isGroupsKnockout && league.final_stage_started);

  const stageFixtures = (isSurvivor || isGroupsKnockout) ? league.fixtures.filter((f) => f.stage === league.current_stage) : league.fixtures;
  const displayTeams = isSurvivor ? league.teams.filter((t) => !t.eliminated) : league.teams;
  const standings = useMemo(() => computeStandings(displayTeams, stageFixtures), [displayTeams, stageFixtures]);
  const totalRounds = Math.max(...stageFixtures.map((f) => f.round), 0);
  const groupStageFixtures = isGroupsKnockout ? league.fixtures.filter((f) => f.stage === 1) : [];
  const groupStageDone = groupStageFixtures.length > 0 && groupStageFixtures.every((f) => f.played);

  const n = standings.length;
  const zoneFor = (idx) => {
    if (idx === 0 && n > 4) return c.accent;
    if (idx < Math.ceil(n / 3) && n > 6) return c.green;
    if (idx >= n - Math.max(1, Math.floor(n / 4)) && n > 6) return c.red;
    return "transparent";
  };

  const currentRoundFixtures = league.fixtures.filter((f) => f.round === totalRounds && (!(isSurvivor || isGroupsKnockout) || f.stage === league.current_stage));
  const currentRoundDone = currentRoundFixtures.length > 0 && currentRoundFixtures.every((f) => f.played);
  const stageDone = stageFixtures.length > 0 && stageFixtures.every((f) => f.played);

  const activeTeamsCount = league.teams.filter((t) => !t.eliminated).length;
  const knockoutChampion = inKnockoutBracket && stageDone && activeTeamsCount === 1 ? league.teams.find((t) => !t.eliminated) : null;
  const survivorComplete = isSurvivor && league.final_stage_started && stageDone;
  const survivorChampion = survivorComplete ? standings[0] : null;

  const formatLabel = FORMATS.find((f) => f.id === league.format)?.label;
  const notStarted = league.fixtures.length === 0;
  const expiredCount = league.fixtures.filter((f) => isExpired(f)).length;

  return (
    <div className="pt-8">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}><ArrowLeft size={15} /> All leagues</button>
        <div className="flex items-center gap-2">
          {canManage && (
            <LeagueMenu league={league} onShare={onShare} onDelete={onDelete} c={c} />
          )}
          {!canManage && joined && (
            <button onClick={() => onLeave(league)} title="Leave league" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.red }}><LogOut size={14} /></button>
          )}
        </div>
      </div>

      <LeaguePhotoBanner league={league} canManage={canManage} onUpdatePhoto={onUpdatePhoto} c={c} />

      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-3xl font-extrabold uppercase tracking-tight leading-none flex items-center gap-2">
            {league.name}
            {league.league_type === "cash" && (
              <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded align-middle" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>Cash</span>
            )}
          </h1>
          <div className="font-mono text-xs mt-2" style={{ color: c.textFaint }}>
            {formatLabel} · {league.teams.length} clubs · {league.members.length} member{league.members.length === 1 ? "" : "s"}
          </div>
          <div className="font-mono text-[11px] mt-1 flex items-center gap-1" style={{ color: c.textFaint }}>
            <Clock size={11} /> Entry closes {fmtDate(league.entry_closes_at)} · Starts {fmtDate(league.starts_at)}
          </div>
        </div>
        {!joined && !entryClosed && <button onClick={onJoin} className="shrink-0 flex items-center gap-1.5 font-body font-semibold text-sm px-4 py-2 rounded-full" style={{ background: c.accent, color: c.accentText }}><Users size={14} /> Join</button>}
        {!joined && entryClosed && <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1.5 rounded shrink-0" style={{ background: c.redSoft, color: c.red }}>Entry closed</span>}
        {joined && myPaymentStatus === "pending" && (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1.5 rounded flex items-center gap-1" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}><Clock size={11} /> Payment pending</span>
        )}
        {joined && myPaymentStatus === "rejected" && (
          <button onClick={() => onResubmitPayment(myMembership)} className="shrink-0 flex items-center gap-1.5 font-body font-semibold text-xs px-3 py-2 rounded-full" style={{ background: c.redSoft, color: c.red }}>
            <XCircle size={13} /> Payment rejected — resubmit
          </button>
        )}
      </div>

      <LeagueReactionBar league={league} session={session} onToggle={onToggleLeagueReaction} c={c} />

      {(league.description || canManage) && (
        <LeagueDescriptionBlock league={league} canManage={canManage} joined={joined} onUpdateDescription={onUpdateDescription}
          descOpen={descOpen} setDescOpen={setDescOpen} c={c} />
      )}

      {notStarted ? (
        <div>
          <div className="rounded-xl p-5 border mb-5" style={{ background: c.surface, borderColor: c.border }}>
            <div className="font-body font-bold text-base mb-1">Registration open</div>
            <div className="font-body text-sm mb-3" style={{ color: c.textDim }}>
              {league.teams.length} club{league.teams.length === 1 ? "" : "s"} registered
              {isSurvivor ? ` · needs 2+ to start, cuts to ${league.survivor_target_count} over time`
                : isGroupsKnockout ? ` · needs at least 4 to form groups of ~${league.group_size || 4} (top ${league.group_qualifiers} from each group go through)`
                : " · needs 2+ to start"}.
              {" "}Players who join automatically register their eFootball username as their club — no need to list them upfront.
            </div>
            {canManage && (
              <button disabled={league.teams.length < 2 || (isGroupsKnockout && league.teams.length < 4)} onClick={() => onGenerateFixtures(league)}
                className="font-body text-sm font-semibold px-4 py-2.5 rounded-full"
                style={(league.teams.length >= 2 && !(isGroupsKnockout && league.teams.length < 4)) ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
                Start league &amp; generate fixtures
              </button>
            )}
          </div>
          {league.league_type === "cash" && canManage && league.members.some((m) => m.payment_status === "pending") && (
            <div className="rounded-lg p-3 mb-3 font-body text-xs flex items-center gap-2" style={{ background: "rgba(217,164,6,0.12)", color: "#B8860B" }}>
              <ReceiptText size={14} /> Download each member's proof of payment, then approve or reject to confirm their registration.
            </div>
          )}
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Registered clubs</div>
          {league.teams.length === 0 ? (
            <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's registered yet — share the league so players can join.</div>
          ) : (
            <div className="space-y-1.5">
              {[...league.teams]
                .map((t) => ({ t, m: league.members.find((mm) => mm.team_id === t.id) }))
                .sort((a, b) => (a.m?.payment_status === "pending" ? -1 : 0) - (b.m?.payment_status === "pending" ? -1 : 0))
                .map(({ t, m }) => (
                m ? (
                  <MemberPaymentRow key={t.id} m={m} t={t} league={league} isCash={league.league_type === "cash"} canManage={canManage} allowRemove
                    isOwnRow={session && m.user_id === session.user.id} onLeave={() => onLeave(league)}
                    onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment} c={c} />
                ) : (
                  <div key={t.id} className="flex items-center gap-3 rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
                    <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{t.name[0]?.toUpperCase()}</div>
                    <span className="font-body text-sm flex-1">{t.name}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Not yet claimed</span>
                    {canManage && (
                      <button onClick={() => onRemoveTeam(t)} className="p-1.5 rounded-full shrink-0" style={{ color: c.textFaint }} title={`Remove ${t.name}`}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )
              ))}
            </div>
          )}
        </div>
      ) : (
      <>
      {knockoutChampion && (
        <div className="rounded-xl p-4 mb-5 flex items-center gap-3" style={{ background: c.greenSoft }}>
          <Crown size={20} style={{ color: c.accent }} />
          <div><div className="font-body font-bold text-sm">{knockoutChampion.name} wins the league!</div><div className="font-body text-xs" style={{ color: c.textDim }}>Knockout complete.</div></div>
        </div>
      )}
      {survivorChampion && (
        <div className="rounded-xl p-4 mb-5 flex items-center gap-3" style={{ background: c.greenSoft }}>
          <Crown size={20} style={{ color: c.accent }} />
          <div><div className="font-body font-bold text-sm">{survivorChampion.name} wins the league!</div><div className="font-body text-xs" style={{ color: c.textDim }}>Survivor final stage complete.</div></div>
        </div>
      )}

      {joined && myTeam && myTeam.eliminated && (
        <div className="rounded-xl p-3 mb-5 font-body text-xs" style={{ background: c.redSoft, color: c.red }}>
          {myTeam.name} has been eliminated — you no longer have access to other players' phone numbers in this league.
        </div>
      )}

      {expiredCount > 0 && (
        <div className="rounded-xl p-3 mb-5 font-body text-xs flex items-center gap-2" style={{ background: c.redSoft, color: c.red }}>
          <Clock size={13} /> {expiredCount} fixture{expiredCount === 1 ? "" : "s"} passed the 2-day deadline unplayed — both clubs recorded a loss automatically.
        </div>
      )}

      {myPendingResults.length > 0 && (
        <PendingResultsPanel league={league} submissions={myPendingResults}
          title={`${myPendingResults.length} result${myPendingResults.length === 1 ? "" : "s"} awaiting your confirmation`}
          approveLabel="Confirm" rejectLabel="Dispute" showDeadline
          onDownloadProof={onDownloadResultProof}
          onApprove={(l, s) => onRespondToResultSubmission(l, s, true)}
          onReject={(l, s) => onRespondToResultSubmission(l, s, false)} c={c} />
      )}

      {canManage && awaitingOpponentResults.length > 0 && (
        <div className="rounded-xl p-4 border mb-5 font-body text-xs flex items-center gap-2" style={{ background: c.surface, borderColor: c.border, color: c.textFaint }}>
          <Clock size={13} className="shrink-0" />
          {awaitingOpponentResults.length} result{awaitingOpponentResults.length === 1 ? "" : "s"} still within the opponent's 24h confirmation window
          {" — "}lands here for your review only if they don't respond in time.
        </div>
      )}

      {canManage && escalatedResults.length > 0 && (
        <PendingResultsPanel league={league} submissions={escalatedResults}
          title={`${escalatedResults.length} result${escalatedResults.length === 1 ? "" : "s"} needing review — opponent didn't respond within 24h`}
          onDownloadProof={onDownloadResultProof} onApprove={onApproveResult} onReject={onRejectResult} c={c} />
      )}

      {isSurvivor && !survivorComplete && (
        <div className="rounded-xl p-4 mb-5 border" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-body text-xs mb-2" style={{ color: c.textDim }}>
            {league.final_stage_started
              ? `Final stage (${league.survivor_final_format === "double_round_robin" ? "double" : "single"} round robin) · ${activeTeamsCount} clubs · ${stageFixtures.filter((f) => f.played).length}/${stageFixtures.length} played`
              : `Stage ${league.current_stage} · ${activeTeamsCount} clubs, ${league.survivor_matches_per_stage} matches each · ${stageFixtures.filter((f) => f.played).length}/${stageFixtures.length} played · bottom ${league.survivor_elimination_percent}% cut when complete`}
          </div>
          {canManage && !league.final_stage_started && (
            <button disabled={!stageDone} onClick={() => onAdvance(league)}
              className="font-body text-xs font-semibold px-3 py-2 rounded-full"
              style={stageDone ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              {stageDone ? "Cut bottom % and start next stage" : "Waiting for all matches"}
            </button>
          )}
        </div>
      )}

      {isGroupsKnockout && inGroupStage && (
        <div className="rounded-xl p-4 mb-5 border" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-body text-xs mb-2" style={{ color: c.textDim }}>
            Group stage · {league.groups_count} groups · {groupStageFixtures.filter((f) => f.played).length}/{groupStageFixtures.length} played · top {league.group_qualifiers} from each group advance
          </div>
          {canManage && (
            <button disabled={!groupStageDone} onClick={() => onAdvance(league)}
              className="font-body text-xs font-semibold px-3 py-2 rounded-full"
              style={groupStageDone ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              {groupStageDone ? "Finalize groups & start knockout stage" : "Waiting for all group matches"}
            </button>
          )}
        </div>
      )}

      {canManage && inKnockoutBracket && !knockoutChampion && (
        <div className="rounded-xl p-4 mb-5 border flex items-center justify-between gap-3" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-body text-xs" style={{ color: c.textDim }}>
            {currentRoundDone ? `Round ${totalRounds} complete — ready for the next round.` : `Round ${totalRounds} in progress: ${currentRoundFixtures.filter((f) => f.played).length}/${currentRoundFixtures.length} played.`}
          </div>
          <button disabled={!currentRoundDone} onClick={() => onAdvance(league)}
            className="font-body text-xs font-semibold px-3 py-2 rounded-full shrink-0"
            style={currentRoundDone ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
            Advance round
          </button>
        </div>
      )}

      <div className="flex gap-1 mb-5 rounded-full p-1 w-fit" style={{ background: c.surface }}>
        {[{ id: "table", label: "Table", icon: Trophy }, { id: "fixtures", label: "Fixtures", icon: Calendar }, { id: "members", label: "Members", icon: Users }].map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full font-body text-xs font-semibold uppercase tracking-wide" style={tab === t.id ? { background: c.text, color: c.bg } : { color: c.textDim }}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "table" && (
        <div>
          {inGroupStage
            ? <GroupTables league={league} groupStageFixtures={groupStageFixtures} c={c} />
            : <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={stageFixtures} isSurvivor={isSurvivor} league={league} c={c} />}
          <CommentsSection league={league} session={session} canComment={joined || canManage}
            comments={resultComments} heading="Results" icon={Trophy} allowCompose={false}
            emptyText="No results posted yet — they'll show up here as matches are played."
            onPost={onPostComment} onDelete={onDeleteComment} onToggleReaction={onToggleReaction} myUsername={myUsername} c={c} />
        </div>
      )}

      {tab === "fixtures" && (
        <div className="space-y-6">
          {(inGroupStage || inKnockoutBracket) && (joined || canManage) && (
            inGroupStage
              ? <GroupFixturesList league={league} groupStageFixtures={groupStageFixtures} canManage={canManage} joined={joined}
                  getSubmission={submissionForFixture} onOpenSubmitResult={onOpenSubmitResult}
                  onRecordResult={(fixture, h, a, file) => onRecordResult(league, fixture, h, a, file)} c={c} />
              : <KnockoutFixturesList league={league} bracketFixtures={stageFixtures} canManage={canManage} joined={joined}
                  getSubmission={submissionForFixture} onOpenSubmitResult={onOpenSubmitResult}
                  onRecordResult={(fixture, h, a, file) => onRecordResult(league, fixture, h, a, file)} c={c} />
          )}
          <FindYourself league={league} stageFixtures={stageFixtures} inGroupStage={inGroupStage} inKnockoutBracket={inKnockoutBracket}
            groupStageFixtures={groupStageFixtures} canSeePhones={canSeePhones} c={c} />
          {(joined || canManage) && (
            <OpponentFinder teams={league.teams} fixtures={stageFixtures} totalRounds={totalRounds} canManage={canManage} joined={joined}
              getSubmission={submissionForFixture} onOpenSubmitResult={onOpenSubmitResult}
              canSeePhones={canSeePhones} onRecordResult={(fixture, h, a, file) => onRecordResult(league, fixture, h, a, file)} c={c} />
          )}
          {canSeePhones && <TeamContactsPanel teams={league.teams} canManage={canManage} onUpdateTeamPhone={onUpdateTeamPhone} c={c} />}
          {joined && !canSeePhones && (
            <div className="rounded-xl p-4 border font-body text-xs" style={{ borderColor: c.borderStrong, color: c.textFaint }}>
              Player contacts are hidden because your club has been eliminated from this league.
            </div>
          )}
          <CommentsSection league={league} session={session} canComment={joined || canManage}
            comments={regularComments} heading="Comments" allowCompose
            onPost={onPostComment} onDelete={onDeleteComment} onToggleReaction={onToggleReaction} myUsername={myUsername} c={c} />
        </div>
      )}

      {tab === "members" && (
        <div>
          {league.league_type === "cash" && canManage && league.members.some((m) => m.payment_status === "pending") && (
            <div className="rounded-lg p-3 mb-3 font-body text-xs flex items-center gap-2" style={{ background: "rgba(217,164,6,0.12)", color: "#B8860B" }}>
              <ReceiptText size={14} /> Download each member's proof of payment, then approve or reject to confirm their registration.
            </div>
          )}
          {league.members.length === 0 ? (
            <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's joined yet.</div>
          ) : (
            <div className="space-y-1.5">
              {[...league.members]
                .sort((a, b) => (a.payment_status === "pending" ? -1 : 0) - (b.payment_status === "pending" ? -1 : 0))
                .map((m) => (
                  <MemberPaymentRow key={m.id} m={m} t={league.teams.find((t) => t.id === m.team_id)} league={league}
                    isCash={league.league_type === "cash"} canManage={canManage}
                    isOwnRow={session && m.user_id === session.user.id} onLeave={() => onLeave(league)}
                    onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment} c={c} />
              ))}
            </div>
          )}
          {league.league_type === "cash" && league.members.some((m) => m.payment_status === "approved") && (
            <PrizeBreakdownPanel league={league} c={c} />
          )}
        </div>
      )}
      </>
      )}
    </div>
  );
}

// Shown on every league, whether it's still pending (open for registration,
// notStarted) or already created and running — comments aren't gated by stage.
// Reading is open to anyone who can open the league at all (visibility is
// enforced by the leagues query itself); posting requires having joined or
// having management rights, same as the rest of the league's tools.
//
// Posting and reacting are both optimistic: the UI reflects the action the
// instant you take it, then quietly reconciles with the real row once the
// reload completes. That round trip is normally invisible; on failure the
// optimistic bit is rolled back and the existing error toast explains why.
//
// Threads nest to unlimited depth — a reply can be replied to, and so on.
// Indentation stops growing past a few levels (deep threads would otherwise
// squeeze down to nothing on a phone), but that's purely visual: every
// comment at every depth still gets its own Reply button and its own count.
const COMMENT_PAGE_SIZE = 6;
const MAX_INDENT_DEPTH = 4;
const REACTIONS = [
  { key: "like", emoji: "👍" },
  { key: "love", emoji: "❤️" },
  { key: "laugh", emoji: "😂" },
  { key: "fire", emoji: "🔥" },
  { key: "wow", emoji: "😮" },
  { key: "skull", emoji: "💀" },
];
const REACTION_EMOJI = Object.fromEntries(REACTIONS.map((r) => [r.key, r.emoji]));

// A reaction bar for the league itself — same emoji-picker pattern as a
// comment's reaction button, just scoped to league_reactions instead of
// comment_likes. Open to anyone signed in (not gated by canComment/joined),
// so the general public can react to a league without joining it.
function LeagueReactionBar({ league, session, onToggle, c, compact = false }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingReaction, setPendingReaction] = useState(undefined);
  const pickerRef = useRef(null);
  const realReactions = league.league_reactions || [];

  const myRealReaction = session ? (realReactions.find((l) => l.user_id === session.user.id)?.reaction || null) : null;
  useEffect(() => {
    if (pendingReaction !== undefined && pendingReaction === myRealReaction) setPendingReaction(undefined);
  }, [myRealReaction]); // eslint-disable-line react-hooks/exhaustive-deps

  const reactions = useMemo(() => {
    if (pendingReaction === undefined) return realReactions;
    const others = realReactions.filter((l) => !(session && l.user_id === session.user.id));
    return pendingReaction === null ? others : [...others, { user_id: session.user.id, reaction: pendingReaction }];
  }, [realReactions, pendingReaction, session]);

  const myReaction = pendingReaction !== undefined ? pendingReaction : myRealReaction;
  const summary = useMemo(() => {
    const counts = new Map();
    for (const r of reactions) counts.set(r.reaction, (counts.get(r.reaction) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [reactions]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onOutside = (e) => { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false); };
    const onEscape = (e) => { if (e.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onOutside); document.removeEventListener("keydown", onEscape); };
  }, [pickerOpen]);

  const react = async (emoji) => {
    if (!session) return;
    setPickerOpen(false);
    setPendingReaction(emoji);
    const ok = await onToggle(league, emoji);
    if (!ok) setPendingReaction(undefined);
  };

  const handleMainClick = async () => {
    if (!session) return;
    if (myReaction) {
      setPendingReaction(null);
      const ok = await onToggle(league, null);
      if (!ok) setPendingReaction(undefined);
    } else {
      setPickerOpen((v) => !v);
    }
  };

  // Reacting lives inside league cards on Home (so people can react before
  // ever opening a league) as well as inside LeagueDetail — stopping
  // propagation here keeps a tap on the reaction button from also
  // triggering the card's onClick (which opens the league).
  return (
    <div className={compact ? "relative shrink-0" : "relative mb-5"} ref={pickerRef} onClick={(e) => e.stopPropagation()}>
      <button onClick={handleMainClick} disabled={!session}
        className={compact
          ? "flex items-center gap-1 font-mono text-[10px] px-2 py-1 rounded-full transition-colors"
          : "flex items-center gap-1.5 font-mono text-[11px] px-2.5 py-1.5 rounded-full transition-colors"}
        style={{ background: c.surface, color: myReaction ? c.accent : c.textFaint }}>
        <span style={{ fontSize: compact ? 12 : 13, lineHeight: 1 }}>{myReaction ? REACTION_EMOJI[myReaction] : "🤍"}</span>
        {!compact && (myReaction ? "You reacted" : "React to this league")}
        {reactions.length > 0 && (
          <span>{compact ? "" : "· "}{summary.slice(0, 3).map(([key]) => REACTION_EMOJI[key]).join("")} {reactions.length}</span>
        )}
      </button>

      {pickerOpen && (
        <div className="reaction-picker absolute top-full right-0 mt-1.5 flex items-center gap-0.5 rounded-full px-1.5 py-1 shadow-lg z-10"
          style={{ background: c.surfaceHover, border: `1px solid ${c.borderStrong}` }}>
          {REACTIONS.map((r) => (
            <button key={r.key} onClick={() => react(r.key)} title={r.key}
              className="reaction-emoji-btn px-1 transition-transform" style={{ fontSize: 16, lineHeight: 1 }}>
              {r.emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentsSection({ league, session, canComment, onPost, onDelete, onToggleReaction, myUsername, c, comments, heading = "Comments", icon: HeadingIcon = MessageCircle, allowCompose = true, emptyText = "No comments yet — be the first to say something." }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [sortBy, setSortBy] = useState("newest"); // "newest" | "top" — top sorts root comments by reaction count
  const [visibleCount, setVisibleCount] = useState(COMMENT_PAGE_SIZE);
  const [pending, setPending] = useState([]); // optimistic comments/replies, cleared once the real row lands
  const [photo, setPhoto] = useState(null); // optional photo attached to the comment being composed
  const textareaRef = useRef(null);
  const photoInputRef = useRef(null);
  const sourceComments = comments || league.comments || [];

  // Once the real comment matching a pending one shows up in the source list,
  // drop the optimistic stand-in — same author, same text, posted recently.
  useEffect(() => {
    if (pending.length === 0) return;
    setPending((prev) => prev.filter((p) => !sourceComments.some((real) =>
      real.user_id === p.user_id && real.body === p.body && real.parent_comment_id === p.parent_comment_id
      && Math.abs(new Date(real.created_at) - new Date(p.created_at)) < 15000
    )));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceComments]);

  // Build the full reply tree (unlimited depth) from the flat list. Optimistic
  // entries are merged in like real ones so a just-posted comment or reply
  // appears in exactly the right spot, at any depth.
  const { roots, totalCount } = useMemo(() => {
    const all = [...sourceComments, ...pending];
    const byId = new Map(all.map((cm) => [cm.id, { ...cm, children: [] }]));
    const topLevel = [];
    for (const node of byId.values()) {
      if (node.parent_comment_id && byId.has(node.parent_comment_id)) {
        byId.get(node.parent_comment_id).children.push(node);
      } else if (!node.parent_comment_id) {
        topLevel.push(node);
      }
      // A reply whose parent id isn't in byId (parent already deleted, or —
      // extremely briefly — pointed at a not-yet-synced optimistic id that
      // got superseded) falls back to top-level rather than vanishing.
    }
    const sortChildren = (node) => {
      node.children.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      node.children.forEach(sortChildren);
      return node;
    };
    topLevel.forEach(sortChildren);
    const sortedRoots = sortBy === "top"
      ? [...topLevel].sort((a, b) => (b.comment_likes?.length || 0) - (a.comment_likes?.length || 0)
          || new Date(b.created_at) - new Date(a.created_at))
      : [...topLevel].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return { roots: sortedRoots, totalCount: all.length };
  }, [sourceComments, pending, sortBy]);

  const visibleRoots = roots.slice(0, visibleCount);
  const hiddenCount = roots.length - visibleRoots.length;

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || posting) return;
    setPosting(true);
    const tempId = `temp-${Date.now()}`;
    const photoFile = photo;
    const optimistic = {
      id: tempId, league_id: league.id, user_id: session.user.id,
      username: myUsername || session.user.email,
      body: trimmed, created_at: new Date().toISOString(), parent_comment_id: null,
      photo_url: photoFile ? URL.createObjectURL(photoFile) : null,
      comment_likes: [], pending: true,
    };
    setPending((prev) => [...prev, optimistic]);
    setText("");
    setPhoto(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const ok = await onPost(league, trimmed, null, photoFile);
    setPosting(false);
    if (!ok) {
      setPending((prev) => prev.filter((p) => p.id !== tempId));
      setText(trimmed);
      setPhoto(photoFile);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <div className="mt-8 pt-6 border-t" style={{ borderColor: c.border }}>
      <style>{`
        @keyframes commentPopIn { 0% { opacity: 0; transform: translateY(4px); } 100% { opacity: 1; transform: translateY(0); } }
        .comment-pop-in { animation: commentPopIn 0.22s ease-out; }
        @keyframes reactPop { 0% { transform: scale(1); } 35% { transform: scale(1.4); } 100% { transform: scale(1); } }
        .react-pop { animation: reactPop 0.28s cubic-bezier(0.34, 1.56, 0.64, 1); display: inline-block; }
        @keyframes pickerIn { 0% { opacity: 0; transform: scale(0.85) translateY(2px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
        .reaction-picker { animation: pickerIn 0.12s ease-out; }
        .comment-textarea:focus { border-color: ${c.accent} !important; }
        .reaction-emoji-btn:hover { transform: scale(1.3); }
        @media (prefers-reduced-motion: reduce) {
          .comment-pop-in, .react-pop, .reaction-picker { animation: none; }
          .reaction-emoji-btn:hover { transform: none; }
        }
      `}</style>

      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-xs uppercase tracking-[0.2em] flex items-center gap-2" style={{ color: c.textFaint }}>
          <HeadingIcon size={13} /> {heading} {totalCount > 0 && `(${totalCount})`}
        </div>
        {totalCount > 1 && (
          <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider">
            {["newest", "top"].map((opt) => (
              <button key={opt} onClick={() => setSortBy(opt)}
                className="px-2 py-1 rounded-md transition-colors"
                style={sortBy === opt ? { background: c.accent, color: c.accentText } : { color: c.textFaint }}>
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>

      {roots.length === 0 ? (
        <div className="border border-dashed rounded-xl p-6 text-center mb-4" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          <HeadingIcon size={20} className="mx-auto mb-2" style={{ color: c.textFaint }} />
          <div className="font-body text-sm">{emptyText}</div>
        </div>
      ) : (
        <div className="space-y-3 mb-3">
          {visibleRoots.map((cm) => (
            <CommentNode key={cm.id} comment={cm} league={league} session={session} canComment={canComment}
              onPost={onPost} onDelete={onDelete} onToggleReaction={onToggleReaction} c={c} depth={0} />
          ))}
        </div>
      )}

      {hiddenCount > 0 && (
        <button onClick={() => setVisibleCount((v) => v + 10)}
          className="mb-4 font-mono text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-full transition-colors"
          style={{ background: c.surface, color: c.textDim }}>
          Show {Math.min(hiddenCount, 10)} more comment{Math.min(hiddenCount, 10) === 1 ? "" : "s"}
        </button>
      )}

      {allowCompose && (canComment ? (
        <div>
          {photo && (
            <div className="flex items-center gap-2 mb-2 ml-10">
              <img src={URL.createObjectURL(photo)} alt="" className="w-14 h-14 rounded-lg object-cover" style={{ border: `1px solid ${c.border}` }} />
              <button onClick={() => setPhoto(null)} className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded-full"
                style={{ background: c.surface, color: c.textFaint }}>
                Remove
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <div className="w-8 h-8 rounded-full flex items-center justify-center font-body font-bold text-xs shrink-0"
              style={{ background: avatarColor(myUsername || session?.user?.email || "?"), color: "#fff" }}>
              {(myUsername || session?.user?.email || "?")[0]?.toUpperCase()}
            </div>
            <textarea ref={textareaRef} value={text}
              onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
              onKeyDown={onKeyDown}
              placeholder="Write a comment…" rows={1} maxLength={1000}
              className="comment-textarea flex-1 font-body text-sm rounded-xl px-3 py-2.5 resize-none outline-none transition-colors"
              style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
            <input ref={photoInputRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => setPhoto(e.target.files?.[0] || null)} />
            <button onClick={() => photoInputRef.current?.click()} title="Attach a photo"
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-full transition-colors"
              style={photo ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              <Camera size={15} />
            </button>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <button onClick={submit} disabled={!text.trim() || posting}
                className="w-10 h-10 flex items-center justify-center rounded-full transition-transform active:scale-90"
                style={text.trim() && !posting ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
                <Send size={15} />
              </button>
              {text.length > 800 && (
                <span className="font-mono text-[9px]" style={{ color: text.length > 970 ? c.red : c.textFaint }}>
                  {1000 - text.length}
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="font-body text-xs" style={{ color: c.textFaint }}>Join this league to leave a comment.</div>
      ))}
    </div>
  );
}

// A single comment, its reaction/reply row, and — recursively — every reply
// underneath it, no matter how deep. Each node owns its own "reply box
// open?" / "replies expanded?" state independently of its siblings and
// ancestors.
function CommentNode({ comment, league, session, canComment, onPost, onDelete, onToggleReaction, c, depth }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [repliesShown, setRepliesShown] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyPhoto, setReplyPhoto] = useState(null);
  const replyRef = useRef(null);
  const replyPhotoInputRef = useRef(null);
  const children = comment.children || [];
  const indent = Math.min(depth + 1, MAX_INDENT_DEPTH) * 36; // px, mirrors the old ml-9 step per level

  // A reply that's still in flight should already be visible under this
  // thread, so expand it the moment the optimistic reply is queued rather
  // than waiting for the round trip to finish.
  useEffect(() => {
    if (children.some((r) => r.pending)) setRepliesShown(true);
  }, [children]);

  const submitReply = async () => {
    const trimmed = replyText.trim();
    if (!trimmed || posting) return;
    setPosting(true);
    const photoFile = replyPhoto;
    setReplyText("");
    setReplyPhoto(null);
    setReplyOpen(false);
    const ok = await onPost(league, trimmed, comment, photoFile);
    setPosting(false);
    if (!ok) { setReplyText(trimmed); setReplyPhoto(photoFile); }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitReply(); }
    if (e.key === "Escape") { setReplyOpen(false); setReplyText(""); }
  };

  // A comment that's still sending doesn't have a real id yet, so it can't
  // be a reply target — the reply box only appears once it's confirmed.
  const canReply = canComment && !comment.pending;

  return (
    <div className={comment.pending ? "opacity-60" : "comment-pop-in"}>
      <CommentRow comment={comment} league={league} session={session} canComment={canComment}
        onDelete={onDelete} onToggleReaction={onToggleReaction} c={c} isReply={depth > 0}
        onReplyClick={canReply ? () => setReplyOpen((v) => !v) : null} />

      {children.length > 0 && (
        <button onClick={() => setRepliesShown((v) => !v)}
          className="mt-1 font-mono text-[10px] uppercase tracking-wider flex items-center gap-1"
          style={{ color: c.textFaint, marginLeft: indent }}>
          <CornerDownRight size={11} />
          {repliesShown ? "Hide" : "Show"} {children.length} repl{children.length === 1 ? "y" : "ies"}
        </button>
      )}

      {repliesShown && (
        <div className="mt-2 space-y-2 pl-3 border-l" style={{ marginLeft: indent, borderColor: c.border }}>
          {children.map((r) => (
            <CommentNode key={r.id} comment={r} league={league} session={session} canComment={canComment}
              onPost={onPost} onDelete={onDelete} onToggleReaction={onToggleReaction} c={c} depth={depth + 1} />
          ))}
        </div>
      )}

      {replyOpen && (
        <div className="mt-2" style={{ marginLeft: indent }}>
          <div className="flex items-center gap-1.5 mb-1.5 font-mono text-[10px]" style={{ color: c.textFaint }}>
            <CornerDownRight size={11} />
            Replying to {comment.username}
            <button onClick={() => { setReplyOpen(false); setReplyText(""); }} className="ml-0.5" style={{ color: c.textFaint }}>
              <X size={11} />
            </button>
          </div>
          {replyPhoto && (
            <div className="flex items-center gap-2 mb-1.5">
              <img src={URL.createObjectURL(replyPhoto)} alt="" className="w-11 h-11 rounded-lg object-cover" style={{ border: `1px solid ${c.border}` }} />
              <button onClick={() => setReplyPhoto(null)} className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded-full"
                style={{ background: c.surface, color: c.textFaint }}>
                Remove
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea ref={replyRef} value={replyText}
              onChange={(e) => { setReplyText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
              onKeyDown={onKeyDown}
              placeholder={`Reply to ${comment.username}…`} rows={1} maxLength={1000} autoFocus
              className="comment-textarea flex-1 font-body text-sm rounded-xl px-3 py-2 resize-none outline-none transition-colors"
              style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
            <input ref={replyPhotoInputRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => setReplyPhoto(e.target.files?.[0] || null)} />
            <button onClick={() => replyPhotoInputRef.current?.click()} title="Attach a photo"
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-colors"
              style={replyPhoto ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              <Camera size={13} />
            </button>
            <button onClick={submitReply} disabled={!replyText.trim() || posting}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-transform active:scale-90"
              style={replyText.trim() && !posting ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
              <Send size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// A single comment or reply row: avatar, username (+ manager badge for the
// league creator), timestamp, delete, body, and a reaction button.
//
// Tap the reaction button: if you haven't reacted yet, a row of emoji opens
// so you can pick one; if you already reacted, tapping removes it in one
// go (fast un-react, same as the old single-emoji like). To switch to a
// different emoji, remove yours first, then pick again — keeps the whole
// thing usable with touch, not just hover.
function CommentRow({ comment: cm, league, session, canComment, onDelete, onToggleReaction, onReplyClick, c, isReply = false }) {
  const isOwn = session && cm.user_id === session.user.id;
  const isManager = cm.user_id === league.created_by;
  const realReactions = cm.comment_likes || [];

  const [pendingReaction, setPendingReaction] = useState(undefined); // undefined = no optimistic override
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const pickerRef = useRef(null);

  const myRealReaction = session ? (realReactions.find((l) => l.user_id === session.user.id)?.reaction || null) : null;
  useEffect(() => {
    if (pendingReaction !== undefined && pendingReaction === myRealReaction) setPendingReaction(undefined);
  }, [myRealReaction]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reactions list with the optimistic change folded in, so both the total
  // count and the "top emoji" summary update instantly on click.
  const reactions = useMemo(() => {
    if (pendingReaction === undefined) return realReactions;
    const others = realReactions.filter((l) => !(session && l.user_id === session.user.id));
    return pendingReaction === null ? others : [...others, { user_id: session.user.id, reaction: pendingReaction }];
  }, [realReactions, pendingReaction, session]);

  const myReaction = pendingReaction !== undefined ? pendingReaction : myRealReaction;
  const summary = useMemo(() => {
    const counts = new Map();
    for (const r of reactions) counts.set(r.reaction, (counts.get(r.reaction) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [reactions]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onOutside = (e) => { if (pickerRef.current && !pickerRef.current.contains(e.target)) setPickerOpen(false); };
    const onEscape = (e) => { if (e.key === "Escape") setPickerOpen(false); };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onOutside); document.removeEventListener("keydown", onEscape); };
  }, [pickerOpen]);

  const react = async (emoji) => {
    if (!session || cm.pending) return;
    setPickerOpen(false);
    setPendingReaction(emoji);
    setPopKey((k) => k + 1);
    const ok = await onToggleReaction(cm, emoji);
    if (!ok) setPendingReaction(undefined);
  };

  const handleMainClick = async () => {
    if (!session || cm.pending) return;
    if (myReaction) {
      setPendingReaction(null);
      const ok = await onToggleReaction(cm, null);
      if (!ok) setPendingReaction(undefined);
    } else {
      setPickerOpen((v) => !v);
    }
  };

  return (
    <div className="flex items-start gap-2.5 group">
      <div className="rounded-full flex items-center justify-center font-body font-bold shrink-0"
        style={{ background: avatarColor(cm.username), color: "#fff", width: isReply ? 22 : 28, height: isReply ? 22 : 28, fontSize: isReply ? 10 : 12 }}>
        {cm.username?.[0]?.toUpperCase() || "?"}
      </div>
      <div className="flex-1 min-w-0 rounded-xl px-3 py-2 transition-colors" style={{ background: c.surface }}>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="font-body font-semibold text-xs truncate">{cm.username}</span>
            {isManager && (
              <span className="font-mono text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0"
                style={{ background: c.accent, color: c.accentText }}>
                Manager
              </span>
            )}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>
              {cm.pending ? "sending…" : timeAgo(cm.created_at)}
            </span>
            {!cm.pending && (isOwn || canComment) && (
              <button onClick={() => onDelete(cm, league)} title="Delete"
                className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: c.textFaint }}>
                <Trash2 size={11} />
              </button>
            )}
          </div>
        </div>
        <div className="font-body text-sm mt-0.5 whitespace-pre-wrap break-words">{cm.body}</div>
        {cm.photo_url && (
          <button onClick={() => window.open(cm.photo_url, "_blank", "noopener,noreferrer")} className="block mt-2">
            <img src={cm.photo_url} alt="" className="rounded-lg max-h-56 object-cover" style={{ border: `1px solid ${c.border}` }} />
          </button>
        )}
        {!cm.pending && (
          <div className="flex items-center gap-3 mt-1.5">
            <div className="relative" ref={pickerRef}>
              <button onClick={handleMainClick} disabled={!session}
                className="flex items-center gap-1 font-mono text-[10px] transition-colors"
                style={{ color: myReaction ? c.accent : c.textFaint }}>
                <span key={popKey} className={popKey > 0 ? "react-pop" : ""} style={{ fontSize: 12, lineHeight: 1 }}>
                  {myReaction ? REACTION_EMOJI[myReaction] : "🤍"}
                </span>
                {reactions.length > 0 && (
                  <span>{summary.slice(0, 3).map(([key]) => REACTION_EMOJI[key]).join("")} {reactions.length}</span>
                )}
              </button>

              {pickerOpen && (
                <div className="reaction-picker absolute bottom-full left-0 mb-1.5 flex items-center gap-0.5 rounded-full px-1.5 py-1 shadow-lg z-10"
                  style={{ background: c.surfaceHover, border: `1px solid ${c.borderStrong}` }}>
                  {REACTIONS.map((r) => (
                    <button key={r.key} onClick={() => react(r.key)} title={r.key}
                      className="reaction-emoji-btn px-1 transition-transform" style={{ fontSize: 16, lineHeight: 1 }}>
                      {r.emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {onReplyClick && (
              <button onClick={onReplyClick} className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>
                Reply
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TeamContactsPanel({ teams, canManage, onUpdateTeamPhone, c }) {
  const [query, setQuery] = useState("");
  const filtered = query.trim() ? teams.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase())) : teams;
  return (
    <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Player contacts</div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search club name..."
        className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none mb-3" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
      <div className="space-y-2 max-h-72 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="font-body text-xs" style={{ color: c.textFaint }}>No clubs match "{query}".</div>
        ) : filtered.map((t) => (
          <TeamContactRow key={t.id} team={t} canManage={canManage} onUpdateTeamPhone={onUpdateTeamPhone} c={c} />
        ))}
      </div>
    </div>
  );
}

function TeamContactRow({ team, canManage, onUpdateTeamPhone, c }) {
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(team.phone || "");
  useEffect(() => { setPhone(team.phone || ""); }, [team.phone]);
  // Admins get a business-toned greeting that identifies the league up front,
  // since they're usually reaching out cold; other viewers (fellow joined
  // players) get a peer-to-peer line instead.
  const message = canManage
    ? `Hi ${team.name}, this is weAfrica admin Saul — reaching out about your matches.`
    : `Hi ${team.name}, let's set up our matchday.`;
  if (editing) {
    return (
      <div className="flex items-center gap-2 font-body text-sm">
        <span className="flex-1 truncate">{team.name}</span>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" type="tel" className="w-40 rounded font-mono text-xs px-2 py-1 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
        <button onClick={() => { onUpdateTeamPhone(team.id, phone.trim()); setEditing(false); }} style={{ color: c.greenText }} className="p-1"><Check size={15} /></button>
        <button onClick={() => setEditing(false)} style={{ color: c.textFaint }} className="p-1"><X size={15} /></button>
      </div>
    );
  }
  return (
    <div onClick={() => setEditing(true)} className="flex items-center gap-2 font-body text-sm cursor-pointer">
      <span className="flex-1 truncate">{team.name}{team.eliminated ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>OUT</span> : ""}</span>
      {team.phone ? <span className="font-mono text-xs" style={{ color: c.textDim }}>{team.phone}</span> : <span className="font-mono text-xs" style={{ color: c.textFaint }}>Add number</span>}
      {team.phone && (
        <span onClick={(e) => e.stopPropagation()}>
          <WhatsAppLink phone={team.phone} text={message} c={c} />
        </span>
      )}
      <Settings2 size={12} className="shrink-0" style={{ color: c.textFaint }} />
    </div>
  );
}

// A single search box: type your eFootball username, get your group standing
// or knockout opponent back — no need to know a matchday number or dig through
// tabs. Works for anyone with a registered club, joined or not.
function FindYourself({ league, stageFixtures, inGroupStage, inKnockoutBracket, groupStageFixtures, canSeePhones, c }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);

  const search = () => {
    const name = query.trim();
    if (!name) return;
    const team = league.teams.find((t) => t.name.trim().toLowerCase() === name.toLowerCase());
    if (!team) { setResult({ notFound: true, reason: `No club registered under "${name}" in this league.` }); return; }

    if (inGroupStage) {
      const groupTeams = league.teams.filter((t) => t.group_number === team.group_number);
      const groupFx = groupStageFixtures.filter((f) => groupTeams.some((gt) => gt.id === f.home_team_id));
      const standings = computeStandings(groupTeams, groupFx).map((r, i) => ({ ...r, rank: i + 1 }));
      const myRow = standings.find((r) => r.id === team.id);
      const nextFixture = groupFx.filter((f) => !f.played && f.away_team_id !== null && (f.home_team_id === team.id || f.away_team_id === team.id))
        .sort((a, b) => a.round - b.round)[0];
      setResult({ kind: "group", team, groupNumber: team.group_number, standings, myRow, nextFixture, allTeams: league.teams });
      return;
    }

    if (inKnockoutBracket) {
      const maxRound = Math.max(...stageFixtures.map((f) => f.round), 0);
      const myFixtures = stageFixtures.filter((f) => f.round === maxRound && (f.home_team_id === team.id || f.away_team_id === team.id))
        .sort((a, b) => a.leg - b.leg);
      const fallback = myFixtures.length ? null : stageFixtures.filter((f) => f.home_team_id === team.id || f.away_team_id === team.id).sort((a, b) => b.round - a.round)[0];
      setResult({ kind: "knockout", team, myFixtures: myFixtures.length ? myFixtures : (fallback ? [fallback] : []), isCurrentRound: myFixtures.length > 0, allTeams: league.teams });
      return;
    }

    const standings = computeStandings(league.teams, stageFixtures).map((r, i) => ({ ...r, rank: i + 1 }));
    const myRow = standings.find((r) => r.id === team.id);
    const nextFixture = stageFixtures.filter((f) => !f.played && f.away_team_id !== null && (f.home_team_id === team.id || f.away_team_id === team.id))
      .sort((a, b) => a.round - b.round)[0];
    setResult({ kind: "table", team, standings, myRow, nextFixture, allTeams: league.teams });
  };

  const opponentOf = (fixture, team, allTeams) => {
    if (!fixture) return null;
    if (fixture.away_team_id === null) return { bye: true };
    const opponentId = fixture.home_team_id === team.id ? fixture.away_team_id : fixture.home_team_id;
    const opponent = allTeams.find((t) => t.id === opponentId);
    const isHome = fixture.home_team_id === team.id;
    return { opponent, isHome };
  };

  return (
    <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Find yourself</div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input list="find-yourself-datalist" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Your eFootball username" className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <datalist id="find-yourself-datalist">{league.teams.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        <button onClick={search} className="font-body text-sm font-semibold px-4 py-2 rounded-lg shrink-0" style={{ background: c.accent, color: c.accentText }}>Find</button>
      </div>

      {result && (result.notFound ? (
        <div className="font-body text-xs mt-3" style={{ color: c.textFaint }}>{result.reason}</div>
      ) : result.kind === "group" ? (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>
          <div className="font-semibold mb-1">{result.team.name} <span className="font-mono text-xs font-normal" style={{ color: c.textFaint }}>· {groupLabel(result.groupNumber)}</span></div>
          {result.myRow && (
            <div className="font-mono text-xs mb-2" style={{ color: c.textDim }}>
              {result.myRow.rank}{result.myRow.rank === 1 ? "st" : result.myRow.rank === 2 ? "nd" : result.myRow.rank === 3 ? "rd" : "th"} in group ·
              {" "}{result.myRow.pts} pts · {result.myRow.w}W {result.myRow.d}D {result.myRow.l}L · GD {result.myRow.gd > 0 ? `+${result.myRow.gd}` : result.myRow.gd}
            </div>
          )}
          {(() => {
            const opp = opponentOf(result.nextFixture, result.team, result.allTeams);
            if (!opp) return <div className="font-mono text-xs" style={{ color: c.textFaint }}>No matches left to play in the group stage.</div>;
            if (opp.bye) return <div className="font-mono text-xs" style={{ color: c.textFaint }}>Automatic advance this round (bye).</div>;
            return (
              <div>
                <div className="font-mono text-xs" style={{ color: c.textDim }}>
                  Next: <span style={{ color: c.text }}>{opp.opponent?.name}</span> ({opp.isHome ? "Home" : "Away"}) · Due {fmtDate(result.nextFixture.due_at)}
                </div>
                {canSeePhones && (
                  opp.opponent?.phone ? (
                    <div className="mt-1.5">
                      <WhatsAppLink phone={opp.opponent.phone} iconOnly
                        text={`Hi, it's ${result.team.name} — matchday ${result.nextFixture.round} is due ${fmtDate(result.nextFixture.due_at)}. No postponements once that passes, so let's lock in a time before then.`} c={c} />
                    </div>
                  ) : <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>No number on file for this club yet.</div>
                )}
              </div>
            );
          })()}
        </div>
      ) : result.kind === "knockout" ? (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>
          <div className="font-semibold mb-1">
            {result.team.name}
            {result.team.eliminated ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>OUT</span> : ""}
          </div>
          {!result.myFixtures?.length ? (
            <div className="font-mono text-xs" style={{ color: c.textFaint }}>No knockout fixture found yet.</div>
          ) : (() => {
            const opp = opponentOf(result.myFixtures[0], result.team, result.allTeams);
            if (opp.bye) return <div className="font-mono text-xs" style={{ color: c.textFaint }}>Automatic advance this round (bye).</div>;
            const twoLegged = result.myFixtures.length > 1;
            const agg = (teamId) => result.myFixtures.reduce((sum, f) => sum + (f.home_team_id === teamId ? f.home_score : f.away_score), 0);
            return (
              <div>
                <div className="font-mono text-xs" style={{ color: c.textDim }}>
                  Round {result.myFixtures[0].round} vs <span style={{ color: c.text }}>{opp.opponent?.name}</span>
                  {twoLegged ? " (home & away)" : ` (${opp.isHome ? "Home" : "Away"})`}
                </div>
                {twoLegged && (
                  <div className="font-mono text-xs mt-1" style={{ color: c.textDim }}>
                    Aggregate: {result.team.name} {agg(result.team.id)} – {agg(opp.opponent.id)} {opp.opponent.name}
                  </div>
                )}
                {result.myFixtures.map((f) => (
                  <div key={f.id} className="font-mono text-xs mt-1" style={{ color: c.textDim }}>
                    {twoLegged ? `Leg ${f.leg} (${f.home_team_id === result.team.id ? "Home" : "Away"}): ` : ""}
                    {f.played ? `${f.home_score} – ${f.away_score}` : isExpired(f) ? <span style={{ color: c.red }}>Expired — recorded as a loss</span> : `Due by ${fmtDate(f.due_at)}`}
                  </div>
                ))}
                {canSeePhones && (
                  opp.opponent?.phone ? (
                    <div className="mt-1.5">
                      <WhatsAppLink phone={opp.opponent.phone} iconOnly
                        text={`Hi, it's ${result.team.name} — matchday ${result.myFixtures[0].round} is due ${fmtDate((result.myFixtures.find((f) => !f.played) || result.myFixtures[0]).due_at)}. No postponements once that passes, so let's lock in a time before then.`} c={c} />
                    </div>
                  ) : <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>No number on file for this club yet.</div>
                )}
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>
          <div className="font-semibold mb-1">{result.team.name}</div>
          {result.myRow && (
            <div className="font-mono text-xs mb-2" style={{ color: c.textDim }}>
              {result.myRow.rank}{result.myRow.rank === 1 ? "st" : result.myRow.rank === 2 ? "nd" : result.myRow.rank === 3 ? "rd" : "th"} in the table ·
              {" "}{result.myRow.pts} pts · {result.myRow.w}W {result.myRow.d}D {result.myRow.l}L · GD {result.myRow.gd > 0 ? `+${result.myRow.gd}` : result.myRow.gd}
            </div>
          )}
          {(() => {
            const opp = opponentOf(result.nextFixture, result.team, result.allTeams);
            if (!opp) return <div className="font-mono text-xs" style={{ color: c.textFaint }}>No upcoming fixtures found.</div>;
            if (opp.bye) return <div className="font-mono text-xs" style={{ color: c.textFaint }}>Automatic advance this round (bye).</div>;
            return (
              <div>
                <div className="font-mono text-xs" style={{ color: c.textDim }}>
                  Next: <span style={{ color: c.text }}>{opp.opponent?.name}</span> ({opp.isHome ? "Home" : "Away"}) · Due {fmtDate(result.nextFixture.due_at)}
                </div>
                {canSeePhones && (
                  opp.opponent?.phone ? (
                    <div className="mt-1.5">
                      <WhatsAppLink phone={opp.opponent.phone} iconOnly
                        text={`Hi, it's ${result.team.name} — matchday ${result.nextFixture.round} is due ${fmtDate(result.nextFixture.due_at)}. No postponements once that passes, so let's lock in a time before then.`} c={c} />
                    </div>
                  ) : <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>No number on file for this club yet.</div>
                )}
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}

function OpponentFinder({ teams, fixtures, totalRounds, canManage, joined, getSubmission, onOpenSubmitResult, canSeePhones, onRecordResult, c }) {
  const [matchday, setMatchday] = useState("");
  const [teamQuery, setTeamQuery] = useState("");
  const [result, setResult] = useState(null);
  const [scores, setScores] = useState({}); // fixture id -> { h, a }
  const [saveState, setSaveState] = useState({}); // fixture id -> "idle" | "saving" | "saved"
  const [photos, setPhotos] = useState({}); // fixture id -> File, admin's optional photo proof
  const photoInputRef = useRef(null);
  const [photoTargetId, setPhotoTargetId] = useState(null);

  const search = () => {
    const md = Number(matchday);
    if (!md || md < 1 || md > totalRounds) { setResult({ notFound: true, reason: `Enter a matchday between 1 and ${totalRounds}.` }); return; }
    const team = teams.find((t) => t.name.trim().toLowerCase() === teamQuery.trim().toLowerCase());
    if (!team) { setResult({ notFound: true, reason: "No club with that exact name — pick one from the suggestions." }); return; }
    const legs = fixtures.filter((f) => f.round === md && (f.home_team_id === team.id || f.away_team_id === team.id))
      .sort((x, y) => x.leg - y.leg);
    if (legs.length === 0) { setResult({ notFound: true, reason: `${team.name} has no fixture on matchday ${md} in the current stage.` }); return; }

    const anyExpired = legs.some((f) => isExpired(f));
    if (anyExpired && !canManage) {
      setResult({ notFound: true, reason: "This match passed its 2-day deadline without a result — both clubs received a loss. It's no longer viewable." });
      return;
    }

    const opponentId = legs[0].home_team_id === team.id ? legs[0].away_team_id : legs[0].home_team_id;
    const opponent = opponentId ? teams.find((t) => t.id === opponentId) : null;
    setScores(Object.fromEntries(legs.map((f) => [f.id, { h: f.home_score, a: f.away_score }])));
    setSaveState({});
    setResult({ legs, team, opponent, bye: opponentId === null, expired: anyExpired, twoLegged: legs.length > 1 });
  };

  const save = async (fixture) => {
    if (!photos[fixture.id]) return;
    const { h, a } = scores[fixture.id] || { h: 0, a: 0 };
    setSaveState((s) => ({ ...s, [fixture.id]: "saving" }));
    await onRecordResult(fixture, h, a, photos[fixture.id] || null);
    setPhotos((p) => ({ ...p, [fixture.id]: null }));
    setSaveState((s) => ({ ...s, [fixture.id]: "saved" }));
    setResult((r) => r && ({ ...r, legs: r.legs.map((f) => (f.id === fixture.id ? { ...f, played: true, home_score: h, away_score: a } : f)) }));
  };

  const aggregate = (legs, teamId) => legs.reduce((sum, f) => sum + (f.home_team_id === teamId ? f.home_score : f.away_score), 0);

  return (
    <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
      <input ref={photoInputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0] || null; if (photoTargetId) setPhotos((p) => ({ ...p, [photoTargetId]: f })); }} />
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Find your opponent</div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input type="number" min={1} max={totalRounds} value={matchday} onChange={(e) => setMatchday(e.target.value)} placeholder="Matchday #"
          className="w-full sm:w-32 border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <input list="team-names-datalist" value={teamQuery} onChange={(e) => setTeamQuery(e.target.value)} placeholder="Your club name"
          className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <datalist id="team-names-datalist">{teams.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        <button onClick={search} className="font-body text-sm font-semibold px-4 py-2 rounded-lg shrink-0" style={{ background: c.accent, color: c.accentText }}>Find</button>
      </div>

      {result && (result.notFound ? (
        <div className="font-body text-xs mt-3" style={{ color: c.textFaint }}>{result.reason}</div>
      ) : result.bye ? (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>{result.team.name} has a bye this round — automatic advance.</div>
      ) : (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>
          <div className="font-semibold">{result.opponent.name} <span className="font-mono text-xs font-normal" style={{ color: c.textFaint }}>({result.twoLegged ? "Home & away" : (result.legs[0].home_team_id === result.team.id ? "Home" : "Away")})</span></div>

          {result.twoLegged && (
            <div className="font-mono text-xs mt-1" style={{ color: c.textDim }}>
              Aggregate: {result.team.name} {aggregate(result.legs, result.team.id)} – {aggregate(result.legs, result.opponent.id)} {result.opponent.name}
              {result.legs.every((f) => f.played) && aggregate(result.legs, result.team.id) === aggregate(result.legs, result.opponent.id) && (
                <span style={{ color: c.red }}> · level on aggregate, needs a decisive edit</span>
              )}
            </div>
          )}

          {canSeePhones ? (
            result.opponent.phone ? (
              <div className="mt-1.5">
                <WhatsAppLink phone={result.opponent.phone} iconOnly
                  text={`Hi, it's ${result.team.name} — matchday ${matchday} is due ${fmtDate((result.legs.find((f) => !f.played) || result.legs[0]).due_at)}. No postponements once that passes, so let's lock in a time before then.`} c={c} />
              </div>
            ) : <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>No number on file for this club yet.</div>
          ) : (
            <div className="font-mono text-xs mt-1" style={{ color: c.red }}>Contact hidden — your club is eliminated.</div>
          )}

          {result.legs.map((fixture) => {
            const isHome = fixture.home_team_id === result.team.id;
            const homeTeam = isHome ? result.team : result.opponent;
            const awayTeam = isHome ? result.opponent : result.team;
            const sc = scores[fixture.id] || { h: 0, a: 0 };
            const st = saveState[fixture.id] || "idle";
            return (
              <div key={fixture.id} className="mt-3 pt-3 border-t" style={{ borderColor: c.border }}>
                <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>
                  {result.twoLegged ? `Leg ${fixture.leg}` : "Result"}
                  {fixture.played ? ` — ${fixture.home_score} – ${fixture.away_score}` : isExpired(fixture) ? " — expired, recorded as a loss" : ` — due ${fmtDate(fixture.due_at)}`}
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{homeTeam.name} <span style={{ color: c.textFaint }}>(Home)</span></div>
                      <input type="number" min={0} value={sc.h} onChange={(e) => setScores((s) => ({ ...s, [fixture.id]: { ...sc, h: Number(e.target.value) } }))} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                    </div>
                    <span className="self-end pb-1.5" style={{ color: c.textFaint }}>–</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{awayTeam.name} <span style={{ color: c.textFaint }}>(Away)</span></div>
                      <input type="number" min={0} value={sc.a} onChange={(e) => setScores((s) => ({ ...s, [fixture.id]: { ...sc, a: Number(e.target.value) } }))} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                    </div>
                    <button onClick={() => { setPhotoTargetId(fixture.id); photoInputRef.current?.click(); }}
                      title={photos[fixture.id] ? photos[fixture.id].name : "Attach photo proof (required)"}
                      className="self-end shrink-0 w-9 h-9 flex items-center justify-center rounded-full"
                      style={photos[fixture.id] ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
                      <Camera size={14} />
                    </button>
                    <button onClick={() => save(fixture)} disabled={st === "saving" || !photos[fixture.id]}
                      title={!photos[fixture.id] ? "Attach a photo proof to save" : undefined}
                      className="self-end font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 flex items-center gap-1"
                      style={{ background: st === "saved" ? c.greenSoft : c.accent, color: st === "saved" ? c.greenText : c.accentText, opacity: (st === "saving" || !photos[fixture.id]) ? 0.5 : 1 }}>
                      {st === "saved" ? (<><Check size={13} /> Saved</>) : st === "saving" ? "Saving…" : "Save"}
                    </button>
                  </div>
                )}
                {!canManage && joined && !fixture.played && !isExpired(fixture) && (() => {
                  const submission = getSubmission?.(fixture.id);
                  return submission?.status === "pending" ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded inline-flex items-center gap-1" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>
                      <Clock size={11} /> Result pending admin review
                    </span>
                  ) : (
                    <button onClick={() => onOpenSubmitResult(fixture, homeTeam, awayTeam, submission?.status === "rejected" ? submission : null)}
                      className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5"
                      style={submission?.status === "rejected" ? { background: c.redSoft, color: c.red } : { background: c.accent, color: c.accentText }}>
                      <Camera size={13} /> {submission?.status === "rejected" ? "Result rejected — resubmit" : "Submit result"}
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
