import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from "react";
import { supabase, setStaySignedInPreference, clearAllAuthStorage } from "./supabaseClient";
import { compressImage } from "./utils/imageCompress";
// Lazy-loaded rather than imported directly: Shop.jsx alone is well over a
// thousand lines, and neither it nor the Terms page is needed for the
// initial render — bundling them in eagerly meant every single visitor
// downloaded and parsed that code up front even if they never open the
// shop or read the terms. Splitting them into their own chunks (Vite does
// this automatically for a dynamic import()) shrinks the JS the browser
// has to fetch and parse before the app is interactive.
const ShopPage = lazy(() => import("./Shop.jsx"));
const TermsPage = lazy(() => import("./Terms.jsx"));
// RulesModal carries its own ~500-line static rules text (league/ladder/
// challenge reference content) that only a fraction of visitors ever open —
// lazy-loading it the same way keeps that text out of everyone else's
// initial download.
const RulesModal = lazy(() => import("./Rules.jsx"));
// The entire signed-in app — Header, Home, leagues, challenges, ladder,
// accounts, leaderboard — lives in SignedInScreens.jsx now, split out for
// the same reason as Shop/Terms/Rules above: a guest on the public homepage
// never needs any of it, so it shouldn't be in their initial download. It's
// fetched the moment session+profile are both ready (see the <Suspense>
// wrapping the signed-in return below). Each const here points at the same
// file; the bundler fetches that chunk once and reuses it for all of them.
const Header = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.Header })));
const Home = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.Home })));
const AccountsPanel = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.AccountsPanel })));
const ChallengesScreen = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.ChallengesScreen })));
const CreateLeague = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.CreateLeague })));
const EditProfileModal = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.EditProfileModal })));
const LadderChallengeSheet = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.LadderChallengeSheet })));
const LadderPage = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.LadderPage })));
const Leaderboard = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.Leaderboard })));
const LeagueDetail = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.LeagueDetail })));
const SuggestionModal = lazy(() => import("./SignedInScreens.jsx").then((m) => ({ default: m.SuggestionModal })));
import { pickBestVoice } from "./utils/pickBestVoice";
import {
  Trophy, Plus, Users, Calendar, ChevronRight, X, Check,
  ArrowLeft, Settings2, Moon, Sun, LogOut, Lock, Crown, Layers, Share2, Trash2, Clock, Info,
  Wallet, Upload, Download, CheckCircle2, XCircle, ReceiptText, Shield, Copy, MessageCircle, Search, AlertTriangle,
  MoreVertical, Send, CornerDownRight, Camera, Eye, ThumbsUp, ThumbsDown, Target, ChevronDown, History, Shuffle,
  TrendingUp, Swords, Volume2, Pause, Play, Square, Mic, Phone, Gamepad2, Medal,
  ShoppingBag, ExternalLink, Shirt, Package, Menu, Star, Flame, Award, Sparkles,
  Zap, Repeat, Rocket,
} from "lucide-react";

const THEME_KEY = "efootball-theme-v1";
const ACCENT_KEY = "efootball-accent-v1";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

// Used by every "refresh this every few seconds while a screen is open"
// effect below. A background tab (phone screen off, switched app,
// minimized browser) was still firing every poll on schedule for data
// nobody could see — this skips the actual fetch while hidden, and catches
// up immediately the moment it becomes visible again instead of waiting
// for the next tick.
function useVisibilityPoll(callback, intervalMs, enabled) {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (!document.hidden) callback(); };
    const id = setInterval(tick, intervalMs);
    const onVisible = () => { if (!document.hidden) callback(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [callback, intervalMs, enabled]);
}

// Subscribes to Postgres changes on `table` and re-runs `callback` (an
// existing loader, e.g. loadLadder) whenever a row changes — rather than
// hand-merging the changed row into state, which would mean two separate
// code paths (fetch-and-parse vs. realtime-patch) that could quietly drift
// out of sync. Re-running the same loader keeps a single source of truth;
// the only thing that changes is what triggers it. Debounced, since several
// rows can change in the same instant (e.g. a confirmed result touching
// both ladder_ranks rows at once) and each would otherwise fire its own
// refetch. This is deliberately paired with useVisibilityPoll elsewhere as
// a slow safety net — a dropped realtime connection (which does happen on
// flaky mobile networks) just means falling back to that poll instead of
// going stale indefinitely.
function useRealtimeRefresh(table, callback, enabled) {
  useEffect(() => {
    if (!enabled) return;
    let debounceId = null;
    const trigger = () => {
      clearTimeout(debounceId);
      debounceId = setTimeout(() => { if (!document.hidden) callback(); }, 400);
    };
    const channel = supabase
      .channel(`realtime:${table}:${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, trigger)
      .subscribe();
    return () => { clearTimeout(debounceId); supabase.removeChannel(channel); };
  }, [table, callback, enabled]);
}

// The "Shop now" banner opens the in-app WeAfrica Shop (see Shop.jsx) —
// full catalog, cart, and checkout, no external site needed.
const SHOP_NAME = "WeAfrica Shop";
const SHOP_GOLD = "#D4A017"; // brand accent, distinct from the app's green so the banner reads as a sponsor/store placement, not another app screen

// Promo badge on the shop banner — flip SHOP_PROMO_ACTIVE to true whenever
// you're running a promotion, and edit the text to match. Flip it back to
// false when the promo ends. No redeploy logic needed beyond editing these
// two lines and shipping.
const SHOP_PROMO_ACTIVE = false;
const SHOP_PROMO_TEXT = "Sale";

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

const MUKURU_DETAILS = {
  receiverName: "Saul",
  receiverPhone: "+27694362789",
};

const clampFee = (n) => Math.min(ENTRY_FEE_MAX, Math.max(ENTRY_FEE_MIN, Math.round(Number(n) || 0)));

// Every cash league — however it ends — reserves a flat 5% of the pool for
// the organizer, untouched by anyone's contribution ratio, leaving the
// remaining 95% to be split across a small number of places. Which places,
// and how the 95% is divided between them, depends on how the league ends:
// a round-robin table gives every club a real, defensible final position,
// so it pays gold/silver/bronze (55%/25%/15%); a knockout bracket only
// gives a clean ranking to the two finalists (everyone knocked out earlier
// is a genuine tie in how far they got), so it pays just the champion and
// runner-up (75%/20%). Either way, each place's share is still scaled by
// how much that member personally put in — same "the more you put in, the
// bigger your prize" rule — and any shortfall from underpayment gets
// redistributed back across the paid places, proportional to their own
// direct prize (see computeCashPrizes). Survivor leagues finish with a
// round-robin stage, so they use the round-robin split too.
const ORGANIZER_SHARE = 0.05;
const KNOCKOUT_PRIZE_SPLIT = [0.75, 0.20]; // champion, runner-up — sums to 0.95, leaving the organizer's 0.05
const ROUND_ROBIN_PRIZE_SPLIT = [0.55, 0.25, 0.15]; // gold, silver, bronze — sums to 0.95, leaving the organizer's 0.05

function isKnockoutFormat(league) {
  return league.format === "knockout" || league.format === "groups_knockout";
}

// Which prize-split array applies to this league's format — see the module
// comment above ORGANIZER_SHARE for why knockout/groups_knockout differ
// from every other (round-robin-ending) format.
function cashPrizePercentages(league) {
  return isKnockoutFormat(league) ? KNOCKOUT_PRIZE_SPLIT : ROUND_ROBIN_PRIZE_SPLIT;
}

// The organizer's flat 5% cut of any cash league's pool — 0 if the league
// isn't cash or nobody's paid in yet. Flat off the total pool regardless of
// anyone's individual contribution ratio.
function organizerFee(league) {
  if (!league || league.league_type !== "cash") return 0;
  const pool = (league.members || []).filter((m) => m.payment_status === "approved").reduce((sum, m) => sum + (m.entry_fee || 0), 0);
  return pool * ORGANIZER_SHARE;
}

// Round-robin-ending formats pay the top 3 (gold/silver/bronze);
// knockout/groups_knockout pay just the top 2 (see cashPrizePercentages).
function cashPrizePlaceCount(league) {
  return cashPrizePercentages(league).length;
}

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

// Optional accent-color choices layered on top of THEMES.dark/light above —
// swaps just `accent`/`accentText` (the color used for primary buttons and
// highlights) while leaving backgrounds, surfaces, and text alone, so every
// choice stays readable without re-deriving a whole palette per color. Each
// has its own dark/light variant since a color that reads fine as a button
// on the near-black dark background often needs to go a shade darker to
// stay readable as a button on the light background, and vice-versa.
const ACCENTS = {
  gold:   { label: "Gold",   dark: { value: "#E9C46A", text: "#0B1F17" }, light: { value: "#B4802E", text: "#F6F5F0" } },
  ocean:  { label: "Ocean",  dark: { value: "#5DA9E9", text: "#0B1F17" }, light: { value: "#1F6FB2", text: "#F6F5F0" } },
  violet: { label: "Violet", dark: { value: "#A78BFA", text: "#0B1F17" }, light: { value: "#6D4FC7", text: "#F6F5F0" } },
  coral:  { label: "Coral",  dark: { value: "#F2765C", text: "#0B1F17" }, light: { value: "#C74A30", text: "#F6F5F0" } },
  mint:   { label: "Mint",   dark: { value: "#4FD1A5", text: "#0B1F17" }, light: { value: "#1F8F68", text: "#F6F5F0" } },
};

// Merges a chosen accent color into a base THEMES.dark/light object.
function withAccent(baseTheme, themeKey, accentKey) {
  const a = ACCENTS[accentKey]?.[themeKey] || ACCENTS.gold[themeKey];
  return { ...baseTheme, accent: a.value, accentText: a.text };
}

// The Ladder gets its own look — black, gold and red, matching the "Ladder
// Battles / No Mercy" badge — instead of following the app's normal
// light/dark theme toggle. It's the one permanent, always-on competition, so
// it's meant to read as its own thing wherever it shows up (the Home strip
// and its own full page). Same key shape as THEMES.dark/light so it can be
// dropped in as a straight replacement for the `c` prop everywhere the
// Ladder's components already thread it through — buttons, modals, rows —
// without touching each one by hand.
const LADDER_THEME = {
  bg: "#0A0806", surface: "rgba(232,185,35,0.06)", surfaceHover: "rgba(232,185,35,0.12)",
  border: "rgba(232,185,35,0.25)", borderStrong: "rgba(232,185,35,0.45)", text: "#F5EEDC",
  textDim: "rgba(245,238,220,0.6)", textFaint: "rgba(245,238,220,0.38)", accent: "#E8B923",
  accentText: "#0A0806", green: "#2D6A4F", greenSoft: "rgba(45,106,79,0.35)", greenText: "#7FC9A2",
  red: "#C81E3A", redSoft: "rgba(200,30,58,0.25)", toastBg: "#F5EEDC", toastText: "#0A0806",
};

// `kind` groups formats for the one-active-fun-league-per-kind join rule: single
// round robin, double round robin, and survivor all play out as an ongoing
// round-robin-style league, so a club active in any one of them counts as
// active for all of them (kind: "round_robin"). Knockout and groups_knockout
// each get their own kind, so they only block against themselves.
const FORMATS = [
  { id: "single_round_robin", label: "Single Round Robin", kind: "round_robin", desc: "Every club plays every other club once.", available: true },
  { id: "double_round_robin", label: "Double Round Robin", kind: "round_robin", desc: "Home and away — every club plays every other club twice.", available: true },
  { id: "knockout", label: "Knockout", kind: "knockout", desc: "Single elimination. Lose and you're out.", available: true },
  { id: "survivor", label: "Survivor", kind: "round_robin", desc: "Play a set number of matches, cut the bottom %, repeat until a target number remain, then finish with a round robin.", available: true },
  { id: "groups_knockout", label: "Groups + Knockout", kind: "groups_knockout", desc: "Split into groups for a round robin, then top clubs advance to a knockout stage.", available: true },
];
const FORMAT_KIND_LABELS = { round_robin: "round robin / survivor" };

function formatKindLabel(formatId) {
  const kind = FORMATS.find((f) => f.id === formatId)?.kind;
  return FORMAT_KIND_LABELS[kind] || FORMATS.find((f) => f.id === formatId)?.label || "this format";
}

// True if the signed-in user has a club actively playing in `l` right now —
// they've claimed a team, it hasn't been eliminated, and the league isn't
// finished. Used both to build the active-fun-league-by-kind map below and,
// more generally, to prioritize "leagues I'm currently active in" in list
// ordering (see Home's sortLeagues).
function isActiveMember(l, session) {
  if (!session?.user?.id) return false;
  const membership = l.members.find((m) => m.user_id === session.user.id);
  if (!membership || !membership.team_id) return false;
  const myTeamInL = l.teams.find((t) => t.id === membership.team_id);
  if (!myTeamInL || myTeamInL.eliminated) return false;
  const leagueComplete = l.fixtures.length > 0 && l.fixtures.every((f) => f.played);
  return !leagueComplete;
}

// Builds a map of format-kind -> the signed-in user's currently active fun
// league of that kind (at most one, by construction of the join rule below).
// Computing this once per render and doing O(1) lookups per card is cheap;
// re-scanning the whole league list inside every card's render is what we're
// avoiding, since a leagues screen can have many cards re-evaluating this on
// every render.
function activeFunLeaguesByKind(leagues, session) {
  const map = new Map();
  for (const l of leagues || []) {
    if (l.league_type !== "fun" || !isActiveMember(l, session)) continue;
    const kind = FORMATS.find((f) => f.id === l.format)?.kind || l.format;
    if (!map.has(kind)) map.set(kind, l);
  }
  return map;
}

// Given the map from activeFunLeaguesByKind, returns the other fun league
// blocking `league` from being joined (same format kind), or null if it's
// free to join. Only fun leagues are restricted — cash leagues never lock
// each other out.
function blockingLeagueFor(activeByKind, league) {
  if (!league || league.league_type !== "fun") return null;
  const kind = FORMATS.find((f) => f.id === league.format)?.kind || league.format;
  const active = activeByKind.get(kind);
  return active && active.id !== league.id ? active : null;
}

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

// Earliest not-yet-played, fully-paired fixture for a given team (used for
// the "next fixture" status message). Sorted by due date first so a fixture
// with no due date yet falls back to round order.
function nextFixtureForTeam(league, teamId) {
  return (league.fixtures || [])
    .filter((f) => !f.played && f.away_team_id !== null && (f.home_team_id === teamId || f.away_team_id === teamId))
    .sort((a, b) => {
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return ad !== bd ? ad - bd : a.round - b.round;
    })[0] || null;
}

// Earliest not-yet-played, fully-paired fixture across the whole league —
// used as the status message's fallback for spectators or once a member's
// own club has no games left to schedule.
function nextFixtureForLeague(league) {
  return (league.fixtures || [])
    .filter((f) => !f.played && f.away_team_id !== null)
    .sort((a, b) => {
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return ad !== bd ? ad - bd : a.round - b.round;
    })[0] || null;
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

// Direct/ladder challenges and open (random) challenges get the same 24h
// window as league fixtures above — both tables store the report time in
// result_reported_at, so one set of helpers covers both. Once expired, the
// result is no longer the opponent's to confirm/dispute; it moves into the
// admin review queue instead (see adminApproveChallengeResult and friends).
function challengeResultConfirmDeadline(ch) {
  return new Date(new Date(ch.result_reported_at).getTime() + RESULT_CONFIRM_WINDOW_HOURS * 60 * 60 * 1000);
}
function challengeResultConfirmExpired(ch) {
  if (!ch.result_reported_at) return false;
  return Date.now() >= challengeResultConfirmDeadline(ch).getTime();
}
function challengeResultHoursLeft(ch) {
  if (!ch.result_reported_at) return null;
  const ms = challengeResultConfirmDeadline(ch).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 60 * 1000));
}

// If the same fixture has already had this many submissions disputed by the
// opponent, the next one skips the 24h window entirely and goes straight to
// the admin queue — two honest mistakes is a reasonable benefit of the
// doubt, a third attempt at the same fixture is a real disagreement that
// needs a referee, not another round of opponent back-and-forth.
const DISPUTE_ESCALATION_THRESHOLD = 2;
function priorRejectedCount(league, submission) {
  return (league.result_submissions || []).filter(
    (s) => s.fixture_id === submission.fixture_id && s.status === "rejected"
  ).length;
}
// null = not escalated yet (opponent's turn); "timeout" = the 24h window
// passed; "dispute-cap" = this fixture's been disputed too many times already.
function resultEscalationReason(league, submission) {
  if (priorRejectedCount(league, submission) >= DISPUTE_ESCALATION_THRESHOLD) return "dispute-cap";
  if (resultConfirmExpired(submission)) return "timeout";
  return null;
}

// The signed-in player's next `limit` opponents across every league they've
// fielded a club in — used for the "Up next" strip at the top of Home.
// Pulled straight off each league's live fixtures (not scoped to one stage),
// so it naturally follows the player from group stage into a knockout
// bracket once those fixtures exist. Byes (away_team_id === null) and
// already-played fixtures are skipped; fixtures with no due_at yet sort to
// the end rather than falling out of the list.
function computeMyUpcomingFixtures(leagues, myTeam, limit = 5) {
  const rows = [];
  (leagues || []).forEach((l) => {
    const team = myTeam ? myTeam(l) : null;
    if (!team) return;
    (l.fixtures || []).forEach((f) => {
      if (f.played || f.away_team_id === null) return;
      if (f.home_team_id !== team.id && f.away_team_id !== team.id) return;
      const opponentId = f.home_team_id === team.id ? f.away_team_id : f.home_team_id;
      const opponent = l.teams.find((t) => t.id === opponentId);
      if (!opponent) return;
      rows.push({
        fixtureId: f.id, leagueId: l.id, leagueName: l.name, team, opponent,
        isHome: f.home_team_id === team.id, round: f.round, due_at: f.due_at, expired: isExpired(f),
      });
    });
  });
  rows.sort((a, b) => {
    const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
    const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
    return ad - bd;
  });
  return rows.slice(0, limit);
}

// Turns the signed-in player's full match history (every played fixture,
// across every league they've fielded a club in) into a lightweight game
// layer for the homepage: a level with an XP bar, and a current win streak.
// XP is deliberately generous to losses too (5 each) so playing regularly
// always moves the bar — wins (25) and draws (10) just move it faster. This
// reads straight off the same played fixtures the Leaderboard uses, so it
// never needs its own backend table and can't drift out of sync with a
// player's real record.
const XP_PER_LEVEL = 150; // cost of the very first level-up (1 -> 2)
const XP_LEVEL_STEP = 20; // each level after that costs this much more than the last

// XP required to climb out of `level` into `level + 1` — a slowly rising
// curve so early levels come quickly (something to show right away) while
// later ones take real time, making the top titles (Ace, Elite, Legend)
// mean more than "played a lot in week one."
function xpToClimb(level) { return XP_PER_LEVEL + (level - 1) * XP_LEVEL_STEP; }

// Converts total career XP into a level plus progress within that level,
// walking the rising per-level cost rather than dividing by one flat number.
function levelForXp(xp) {
  let level = 1;
  let remaining = xp;
  let need = xpToClimb(level);
  while (remaining >= need) {
    remaining -= need;
    level++;
    need = xpToClimb(level);
  }
  return { level, xpIntoLevel: remaining, xpForNextLevel: need };
}

function computeMyProgress(leagues, myTeam) {
  const matches = [];
  (leagues || []).forEach((l) => {
    const team = myTeam ? myTeam(l) : null;
    if (!team) return;
    (l.fixtures || []).forEach((f) => {
      if (!f.played || f.away_team_id === null) return;
      if (f.home_team_id !== team.id && f.away_team_id !== team.id) return;
      const isHome = f.home_team_id === team.id;
      const gf = isHome ? f.home_score : f.away_score;
      const ga = isHome ? f.away_score : f.home_score;
      matches.push({ time: new Date(fixturePlayedDate(f)).getTime(), outcome: gf > ga ? "w" : gf < ga ? "l" : "d", gf, ga });
    });
  });
  matches.sort((a, b) => a.time - b.time);

  const w = matches.filter((m) => m.outcome === "w").length;
  const d = matches.filter((m) => m.outcome === "d").length;
  const l = matches.filter((m) => m.outcome === "l").length;

  // Current win streak — consecutive wins counting back from the most
  // recent match, stopping at the first draw or loss.
  let streak = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].outcome !== "w") break;
    streak++;
  }

  // Career-best win streak — the longest run of consecutive wins anywhere
  // in the player's history, kept even after that run ends, so a big streak
  // from weeks ago still shows up instead of disappearing the moment it's
  // broken.
  let bestStreak = 0, run = 0;
  matches.forEach((m) => {
    if (m.outcome === "w") { run++; bestStreak = Math.max(bestStreak, run); }
    else run = 0;
  });

  // Career-best unbeaten run (wins + draws) — a looser cousin of the win
  // streak for the "hard to beat" achievement, since a string of draws
  // against tough opponents deserves credit too, not just outright wins.
  let bestNoLossStreak = 0, noLossRun = 0;
  matches.forEach((m) => {
    if (m.outcome !== "l") { noLossRun++; bestNoLossStreak = Math.max(bestNoLossStreak, noLossRun); }
    else noLossRun = 0;
  });

  // Wins with a shutout at the back, and the biggest winning margin — feed
  // the "clean sheet" and "demolition job" achievements respectively.
  const cleanSheets = matches.filter((m) => m.outcome === "w" && m.ga === 0).length;
  const biggestWinMargin = matches.reduce((max, m) => (m.outcome === "w" ? Math.max(max, m.gf - m.ga) : max), 0);

  const xp = w * 25 + d * 10 + l * 5;
  const { level, xpIntoLevel, xpForNextLevel } = levelForXp(xp);
  return { played: matches.length, w, d, l, streak, bestStreak, bestNoLossStreak, cleanSheets, biggestWinMargin, xp, level, xpIntoLevel, xpForNextLevel, levelTitle: levelTitleFor(level) };
}

// Purely cosmetic rank names for the level badge — a light "there's more to
// reach for" hook, not tied to anything mechanical elsewhere in the app.
function levelTitleFor(level) {
  if (level >= 21) return "Legend";
  if (level >= 16) return "Elite";
  if (level >= 11) return "Ace";
  if (level >= 6) return "Veteran";
  if (level >= 3) return "Contender";
  return "Rookie";
}

// The next title tier up from the given level — what the "next: X" hint in
// the breakdown modal points at. Returns null once a player is already at
// the top tier (Legend), since there's nothing further to name.
function nextTitleFor(level) {
  if (level < 3) return "Contender";
  if (level < 6) return "Veteran";
  if (level < 11) return "Ace";
  if (level < 16) return "Elite";
  if (level < 21) return "Legend";
  return null;
}

// A distinct color per title tier — fixed hex, independent of the active
// theme, the same way the ladder's top-3 medal colors work — so climbing
// from Rookie to Legend is visually obvious at a glance, not just a text
// change against the same accent color every time.
function tierColorFor(level) {
  if (level >= 21) return "#FFD700"; // Legend — gold
  if (level >= 16) return "#F97316"; // Elite — orange
  if (level >= 11) return "#A855F7"; // Ace — purple
  if (level >= 6) return "#3B82F6"; // Veteran — blue
  if (level >= 3) return "#22C55E"; // Contender — green
  return "#9CA3AF"; // Rookie — neutral gray
}

// The tap target for the Home player card's level/XP row — spells out the
// math behind the bar (XP to go, full W/D/L record, current streak) instead
// of leaving a player to guess what moves it.
function ProgressBreakdownModal({ progress, onClose, c }) {
  const xpToGo = progress.xpForNextLevel - progress.xpIntoLevel;
  const next = nextTitleFor(progress.level);
  const winRate = progress.played ? Math.round((progress.w / progress.played) * 100) : 0;
  const tier = tierColorFor(progress.level);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl p-6 border" style={{ background: c.bg, borderColor: c.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wider" style={{ color: tier }}>
              <Star size={13} /> Level {progress.level} · {progress.levelTitle}
            </div>
            <div className="font-body text-xs mt-1" style={{ color: c.textDim }}>
              {xpToGo} XP to Level {progress.level + 1}{next && next !== progress.levelTitle ? ` · next: ${next}` : ""}
            </div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ color: c.textFaint }}><X size={18} /></button>
        </div>
        <div className="h-2 rounded-full overflow-hidden mb-5" style={{ background: c.surfaceHover }}
          role="progressbar" aria-valuenow={progress.xpIntoLevel} aria-valuemin={0} aria-valuemax={progress.xpForNextLevel}
          aria-label={`Level ${progress.level} XP progress: ${progress.xpIntoLevel} of ${progress.xpForNextLevel}`}>
          <div className="h-full rounded-full" style={{ width: `${(progress.xpIntoLevel / progress.xpForNextLevel) * 100}%`, background: tier }} />
        </div>
        <div className="grid grid-cols-4 gap-2 mb-4">
          <div className="text-center rounded-xl py-2.5" style={{ background: c.surfaceHover }}>
            <div className="font-bold text-base" style={{ color: c.text }}>{progress.w}</div>
            <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>Wins</div>
          </div>
          <div className="text-center rounded-xl py-2.5" style={{ background: c.surfaceHover }}>
            <div className="font-bold text-base" style={{ color: c.text }}>{progress.d}</div>
            <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>Draws</div>
          </div>
          <div className="text-center rounded-xl py-2.5" style={{ background: c.surfaceHover }}>
            <div className="font-bold text-base" style={{ color: c.text }}>{progress.l}</div>
            <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>Losses</div>
          </div>
          <div className="text-center rounded-xl py-2.5" style={{ background: c.surfaceHover }}>
            <div className="font-bold text-base" style={{ color: c.text }}>{winRate}%</div>
            <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>Win rate</div>
          </div>
        </div>
        {(progress.streak >= 2 || progress.bestStreak >= 2) && (
          <div className="flex items-center gap-2 mb-4">
            {progress.streak >= 2 && (
              <div className="flex items-center gap-1.5 font-mono text-xs font-bold rounded-xl px-3 py-2" style={{ background: `${c.red}1F`, color: c.red, border: `1px solid ${c.red}55` }}>
                <Flame size={13} /> {progress.streak} current
              </div>
            )}
            {progress.bestStreak >= 2 && (
              <div className="flex items-center gap-1.5 font-mono text-xs font-bold rounded-xl px-3 py-2" style={{ background: c.surfaceHover, color: c.textDim }}>
                <Trophy size={13} /> {progress.bestStreak} best
              </div>
            )}
          </div>
        )}
        <div className="font-body text-[11px] leading-relaxed" style={{ color: c.textFaint }}>
          {progress.played} career {progress.played === 1 ? "match" : "matches"} ·{" "}
          Wins are worth 25 XP, draws 10 XP, losses 5 XP — every match you play moves the bar.
        </div>
      </div>
    </div>
  );
}

// Milestone badges layered on top of the level/XP system — a second, more
// permanent "collection" hook next to the streak-and-level bar (which can go
// up or down in feel from match to match). Every def is derived purely from
// data Home already has (match record, league membership, ladder rank), so
// like the XP system this needs no backend table of its own and can't drift
// out of sync. `value(ctx)` returns the player's raw progress toward
// `target`; reaching or passing target earns the badge.
const ACHIEVEMENTS_DEF = [
  { id: "first_match", icon: Gamepad2, color: "#3B82F6", tier: "bronze", category: "matches", label: "First Whistle", desc: "Play your first match", target: 1, value: (ctx) => ctx.p.played },
  { id: "matches_10", icon: Calendar, color: "#3B82F6", tier: "silver", category: "matches", label: "Regular", desc: "Play 10 matches", target: 10, value: (ctx) => ctx.p.played },
  { id: "matches_50", icon: History, color: "#3B82F6", tier: "gold", category: "matches", label: "Veteran Grinder", desc: "Play 50 matches", target: 50, value: (ctx) => ctx.p.played },
  { id: "century", icon: Package, color: "#6366F1", tier: "platinum", category: "matches", label: "Centurion", desc: "Play 100 matches", target: 100, value: (ctx) => ctx.p.played },
  { id: "first_win", icon: Trophy, color: "#22C55E", tier: "bronze", category: "wins", label: "First Blood", desc: "Win your first match", target: 1, value: (ctx) => ctx.p.w },
  { id: "wins_10", icon: Medal, color: "#22C55E", tier: "silver", category: "wins", label: "Winning Machine", desc: "Win 10 matches", target: 10, value: (ctx) => ctx.p.w },
  { id: "wins_25", icon: Award, color: "#22C55E", tier: "gold", category: "wins", label: "Champion Mentality", desc: "Win 25 matches", target: 25, value: (ctx) => ctx.p.w },
  { id: "wins_50", icon: Target, color: "#22C55E", tier: "platinum", category: "wins", label: "Serial Winner", desc: "Win 50 matches", target: 50, value: (ctx) => ctx.p.w },
  { id: "draws_10", icon: Repeat, color: "#F59E0B", tier: "silver", category: "form", label: "Stalemate Specialist", desc: "Draw 10 matches", target: 10, value: (ctx) => ctx.p.d },
  { id: "clean_sheets_5", icon: CheckCircle2, color: "#06B6D4", tier: "silver", category: "form", label: "Clean Sheet Starter", desc: "Win 5 matches without conceding", target: 5, value: (ctx) => ctx.p.cleanSheets },
  { id: "clean_sheets_15", icon: CheckCircle2, color: "#0891B2", tier: "gold", category: "form", label: "Defensive Wall", desc: "Win 15 matches without conceding", target: 15, value: (ctx) => ctx.p.cleanSheets },
  { id: "big_win", icon: Zap, color: "#EF4444", tier: "gold", category: "form", label: "Demolition Job", desc: "Win a match by 4 or more goals", target: 1, value: (ctx) => (ctx.p.biggestWinMargin >= 4 ? 1 : 0) },
  { id: "unbeaten_10", icon: Shield, color: "#84CC16", tier: "gold", category: "form", label: "Iron Wall", desc: "Go 10 matches without a loss", target: 10, value: (ctx) => ctx.p.bestNoLossStreak },
  { id: "streak_3", icon: Flame, color: "#F97316", tier: "silver", category: "form", label: "Hot Streak", desc: "Win 3 matches in a row", target: 3, value: (ctx) => ctx.p.bestStreak },
  { id: "streak_5", icon: Flame, color: "#EF4444", tier: "gold", category: "form", label: "On Fire", desc: "Win 5 matches in a row", target: 5, value: (ctx) => ctx.p.bestStreak },
  { id: "streak_10", icon: Sparkles, color: "#EF4444", tier: "platinum", category: "form", label: "Unstoppable", desc: "Win 10 matches in a row", target: 10, value: (ctx) => ctx.p.bestStreak },
  { id: "level_6", icon: Shield, color: "#3B82F6", tier: "silver", category: "level", label: "Veteran Status", desc: "Reach Level 6", target: 6, value: (ctx) => ctx.p.level },
  { id: "level_11", icon: Swords, color: "#A855F7", tier: "gold", category: "level", label: "Ace Status", desc: "Reach Level 11", target: 11, value: (ctx) => ctx.p.level },
  { id: "level_16", icon: Rocket, color: "#F97316", tier: "platinum", category: "level", label: "Elite Status", desc: "Reach Level 16", target: 16, value: (ctx) => ctx.p.level },
  { id: "level_21", icon: Crown, color: "#FFD700", tier: "platinum", category: "level", label: "Legend Status", desc: "Reach Level 21", target: 21, value: (ctx) => ctx.p.level },
  { id: "join_league", icon: Users, color: "#14B8A6", tier: "bronze", category: "leagues", label: "Joiner", desc: "Join your first league", target: 1, value: (ctx) => ctx.joinedCount },
  { id: "join_3", icon: Layers, color: "#14B8A6", tier: "silver", category: "leagues", label: "Multi-Leaguer", desc: "Join 3 leagues", target: 3, value: (ctx) => ctx.joinedCount },
  { id: "ladder_ranked", icon: TrendingUp, color: "#9CA3AF", tier: "bronze", category: "ladder", label: "On The Board", desc: "Get ranked on the Ladder", target: 1, value: (ctx) => (ctx.myLadderRank ? 1 : 0) },
  { id: "ladder_top10", icon: Star, color: "#FFD700", tier: "gold", category: "ladder", label: "Top 10", desc: "Break into the Ladder's Top 10", target: 1, value: (ctx) => (ctx.myLadderRank && ctx.myLadderRank <= 10 ? 1 : 0) },
  { id: "ladder_no1", icon: Crown, color: "#FFD700", tier: "platinum", category: "ladder", label: "King Of The Hill", desc: "Reach #1 on the Ladder", target: 1, value: (ctx) => (ctx.myLadderRank === 1 ? 1 : 0) },
];

// Fixed display order + label for each achievement category — used to group
// the full list in the modal so browsing reads as "here's everything in
// Wins, here's everything in Form", not a flat wall of 25 tiles.
const ACHIEVEMENT_CATEGORIES = [
  { id: "matches", label: "Matches Played" },
  { id: "wins", label: "Wins" },
  { id: "form", label: "Form & Style" },
  { id: "level", label: "Level" },
  { id: "leagues", label: "Leagues" },
  { id: "ladder", label: "Ladder" },
];

// Groups an already-computed achievements list by category, in the fixed
// order above, preserving each item's relative order (earned, then closest
// to earning) within its group.
function groupAchievementsByCategory(achievements) {
  const byCategory = {};
  achievements.forEach((a) => {
    if (!byCategory[a.category]) byCategory[a.category] = [];
    byCategory[a.category].push(a);
  });
  return ACHIEVEMENT_CATEGORIES.filter((cat) => byCategory[cat.id]).map((cat) => ({ ...cat, items: byCategory[cat.id] }));
}

// Visual weight per rarity tier — how thick the ring is. Gold and platinum
// (the harder badges) also get a soft pulsing glow once earned (see the
// animate-achievement-glow keyframes in index.css), so the rarest badges
// are unmistakably the shiniest tiles in the strip.
const TIER_RING = { bronze: 1.5, silver: 2, gold: 2.5, platinum: 3 };

// Trophy-score weighting per tier for the Wall of Fame ranking — a platinum
// badge is worth more than five bronzes, so the board rewards chasing hard
// badges rather than just racking up easy ones. TIER_ORDER is the same
// ranking used to pick a player's single "best" badge to show off.
const TIER_WEIGHT = { bronze: 1, silver: 2, gold: 3, platinum: 5 };
const TIER_ORDER = { bronze: 0, silver: 1, gold: 2, platinum: 3 };
const TIER_COLOR = { bronze: "#CD7F32", silver: "#C0C0C0", gold: "#FFD700", platinum: "#B9F2FF" };

// Aggregates every row from the shared `achievements` table (every badge,
// every member) into one ranked row per member — count earned, a weighted
// trophy score, and their single best (highest-tier) badge to show off next
// to their name. Members with no earned badges yet, or with rows we can't
// match to a profile (memberAvatars only lists other members — the
// signed-in player's own name/photo is merged in by the caller), are left
// out rather than shown as a zero.
function computeWallOfFame(allAchievements, profileByUserId) {
  const byUser = {};
  (allAchievements || []).forEach((row) => {
    const def = ACHIEVEMENTS_DEF.find((d) => d.id === row.achievement_id);
    if (!def) return; // ignore rows for a badge id that no longer exists
    if (!byUser[row.user_id]) byUser[row.user_id] = { userId: row.user_id, count: 0, score: 0, bestBadge: null };
    const entry = byUser[row.user_id];
    entry.count += 1;
    entry.score += TIER_WEIGHT[def.tier] || 1;
    if (!entry.bestBadge || TIER_ORDER[def.tier] > TIER_ORDER[entry.bestBadge.tier]) entry.bestBadge = def;
  });
  return Object.values(byUser)
    .map((e) => ({ ...e, profile: profileByUserId.get(e.userId) }))
    .filter((e) => e.profile)
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

// Earned badges sort first (most nearly-complete locked badge next), so the
// strip's leading tiles are always either something to be proud of or
// something worth chasing next — never a random pick from the middle.
function computeAchievements(ctx) {
  return ACHIEVEMENTS_DEF.map((def) => {
    const raw = def.value(ctx) || 0;
    const value = Math.min(raw, def.target);
    return { ...def, value, earned: raw >= def.target };
  }).sort((a, b) => {
    if (a.earned !== b.earned) return a.earned ? -1 : 1;
    return b.value / b.target - a.value / a.target;
  });
}

// A single badge tile — a filled, colored ring around the icon once earned
// (ring thickness and, for gold/platinum, a soft glow scale with rarity
// tier); a dim outline with a thin progress ring (how close) while locked.
// Used both in the homepage strip (small) and the full achievements modal
// (larger), so size is a prop rather than fixed.
function AchievementBadge({ ach, size = 44, c }) {
  const pct = Math.round((ach.value / ach.target) * 100);
  const iconSize = Math.round(size * 0.42);
  const ringWidth = TIER_RING[ach.tier] || 1.5;
  const glows = ach.earned && (ach.tier === "gold" || ach.tier === "platinum");
  return (
    <div className="flex flex-col items-center gap-1 shrink-0" style={{ width: size + 14 }}>
      <div className="relative flex items-center justify-center rounded-full" style={{ width: size, height: size }}>
        {!ach.earned && (
          <svg className="absolute inset-0 -rotate-90" width={size} height={size} viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="16" fill="none" stroke={c.border} strokeWidth="2" />
            <circle cx="18" cy="18" r="16" fill="none" stroke={ach.color} strokeWidth="2" strokeLinecap="round" pathLength="100" strokeDasharray={`${pct} 100`} />
          </svg>
        )}
        <div className={glows ? "animate-achievement-glow rounded-full" : "rounded-full"} style={{
          width: size - 6, height: size - 6,
          background: ach.earned ? `linear-gradient(135deg, ${ach.color}, ${ach.color}99)` : c.surfaceHover,
          border: `${ringWidth}px solid ${ach.earned ? ach.color : c.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          "--badge-glow": ach.color,
        }}>
          <ach.icon size={iconSize} style={{ color: ach.earned ? "#fff" : c.textFaint }} />
        </div>
        {ach.earned && ach.tier === "platinum" && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full" style={{ width: size * 0.32, height: size * 0.32, background: "#FFD700", border: `1.5px solid ${c.bg}` }}>
            <Sparkles size={size * 0.18} style={{ color: "#1a1a1a" }} />
          </span>
        )}
      </div>
      <div className="font-mono text-[8px] uppercase tracking-wide text-center leading-tight w-full truncate" style={{ color: ach.earned ? c.text : c.textFaint }}>
        {ach.label}
      </div>
    </div>
  );
}

// Homepage teaser — a horizontally-scrolling row of badges (earned first,
// then the nearest-to-unlocking locked ones), with an "X/Y" counter that
// doubles as the tap target for the full list, and a small progress bar
// underneath so overall collection progress reads at a glance without
// having to count tiles. The row fades out at each edge (mask-image)
// instead of hard-cutting mid-badge, hinting that it scrolls.
function AchievementsStrip({ achievements, earnedCount, onOpen, c }) {
  if (achievements.length === 0) return null;
  const pct = Math.round((earnedCount / achievements.length) * 100);
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>Achievements</div>
        <button onClick={onOpen} className="flex items-center gap-0.5 font-mono text-[10px] font-bold uppercase tracking-wide" style={{ color: c.accent }}>
          {earnedCount}/{achievements.length} <ChevronRight size={12} />
        </button>
      </div>
      <div className="h-1 rounded-full overflow-hidden mb-3" style={{ background: c.surfaceHover }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: c.accent }} />
      </div>
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
        className="flex gap-3 overflow-x-auto pb-1 cursor-pointer" style={{ scrollbarWidth: "none", WebkitMaskImage: "linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)", maskImage: "linear-gradient(to right, transparent, black 12px, black calc(100% - 12px), transparent)" }}>
        {achievements.slice(0, 10).map((a) => <AchievementBadge key={a.id} ach={a} c={c} />)}
      </div>
    </section>
  );
}

// The full achievements list — every badge, earned and locked, grouped by
// category (Matches, Wins, Form & Style, Level, Leagues, Ladder) so
// browsing reads as sections rather than one flat wall of tiles. An overall
// progress bar up top mirrors the strip's, and each locked tile shows
// exactly how close the player is via its progress ring + the X/Y caption.
function AchievementsModal({ achievements, earnedCount, onClose, c }) {
  const pct = Math.round((earnedCount / achievements.length) * 100);
  const groups = groupAchievementsByCategory(achievements);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl p-6 border" style={{ background: c.bg, borderColor: c.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-2">
          <div>
            <div className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wider" style={{ color: c.accent }}>
              <Trophy size={13} /> Achievements
            </div>
            <div className="font-body text-xs mt-1" style={{ color: c.textDim }}>{earnedCount} of {achievements.length} unlocked</div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ color: c.textFaint }}><X size={18} /></button>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden mb-6" style={{ background: c.surfaceHover }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: c.accent }} />
        </div>
        {groups.map((group, i) => (
          <div key={group.id} className={i > 0 ? "mt-6" : ""}>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>{group.label}</div>
            <div className="grid grid-cols-3 gap-x-2 gap-y-4">
              {group.items.map((a) => (
                <div key={a.id} className="flex flex-col items-center gap-1" title={`${a.desc} · ${a.tier}`}>
                  <AchievementBadge ach={a} size={54} c={c} />
                  <div className="font-body text-[9px] text-center leading-tight px-0.5 flex items-center justify-center gap-1" style={{ color: c.textFaint }}>
                    <span className="inline-block rounded-full shrink-0" style={{ width: 5, height: 5, background: TIER_COLOR[a.tier] }} />
                    {a.earned ? a.desc : `${a.value}/${a.target}`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Compact homepage preview of the platform-wide Wall of Fame — top 3 by
// trophy score, podium-styled like the Leaderboard/Ladder strips it sits
// next to. Renders nothing until at least one badge has been earned by
// anyone, same "don't show an empty shelf" reasoning as those strips.
function WallOfFameStrip({ standings, onOpen, c }) {
  if (!standings || standings.length === 0) return null;
  const top3 = standings.slice(0, 3);
  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>Wall of Fame</div>
        <button onClick={onOpen} className="flex items-center gap-0.5 font-mono text-[10px] font-bold uppercase tracking-wide" style={{ color: c.accent }}>
          See all <ChevronRight size={12} />
        </button>
      </div>
      <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
        className="flex items-stretch gap-2.5 overflow-x-auto pb-1 cursor-pointer" style={{ scrollbarWidth: "none" }}>
        {top3.map((row) => (
          <div key={row.userId} className="relative flex items-center gap-2 shrink-0 rounded-xl pl-2 pr-3.5 py-2" style={{
            background: row.rank === 1 ? `linear-gradient(135deg, ${c.accent}26, ${c.surface})` : c.surface,
            border: `1px solid ${row.rank === 1 ? c.accent + "55" : c.border}`,
          }}>
            <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${rankColors[row.rank - 1]}22`, border: `1px solid ${rankColors[row.rank - 1]}66` }}>
              {row.rank === 1 ? <Crown size={13} style={{ color: rankColors[0] }} /> : <Medal size={13} style={{ color: rankColors[row.rank - 1] }} />}
            </span>
            <MemberAvatar url={row.profile.avatar_url} username={row.profile.username} size={26} c={c} />
            <div className="flex flex-col leading-tight">
              <span className="font-body font-semibold text-sm truncate max-w-[100px]" style={{ color: c.text }}>{row.profile.username}</span>
              <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{row.count} badges</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// The full Wall of Fame — every member who's earned at least one badge,
// ranked by trophy score (rarer badges count for more, so it rewards
// chasing hard badges rather than just racking up easy ones), each row
// showing their badge count and single best badge as a preview.
function WallOfFameModal({ standings, myUserId, onClose, c }) {
  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl p-6 border" style={{ background: c.bg, borderColor: c.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wider" style={{ color: c.accent }}>
              <Crown size={13} /> Wall of Fame
            </div>
            <div className="font-body text-xs mt-1" style={{ color: c.textDim }}>Ranked by trophy score — rarer badges count for more</div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ color: c.textFaint }}><X size={18} /></button>
        </div>
        <div className="flex flex-col gap-2">
          {standings.map((row) => {
            const isMe = row.userId === myUserId;
            const rankColor = row.rank <= 3 ? rankColors[row.rank - 1] : c.textFaint;
            return (
              <div key={row.userId} className="flex items-center gap-2.5 rounded-xl px-2.5 py-2" style={{
                background: isMe ? `${c.accent}14` : "transparent",
                border: `1px solid ${isMe ? c.accent + "55" : "transparent"}`,
              }}>
                <span className="w-6 text-center font-mono text-xs font-bold shrink-0" style={{ color: rankColor }}>
                  {row.rank <= 3 ? <Crown size={13} style={{ color: rankColor, display: "inline" }} /> : row.rank}
                </span>
                <MemberAvatar url={row.profile.avatar_url} username={row.profile.username} size={30} c={c} />
                <div className="flex-1 min-w-0 leading-tight">
                  <div className="font-body font-semibold text-sm truncate" style={{ color: c.text }}>{row.profile.username}{isMe ? " (you)" : ""}</div>
                  <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{row.count} badges · {row.score} pts</div>
                </div>
                {row.bestBadge && (
                  <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: 26, height: 26, background: `linear-gradient(135deg, ${row.bestBadge.color}, ${row.bestBadge.color}99)`, border: `1.5px solid ${row.bestBadge.color}` }} title={row.bestBadge.label}>
                    <row.bestBadge.icon size={13} style={{ color: "#fff" }} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Expired, unplayed fixtures count as a loss for both sides once past their
// deadline — and, per the no-show rule, both sides also concede 4 goals
// (scoring 0 themselves), so each ends up with a -4 goal difference for
// this fixture. This is a standings-table penalty only, not a real
// scoreline — the fixture itself stays unplayed/scoreless in the database;
// isExpired just tells computeStandings to treat it this way live.
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
      h.ga += 4; a.ga += 4; // no-show penalty: both concede 4, no points either way
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
// not team, so someone's record follows them between leagues). A club that
// hasn't been claimed by a signed-up member yet — e.g. a name from a
// league's pre-listed open-registration team sheet that nobody has joined
// under — has no user to attribute its results to, so it's kept as its own
// row keyed by team instead, named after the club. Without this fallback
// those clubs' wins would silently vanish from the Leaderboard (though they'd
// still count on that league's own Table, since computeStandings works off
// fixtures/teams directly) — which is exactly why a club leading its
// league's table could still be missing from the platform-wide rankings.
// Pass `bounds` ({start, end} Dates) to scope it to one season; pass
// null/undefined for the all-time board.
function computeGlobalLeaderboard(leagues, bounds) {
  const byKey = new Map();
  (leagues || []).forEach((l) => {
    const ownerByTeamId = new Map();
    (l.members || []).forEach((m) => { if (m.team_id) ownerByTeamId.set(m.team_id, m); });
    (l.teams || []).forEach((team) => {
      const owner = ownerByTeamId.get(team.id);
      const key = owner ? `u:${owner.user_id}` : `t:${team.id}`;
      const name = owner ? owner.display_name : team.name;
      const played = l.fixtures.filter((f) => {
        if (!f.played || f.away_team_id === null) return false;
        if (f.home_team_id !== team.id && f.away_team_id !== team.id) return false;
        if (!bounds) return true;
        const at = new Date(fixturePlayedDate(f));
        return at >= bounds.start && at < bounds.end;
      });
      if (played.length === 0) return;
      let acc = byKey.get(key);
      if (!acc) { acc = { key, userId: owner ? owner.user_id : null, name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }; byKey.set(key, acc); }
      acc.name = name; // most recently seen name wins
      played.forEach((f) => {
        const isHome = f.home_team_id === team.id;
        const gf = isHome ? f.home_score : f.away_score;
        const ga = isHome ? f.away_score : f.home_score;
        acc.p++; acc.gf += gf; acc.ga += ga;
        if (gf > ga) acc.w++; else if (gf < ga) acc.l++; else acc.d++;
      });
    });
  });
  return [...byKey.values()].map((r) => ({ ...r, gd: r.gf - r.ga, winRate: r.p ? r.w / r.p : 0, pts: r.w * 3 + r.d }));
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
  if (least === top || (least.key !== undefined && least.key === top.key) || (least.userId !== undefined && least.userId != null && least.userId === top.userId) || (least.id !== undefined && least.id === top.id)) {
    least = byFewestConceded[1];
  }
  return { top, least };
}


// member id -> { rank, contribution, directPrize, redistributed, total }
// for every member who actually won a place (top 3 — gold/silver/bronze —
// for round-robin-ending leagues, champion + runner-up for
// knockout/groups_knockout — see cashPrizePercentages — among
// approved/paid members only). Every place is scaled by how much that
// member personally put in (entryRatio below), and any shortfall from
// underpayment gets redistributed back across the winners, proportional to
// their own direct prize — see the module comment near ORGANIZER_SHARE for
// how the organizer's flat 5% reservation fits into that. Works off
// whatever fixtures currently exist, so callers decide whether that's a
// live projection or the final result — see memberBalance and the
// "started/complete" lifecycle below. Does NOT include the organizer's
// cut — that's a flat fee, not a member prize, computed separately by
// organizerFee().
function computeCashPrizes(league) {
  const results = new Map();
  if (!league || league.league_type !== "cash") return results;
  const pool = (league.members || []).filter((m) => m.payment_status === "approved").reduce((sum, m) => sum + (m.entry_fee || 0), 0);
  if (pool <= 0) return results;
  const rankedTeamIds = computeKnockoutRanking(league);
  const approvedByTeamId = new Map((league.members || [])
    .filter((m) => m.payment_status === "approved" && m.team_id)
    .map((m) => [m.team_id, m]));

  const percentages = cashPrizePercentages(league);
  // The organizer's flat 5% is reserved off the top of every cash league
  // now, so only the remaining 95% is what underpaid winners' shortfall
  // gets redistributed out of.
  const distributable = pool * (1 - ORGANIZER_SHARE);

  const winners = [];
  for (const teamId of rankedTeamIds) {
    if (winners.length >= percentages.length) break;
    const member = approvedByTeamId.get(teamId);
    if (!member) continue; // only paid, approved members can draw a place
    const sharePercent = percentages[winners.length];
    const entryRatio = Math.min(member.entry_fee || 0, ENTRY_FEE_MAX) / ENTRY_FEE_MAX;
    const directPrize = sharePercent * entryRatio * pool;
    winners.push({ member, rank: winners.length + 1, directPrize });
  }
  const directTotal = winners.reduce((sum, w) => sum + w.directPrize, 0);
  const leftover = Math.max(0, distributable - directTotal);
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

// Converts a stored ISO timestamp into the "YYYY-MM-DDTHH:mm" shape a
// <input type="datetime-local"> expects, in the browser's local time — the
// exact inverse of how CreateLeague turns that same input's value back into
// an ISO string (`new Date(value).toISOString()`), so editing round-trips
// without drifting by a timezone offset.
function toDatetimeLocalValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

// Days remaining until a ladder challenge's accept-by deadline. Once this
// hits 0 nothing resolves it automatically — it just becomes visible in the
// admin queue (see escalatedLadderAccepts) for an admin to grant a walkover
// or cancel the challenge.
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

// The one support line for the whole site — shown as a floating button on
// every screen (signed in or not) so anyone can reach a human fast.
const SUPPORT_WHATSAPP_NUMBER = "+27694362789";

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

// Appended only to matchday-1 "let's arrange the match" texts — a brand new
// opponent may not know the site exists yet, so the very first fixture
// message points them to it and tells them where to find their matchup
// (the "Up next" strip right at the top of the homepage). Later matchdays
// skip this since by then they've already been there.
const SITE_URL = "https://www.weafrica.co.za/";
function firstMatchdayNote(round) {
  if (round !== 1) return "";
  return ` Also, jump on ${SITE_URL} — you'll find your opponent right at the top of the homepage 👆`;
}

// Small pill button used anywhere we offer to message a club's registered
// number. Renders nothing if there's no usable phone number, so callers can
// place it directly after a phone number without an extra guard. With
// iconOnly, renders as a plain round icon button and drops the text label —
// used in fixtures where we show the WhatsApp entry point but not the raw
// number itself.
function WhatsAppLink({ phone, text, label, iconOnly, onClick, c }) {
  const href = waLink(phone, text);
  if (!href) return null;
  if (iconOnly) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title="Message on WhatsApp" onClick={onClick}
        className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0"
        style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
        <MessageCircle size={14} />
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title="Message on WhatsApp" onClick={onClick}
      className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold px-2 py-1 rounded-full shrink-0"
      style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
      <MessageCircle size={11} /> {label || "WhatsApp"}
    </a>
  );
}

// A "call" entry point that goes through WhatsApp instead of the device's
// own dialer. WhatsApp has no public deep link that starts a voice call
// directly against a phone number (its Call Link feature only shares links
// to calls a user already created inside the app) — so this opens the
// WhatsApp chat with that number, prefilled with a message explaining why,
// so the other person immediately knows to expect a call. From there the
// person taps WhatsApp's own call icon. Renders nothing without a usable
// number, same guard pattern as WhatsAppLink so the two can sit side-by-side.
function WhatsAppCallLink({ phone, text, label, iconOnly, c }) {
  const href = waLink(phone, text);
  if (!href) return null;
  if (iconOnly) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title="Call to arrange the match on WhatsApp"
        className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0"
        style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
        <Phone size={13} />
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title="Call to arrange the match on WhatsApp"
      className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold px-2 py-1 rounded-full shrink-0"
      style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
      <Phone size={11} /> {label || "Call"}
    </a>

  );
}

// Site-wide quick-contact entry point — a floating round WhatsApp button
// pinned to the corner of every screen, signed in or not, so reaching
// support never depends on which page someone happens to be on. Opens a
// prefilled chat to SUPPORT_WHATSAPP_NUMBER rather than a raw phone number,
// same pattern as WhatsAppLink elsewhere in the app.
function SupportWhatsAppButton({ context }) {
  const href = waLink(SUPPORT_WHATSAPP_NUMBER, `Hi, I need help with ${context || "the Matchday app"}.`);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title="Chat to support on WhatsApp"
      className="fixed bottom-4 right-3 z-50 w-[18px] h-[18px] rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-105"
      style={{ background: WHATSAPP_GREEN, color: "#fff" }}>
      <MessageCircle size={9} />
    </a>
  );
}

// Small persistent "Terms" link, mirroring the WhatsApp support button on the
// opposite corner — keeps the Terms & Conditions one tap away from every
// screen without crowding the header.
function TermsFooterLink({ onOpen, c }) {
  return (
    <button onClick={onOpen} title="Terms & Conditions"
      className="fixed bottom-4 left-3 z-50 font-mono text-[9px] uppercase tracking-wider underline underline-offset-2"
      style={{ color: c.textFaint }}>
      Terms
    </button>
  );
}

// The "referee" notification mascot — drop-in replacement for the old
// plain-text bottom toast. Slides in from the right to dead center of the
// screen with her message in a speech bubble, holds briefly, then slides
// back out to the left (see the referee-in/referee-out keyframes in
// index.css). Two photo variants alternate at random each time one fires
// (see the queueing logic in App()) just for a bit of visual variety —
// pointer-events stay off throughout so she never blocks a tap on
// whatever's underneath her.
function RefereeNotification({ data, c }) {
  const isFullBody = data.variant === "fullbody";
  // Same singleton used by the rules player and comment rows — tapping this
  // speaker reads the notification aloud with whatever voice/engine those
  // already use, and toggles off (id -> null) the same way a comment's
  // speaker does if tapped again mid-read.
  const speakingId = useCommentSpeakingId();
  const isSpeaking = speakingId === data.id;
  // Small reusable HUD-style corner bracket, mirrored/rotated per corner via
  // the `pos` classes passed in — gives the bubble a "targeting frame" look
  // instead of a plain rectangle.
  const corner = (pos, borders) => (
    <span className={`absolute w-2.5 h-2.5 ${pos}`} style={{ ...borders, borderColor: c.accent }} />
  );
  return (
    <>
      {/* Vignette: dims whatever's underneath just enough that she pops
          against a busy page. Sits below her (z-99 vs z-100), never
          intercepts taps. */}
      <div className="fixed inset-0 z-[99] pointer-events-none"
        style={{
          background: "radial-gradient(circle at 50% 50%, transparent 0%, rgba(0,0,0,0.45) 100%)",
          animation: `${data.phase === "out" ? "referee-vignette-out" : "referee-vignette-in"} 450ms ease-out forwards`,
        }} />
      <div className="fixed top-1/2 left-1/2 z-[100] flex flex-col items-center pointer-events-none"
        style={{ animation: `${data.phase === "out" ? "referee-out" : "referee-in"} 450ms ease-out forwards` }}>
        <div className="referee-bubble-pop relative flex flex-col gap-1 pl-4 pr-3 py-2.5 max-w-[85vw] md:max-w-sm shadow-lg"
          style={{
            background: `linear-gradient(135deg, ${c.bg} 0%, ${c.surfaceHover} 100%)`,
            border: `1.5px solid ${c.accent}`,
            boxShadow: `0 0 22px ${c.accent}4D, 0 10px 24px rgba(0,0,0,0.45)`,
            clipPath: "polygon(3% 0%, 100% 0%, 97% 100%, 0% 100%)",
          }}>
          {/* One-shot expanding ring, timed to the bubble's own pop-in */}
          <span className="referee-impact-ring pointer-events-none absolute left-1/2 top-1/2 rounded-full"
            style={{ width: 40, height: 40, border: `1.5px solid ${c.accent}` }} />
          {/* Accent stripe down the left edge, like a HUD callout tab */}
          <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: c.accent }} />
          {/* Targeting-frame corner brackets */}
          {corner("-top-1 -left-1", { borderTop: "2px solid", borderLeft: "2px solid" })}
          {corner("-top-1 -right-1", { borderTop: "2px solid", borderRight: "2px solid" })}
          {corner("-bottom-1 -left-1", { borderBottom: "2px solid", borderLeft: "2px solid" })}
          {corner("-bottom-1 -right-1", { borderBottom: "2px solid", borderRight: "2px solid" })}
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.15em] mb-0.5" style={{ color: c.accent }}>
                Referee
              </div>
              <span className="font-display font-bold uppercase tracking-wide leading-tight block"
                style={{ color: c.text, fontSize: "clamp(13px, 4vw, 17px)", textShadow: `0 0 12px ${c.accent}66` }}>
                {data.msg}
              </span>
            </div>
            <button onClick={() => commentSpeech.speak(data.id, data.msg)} title="Read notification aloud"
              className="pointer-events-auto shrink-0 transition-colors" style={{ color: isSpeaking ? c.accent : c.textDim }}>
              <Volume2 size={16} />
            </button>
          </div>
        </div>
        {/* Thin glowing connector linking the callout to the mascot below it */}
        <span className="w-[2px] h-3" style={{ background: `linear-gradient(${c.accent}, transparent)` }} />
        <div className="relative flex items-center justify-center">
          <span className="referee-spotlight pointer-events-none absolute left-1/2 top-1/2 rounded-full"
            style={{
              width: isFullBody ? 200 : 240, height: isFullBody ? 200 : 240,
              background: `radial-gradient(circle, ${c.accent}55 0%, transparent 70%)`,
              filter: "blur(18px)", zIndex: 0,
            }} />
          <img src={isFullBody ? "/referee-fullbody.png" : "/referee-closeup.png"} alt=""
            className="referee-idle-sway select-none relative" draggable={false}
            style={{ height: isFullBody ? "38vh" : "26vh", maxHeight: 340, zIndex: 1, filter: "drop-shadow(0 12px 24px rgba(0,0,0,0.35))" }} />
        </div>
      </div>
    </>
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
          <button aria-label="Cancel" onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>
        <div className="font-body text-sm mb-4" style={{ color: c.textDim }}>{league.name}</div>

        <div className="rounded-lg p-3 mb-3 font-body text-xs" style={{ background: c.surface, color: c.textDim }}>
          <div className="flex items-center gap-2 mb-2">
            <img src="/capitec-logo.png" alt="Capitec Bank" className="h-4 w-auto object-contain" />
            <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Payment details</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span style={{ color: c.textFaint }}>Bank</span><span>{BANK_DETAILS.bank}</span>
            <span style={{ color: c.textFaint }}>Account name</span><span>{BANK_DETAILS.accountName}</span>
            <span style={{ color: c.textFaint }}>Account number</span><span className="font-mono">{BANK_DETAILS.accountNumber}</span>
            <span style={{ color: c.textFaint }}>Account type</span><span>{BANK_DETAILS.accountType}</span>
          </div>
          <div className="flex items-center gap-2 mt-3 mb-2">
            <img src="/mukuru-logo.png" alt="Mukuru" className="h-4 w-auto object-contain" />
            <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Or via Mukuru</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span style={{ color: c.textFaint }}>Receiver name</span><span>{MUKURU_DETAILS.receiverName}</span>
            <span style={{ color: c.textFaint }}>Receiver phone</span><span className="font-mono">{MUKURU_DETAILS.receiverPhone}</span>
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
          <button aria-label="Cancel" onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
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
          <button aria-label="Cancel" onClick={onCancel} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
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
          If the screenshot clearly shows both usernames and this score, it's approved instantly. Otherwise {opponentUsername} will need to confirm it.
        </div>

        <button disabled={!file || saving} onClick={submit} className="w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full"
          style={file && !saving ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {saving ? "Logging…" : "Log result"}
        </button>
      </div>
    </div>
  );
}

// Comments render in many independent components scattered across the
// challenge board and league pages, but the browser can only speak one
// utterance at a time — so "which comment is currently being read aloud"
// lives here, outside React, as a tiny subscribe/notify singleton. Every
// comment row's speaker button reads from this same source via
// useCommentSpeakingId(), so starting a new one automatically resets the
// icon on whichever row was playing before.
let commentVoicesCache = [];
function refreshCommentVoices() {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    commentVoicesCache = window.speechSynthesis.getVoices();
  }
}
if (typeof window !== "undefined" && window.speechSynthesis) {
  refreshCommentVoices();
  // addEventListener (rather than the onvoiceschanged property) so this
  // doesn't clobber — or get clobbered by — RulesModal's own voice loading.
  window.speechSynthesis.addEventListener("voiceschanged", refreshCommentVoices);
  let commentVoicePollAttempts = 0;
  const commentVoicePoll = setInterval(() => {
    commentVoicePollAttempts += 1;
    refreshCommentVoices();
    if (commentVoicesCache.length || commentVoicePollAttempts > 10) clearInterval(commentVoicePoll);
  }, 300);
}
const isMobileDeviceGlobal = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// Only one audio source — a "read aloud" utterance or a voice-note clip —
// should ever be playing at once across the whole app. Whoever wants to
// start playing calls take() with its own stop function; if something else
// was already playing, this stops it first. release() only clears the slot
// if it's still the caller's own stop function (so a stale release from an
// already-superseded player can't clobber whatever's playing now).
const audioArbiter = {
  current: null,
  take(stop) {
    if (this.current && this.current !== stop) this.current();
    this.current = stop;
  },
  release(stop) {
    if (this.current === stop) this.current = null;
  },
};

const commentSpeech = {
  speakingId: null,
  utterance: null,
  watchdog: null,
  listeners: new Set(),
  notify() { this.listeners.forEach((fn) => fn(this.speakingId)); },
  clearWatchdog() { if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; } },
  stop() {
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    this.clearWatchdog();
    this.speakingId = null;
    this.utterance = null;
    audioArbiter.release(this.arbiterStop);
    this.notify();
  },
  // Tapping the speaker on whatever's already playing stops it; tapping a
  // different comment cancels the first and starts the new one. Also yields
  // the shared audioArbiter slot, so starting a voice-note playback elsewhere
  // stops this the same way a second read-aloud tap would.
  speak(id, text) {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    this.clearWatchdog();
    if (this.speakingId === id) { this.speakingId = null; this.utterance = null; audioArbiter.release(this.arbiterStop); this.notify(); return; }
    if (!this.arbiterStop) this.arbiterStop = () => this.stop();
    audioArbiter.take(this.arbiterStop);
    const utter = new SpeechSynthesisUtterance(text);
    const voice = pickBestVoice(commentVoicesCache);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang || "en-US";
    utter.onend = () => { this.speakingId = null; this.utterance = null; this.clearWatchdog(); this.notify(); };
    utter.onerror = () => { this.speakingId = null; this.utterance = null; this.clearWatchdog(); this.notify(); };
    this.utterance = utter;
    this.speakingId = id;
    this.notify();
    window.speechSynthesis.speak(utter);
    // Same desktop Chrome/Edge "goes silent after ~15s" bug worked around
    // in RulesModal — harmless no-op on browsers that don't have it.
    if (!isMobileDeviceGlobal) {
      this.watchdog = setInterval(() => {
        if (!window.speechSynthesis.speaking) { this.clearWatchdog(); return; }
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }, 5000);
    }
  },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};

// Returns the id of whichever comment is currently being read aloud (or
// null), staying in sync across every comment row via commentSpeech above.
function useCommentSpeakingId() {
  const [id, setId] = useState(commentSpeech.speakingId);
  useEffect(() => commentSpeech.subscribe(setId), []);
  return id;
}

const fmtDuration = (s) => {
  const total = Math.max(0, Math.round(s || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

// Records a short voice note from the mic. Every composer (top-level and
// replies, on both the league comments and the challenge board) gets its
// own instance of this, same as they each get their own text/photo state —
// nothing here is shared across composers, unlike commentSpeech/audioArbiter
// above which coordinate *playback* across the whole app.
function useVoiceRecorder() {
  const [state, setState] = useState("idle"); // idle | recording | recorded | denied
  const [seconds, setSeconds] = useState(0);
  const [clip, setClip] = useState(null); // { blob, duration }
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const streamRef = useRef(null);
  const secondsRef = useRef(0);

  const cleanupStream = () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
  };

  const start = async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("denied");
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported?.(t));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setClip({ blob, duration: secondsRef.current });
        setState("recorded");
        cleanupStream();
      };
      recorderRef.current = recorder;
      recorder.start();
      setSeconds(0);
      secondsRef.current = 0;
      setState("recording");
      timerRef.current = setInterval(() => { secondsRef.current += 1; setSeconds(secondsRef.current); }, 1000);
      return true;
    } catch {
      setState("denied");
      return false;
    }
  };

  const stop = () => {
    clearInterval(timerRef.current);
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  };

  const discard = () => {
    clearInterval(timerRef.current);
    cleanupStream();
    setClip(null);
    setSeconds(0);
    setState("idle");
  };

  // Puts a previously-recorded clip back into the "recorded" preview state —
  // used to undo an optimistic discard() when the post it was attached to
  // fails to send, mirroring how failed text/photo get restored to the box.
  const restore = (savedClip) => {
    if (!savedClip) return;
    setClip(savedClip);
    setSeconds(savedClip.duration || 0);
    setState("recorded");
  };

  useEffect(() => () => { clearInterval(timerRef.current); cleanupStream(); }, []);

  return { state, seconds, clip, start, stop, discard, restore };
}

// Mic button for a comment composer: idle → tap to start recording → tap
// again to stop. While recording it swaps to a small pulsing timer, mirroring
// how the Camera attach button sits next to the textarea everywhere else.
function VoiceRecorderButton({ recorder, c, size = 40, iconSize = 15 }) {
  const handleClick = () => {
    if (recorder.state === "recording") recorder.stop();
    else if (recorder.state === "idle" || recorder.state === "denied") recorder.start();
  };
  if (recorder.state === "recording") {
    return (
      <button onClick={handleClick} title="Stop recording" type="button"
        className="shrink-0 flex items-center justify-center gap-1.5 rounded-full px-3 font-mono text-[10px] transition-colors"
        style={{ height: size, background: c.red, color: "#fff" }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#fff", animation: "voiceRecPulse 1s ease-in-out infinite" }} />
        {fmtDuration(recorder.seconds)}
      </button>
    );
  }
  return (
    <button onClick={handleClick} title="Record a voice note" type="button"
      className="shrink-0 flex items-center justify-center rounded-full transition-colors"
      style={{ width: size, height: size, background: c.surfaceHover, color: c.textFaint }}>
      <Mic size={iconSize} />
    </button>
  );
}

// Compact play/pause + progress pill used both for a just-recorded preview
// clip (object URL, still local) and for a posted comment's voice note
// (public storage URL). Registers with audioArbiter so playing one stops
// any read-aloud comment, or another voice note, that was already going.
function VoiceNotePlayer({ url, duration, c, compact = false }) {
  const audioRef = useRef(null);
  const stopRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dur, setDur] = useState(duration || 0);

  useEffect(() => {
    return () => { audioRef.current?.pause(); audioArbiter.release(stopRef.current); };
  }, []);

  const pause = () => { audioRef.current?.pause(); setPlaying(false); };

  const toggle = () => {
    if (!audioRef.current) {
      const audio = new Audio(url);
      audio.onended = () => { setPlaying(false); setProgress(0); audioArbiter.release(stopRef.current); };
      audio.onloadedmetadata = () => { if (isFinite(audio.duration) && audio.duration > 0) setDur(audio.duration); };
      audio.ontimeupdate = () => { if (audio.duration) setProgress(audio.currentTime / audio.duration); };
      audioRef.current = audio;
      stopRef.current = () => pause();
    }
    if (playing) { pause(); audioArbiter.release(stopRef.current); }
    else { audioArbiter.take(stopRef.current); audioRef.current.play(); setPlaying(true); }
  };

  return (
    <button onClick={toggle} type="button"
      className="flex items-center gap-2 rounded-full transition-colors"
      style={{ padding: compact ? "5px 10px" : "7px 12px", background: c.surfaceHover, border: `1px solid ${c.border}` }}>
      <span className="rounded-full flex items-center justify-center shrink-0" style={{ width: compact ? 20 : 24, height: compact ? 20 : 24, background: c.accent, color: c.accentText }}>
        {playing ? <Pause size={compact ? 9 : 11} /> : <Play size={compact ? 9 : 11} style={{ marginLeft: 1 }} />}
      </span>
      <div className="rounded-full overflow-hidden" style={{ width: compact ? 64 : 90, height: 3, background: c.border }}>
        <div className="h-full" style={{ width: `${Math.min(1, progress) * 100}%`, background: c.accent }} />
      </div>
      <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>
        {fmtDuration(playing ? progress * dur : dur)}
      </span>
    </button>
  );
}


// Small pill button that opens a RulesModal — dropped in wherever a player
// might want a quick reminder of how something works without leaving the
// screen: on a league page, next to the ladder, and in the challenges hub.
function RulesButton({ label, onClick, c }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}>
      <Info size={11} /> {label}
    </button>
  );
}

// Shared with SignedInScreens.jsx (the split-out signed-in app — see the
// lazy() consts above): these all stay defined here because App() itself
// still calls several of them directly in its own handlers/hooks, so they
// can't move out with the rest. Exporting them lets the split-out file use
// the exact same functions/singletons instead of duplicating them.
export {
  RulesModal, ENTRY_FEE_MIN, ENTRY_FEE_MAX, formatRand, isKnockoutFormat, organizerFee, LADDER_THEME, FORMATS,
  isActiveMember, activeFunLeaguesByKind, blockingLeagueFor, groupLabel, isExpired, nextFixtureForTeam, nextFixtureForLeague,
  resultConfirmDeadline, resultConfirmHoursLeft, challengeResultConfirmExpired, challengeResultHoursLeft, resultEscalationReason,
  computeMyUpcomingFixtures, computeMyProgress, tierColorFor, ProgressBreakdownModal, computeWallOfFame, computeAchievements,
  AchievementsStrip, AchievementsModal, WallOfFameStrip, WallOfFameModal, computeStandings, seasonAnchor, seasonBounds,
  seasonKey, seasonLabel, currentSeason, daysUntilSeasonReset, listSeasons, computeRecentMatches, computeGlobalLeaderboard,
  goalExtremes, computeCashPrizes, memberBalance, splitCommentsByRoot, findSubmissionOpponentId, fmtDate, toDatetimeLocalValue,
  timeAgo, ladderDaysLeft, avatarColor, WHATSAPP_GREEN, waLink, firstMatchdayNote, WhatsAppLink, WhatsAppCallLink, Loader,
  commentSpeech, useCommentSpeakingId, useVoiceRecorder, VoiceRecorderButton, VoiceNotePlayer, RulesButton,
};

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [leagues, setLeagues] = useState(null);
  // A hard refresh re-mounts the whole app from scratch, so React state
  // always starts from these defaults — but the browser itself preserves
  // window.history.state across a reload of the same entry (it's tied to
  // the URL/history entry, not the page's in-memory state). Reading it here
  // means a refresh lands back on whichever screen the appNav effect below
  // last recorded, instead of always bouncing to Home.
  const [view, setView] = useState(() => (window.history.state?.appView ? window.history.state.view : null) || "home");
  const [activeLeagueId, setActiveLeagueId] = useState(() => (window.history.state?.appView ? window.history.state.activeLeagueId : null) ?? null);
  const [refereeQueue, setRefereeQueue] = useState([]); // [{ id, msg }] — messages waiting to be shown
  const [activeReferee, setActiveReferee] = useState(null); // { id, msg, variant, phase: "in" | "hold" | "out" } — currently on screen
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || "dark"; } catch (e) { return "dark"; }
  });
  // Accent color: originally a guest-only preference (picked on PublicHome,
  // before signing in) that never made it past that screen — a guest who
  // picked "Ocean" would land back on gold the moment they signed in, since
  // the signed-in app read straight from THEMES[theme] with no accent
  // layered on. Lifting the state up here means the same choice (same
  // ACCENT_KEY in localStorage) now colors every screen, guest or signed
  // in, instead of resetting at the login boundary.
  const [accentKey, setAccentKey] = useState(() => {
    try { return localStorage.getItem(ACCENT_KEY) || "gold"; } catch (e) { return "gold"; }
  });
  const setAccent = (key) => {
    setAccentKey(key);
    try { localStorage.setItem(ACCENT_KEY, key); } catch (e) { /* ignore — storage unavailable */ }
  };
  const [handledDeepLink, setHandledDeepLink] = useState(false);
  const [paymentModal, setPaymentModal] = useState(null); // { league, member } — member set only when resubmitting
  const [resultModal, setResultModal] = useState(null); // { league, fixture, homeTeam, awayTeam, existing } — existing set only when resubmitting a rejected result
  // Set when a player taps an "Up next" card on Home wanting to log that
  // specific fixture's result — activeLeagueId flips first and the league's
  // full data may not be loaded into `leagues` yet on the same tick, so this
  // just remembers the intent; the effect below picks it up once the league
  // (and that fixture) actually appear in `activeLeague`, then opens
  // resultModal for it and clears itself.
  const [pendingLogFixtureId, setPendingLogFixtureId] = useState(null);
  const [challengeResultModal, setChallengeResultModal] = useState(null); // { kind: "challenge" | "open", challenge } — logging a score for an accepted challenge
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [accounts, setAccounts] = useState(null); // admin-only: every profile on the platform
  const [challengeMembers, setChallengeMembers] = useState(null); // every other member, for the challenge picker
  const [allAchievements, setAllAchievements] = useState(null); // every earned badge, every member — feeds the Wall of Fame
  const [teamAvatars, setTeamAvatars] = useState({}); // team_id -> avatar_url, for club photos on the Table (mirrors the guest view's version)
  const [challenges, setChallenges] = useState(null); // every challenge involving the signed-in member, either side
  const [openChallenges, setOpenChallenges] = useState(null); // broadcast "random challenge" pool — open to whoever accepts first
  const [recentResults, setRecentResults] = useState(null); // last 100 confirmed challenge results, platform-wide (community feed)
  const [boardComments, setBoardComments] = useState(null); // platform-wide comment wall shown under Challenges
  const [ladderComments, setLadderComments] = useState(null); // comment wall shown on the full Ladder page
  const [ladderResults, setLadderResults] = useState(null); // last 100 confirmed ladder-challenge results, for the full Ladder page
  const [ladder, setLadder] = useState(null); // the whole permanent ladder, ordered by rank_position — never resets
  const [ladderChallengeOpen, setLadderChallengeOpen] = useState(false); // the "who can I challenge" sheet
  const [confirmFlow, setConfirmFlow] = useState(null); // { steps: string[], step: number, action: () => void }
  const [authPrompt, setAuthPrompt] = useState(null); // reason string, shown in the "sign in to continue" modal for guests
  const [shopDeepLinkProductId, setShopDeepLinkProductId] = useState(null); // from a shared /shop/<id> link — works signed in or as a guest
  const [handledShopDeepLink, setHandledShopDeepLink] = useState(false);
  const c = useMemo(() => withAccent(THEMES[theme], theme, accentKey), [theme, accentKey]);

  // The app's own content div paints its themed background, but the real
  // <html>/<body> behind it never did — on mobile, an edge swipe triggers
  // the browser's natural elastic overscroll bounce, which briefly reveals
  // whatever's behind the content (blank white by default) before snapping
  // back. Keeping the page's actual background in sync with the theme means
  // that bounce reveals the right color instead of a white sliver.
  useEffect(() => {
    document.documentElement.style.background = c.bg;
    document.body.style.background = c.bg;
  }, [c.bg]);

  // Same call signature as the old showToast(msg) — every existing call
  // site across the app is untouched, this just queues the message for the
  // referee mascot instead of setting a plain toast string.
  const showToast = useCallback((msg) => {
    setRefereeQueue((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, msg }]);
  }, []);

  // Pulls the next queued message onto screen once nothing's currently
  // showing — so firing several actions in quick succession (e.g.
  // confirming a few results back to back) queues them one after another
  // instead of interrupting or overlapping.
  useEffect(() => {
    if (activeReferee || refereeQueue.length === 0) return;
    const next = refereeQueue[0];
    setRefereeQueue((prev) => prev.slice(1));
    const variant = Math.random() < 0.5 ? "closeup" : "fullbody";
    setActiveReferee({ ...next, variant, phase: "in" });
  }, [activeReferee, refereeQueue]);

  // Whichever comment/notification is currently being read aloud — shared
  // with the rules player and comment rows via the same commentSpeech
  // singleton. Used below to keep the referee on screen for as long as her
  // own notification is being read, instead of dismissing her on the usual
  // timer partway through.
  const refereeSpeakingId = useCommentSpeakingId();

  // Walks the current notification through in -> hold -> out -> gone, at
  // which point the effect above picks up the next queued one, if any.
  useEffect(() => {
    if (!activeReferee) return;
    if (activeReferee.phase === "in") {
      const t = setTimeout(() => setActiveReferee((cur) => (cur ? { ...cur, phase: "hold" } : cur)), 450);
      return () => clearTimeout(t);
    }
    if (activeReferee.phase === "hold") {
      // Someone tapped the speaker on this notification — hold off the
      // usual auto-dismiss timer. The effect below sends her to "out" the
      // moment the reading actually finishes instead.
      if (refereeSpeakingId === activeReferee.id) return;
      const t = setTimeout(() => setActiveReferee((cur) => (cur ? { ...cur, phase: "out" } : cur)), 2400);
      return () => clearTimeout(t);
    }
    if (activeReferee.phase === "out") {
      const t = setTimeout(() => setActiveReferee(null), 450);
      return () => clearTimeout(t);
    }
  }, [activeReferee, refereeSpeakingId]);

  // Once a speaker-triggered read of the active notification ends (its id
  // drops out of commentSpeech's speakingId), send her straight into the
  // "out" animation rather than waiting on — or restarting — the hold
  // timer above.
  const prevRefereeSpeakingIdRef = useRef(null);
  useEffect(() => {
    const wasSpeakingId = prevRefereeSpeakingIdRef.current;
    prevRefereeSpeakingIdRef.current = refereeSpeakingId;
    if (wasSpeakingId && refereeSpeakingId === null && activeReferee?.id === wasSpeakingId && activeReferee.phase !== "out") {
      setActiveReferee((cur) => (cur ? { ...cur, phase: "out" } : cur));
    }
  }, [refereeSpeakingId, activeReferee]);

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
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore — storage unavailable */ }
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
  const deleteAccount = (account, leagueCounts) => {
    const label = account.efootball_username || account.email || "this account";
    const createdWarning = leagueCounts.created > 0
      ? ` They created ${leagueCounts.created} league${leagueCounts.created === 1 ? "" : "s"} — ${leagueCounts.created === 1 ? "it" : "those"} will keep running exactly as-is, just manageable only by platform admins from now on.`
      : "";
    const joinedWarning = leagueCounts.joined > 0
      ? ` They're a member of ${leagueCounts.joined} league${leagueCounts.joined === 1 ? "" : "s"} — their club name and results stay in those leagues, just no longer linked to a live account.`
      : "";
    requestConfirm([
      `Permanently delete ${label}'s account? This removes their login, phone number and profile for good and can't be undone.${createdWarning}${joinedWarning}`,
      `Are you sure? ${label}'s login will stop working immediately.`,
      `Really sure you want ${label} gone for good?`,
      `Last check before deleting ${label} — still want to continue?`,
      `Final confirmation — click to permanently delete ${label}'s account.`,
    ], async () => {
      const { error } = await supabase.rpc("admin_delete_account", { target_user_id: account.user_id });
      if (error) { showToast(`Couldn't delete account: ${error.message}`); return; }
      setAccounts((prev) => (prev || []).filter((a) => a.user_id !== account.user_id));
      await loadLeagues();
      showToast(`${label} deleted.`);
    });
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

  // Club-owner photos for the Table, same source the signed-out guest view
  // uses (public_team_avatars: team_id -> avatar_url only, nothing else
  // about the owning member). Loaded once alongside leagues so every
  // league's Table can show them without a fetch of its own.
  const loadTeamAvatars = useCallback(async () => {
    const { data, error } = await supabase.from("public_team_avatars").select("*");
    if (error) return;
    const map = {};
    (data || []).forEach((row) => { if (row.avatar_url) map[row.team_id] = row.avatar_url; });
    setTeamAvatars(map);
  }, []);

  // Every earned badge from every member — the Wall of Fame's raw material.
  // The achievements table is readable by anyone (see
  // supabase/achievements-migration.sql), and only ever contains a user_id
  // + achievement_id + when, nothing sensitive, so a plain select is safe
  // here (no SECURITY DEFINER function needed, unlike list_challengeable_members).
  const loadAllAchievements = useCallback(async () => {
    const { data, error } = await supabase.from("achievements").select("user_id, achievement_id, earned_at");
    if (error) { setAllAchievements([]); return; }
    setAllAchievements(data || []);
  }, []);

  // Every challenge the signed-in member is involved in, either as the one who
  // sent it or the one who received it.
  const loadChallenges = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.from("challenges")
      .select("*")
      .or(`challenger_id.eq.${session.user.id},opponent_id.eq.${session.user.id}`)
      .order("created_at", { ascending: false });
    if (error) { showToast("Couldn't load challenges."); setChallenges([]); return; }
    setChallenges(data || []);
  }, [session, showToast]);

  // The permanent ladder — every member, ordered by rank_position. Never
  // resets (that's the whole point), unlike seasons/leagues elsewhere in the
  // app. RLS only allows reading this while signed in; the homepage shows
  // its own public_ladder_full view instead (see PublicLadderSection).
  const loadLadder = useCallback(async () => {
    const { data, error } = await supabase.from("ladder_ranks").select("*").order("rank_position", { ascending: true });
    if (error) { console.error("Couldn't load the ladder:", error.message); setLadder([]); return; }
    setLadder(data || []);
  }, []);

  // Every confirmed challenge/fixture/random-challenge result attempts a
  // ladder update, but it only actually lands if both players are on the
  // ladder and within 10 points of each other (see apply_ladder_result in
  // the DB). This reads back the row that attempt logged so toasts can say
  // what really happened instead of always claiming "the ladder updated."
  // Returns null if there's nothing to say (log row not written yet, or a
  // logging error) — callers fall back to a plain confirmation toast.
  const describeLadderOutcome = async (source, sourceId) => {
    const { data, error } = await supabase.from("ladder_result_log")
      .select("applied, reason")
      .eq("source", source).eq("source_id", sourceId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    if (!data.applied) {
      if (data.reason === "gap_too_large") return "too far apart in points to affect the ladder.";
      if (data.reason === "not_on_ladder") return "one of you isn't on the ladder, so it wasn't affected.";
      if (data.reason === "pair_cooldown") return "you two already have 2 ladder results today — this one's just for the record.";
      return null;
    }
    return "the ladder just updated.";
  };

  // The only people the signed-in member is allowed to send a ladder
  // challenge to: anyone ranked above them whose points total is within 10
  // points of their own (i.e. up to 10 points ahead). Before your first
  // ladder match, everyone starts at 0 points, so "ahead of you" alone would
  // leave you with nobody to challenge — for that first match only, clubs
  // level with you on points are eligible too. Ordered closest points first,
  // since that's the one worth trying first.
  const ladderTargets = useMemo(() => {
    if (!ladder || !session) return [];
    const mine = ladder.find((r) => r.user_id === session.user.id);
    if (!mine) return [];
    const playedNoMatches = mine.wins + mine.draws + mine.losses === 0;
    return ladder
      .filter((r) => r.user_id !== mine.user_id)
      .filter((r) => !r.challenges_paused)
      .filter((r) => (playedNoMatches && r.points === mine.points) || (r.points > mine.points && r.points - mine.points <= 10))
      .sort((a, b) => a.points - b.points);
  }, [ladder, session]);
  const myLadderRank = useMemo(() => (ladder && session ? ladder.find((r) => r.user_id === session.user.id) : null), [ladder, session]);

  // Lets a member stop receiving new ladder challenges — e.g. if they're
  // swamped with a backlog and want a breather. Doesn't affect challenges
  // already sent/accepted, only blocks brand-new ones from landing on them
  // (enforced both here, by excluding paused players from ladderTargets, and
  // server-side via trg_block_paused_ladder_challenge so it can't be bypassed).
  const toggleLadderPause = async () => {
    if (!myLadderRank) return;
    const next = !myLadderRank.challenges_paused;
    const { error } = await supabase.rpc("set_ladder_pause", { paused: next });
    if (error) { showToast(`Couldn't update pause status: ${error.message}`); return; }
    await loadLadder();
    showToast(next ? "Ladder challenges paused — you won't receive new ones until you unpause." : "Ladder challenges resumed.");
  };

  // Sends a challenge to another member. Snapshots the challenger's own
  // username/phone onto the row right away (same pattern used everywhere
  // else in the app — a team's display_name/phone are snapshotted at join
  // time too) — the opponent's phone stays off the row entirely until they
  // accept, so nobody's number is exposed before they've agreed to it.
  // `isLadder` tags it so that, if it's ever confirmed, the points-awarding
  // trigger in Supabase actually credits the two of them.
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
  const reportChallengeResult = async (challenge, myScore, theirScore, rawFile) => {
    if (!rawFile) { showToast("Attach a photo of the final scoreboard before logging a result."); return; }
    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
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
    await loadLadder();
    const outcome = await describeLadderOutcome("challenge", challenge.id);
    showToast(outcome ? `Result confirmed — ${outcome}` : "Result confirmed.");
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

  // Admin-only fallback once challengeResultConfirmExpired(challenge) is true —
  // the opponent had 24h to confirm/dispute and didn't, so an admin can
  // settle it directly from the screenshot instead. Same two outcomes as
  // the opponent's own confirm/dispute above.
  const adminApproveChallengeResult = async (challenge) => {
    const { error } = await supabase.from("challenges")
      .update({ result_status: "confirmed", result_confirmed_at: new Date().toISOString() })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't approve: ${error.message}`); return; }
    await loadChallenges();
    await loadLadder();
    const outcome = await describeLadderOutcome("challenge", challenge.id);
    showToast(outcome ? `Result approved — ${outcome}` : "Result approved.");
  };
  const adminRejectChallengeResult = async (challenge) => {
    const { error } = await supabase.from("challenges")
      .update({ challenger_score: null, opponent_score: null, result_status: null, result_reported_by: null, result_reported_at: null, result_photo_path: null })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't reject: ${error.message}`); return; }
    await loadChallenges();
    showToast("Result rejected — they'll need to log it again.");
  };

  // Admin-only fallback once a ladder challenge's 5-day accept window has
  // passed with no response — an admin can grant the challenger a walkover
  // instead of it auto-resolving. This is logged as a nominal 3-0 win and
  // routed through the same confirmed-result update as a normal match, so
  // trg_resolve_ladder_challenge awards the points/win/loss exactly like
  // any other confirmed ladder result would.
  const adminGrantLadderWalkover = async (challenge) => {
    const { error } = await supabase.from("challenges").update({
      status: "expired",
      ladder_expiry: "walkover",
      responded_at: new Date().toISOString(),
      challenger_score: 3,
      opponent_score: 0,
      result_status: "confirmed",
      result_confirmed_at: new Date().toISOString(),
    }).eq("id", challenge.id);
    if (error) { showToast(`Couldn't grant walkover: ${error.message}`); return; }
    await loadChallenges();
    await loadLadder();
    const outcome = await describeLadderOutcome("challenge", challenge.id);
    showToast(outcome ? `Walkover granted — ${outcome}` : "Walkover granted.");
  };
  // The other admin option for the same queue — closes the challenge out
  // with no ladder effect on either side, same as a normal decline.
  const adminCancelLadderChallenge = async (challenge) => {
    const { error } = await supabase.from("challenges")
      .update({ status: "declined", responded_at: new Date().toISOString() })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't cancel: ${error.message}`); return; }
    await loadChallenges();
    showToast("Challenge cancelled.");
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

  const postBoardComment = async (body, parentComment = null, voiceClip = null) => {
    const trimmed = (body || "").trim();
    if (!trimmed && !voiceClip) return false;
    const username = profile?.efootball_username || session.user.email;
    let voice_url = null;
    let voice_duration = null;
    if (voiceClip) {
      const ext = (voiceClip.blob.type || "").includes("mp4") ? "m4a" : (voiceClip.blob.type || "").includes("ogg") ? "ogg" : "webm";
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("comment-voice-notes")
        .upload(path, voiceClip.blob, { contentType: voiceClip.blob.type || "audio/webm" });
      if (uploadErr) { showToast(`Couldn't upload voice note: ${uploadErr.message}`); return false; }
      const { data: pub } = supabase.storage.from("comment-voice-notes").getPublicUrl(path);
      voice_url = pub.publicUrl;
      voice_duration = voiceClip.duration || null;
    }
    const { error } = await supabase.from("challenge_board_comments").insert({
      user_id: session.user.id, username, body: trimmed,
      parent_comment_id: parentComment?.id || null, voice_url, voice_duration,
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
    const noun = comment.parent_comment_id ? "reply" : replyCount > 0 ? `comment and its ${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "comment";
    requestConfirm([
      `Delete this ${noun}? This can't be undone.`,
      `Are you sure? Once it's gone, it's gone for good.`,
      `Final check — click to permanently delete this ${noun}.`,
    ], async () => {
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

  // The Ladder's own comment wall — same shape and behavior as the challenge
  // board comments above, just backed by a separate `ladder_comments` table
  // so the two threads don't mix.
  const loadLadderComments = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.from("ladder_comments")
      .select("*, ladder_comment_likes(*)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) { console.error("Couldn't load the ladder comments:", error.message); setLadderComments([]); return; }
    setLadderComments(data || []);
  }, [session]);

  // Last 100 confirmed ladder-challenge results, platform-wide — reads from
  // the ladder_match_results view (see README) so it isn't limited by the
  // per-user RLS on the raw challenges table.
  const loadLadderResults = useCallback(async () => {
    if (!session) return;
    const { data, error } = await supabase.from("ladder_match_results")
      .select("*")
      .order("result_confirmed_at", { ascending: false })
      .limit(100);
    if (error) { console.error("Couldn't load ladder results:", error.message); setLadderResults([]); return; }
    const rows = data || [];

    // The screenshots live in a private storage bucket, so the raw path
    // alone isn't viewable — each one needs a signed URL. Fetch them all
    // in a single batched call (createSignedUrls) rather than one request
    // per row, and attach the result as `photo_url` on each match.
    const paths = rows.map((r) => r.result_photo_path).filter(Boolean);
    if (paths.length === 0) { setLadderResults(rows); return; }
    const { data: signed, error: signErr } = await supabase.storage
      .from("result-proofs")
      .createSignedUrls(paths, 3600);
    if (signErr) {
      console.error("Couldn't sign ladder result photos:", signErr.message);
      setLadderResults(rows);
      return;
    }
    const urlByPath = {};
    (signed || []).forEach((s) => { if (s.signedUrl) urlByPath[s.path] = s.signedUrl; });
    setLadderResults(rows.map((r) => ({ ...r, photo_url: r.result_photo_path ? urlByPath[r.result_photo_path] : null })));
  }, [session]);


  const postLadderComment = async (body, parentComment = null, voiceClip = null) => {
    const trimmed = (body || "").trim();
    if (!trimmed && !voiceClip) return false;
    const username = profile?.efootball_username || session.user.email;
    let voice_url = null;
    let voice_duration = null;
    if (voiceClip) {
      const ext = (voiceClip.blob.type || "").includes("mp4") ? "m4a" : (voiceClip.blob.type || "").includes("ogg") ? "ogg" : "webm";
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("comment-voice-notes")
        .upload(path, voiceClip.blob, { contentType: voiceClip.blob.type || "audio/webm" });
      if (uploadErr) { showToast(`Couldn't upload voice note: ${uploadErr.message}`); return false; }
      const { data: pub } = supabase.storage.from("comment-voice-notes").getPublicUrl(path);
      voice_url = pub.publicUrl;
      voice_duration = voiceClip.duration || null;
    }
    const { error } = await supabase.from("ladder_comments").insert({
      user_id: session.user.id, username, body: trimmed,
      parent_comment_id: parentComment?.id || null, voice_url, voice_duration,
    });
    if (error) { showToast(`Couldn't post ${parentComment ? "reply" : "comment"}: ${error.message}`); return false; }
    await loadLadderComments();
    return true;
  };

  const deleteLadderComment = (comment) => {
    const all = ladderComments || [];
    const countDescendants = (id) => {
      const direct = all.filter((cm) => cm.parent_comment_id === id);
      return direct.reduce((sum, d) => sum + 1 + countDescendants(d.id), 0);
    };
    const replyCount = countDescendants(comment.id);
    const noun = comment.parent_comment_id ? "reply" : replyCount > 0 ? `comment and its ${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "comment";
    requestConfirm([
      `Delete this ${noun}? This can't be undone.`,
      `Are you sure? Once it's gone, it's gone for good.`,
      `Final check — click to permanently delete this ${noun}.`,
    ], async () => {
      const { error } = await supabase.from("ladder_comments").delete().eq("id", comment.id);
      if (error) { showToast(`Couldn't delete comment: ${error.message}`); return; }
      await loadLadderComments();
      showToast(comment.parent_comment_id ? "Reply deleted." : "Comment deleted.");
    });
  };

  const toggleLadderCommentReaction = async (comment, reaction) => {
    const mine = (comment.ladder_comment_likes || []).find((l) => l.user_id === session.user.id);
    if (reaction === null) {
      if (!mine) return true;
      const { error } = await supabase.from("ladder_comment_likes").delete().eq("id", mine.id);
      if (error) { showToast(`Couldn't remove reaction: ${error.message}`); return false; }
    } else if (mine) {
      const { error } = await supabase.from("ladder_comment_likes").update({ reaction }).eq("id", mine.id);
      if (error) { showToast(`Couldn't update reaction: ${error.message}`); return false; }
    } else {
      const { error } = await supabase.from("ladder_comment_likes").insert({ comment_id: comment.id, user_id: session.user.id, reaction });
      if (error) { showToast(`Couldn't react: ${error.message}`); return false; }
    }
    await loadLadderComments();
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
  const reportOpenChallengeResult = async (challenge, myScore, theirScore, rawFile) => {
    if (!rawFile) { showToast("Attach a photo of the final scoreboard before logging a result."); return; }
    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
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
    await loadLadder(); // random challenges count toward ladder points, when eligible (see describeLadderOutcome)
    const outcome = await describeLadderOutcome("open_challenge", challenge.id);
    showToast(outcome ? `Result confirmed — ${outcome}` : "Result confirmed.");
  };

  const disputeOpenChallengeResult = async (challenge) => {
    const { error } = await supabase.from("open_challenges")
      .update({ creator_score: null, accepted_by_score: null, result_status: null, result_reported_by: null, result_reported_at: null, result_photo_path: null })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't dispute result: ${error.message}`); return; }
    await loadOpenChallenges();
    showToast("Result disputed — ask them to re-log it.");
  };

  // Admin-only fallback, same rule as adminApproveChallengeResult above.
  const adminApproveOpenChallengeResult = async (challenge) => {
    const { error } = await supabase.from("open_challenges")
      .update({ result_status: "confirmed", result_confirmed_at: new Date().toISOString() })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't approve: ${error.message}`); return; }
    await loadOpenChallenges();
    await loadLadder(); // random challenges count toward ladder points, when eligible (see describeLadderOutcome)
    const outcome = await describeLadderOutcome("open_challenge", challenge.id);
    showToast(outcome ? `Result approved — ${outcome}` : "Result approved.");
  };
  const adminRejectOpenChallengeResult = async (challenge) => {
    const { error } = await supabase.from("open_challenges")
      .update({ creator_score: null, accepted_by_score: null, result_status: null, result_reported_by: null, result_reported_at: null, result_photo_path: null })
      .eq("id", challenge.id);
    if (error) { showToast(`Couldn't reject: ${error.message}`); return; }
    await loadOpenChallenges();
    showToast("Result rejected — they'll need to log it again.");
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
    loadChallengeMembers(); // also feeds the Leaderboard's profile photos
    loadTeamAvatars(); // also feeds the Table's club photos
    loadAllAchievements(); // feeds the Wall of Fame
  }, [session, profile, loadLeagues, loadChallenges, loadOpenChallenges, loadLadder, loadChallengeMembers, loadTeamAvatars, loadAllAchievements]);

  // The ladder never resets, but ranks can move any time someone else's
  // challenge gets confirmed — so refresh it quietly while Home is open,
  // the same way the random-challenge pool refreshes itself.
  // Previously this list only ever refreshed after the signed-in member's
  // own actions (accept, decline, log a result, etc.) — if the *other*
  // side of a challenge acted, there was no live update at all, only
  // whatever was loaded on the last visit to this screen. This subscribes
  // it properly instead of adding a new poll for something that never
  // polled before.
  useRealtimeRefresh("challenges", loadChallenges, !!session);

  useRealtimeRefresh("ladder_ranks", loadLadder, (view === "home" || view === "ladder") && !!profile);
  useVisibilityPoll(loadLadder, 60000, (view === "home" || view === "ladder") && !!profile);

  // While the Challenges screen — or Home, where the random-challenge
  // notification banner lives — is open, poll the random-challenge pool
  // every few seconds. It's a race to accept, so members want to see it
  // move without having to manually refresh.
  useRealtimeRefresh("open_challenges", loadOpenChallenges, view === "challenges" || view === "home");
  useVisibilityPoll(loadOpenChallenges, 30000, view === "challenges" || view === "home");

  // Same idea for the community results feed, on a slower clock — new
  // confirmed results trickle in rather than needing a race-to-accept refresh.
  useEffect(() => {
    if (view !== "challenges") return;
    loadRecentResults();
  }, [view, loadRecentResults]);
  useRealtimeRefresh("challenges", loadRecentResults, view === "challenges");
  useRealtimeRefresh("open_challenges", loadRecentResults, view === "challenges");
  useVisibilityPoll(loadRecentResults, 60000, view === "challenges");

  useEffect(() => {
    if (view !== "challenges") return;
    loadBoardComments();
  }, [view, loadBoardComments]);
  useRealtimeRefresh("challenge_board_comments", loadBoardComments, view === "challenges");
  useRealtimeRefresh("challenge_board_comment_likes", loadBoardComments, view === "challenges");
  useVisibilityPoll(loadBoardComments, 60000, view === "challenges");

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

  // Handle a shared shop product link like /shop/<id> — anyone can open
  // one, signed in or not, so this runs independently of session state.
  useEffect(() => {
    if (handledShopDeepLink) return;
    const match = window.location.pathname.match(/^\/shop\/([^/]+)\/?$/);
    if (match) {
      setShopDeepLinkProductId(match[1]);
      window.history.replaceState({}, "", "/");
    }
    setHandledShopDeepLink(true);
  }, [handledShopDeepLink]);

  // Once signed in, a pending shop product link should jump straight to the shop.
  useEffect(() => {
    if (shopDeepLinkProductId && session) setView("shop");
  }, [shopDeepLinkProductId, session]);

  // Browser tab title reflects where the shopper actually is.
  useEffect(() => {
    document.title = view === "shop" ? "Department Store" : "Matchday — eFootball Leagues";
  }, [view]);

  // Push a real browser history entry for every screen change, so the
  // hardware/gesture back action moves between in-app screens (League →
  // Home, Shop → Home, etc.) instead of leaving the site entirely — which
  // previously looked like getting logged out, since coming back in reloaded
  // the app from scratch.
  const appNavFirstRef = useRef(true);
  useEffect(() => {
    const state = { appView: true, view, activeLeagueId };
    const cur = window.history.state;
    if (cur && cur.appView && cur.view === view && cur.activeLeagueId === activeLeagueId) return;
    if (appNavFirstRef.current) { appNavFirstRef.current = false; window.history.replaceState(state, ""); return; }
    window.history.pushState(state, "");
  }, [view, activeLeagueId]);

  useEffect(() => {
    const onPopState = (e) => {
      const state = e.state;
      if (!state || !state.appView) return; // not one of ours — leave it to whichever nav owns it
      setView(state.view || "home");
      setActiveLeagueId(state.activeLeagueId ?? null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Every in-app "← Back" button used to call setView("home") directly —
  // which *pushes* a new history entry rather than stepping back through
  // the ones already there. Repeat that a few times while browsing around
  // and the real history stack fills up with duplicate "home" entries, so
  // the hardware/gesture back action often lands on one of those instead of
  // wherever the person actually came from. Using real browser back
  // navigation here lets the popstate handler above restore the true
  // previous screen instead. The appNav effect always replaces the very
  // first entry with the initial view, so there's always something to go
  // back to; the setView("home") fallback only matters if that assumption
  // is ever wrong (e.g. history was cleared externally).
  const goBack = useCallback(() => {
    if (window.history.state?.appView) window.history.back();
    else setView("home");
  }, []);

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
  const updateProfilePhoto = async (rawFile) => {
    const file = await compressImage(rawFile, { maxDimension: 512, quality: 0.85 });
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
  const activeFunLeaguesByKindMap = useMemo(() => activeFunLeaguesByKind(leagues, session), [leagues, session]);

  // Picks up the intent set by tapping an "Up next" card on Home (see
  // pendingLogFixtureId above) once activeLeague's fixtures/teams are
  // actually available, and opens the same SubmitResultModal the manual
  // "Find your opponent" flow uses — pre-filled with that exact fixture, so
  // the player lands ready to enter a score and attach their photo rather
  // than having to search for themselves.
  useEffect(() => {
    if (!pendingLogFixtureId || !activeLeague) return;
    const fixture = activeLeague.fixtures.find((f) => f.id === pendingLogFixtureId);
    if (!fixture) return; // not loaded into this league's data yet — wait for the next update
    setPendingLogFixtureId(null);
    if (fixture.played) return; // already logged elsewhere in the meantime — just land on the league
    if (isExpired(fixture)) {
      showToast("That match passed its 2-day deadline without a result — both clubs received a loss. It's no longer loggable.");
      return;
    }
    const homeTeam = activeLeague.teams.find((t) => t.id === fixture.home_team_id);
    const awayTeam = fixture.away_team_id ? activeLeague.teams.find((t) => t.id === fixture.away_team_id) : null;
    if (!homeTeam || !awayTeam) return;
    const subs = (activeLeague.result_submissions || []).filter((s) => s.fixture_id === fixture.id);
    const pending = subs.find((s) => s.status === "pending");
    const existing = pending || subs.filter((s) => s.status === "rejected").sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
    if (pending) { showToast("This result is already awaiting confirmation."); return; }
    setResultModal({ league: activeLeague, fixture, homeTeam, awayTeam, existing });
  }, [pendingLogFixtureId, activeLeague, showToast]);

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
    const key = `gen-${league.id}`;
    if (stageActionInFlight.current.has(key)) return;
    stageActionInFlight.current.add(key);
    try {
    // Same class of fix as the advance-stage functions: read the current
    // roster fresh from the database right before generating fixtures. A
    // club that joined moments ago but hasn't shown up in this browser's
    // state yet would otherwise be silently left out of the whole schedule.
    const { data: freshTeams, error: teamsErr } = await supabase.from("teams").select("*").eq("league_id", league.id);
    if (teamsErr) { showToast("Couldn't confirm the current club list — try again."); return; }

    if (freshTeams.length < 2) { showToast("Need at least 2 registered clubs to start the league."); return; }
    if (league.format === "groups_knockout" && freshTeams.length < 4) {
      showToast("Need at least 4 clubs to form groups."); return;
    }
    const { fixtureRows, startsInFinal, groups: groupAssignments, groupsCount } = generateOpeningFixtures(league, freshTeams.map((t) => t.id), generationDueBase(league));
    if (groupAssignments) {
      const ok = await persistGroupAssignments(groupAssignments);
      if (!ok) return;
      await supabase.from("leagues").update({ groups_count: groupsCount }).eq("id", league.id);
    }
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;
    if (startsInFinal) await supabase.from("leagues").update({ final_stage_started: true }).eq("id", league.id);
    await loadLeagues();
    showToast(`League started — ${fixtureRows.length} fixtures generated for ${freshTeams.length} clubs${groupAssignments ? ` across ${groupAssignments.length} groups` : ""}.`);
    } finally {
      stageActionInFlight.current.delete(key);
    }
  };

  const advanceGroupsToKnockout = async (league) => {
    // Same fix as advanceSurvivor: read this league's teams/fixtures fresh
    // right before deciding qualifiers, rather than trusting whatever the
    // admin's browser already had — a stale copy here can both cut the
    // wrong clubs from the group stage and seed the knockout bracket wrong.
    const { data: fresh, error: freshErr } = await supabase
      .from("leagues").select("groups_count, teams(*), fixtures(*)").eq("id", league.id).single();
    if (freshErr || !fresh) { showToast("Couldn't confirm the latest results — try again."); return; }

    const groupFixtures = fresh.fixtures.filter((f) => f.stage === 1);
    const unplayed = groupFixtures.filter((f) => !f.played && !isExpired(f));
    if (unplayed.length > 0) { showToast(`${unplayed.length} group match(es) still need a result.`); return; }

    const groupsCount = fresh.groups_count;
    const qualifiers = [];
    const eliminatedIds = [];
    for (let g = 0; g < groupsCount; g++) {
      const groupTeams = fresh.teams.filter((t) => t.group_number === g);
      if (groupTeams.length === 0) continue;
      const groupFx = groupFixtures.filter((f) => groupTeams.some((t) => t.id === f.home_team_id));
      const standings = computeStandings(groupTeams, groupFx);
      const n = Math.min(league.group_qualifiers, standings.length);
      standings.slice(0, n).forEach((r) => qualifiers.push(r.id));
      standings.slice(n).forEach((r) => eliminatedIds.push(r.id));
    }
    if (qualifiers.length < 2) { showToast("Not enough qualifying clubs to start a knockout stage."); return; }

    if (eliminatedIds.length > 0) {
      const { data: updatedRows, error } = await supabase.from("teams").update({ eliminated: true }).in("id", eliminatedIds).select("id");
      if (error) { showToast(`Couldn't finalize groups: ${error.message}`); return; }
      if ((updatedRows?.length || 0) < eliminatedIds.length) {
        showToast(`Only ${updatedRows?.length || 0} of ${eliminatedIds.length} clubs were actually eliminated (permissions issue) — groups NOT finalized. Try again or check with support.`);
        return;
      }
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
  // Same idea as joinInFlight, for the admin-side actions that generate or
  // advance fixtures — a double-tap here (easy to do on mobile) would fire
  // the insert twice before the button's derived `disabled` state catches
  // up, which can duplicate a whole round of fixtures.
  const stageActionInFlight = useRef(new Set());
  const joinLeague = async (leagueId) => {
    if (joinInFlight.current.has(leagueId)) return;
    joinInFlight.current.add(leagueId);
    try {
    const league = (leagues || []).find((l) => l.id === leagueId);
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return; }

    if (league.league_type === "fun") {
      const activeFunLeague = blockingLeagueFor(activeFunLeaguesByKind(leagues, session), league);
      if (activeFunLeague) {
        showToast(`You're still active in "${activeFunLeague.name}" — join another ${formatKindLabel(league.format)} league once your club there is eliminated, or that league finishes.`);
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
  const joinCashLeague = async (league, fee, rawFile) => {
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return false; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return false; }
    if (!rawFile) { showToast("Attach your proof of payment before submitting."); return false; }

    const result = await claimOrRegisterTeam(league);
    if (result.error) return false;

    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
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
  const resubmitCashPayment = async (league, member, fee, rawFile) => {
    if (!rawFile) { showToast("Attach your proof of payment before submitting."); return false; }
    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
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

  // Fired when an admin taps the WhatsApp icon next to a member — flags that
  // member red (for every admin) until the due date the message was about
  // passes. dueAt is skipped (nothing to store) for messages with no date,
  // e.g. the "you've been eliminated" text.
  const markWaReminder = async (member, dueAt) => {
    if (!dueAt) return;
    const { error } = await supabase.from("members").update({ wa_reminder_due_at: dueAt }).eq("id", member.id);
    if (error) return; // best effort — don't interrupt the WhatsApp send with a toast
    await loadLeagues();
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
      // Fetch this tie's leg(s) fresh — not from local `league.fixtures` —
      // so a leg completed earlier (but not yet reflected in this browser's
      // state) doesn't make an already-finished tie look incomplete and
      // silently skip elimination.
      const { data: freshLegs, error: legsErr } = await supabase.from("fixtures")
        .select("*").eq("league_id", league.id).eq("stage", fixture.stage).eq("round", fixture.round);
      const tieFixtures = (legsErr ? league.fixtures : freshLegs)
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
          const { data: updatedRows, error: elimErr } = await supabase.from("teams").update({ eliminated: true }).eq("id", loserId).select("id");
          if (elimErr || !updatedRows?.length) showToast("Result saved, but the losing club couldn't be marked eliminated — check permissions.");
        }
      }
    }
    const homeName = league.teams.find((t) => t.id === fixture.home_team_id)?.name || "Home";
    const awayName = league.teams.find((t) => t.id === fixture.away_team_id)?.name || "Away";
    await postComment(league, `Matchday ${fixture.round} — ${homeName} ${homeScore} – ${awayScore} ${awayName}`, null, file, null, true);
    await loadLeagues();
    await loadLadder(); // league results count toward ladder points, when eligible (see describeLadderOutcome)
    const outcome = await describeLadderOutcome("fixture", fixture.id);
    showToast(outcome ? `Saved: ${homeName} ${homeScore} – ${awayScore} ${awayName} — ${outcome}` : `Saved: ${homeName} ${homeScore} – ${awayScore} ${awayName}`);
  };

  // A joined, non-managing player's version of recordResult: same score
  // entry, but it lands as a pending row instead of writing the fixture
  // directly, and a photo of the scoreboard is mandatory. The fixture itself
  // is only updated once an admin/creator approves it (see approveResult).
  const submitMatchResult = async (league, fixture, homeScore, awayScore, rawFile) => {
    if (!rawFile) { showToast("Attach a photo of the final scoreboard before submitting."); return false; }
    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
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
    await loadLadder(); // league results count toward ladder points, when eligible (see describeLadderOutcome)
    const outcome = await describeLadderOutcome("fixture", submission.fixture_id);
    showToast(outcome ? `Result approved — posted to comments as ${submission.submitted_by_username} — ${outcome}` : `Result approved — posted to comments as ${submission.submitted_by_username}.`);
  };

  const rejectResult = (league, submission) => {
    requestConfirm([
      `Reject this result submitted by ${submission.submitted_by_username}? They'll be able to resubmit.`,
      `Are you sure? The match will stay unplayed until someone resubmits.`,
      `Final check — click to reject this result.`,
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
      `Final check — click to dispute this result.`,
    ], post);
  };

  const advanceKnockout = async (league) => {
    // Same fix as advanceSurvivor/advanceGroupsToKnockout: read this
    // league's fixtures fresh right before deciding round winners. Working
    // off stale local data here is the worst version of this bug — it can
    // advance the wrong team to the next round entirely.
    const { data: fresh, error: freshErr } = await supabase
      .from("leagues").select("fixtures(*)").eq("id", league.id).single();
    if (freshErr || !fresh) { showToast("Couldn't confirm the latest results — try again."); return; }

    // Pure knockout leagues run their whole bracket in stage 1; groups_knockout
    // leagues only enter the bracket once the group stage (stage 1) is done,
    // and the bracket itself lives in stage 2.
    const bracketStage = league.format === "groups_knockout" ? 2 : 1;
    const bracketFixtures = fresh.fixtures.filter((f) => f.stage === bracketStage);
    const maxRound = Math.max(...bracketFixtures.map((f) => f.round));
    const currentRoundFixtures = bracketFixtures.filter((f) => f.round === maxRound);
    const unplayed = currentRoundFixtures.filter((f) => !f.played && !isExpired(f));
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
    // Pull this league's teams/fixtures fresh right before deciding who's
    // cut — not the `league` object already sitting in the browser's state.
    // If a result was recorded (by anyone, in any tab) since this admin's
    // page last loaded, the local copy is stale, and computing the cut
    // against it can eliminate a club that had actually won its match —
    // it just hadn't shown up on this screen yet.
    const { data: fresh, error: freshErr } = await supabase
      .from("leagues").select("current_stage, final_stage_started, teams(*), fixtures(*)").eq("id", league.id).single();
    if (freshErr || !fresh) { showToast("Couldn't confirm the latest results — try again."); return; }

    const currentStage = fresh.current_stage;
    const stageFixtures = fresh.fixtures.filter((f) => f.stage === currentStage);
    const unplayed = stageFixtures.filter((f) => !f.played && !isExpired(f));
    if (unplayed.length > 0) { showToast(`${unplayed.length} match(es) in this stage still need a result.`); return; }

    if (fresh.final_stage_started) { showToast("This is the final stage — check the table for the champion."); return; }

    const activeTeams = fresh.teams.filter((t) => !t.eliminated);
    const standings = computeStandings(activeTeams, stageFixtures);
    let toEliminate = Math.max(1, Math.round(activeTeams.length * (league.survivor_elimination_percent / 100)));
    if (activeTeams.length - toEliminate < league.survivor_target_count) {
      toEliminate = activeTeams.length - league.survivor_target_count;
    }
    const eliminatedIds = standings.slice(standings.length - toEliminate).map((r) => r.id);

    if (eliminatedIds.length > 0) {
      const { data: updatedRows, error } = await supabase.from("teams").update({ eliminated: true }).in("id", eliminatedIds).select("id");
      if (error) { showToast(`Couldn't eliminate teams: ${error.message}`); return; }
      if ((updatedRows?.length || 0) < eliminatedIds.length) {
        showToast(`Only ${updatedRows?.length || 0} of ${eliminatedIds.length} clubs were actually eliminated (permissions issue) — stage NOT advanced. Try again or check with support.`);
        return;
      }
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
    const key = `adv-${league.id}`;
    if (stageActionInFlight.current.has(key)) return;
    stageActionInFlight.current.add(key);
    try {
      if (league.format === "knockout") return await advanceKnockout(league);
      if (league.format === "survivor") return await advanceSurvivor(league);
      if (league.format === "groups_knockout") {
        return league.final_stage_started ? await advanceKnockout(league) : await advanceGroupsToKnockout(league);
      }
    } finally {
      stageActionInFlight.current.delete(key);
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
  const leaveLeague = (league) => {
    const membership = myMembership(league);
    if (!membership) return;
    requestConfirm([
      `Leave "${league.name}"? This can't be undone.`,
      `Are you sure? You'll lose access to this league.`,
      `Final check — click to leave "${league.name}" for good.`,
    ], async () => {
      const team = membership.team_id ? league.teams.find((t) => t.id === membership.team_id) : null;
      const { error } = await supabase.from("members").delete().eq("id", membership.id);
      if (error) { showToast(`Couldn't leave: ${error.message}`); return; }
      if (team && league.fixtures.length === 0) {
        await supabase.from("teams").delete().eq("id", team.id);
      }
      if (activeLeagueId === league.id) { setView("home"); setActiveLeagueId(null); }
      await loadLeagues();
      showToast(`You left ${league.name}.`);
    });
  };

  const updateLeaguePhoto = async (league, rawFile) => {
    const file = await compressImage(rawFile, { maxDimension: 1000, quality: 0.85 });
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

  // Lets whoever can manage the league (its creator, or an admin) push the
  // entry-close and kickoff dates back — plans change, a WhatsApp group is
  // slow to fill, whatever. Both are required, same as at creation, so a
  // league can never end up with one set and the other blank.
  const updateLeagueSchedule = async (league, { entryClosesAt, startsAt }) => {
    const { error } = await supabase.from("leagues")
      .update({ entry_closes_at: new Date(entryClosesAt).toISOString(), starts_at: new Date(startsAt).toISOString() })
      .eq("id", league.id);
    if (error) { showToast(`Couldn't save dates: ${error.message}`); return; }
    await loadLeagues();
    showToast("League dates updated.");
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
  // voiceClip is { blob, duration } from useVoiceRecorder — optional, same
  // as the photo, and stands alone fine (a voice-only comment with no text).
  const postComment = async (league, body, parentComment = null, file = null, photoUrl = null, isResult = false, voiceClip = null) => {
    const trimmed = (body || "").trim();
    if (!trimmed && !file && !photoUrl && !voiceClip) return;
    const username = profile?.efootball_username || session.user.email;
    let photo_url = photoUrl || null;
    if (!photo_url && file) {
      const compressed = await compressImage(file, { maxDimension: 1600, quality: 0.85 });
      const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("comment-photos").upload(path, compressed);
      if (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return false; }
      const { data: pub } = supabase.storage.from("comment-photos").getPublicUrl(path);
      photo_url = pub.publicUrl;
    }
    let voice_url = null;
    let voice_duration = null;
    if (voiceClip) {
      const ext = (voiceClip.blob.type || "").includes("mp4") ? "m4a" : (voiceClip.blob.type || "").includes("ogg") ? "ogg" : "webm";
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("comment-voice-notes")
        .upload(path, voiceClip.blob, { contentType: voiceClip.blob.type || "audio/webm" });
      if (uploadErr) { showToast(`Couldn't upload voice note: ${uploadErr.message}`); return false; }
      const { data: pub } = supabase.storage.from("comment-voice-notes").getPublicUrl(path);
      voice_url = pub.publicUrl;
      voice_duration = voiceClip.duration || null;
    }
    const { error } = await supabase.from("comments").insert({
      league_id: league.id, user_id: session.user.id, username, body: trimmed,
      parent_comment_id: parentComment?.id || null, photo_url, is_result: isResult,
      voice_url, voice_duration,
    });
    if (error) { showToast(`Couldn't post ${parentComment ? "reply" : "comment"}: ${error.message}`); return false; }
    await loadLeagues();
    return true;
  };

  const deleteComment = (comment, league) => {
    const replyCount = (league?.comments || []).filter((c) => c.parent_comment_id === comment.id).length;
    const noun = comment.parent_comment_id ? "reply" : replyCount > 0 ? `comment and its ${replyCount} repl${replyCount === 1 ? "y" : "ies"}` : "comment";
    requestConfirm([
      `Delete this ${noun}? This can't be undone.`,
      `Are you sure? Once it's gone, it's gone for good.`,
      `Final check — click to permanently delete this ${noun}.`,
    ], async () => {
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
  if (!session) {
    return (
      <>
        <PublicHome c={c} theme={theme} toggleTheme={toggleTheme} accentKey={accentKey} setAccent={setAccent}
          onSignIn={(stay) => signInWithGoogle(stay)}
          onRequireAuth={(reason) => setAuthPrompt(reason)}
          initialShopProductId={shopDeepLinkProductId} />
        {authPrompt && (
          <AuthPromptModal reason={authPrompt} c={c}
            onCancel={() => setAuthPrompt(null)}
            onSignIn={(stay) => signInWithGoogle(stay)} />
        )}
      </>
    );
  }
  if (profile === undefined) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: c.bg }}><Loader c={c} /></div>;
  }
  if (profile === null) return <ProfileGate c={c} theme={theme} toggleTheme={toggleTheme} onSubmit={completeProfile} />;

  // loadRecentResults and loadBoardComments aren't called here even though
  // this is "opening" the screen — the effects that poll them already fire
  // immediately the moment `view` becomes "challenges" (see below), so
  // calling them again here just fired the same two requests twice back to
  // back on every single visit to this screen.
  const openChallengesScreen = () => { setView("challenges"); loadChallengeMembers(); loadChallenges(); loadOpenChallenges(); };
  const openLadderScreen = () => { setView("ladder"); loadLadder(); loadLadderComments(); loadLadderResults(); };

  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center" style={{ background: c.bg }}><Loader c={c} /></div>}>
    <div className="min-h-screen transition-colors duration-200" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      {view !== "shop" && (
        <Header view={view} setView={setView} activeLeague={activeLeague} theme={theme} toggleTheme={toggleTheme} c={c} onSignOut={signOut} userEmail={session.user.email}
          avatarUrl={profile?.avatar_url}
          onEditProfile={() => setEditProfileOpen(true)} isAdmin={isAdmin} onOpenAccounts={() => { setView("accounts"); loadAccounts(); }}
          onOpenChallenges={openChallengesScreen}
          challengeBadge={incomingPendingCount}
          onOpenCreate={() => setView("create")}
          grabbableCount={(openChallenges || []).filter((ch) => ch.status === "open" && ch.creator_id !== session?.user?.id).length}
          onOpenSuggestion={() => setSuggestionOpen(true)} onOpenLeaderboard={() => setView("leaderboard")} onOpenLadder={openLadderScreen} />
      )}
      <main className="max-w-3xl mx-auto px-4 pb-24">
        {view === "accounts" && isAdmin ? (
          <AccountsPanel accounts={accounts} leagues={leagues} session={session} onDelete={deleteAccount} onApprove={approveAccount} onBack={goBack} c={c} />
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
            onAdminApproveResult={adminApproveChallengeResult} onAdminRejectResult={adminRejectChallengeResult}
            onAdminApproveResultOpen={adminApproveOpenChallengeResult} onAdminRejectResultOpen={adminRejectOpenChallengeResult}
            onAdminGrantLadderWalkover={adminGrantLadderWalkover} onAdminCancelLadderChallenge={adminCancelLadderChallenge}
            onViewResultProof={viewChallengeResultProof}
            onSendRandom={sendRandomChallenge} onAcceptOpen={acceptOpenChallenge} onCancelOpen={cancelOpenChallenge} onRemoveOpen={removeOpenChallenge}
            onBack={goBack} showToast={showToast} c={c} />
        ) : leagues === null ? <Loader c={c} /> : (
          <>
            {view === "home" && (
              <Home leagues={leagues} isAdmin={isAdmin} isMemberOf={isMemberOf} entryClosed={entryClosed} myPaymentStatus={myPaymentStatus}
                canManageLeague={canManageLeague} myTeam={myTeam} session={session} onToggleLeagueReaction={toggleLeagueReaction}
                challenges={challenges} openChallenges={openChallenges} onOpenChallenges={openChallengesScreen}
                onOpenLogResult={(ch) => setChallengeResultModal({ kind: "challenge", challenge: ch })}
                onOpenLogResultOpen={(ch) => setChallengeResultModal({ kind: "open", challenge: ch })}
                ladder={ladder} myLadderRank={myLadderRank} onOpenLadder={openLadderScreen} onOpenLeaderboard={() => setView("leaderboard")}
                onOpen={(id, fixtureId) => { setActiveLeagueId(id); setView("league"); if (fixtureId) setPendingLogFixtureId(fixtureId); }}
                onCreate={() => setView("create")} onJoin={startJoin} onOpenShop={() => setView("shop")} memberAvatars={challengeMembers} allAchievements={allAchievements} onAchievementsSynced={loadAllAchievements} myAvatarUrl={profile?.avatar_url} showToast={showToast} c={c} />
            )}
            {view === "create" && <CreateLeague onCancel={goBack} onCreate={createLeague} isAdmin={isAdmin} c={c} />}
            {view === "league" && activeLeague && (
              <LeagueDetail league={activeLeague} session={session} isAdmin={isAdmin} joined={isMemberOf(activeLeague)}
                myUsername={profile?.efootball_username || session.user.email}
                canSeePhones={canSeePhones(activeLeague)} myTeam={myTeam(activeLeague)} entryClosed={entryClosed(activeLeague)}
                myPaymentStatus={myPaymentStatus(activeLeague)}
                blockedByLeague={isMemberOf(activeLeague) ? null : blockingLeagueFor(activeFunLeaguesByKindMap, activeLeague)}
                onBack={goBack} onJoin={() => startJoin(activeLeague.id)}
                onResubmitPayment={(member) => openResubmitPayment(activeLeague, member)}
                onDownloadProof={downloadPaymentProof} onReviewPayment={reviewPayment} onMarkWaReminder={markWaReminder}
                onRecordResult={recordResult} onUpdateTeamPhone={updateTeamPhone} onRemoveTeam={removeTeam} onUpdatePhoto={updateLeaguePhoto} onUpdateDescription={updateLeagueDescription} onUpdateSchedule={updateLeagueSchedule}
                onAdvance={advanceStage} onGenerateFixtures={generateFixtures}
                onDelete={deleteLeague} onShare={shareLeague} onLeave={leaveLeague}
                onOpenSubmitResult={(fixture, homeTeam, awayTeam, existing) => setResultModal({ league: activeLeague, fixture, homeTeam, awayTeam, existing })}
                onDownloadResultProof={downloadResultProof} onApproveResult={approveResult} onRejectResult={rejectResult}
                onRespondToResultSubmission={respondToResultSubmission}
                onPostComment={postComment} onDeleteComment={deleteComment} onToggleReaction={toggleCommentReaction}
                onToggleLeagueReaction={toggleLeagueReaction} avatarByTeamId={teamAvatars} c={c} />
            )}
            {view === "leaderboard" && (
              <Leaderboard leagues={leagues} session={session} memberAvatars={challengeMembers} myAvatarUrl={profile?.avatar_url} onBack={goBack} c={c} />
            )}
            {view === "ladder" && (
              <LadderPage ladder={ladder} myLadderRank={myLadderRank} targets={ladderTargets} session={session}
                onOpenChallenge={() => setLadderChallengeOpen(true)} onBack={goBack}
                onTogglePause={toggleLadderPause}
                comments={ladderComments} isAdmin={isAdmin} myUsername={profile?.efootball_username || session.user.email}
                onPostComment={postLadderComment} onDeleteComment={deleteLadderComment} onToggleCommentReaction={toggleLadderCommentReaction}
                recentMatches={ladderResults}
                challenges={challenges} onAccept={(ch) => respondChallenge(ch, true)} onDecline={(ch) => respondChallenge(ch, false)} onRemove={removeChallenge}
                onOpenLogResult={(ch) => setChallengeResultModal({ kind: "challenge", challenge: ch })}
                onConfirmResult={confirmChallengeResult} onDisputeResult={disputeChallengeResult}
                onViewResultProof={viewChallengeResultProof} showToast={showToast}
                c={c} />
            )}
            {view === "shop" && (
              <Suspense fallback={<Loader c={c} />}>
                <ShopPage c={c} session={session} profile={profile} isAdmin={isAdmin} onBack={goBack} initialProductId={shopDeepLinkProductId} />
              </Suspense>
            )}
            {view === "terms" && (
              <Suspense fallback={<Loader c={c} />}>
                <TermsPage c={c} onBack={goBack} />
              </Suspense>
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
      {activeReferee && <RefereeNotification data={activeReferee} c={c} />}
      <SupportWhatsAppButton context={view === "shop" ? SHOP_NAME : "the Matchday app"} />
      <TermsFooterLink onOpen={() => setView("terms")} c={c} />
    </div>
    </Suspense>
  );
}

// The signed-out homepage. This *is* the site's front door now — visitors can
// scroll the whole thing, see live tables and the ladder, and click around
// freely. Nothing here loads from tables gated to signed-in users; it's all
// public_* views (granted to anon in Supabase). The only thing this screen
// does on its own is offer Google sign-in — every actual action (joining a
// league, sending a challenge, climbing the ladder) is gated by onRequireAuth,
// which the parent turns into the AuthPromptModal.
function PublicHome({ c, theme, toggleTheme, accentKey, setAccent, onSignIn, onRequireAuth, initialShopProductId }) {
  // Accent color (used for primary buttons/highlights throughout this page)
  // is picked from ACCENTS and lives in the app root now — see the comment
  // by accentKey's useState in App() — so whatever a guest picks here is
  // still in effect the moment they sign in, instead of resetting to gold.
  const [accentPickerOpen, setAccentPickerOpen] = useState(false);
  useEffect(() => {
    if (!accentPickerOpen) return;
    const onKey = (e) => { if (e.key === "Escape") setAccentPickerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accentPickerOpen]);
  const [staySignedIn, setStaySignedIn] = useState(true);
  const [shopOpen, setShopOpen] = useState(!!initialShopProductId);
  const [termsOpen, setTermsOpen] = useState(false);
  useEffect(() => {
    if (initialShopProductId) setShopOpen(true);
  }, [initialShopProductId]);

  // Same real-history treatment as the signed-in app (see App()'s appNav
  // effects) — a guest opening the shop and swiping back should land on the
  // homepage, not leave the site.
  const guestShopNavFirstRef = useRef(true);
  useEffect(() => {
    const state = { guestShopOpen: true, shopOpen };
    const cur = window.history.state;
    if (cur && cur.guestShopOpen && cur.shopOpen === shopOpen) return;
    if (guestShopNavFirstRef.current) { guestShopNavFirstRef.current = false; window.history.replaceState(state, ""); return; }
    window.history.pushState(state, "");
  }, [shopOpen]);

  useEffect(() => {
    const onPopState = (e) => {
      const state = e.state;
      if (!state || !("shopOpen" in state) || !state.guestShopOpen) return;
      setShopOpen(!!state.shopOpen);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    document.title = shopOpen ? "Department Store" : "Matchday — eFootball Leagues";
  }, [shopOpen]);
  const ladderRef = useRef(null);
  const tablesRef = useRef(null);
  const activityRef = useRef(null);
  const scrollTo = (ref) => ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Everything a guest can see lives behind public_* views (granted SELECT
  // to anon in Supabase) — loaded once here and handed down as props so the
  // ladder strip, league sections, and activity feed don't each fire their
  // own round trip, and so the HUD stats can be computed from the same data.
  const [guestData, setGuestData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [leaguesRes, teamsRes, fixturesRes, extraRes, ladderRes, resultsRes, teamAvatarsRes] = await Promise.all([
        supabase.from("public_leagues").select("*"),
        supabase.from("public_league_teams").select("*"),
        supabase.from("public_league_fixtures").select("*"),
        supabase.from("public_league_extra").select("*"),
        supabase.from("public_ladder_full").select("*").order("rank_position", { ascending: true }),
        supabase.from("public_challenge_results").select("*").order("result_confirmed_at", { ascending: false }).limit(50),
        // Club-owner photos for the standings tables below — team_id ->
        // avatar_url only (see public_team_avatars view), nothing else about
        // the owning member is exposed to guests.
        supabase.from("public_team_avatars").select("*"),
      ]);
      if (cancelled) return;
      const avatarByTeamId = {};
      (teamAvatarsRes.data || []).forEach((row) => { if (row.avatar_url) avatarByTeamId[row.team_id] = row.avatar_url; });
      setGuestData({
        leagues: leaguesRes.data || [],
        teams: teamsRes.data || [],
        fixtures: fixturesRes.data || [],
        extras: extraRes.data || [],
        ladder: ladderRes.data || [],
        results: resultsRes.data || [],
        avatarByTeamId,
      });
    })();
    return () => { cancelled = true; };
  }, []);

  // Two real products, picked at random, floating on the shop banner below.
  // Fetched once per visit (this effect only ever runs on mount, same as
  // the guestData load above) and re-picked from that fresh list every
  // time — so a guest landing on the page gets a different pair each time,
  // without needing an account or touching the shop itself.
  const [shopPicks, setShopPicks] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("shop_products").select("id, name, price, image_url").not("image_url", "is", null);
      if (cancelled) return;
      const pool = data || [];
      if (pool.length === 0) { setShopPicks([]); return; }
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      setShopPicks(shuffled.slice(0, 2));
    })();
    return () => { cancelled = true; };
  }, []);

  // Guests only ever see non-cash leagues (see the "Leagues" section below) —
  // cash leagues require signing in first. Every guest-facing number (hero
  // stats, empty states) is derived from funLeagues/funLeagueIds so nothing
  // on this page hints that cash leagues exist before sign-in.
  const isCashLeague = (l) => guestData?.extras.find((e) => e.league_id === l.id)?.league_type === "cash";
  const funLeagues = guestData ? guestData.leagues.filter((l) => !isCashLeague(l)) : [];
  const funLeagueIds = new Set(funLeagues.map((l) => l.id));
  const totalClubs = guestData ? guestData.teams.filter((t) => funLeagueIds.has(t.league_id)).length : 0;
  const totalMatches = guestData ? guestData.fixtures.filter((f) => f.played && funLeagueIds.has(f.league_id)).length : 0;

  return (
    <div className="min-h-screen" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      {/* Sticky guest header — same shell language as the signed-in Header,
          minus anything that needs an account. Sign In is always one tap away. */}
      <header className="border-b sticky top-0 backdrop-blur z-40" style={{ borderColor: c.border, background: `${c.bg}F2` }}>
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          {shopOpen ? <div /> : (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded flex items-center justify-center" style={{ background: c.green }}><Trophy size={16} color={c.accent} /></div>
              <div className="text-lg font-extrabold tracking-tight uppercase">Matchday</div>
            </div>
          )}
          <div className="flex items-center gap-2 relative">
            <button onClick={() => setAccentPickerOpen((v) => !v)} aria-label="Choose accent color" aria-haspopup="true" aria-expanded={accentPickerOpen} className="w-8 h-8 flex items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 active:scale-90"
              style={{ background: c.surface, border: `2px solid ${c.accent}` }}>
              <span className="w-3.5 h-3.5 rounded-full" style={{ background: c.accent }} />
            </button>
            {accentPickerOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAccentPickerOpen(false)} />
                <div role="menu" aria-label="Accent color" className="absolute top-10 right-0 z-50 flex items-center gap-1.5 p-2 rounded-full border shadow-lg animate-popover-in" style={{ background: c.bg, borderColor: c.border }}>
                  {Object.entries(ACCENTS).map(([key, opt]) => (
                    <button key={key} role="menuitemradio" aria-checked={key === accentKey} aria-label={opt.label} title={opt.label} onClick={() => { setAccent(key); setAccentPickerOpen(false); }}
                      className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-110"
                      style={{ background: opt[theme].value, border: key === accentKey ? `2px solid ${c.text}` : "2px solid transparent" }}>
                      {key === accentKey && <Check size={11} color={opt[theme].text} strokeWidth={3} />}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button onClick={toggleTheme} aria-label="Toggle dark mode" className="w-8 h-8 flex items-center justify-center rounded-full transition-transform duration-150 hover:scale-110 active:scale-90"
              style={{ background: theme === "dark" ? "#F59E0B22" : "#6366F122" }}>
              {theme === "dark"
                ? <Sun key="sun" size={14} color="#F59E0B" className="animate-theme-icon" />
                : <Moon key="moon" size={14} color="#6366F1" className="animate-theme-icon" />}
            </button>
            <button onClick={() => onSignIn(staySignedIn)} className="flex items-center gap-1.5 px-3.5 h-8 rounded-full font-body text-xs font-semibold" style={{ background: c.accent, color: c.accentText }}>
              <GoogleIcon small /> Sign in
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 pb-24">
        {shopOpen ? (
          <Suspense fallback={<Loader c={c} />}>
            <ShopPage c={c} session={null} profile={null} isAdmin={false} onBack={() => setShopOpen(false)} onRequireAuth={onRequireAuth} initialProductId={initialShopProductId} />
          </Suspense>
        ) : termsOpen ? (
          <Suspense fallback={<Loader c={c} />}>
            <TermsPage c={c} onBack={() => setTermsOpen(false)} />
          </Suspense>
        ) : (
          <>
        <ShopBanner onOpen={() => setShopOpen(true)} picks={shopPicks} onOpenPick={(id) => setShopOpen(true)} c={c} />

        {/* Compact HUD banner — same shell the signed-in Home uses (emblem,
            live-season pulse, stat strip). No CTA button here on purpose:
            this is the "look, it's real and it's live" beat, not the sign-in
            beat — the header covers anyone in a hurry, and the single strong
            CTA lives at the bottom, after there's something to be convinced by. */}
        <section className="relative mt-4 rounded-2xl overflow-hidden" style={{ background: `linear-gradient(120deg, ${c.green}33, ${c.surface})`, border: `1px solid ${c.border}` }}>
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="animate-glow-drift absolute -top-16 -right-10 w-40 h-40 rounded-full blur-3xl" style={{ background: c.accent, opacity: 0.25 }} />
          </div>
          <div className="relative flex items-center gap-3 px-4 py-3.5">
            <img src="/hero-emblem.png" alt="" width="176" height="176" fetchPriority="high" className="w-11 h-11 object-contain shrink-0 drop-shadow-lg" />
            <div className="min-w-0 flex-1">
              <div className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] uppercase" style={{ color: c.accent }}>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full" style={{ background: c.accent }} />
                </span>
                Season 2026 · Live
              </div>
              <div className="font-extrabold uppercase tracking-tight text-lg leading-tight truncate">Run your table. Own your league.</div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="text-right font-mono leading-tight">
                <div className="font-bold text-sm" style={{ color: c.text }}>{guestData ? funLeagues.length : "–"}</div>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>leagues</div>
              </div>
              <div className="w-px h-7" style={{ background: c.border }} />
              <div className="text-right font-mono leading-tight">
                <div className="font-bold text-sm" style={{ color: c.text }}>{totalClubs || "–"}</div>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>clubs</div>
              </div>
              <div className="w-px h-7" style={{ background: c.border }} />
              <div className="text-right font-mono leading-tight">
                <div className="font-bold text-sm" style={{ color: c.text }}>{totalMatches || "–"}</div>
                <div className="text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>played</div>
              </div>
            </div>
          </div>
          <div className="relative px-4 pb-3.5">
            <p className="font-body text-xs" style={{ color: c.textDim }}>Have a look around — everything below is live.</p>
          </div>
        </section>

        {/* Menu tiles — usable ones lead now (Ladder, Leagues both just
            scroll down to real content), so a guest doesn't hit a wall of
            "locked" tiles as the very first thing after the hero. The two
            account-gated tiles (New league, Random) still show, just after,
            as a preview of what unlocks on sign-in rather than the headline. */}
        <section className="grid grid-cols-4 gap-2 mt-4">
          <GuestMenuTile icon={TrendingUp} label="Ladder" onClick={() => scrollTo(ladderRef)} c={c} />
          <GuestMenuTile icon={Gamepad2} label="Leagues" onClick={() => scrollTo(tablesRef)} c={c} />
          <GuestMenuTile icon={Plus} label="New league" locked onClick={() => onRequireAuth("Sign in to create your own league.")} c={c} />
          <GuestMenuTile icon={Shuffle} label="Random" locked onClick={() => onRequireAuth("Sign in to grab a random challenge.")} c={c} />
        </section>

        <div ref={ladderRef}>
          {guestData ? (
            <GuestLadderStrip ladder={guestData.ladder} onClimb={() => onRequireAuth("Sign in to challenge your way up the ladder.")} c={c} />
          ) : <div className="pt-8 flex justify-center"><Loader c={c} /></div>}
        </div>

        <div ref={tablesRef}>
          {guestData && funLeagues.length === 0 && (
            <section className="mt-8">
              <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
                No leagues running yet — sign in and start the first one.
              </div>
            </section>
          )}

          {guestData && (
            <GuestLeagueSection title="Leagues" icon={Gamepad2} leagues={funLeagues} data={guestData}
              onJoin={() => onRequireAuth("Sign in to join this league.")} avatarByTeamId={guestData.avatarByTeamId} c={c} />
          )}
        </div>

        <section ref={activityRef} className="mt-10 pt-8" style={{ borderTop: `1px solid ${c.border}` }}>
          {guestData && (
            <PublicActivityFeed results={guestData.results} c={c} onChallenge={() => onRequireAuth("Sign in to send and receive challenges.")} />
          )}
        </section>

        {/* The one strong CTA on the page — everything above was proof, this
            is the ask. "Stay signed in" lives here too, right next to the
            button it actually affects, instead of floating on its own. */}
        <div className="mt-10 pt-8 border-t flex flex-col items-center text-center" style={{ borderColor: c.border }}>
          <div className="font-body font-semibold text-sm mb-3" style={{ color: c.textDim }}>Ready to get in the game?</div>
          <button onClick={() => onSignIn(staySignedIn)} className="inline-flex items-center gap-3 font-body font-semibold px-6 py-3 rounded-full" style={{ background: c.accent, color: c.accentText }}>
            <GoogleIcon /> Continue with Google
          </button>
          <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
            <span className="relative w-4 h-4 shrink-0 rounded flex items-center justify-center" style={{ background: staySignedIn ? c.accent : "transparent", border: `1px solid ${staySignedIn ? c.accent : c.borderStrong}` }}>
              <input type="checkbox" checked={staySignedIn} onChange={(e) => setStaySignedIn(e.target.checked)} className="absolute inset-0 opacity-0 cursor-pointer" />
              {staySignedIn && <Check size={11} color={c.accentText} strokeWidth={3} />}
            </span>
            <span className="font-body text-xs" style={{ color: c.textDim }}>Stay signed in on this device</span>
          </label>
        </div>
          </>
        )}
      </main>
      <SupportWhatsAppButton context={shopOpen ? SHOP_NAME : "the Matchday app"} />
      <TermsFooterLink onOpen={() => setTermsOpen(true)} c={c} />
    </div>
  );
}

// One equal-weight tile in the guest quick-action grid — same visual as the
// signed-in Home's MenuTile, plus a small lock badge on anything that needs
// an account. Ladder just scrolls down to content that's already public;
// Shop carries an "external" badge instead of a lock since it needs no
// account, it just leaves the app.
function GuestMenuTile({ icon: Icon, label, locked, external, onClick, c }) {
  return (
    <button onClick={onClick} className="relative flex flex-col items-center justify-center gap-1.5 rounded-xl py-3 px-1 font-body"
      style={{ background: c.surface, border: `1px solid ${c.border}` }}>
      {locked && (
        <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.textFaint }}>
          <Lock size={9} />
        </span>
      )}
      {external && (
        <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover, color: c.textFaint }}>
          <ExternalLink size={9} />
        </span>
      )}
      <span className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover }}>
        <Icon size={16} style={{ color: c.accent }} />
      </span>
      <span className="text-[10px] font-semibold text-center leading-tight" style={{ color: c.textDim }}>{label}</span>
    </button>
  );
}

// The "sign in to continue" gate — shown over whatever the guest was just
// looking at, rather than yanking them off to a separate page. Reused for
// every login-gated action (join, challenges, climbing the ladder, creating
// a league) with a short reason line so it's clear what unlocks once they do.
function AuthPromptModal({ reason, c, onCancel, onSignIn }) {
  const [staySignedIn, setStaySignedIn] = useState(true);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl p-6 border flex flex-col items-center text-center" style={{ background: c.bg, borderColor: c.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <button aria-label="Close" onClick={onCancel} className="self-end -mt-2 -mr-2 mb-1" style={{ color: c.textFaint }}><X size={16} /></button>
        <div className="w-11 h-11 rounded-full flex items-center justify-center mb-3" style={{ background: c.surfaceHover }}>
          <Lock size={16} style={{ color: c.accent }} />
        </div>
        <div className="font-body font-bold text-base mb-1">Sign in to continue</div>
        <div className="font-body text-xs mb-5" style={{ color: c.textDim }}>{reason}</div>
        <button onClick={() => onSignIn(staySignedIn)} className="flex items-center gap-3 font-body font-semibold px-6 py-3 rounded-full mb-3" style={{ background: c.accent, color: c.accentText }}>
          <GoogleIcon /> Continue with Google
        </button>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="relative w-4 h-4 shrink-0 rounded flex items-center justify-center" style={{ background: staySignedIn ? c.accent : "transparent", border: `1px solid ${staySignedIn ? c.accent : c.borderStrong}` }}>
            <input type="checkbox" checked={staySignedIn} onChange={(e) => setStaySignedIn(e.target.checked)} className="absolute inset-0 opacity-0 cursor-pointer" />
            {staySignedIn && <Check size={11} color={c.accentText} strokeWidth={3} />}
          </span>
          <span className="font-body text-xs" style={{ color: c.textDim }}>Stay signed in on this device</span>
        </label>
      </div>
    </div>
  );
}

// The ladder for guests — visually identical to the signed-in Home's
// LadderStrip (same horizontally-scrolling chips, same rank medals), just
// swapping the "You're #N" shortcut for a locked "Climb it" prompt since
// there's no signed-in member to rank. Reads from public_ladder_full (all
// ranks; granted to anon), passed down already loaded from PublicHome.
function GuestLadderStrip({ ladder, onClimb, c }) {
  if (!ladder || ladder.length === 0) return null;
  const top5 = ladder.slice(0, 5);
  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  return (
    <section className="pt-5">
      <div className="flex items-center justify-between mb-2.5">
        <div className="font-mono text-[11px] tracking-[0.25em] uppercase flex items-center gap-1.5" style={{ color: c.textFaint }}>
          <TrendingUp size={12} /> The Ladder
        </div>
        <button onClick={onClimb} className="font-mono text-[11px] uppercase tracking-wider flex items-center gap-1 shrink-0" style={{ color: c.accent }}>
          <Lock size={10} /> {ladder.length} climbing
        </button>
      </div>
      <div className="no-scrollbar flex items-stretch gap-2.5 overflow-x-auto -mx-4 px-4 pb-1">
        {top5.map((row, i) => (
          <div key={row.user_id} className="flex items-center gap-2 shrink-0 rounded-xl pl-2 pr-3.5 py-2"
            style={{
              background: i === 0 ? `linear-gradient(135deg, ${c.accent}26, ${c.surface})` : c.surface,
              border: `1px solid ${i === 0 ? c.accent + "55" : c.border}`,
            }}>
            {i < 3 ? (
              <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${rankColors[i]}22`, border: `1px solid ${rankColors[i]}66` }}>
                {i === 0 ? <Crown size={13} style={{ color: rankColors[0] }} /> : <Medal size={13} style={{ color: rankColors[i] }} />}
              </span>
            ) : (
              <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 font-mono text-xs font-bold" style={{ background: c.surfaceHover, color: c.textFaint }}>
                {i + 1}
              </span>
            )}
            <div className="flex flex-col leading-tight">
              <span className="font-body font-semibold text-sm truncate max-w-[110px]">{row.username}</span>
              <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{row.points}pts · {row.wins}W–{row.losses}L</span>
            </div>
          </div>
        ))}
        <button onClick={onClimb} className="flex items-center gap-1.5 shrink-0 font-mono text-[11px] rounded-xl px-3"
          style={{ color: c.accent, background: c.surfaceHover, border: `1px dashed ${c.borderStrong}` }}>
          <Lock size={11} /> {ladder.length > 5 ? "See full ladder" : "Climb it"}
        </button>
      </div>
    </section>
  );
}

// Platform-wide "who just played" feed for guests — reuses the exact same
// CommunityResultRow the signed-in Challenges screen uses, fed from
// public_challenge_results (granted to anon; already existed for the
// signed-in feed, this just drops the session check). myId is always null
// here since there's no signed-in member to highlight rows for.
function PublicActivityFeed({ results, c, onChallenge }) {
  if (!results || results.length === 0) return null;
  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>
          <History size={12} /> Recent activity
        </div>
        <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>{results.length} shown</div>
      </div>
      <div className="font-body text-xs mb-3" style={{ color: c.textDim }}>Confirmed challenge results across Matchday, most recent first.</div>
      <div className="flex flex-col gap-1.5 max-h-[24rem] overflow-y-auto pr-0.5">
        {results.map((r) => <CommunityResultRow key={`${r.kind}-${r.id}`} result={r} myId={null} c={c} />)}
      </div>
      {onChallenge && (
        <div className="flex justify-center mt-3">
          <button onClick={onChallenge} className="flex items-center gap-1.5 font-body text-xs font-semibold px-3.5 py-1.5 rounded-full" style={{ background: c.surface, border: `1px solid ${c.border}`, color: c.textDim }}>
            <Lock size={11} /> Sign in to send a challenge
          </button>
        </div>
      )}
    </div>
  );
}

// A section of league previews for guests — same header format as the
// signed-in Home's LeagueSection (icon badge, title, count pill), but
// stacked full-width standings previews instead of a horizontal card
// carousel, since there's no detail page for a guest to tap through to.
function GuestLeagueSection({ title, icon: Icon, leagues, data, onJoin, avatarByTeamId, c }) {
  if (leagues.length === 0) return null;
  return (
    <section className="mt-8 first:mt-0">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, border: `1px solid ${c.border}` }}><Icon size={15} style={{ color: c.accent }} /></span>
        <div className="font-extrabold uppercase tracking-tight text-lg leading-none flex items-center gap-2">
          {title}
          <span className="font-mono text-[10px] font-normal tracking-wider px-1.5 py-0.5 rounded" style={{ background: c.surfaceHover, color: c.textFaint }}>{leagues.length}</span>
        </div>
      </div>
      <div className="space-y-4">
        {leagues.map((l) => <PublicLeagueCard key={l.id} league={l} data={data} onJoin={onJoin} avatarByTeamId={avatarByTeamId} c={c} />)}
      </div>
    </section>
  );
}


function PublicLeagueCard({ league: l, data, onJoin, avatarByTeamId, c }) {
  const [showAllMatches, setShowAllMatches] = useState(false);
  const extra = data.extras.find((e) => e.league_id === l.id);
  const leagueTeams = data.teams.filter((t) => t.league_id === l.id);
  const allLeagueFixtures = data.fixtures.filter((f) => f.league_id === l.id);
  const isStaged = l.format === "survivor" || l.format === "groups_knockout";
  const leagueFixtures = allLeagueFixtures.filter((f) => !isStaged || f.stage === l.current_stage);
  const inGroupStage = l.format === "groups_knockout" && !l.final_stage_started;
  const teamName = (id) => leagueTeams.find((t) => t.id === id)?.name || "TBD";

  // Guests should never receive a cash league here at all (see funLeagues
  // in PublicHome), so no cash badge on the header — the description guard
  // below is a defensive backstop, not something guests normally hit.
  const header = (
    <div className="flex items-center justify-between mb-3 gap-2">
      <div className="min-w-0">
        <div className="font-semibold text-sm truncate">{l.name}</div>
      </div>
      {onJoin && (
        <button onClick={onJoin} className="flex items-center gap-1 font-body text-[10px] font-semibold px-2.5 py-1 rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textDim }}>
          <Lock size={9} /> Join
        </button>
      )}
    </div>
  );

  // Belt-and-suspenders, matching how this codebase double-checks
  // cash-league restrictions elsewhere: guests should never receive a cash
  // league here at all (see funLeagues in PublicHome), but descriptions
  // often contain banking/EFT details for cash leagues specifically, so
  // this still refuses to render one even if that filtering were ever
  // bypassed upstream.
  const photoAndDescription = extra?.photo_url && (
    <div className="mb-3 -mt-1">
      <img src={extra.photo_url} alt="" className="w-full h-32 object-cover rounded-lg mb-2" />
    </div>
  );

  const allMatchesToggle = allLeagueFixtures.length > 0 && (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: c.border }}>
      <button onClick={() => setShowAllMatches((v) => !v)} className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>
        {showAllMatches ? "Hide match history" : `View all matches (${allLeagueFixtures.length})`} <ChevronDown size={11} style={{ transform: showAllMatches ? "rotate(180deg)" : "none" }} />
      </button>
      {showAllMatches && (
        <div className="flex flex-col gap-1 mt-2.5 max-h-72 overflow-y-auto pr-0.5">
          {allLeagueFixtures.map((f) => (
            <div key={f.id} className="flex items-center justify-between gap-2 font-body text-xs px-2 py-1.5 rounded" style={{ background: c.surfaceHover }}>
              <span className="truncate flex-1 text-right" style={{ color: f.played && f.home_score > f.away_score ? c.text : c.textFaint, fontWeight: f.played && f.home_score > f.away_score ? 600 : 400 }}>{teamName(f.home_team_id)}</span>
              <span className="font-mono text-[11px] shrink-0" style={{ color: c.textFaint }}>{f.played ? `${f.home_score}–${f.away_score}` : "vs"}</span>
              <span className="truncate flex-1" style={{ color: f.played && f.away_score > f.home_score ? c.text : c.textFaint, fontWeight: f.played && f.away_score > f.home_score ? 600 : 400 }}>{teamName(f.away_team_id)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (inGroupStage) {
    if (leagueTeams.length === 0) return null;
    return (
      <div className="rounded-xl border p-4" style={{ borderColor: c.border, background: c.surface }}>
        {header}
        {photoAndDescription}
        <GroupTables league={{ ...l, teams: leagueTeams }} groupStageFixtures={leagueFixtures} avatarByTeamId={avatarByTeamId} c={c} />
        {allMatchesToggle}
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
    <div className="rounded-xl border p-4" style={{ borderColor: c.border, background: c.surface }}>
      {header}
      {photoAndDescription}
      <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={leagueFixtures}
        isSurvivor={l.format === "survivor"} league={l} avatarByTeamId={avatarByTeamId} c={c} />
      {allMatchesToggle}
    </div>
  );
}

function GoogleIcon({ small }) {
  const size = small ? 13 : 18;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.87-3.04.87-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z" />
      <path fill="#FBBC05" d="M3.97 10.73a5.4 5.4 0 010-3.46V4.94H.96a9 9 0 000 8.12l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 00.96 4.94l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

// Full-width promo banner for the WeAfrica Shop — sits above everything
// else on both the login page and Home, so it reads as top billing rather
// than one more icon buried in the menu grid. Deliberately in gold, not the
// app's green, so it registers as a store placement rather than another
// screen inside the app. The whole card is a tap target (not just the
// pill), open to guests and members alike since browsing the store needs no
// account.
function ShopBanner({ onOpen, picks, onOpenPick, c }) {
  const hasPicks = picks && picks.length > 0;
  return (
    <section onClick={onOpen} className="relative mt-4 rounded-2xl overflow-hidden cursor-pointer active:scale-[0.98] transition-transform"
      style={{ background: `linear-gradient(120deg, ${SHOP_GOLD}2E, ${c.surface})`, border: `1px solid ${SHOP_GOLD}55` }}>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-glow-drift absolute -top-14 -right-8 w-36 h-36 rounded-full blur-3xl" style={{ background: SHOP_GOLD, opacity: 0.22 }} />
        {!hasPicks && (
          /* Small "products" bobbing and glowing in the banner's corner —
             purely decorative fallback shown only while the real picks
             below are loading, or if the shop has nothing with a photo yet. */
          <>
            <ShoppingBag size={13} className="animate-product-float absolute top-2.5 right-20" style={{ color: SHOP_GOLD, animationDelay: "0s" }} />
            <Shirt size={15} className="animate-product-float absolute top-8 right-9" style={{ color: SHOP_GOLD, animationDelay: "0.5s" }} />
            <Package size={12} className="animate-product-float absolute bottom-2.5 right-16" style={{ color: SHOP_GOLD, animationDelay: "1s" }} />
          </>
        )}
      </div>
      {SHOP_PROMO_ACTIVE && (
        <span className="absolute top-2.5 right-2.5 font-mono text-[10px] font-bold tracking-[0.1em] uppercase px-2 py-1 rounded-full shadow-sm"
          style={{ background: "#E8433D", color: "#fff" }}>
          {SHOP_PROMO_TEXT}
        </span>
      )}
      <div className="relative flex items-center gap-3 px-4 py-3.5">
        <span className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${SHOP_GOLD}22`, border: `1px solid ${SHOP_GOLD}55` }}>
          <ShoppingBag size={20} style={{ color: SHOP_GOLD }} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] tracking-[0.2em] uppercase" style={{ color: SHOP_GOLD }}>Official store</div>
          <div className="font-extrabold uppercase tracking-tight text-lg leading-tight truncate">{SHOP_NAME}</div>
          <div className="font-body text-xs truncate" style={{ color: c.textDim }}>Kits, jerseys & gear — open to everyone</div>
        </div>
        <span className="flex items-center gap-1.5 shrink-0 font-body text-xs font-semibold px-3.5 py-2 rounded-full" style={{ background: SHOP_GOLD, color: "#1a1200" }}>
          Shop now <ChevronRight size={12} />
        </span>
      </div>
      {hasPicks && (
        // Two real products, picked at random on every visit (see
        // PublicHome) — bobbing hexagon badges instead of generic icon
        // glyphs, so this reads as "here's what's actually in stock right
        // now" rather than a static ad. A fresh pair shows up each time
        // someone lands on the login page.
        <div className="relative flex items-center gap-3 px-4 pb-3.5 pt-1">
          <span className="font-mono text-[9px] uppercase tracking-wider shrink-0" style={{ color: c.textFaint }}>Fresh in store</span>
          <div className="flex items-center gap-4 ml-auto pr-1">
            {picks.map((p, i) => (
              <button key={p.id} onClick={(e) => { e.stopPropagation(); onOpenPick?.(p.id); }}
                className="animate-pick-bob flex flex-col items-center"
                style={{ animationDelay: i === 0 ? "0s" : "0.9s" }}>
                <span className="animate-pick-ring hex-clip w-11 h-11 overflow-hidden flex items-center justify-center"
                  style={{ "--pick-ring": SHOP_GOLD, background: c.surface }}>
                  <img src={p.image_url} alt={p.name} className="w-full h-full object-cover" />
                </span>
                <span className="font-mono text-[8px] font-bold mt-1 px-1.5 py-0.5 rounded-full whitespace-nowrap"
                  style={{ background: SHOP_GOLD, color: "#1a1200" }}>
                  {formatRand(p.price)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ProfileGate({ c, theme, toggleTheme, onSubmit }) {
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const fileInputRef = useRef(null);
  const usernameTrimmed = username.trim();
  const usernameIsOneWord = usernameTrimmed.length > 0 && !/\s/.test(usernameTrimmed);
  const valid = phone.trim().startsWith("+") && phone.trim().length >= 8 && usernameTrimmed.length >= 2 && usernameIsOneWord && agreedToTerms;

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
        <label className="flex items-start gap-2.5 mb-5 cursor-pointer">
          <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)}
            className="mt-0.5 w-4 h-4 shrink-0 rounded" style={{ accentColor: c.accent }} />
          <span className="font-body text-xs" style={{ color: c.textDim }}>
            I'm 18 or older and I agree to the{" "}
            <button type="button" onClick={() => setTermsOpen(true)} className="underline font-semibold" style={{ color: c.text }}>
              Terms &amp; Conditions
            </button>, including how cash league entry fees, prize pools, and results work.
          </span>
        </label>
        <button disabled={!valid || submitting} onClick={submit}
          title={!agreedToTerms ? "Agree to the Terms & Conditions to continue" : undefined}
          className="w-full font-body font-semibold px-4 py-3 rounded-full"
          style={valid ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {submitting ? "Saving..." : "Continue to Matchday"}
        </button>
      </div>
      <SupportWhatsAppButton />
      {termsOpen && (
        <div className="fixed inset-0 z-[60] overflow-y-auto" style={{ background: c.bg }}>
          <div className="max-w-3xl mx-auto px-4">
            <Suspense fallback={<Loader c={c} />}>
              <TermsPage c={c} onBack={() => setTermsOpen(false)} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}

