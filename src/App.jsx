import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from "react";
import { supabase, setStaySignedInPreference, clearAllAuthStorage } from "./supabaseClient";
import { logActivity } from "./activityLog";
import { compressImage } from "./utils/imageCompress";
import { proxiedSignedUrl, toProxiedUrl } from "./utils/mediaUrl";
import { uploadToBlob } from "./utils/blobUpload";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import NetsBadge from "./NetsBadge.jsx";
import { creditNets, formatNets } from "./nets.js";
// Lazy-loaded rather than imported directly: Shop.jsx alone is well over a
// thousand lines, and neither it nor the Terms page is needed for the
// initial render — bundling them in eagerly meant every single visitor
// downloaded and parsed that code up front even if they never open the
// shop or read the terms. Splitting them into their own chunks (Vite does
// this automatically for a dynamic import()) shrinks the JS the browser
// has to fetch and parse before the app is interactive.
const ShopPage = lazy(() => import("./Shop.jsx"));
const TransferMarketPage = lazy(() => import("./TransferMarket.jsx"));
const TermsPage = lazy(() => import("./Terms.jsx"));
// RulesModal carries its own ~500-line static rules text (league/ladder/
// challenge reference content) that only a fraction of visitors ever open —
// lazy-loading it the same way keeps that text out of everyone else's
// initial download.
const RulesModal = lazy(() => import("./Rules.jsx"));
// LeagueDetail is the biggest single screen in the app (standings, fixtures,
// comments, payments, admin controls) and is only ever opened by a signed-in
// user tapping into a specific league — never on the guest/login page — so
// it's split out the same way.
const LeagueDetail = lazy(() => import("./LeagueDetail.jsx"));
// ChallengesScreen (community board + open/1-on-1 challenges + chat) is
// similarly only opened by a signed-in user from the header menu.
const ChallengesScreen = lazy(() => import("./ChallengesScreen.jsx"));
// CreateLeague (the "start a new league" form) is only ever opened by a
// signed-in admin/organizer starting a league - never on first load, and
// never by most visitors at all. Lazy-loaded the same way.
const CreateLeague = lazy(() => import("./CreateLeague.jsx"));
// Leaderboard (the platform-wide rankings) is only opened by a signed-in
// user tapping into it from the header or the home screen preview strip -
// never on first load. Lazy-loaded the same way. (GoalExtremesBar and
// rankLeaderboard stay behind in App.jsx and are exported instead, since
// StandingsPanel and the home screen's LeaderboardStrip preview also need
// them.)
const LeaderboardPage = lazy(() => import("./Leaderboard.jsx"));
// Ladder (the platform-wide permanent ladder) is only opened by a signed-in
// user tapping into it from the header or the home screen's LadderStrip
// preview - never on first load. Lazy-loaded the same way. (LADDER_THEME
// stays behind in App.jsx and is exported instead, since LadderStrip also
// needs it; ShareRangeModal stays behind and is exported since StandingsPanel
// also needs it.)
const LadderPage = lazy(() => import("./Ladder.jsx"));
import { pickBestVoice } from "./utils/pickBestVoice";
// Step 9 (opponent slate + challenge flow) is the first place App.jsx
// itself needs the pure engine. Home/away assignment now
// happens server-side inside initiate_ladder_cup_match (see
// supabase/migrations/20260815_ladder_cup_match_rpc.sql), so the pure
// engine's assignHomeTeam isn't imported here anymore — it's still used
// by the RPC's own logic, mirrored in SQL rather than called from JS.
// rankLadderCupStandings/getOpponentPool stay imported where they're
// actually consumed (LeagueDetail.jsx) rather than duplicated here.
import { rankLadderCupStandings, recordLadderCupWin, resolveMatchWinner, acceptSecondLife, declineOrExpireSecondLife, createWalkoverClaim, isWalkoverClaimable, approveWalkoverClaim, rejectWalkoverClaim, finalizeAtCutoff, crownChampion, hasLadderCupCutoffPassed, createLadderCupEntry, reborn, rebirthAnnouncement, hasMissedJoinContactWindow, LADDER_CUP_RULES } from "./formats/ladderCup.js";
import {
  Trophy, Plus, Users, Calendar, ChevronRight, X, Check,
  ArrowLeft, Settings2, Moon, Sun, LogOut, Lock, Crown, Layers, Share2, Trash2, Clock, Info,
  Wallet, Upload, Download, CheckCircle2, XCircle, ReceiptText, Shield, Copy, MessageCircle, Search, AlertTriangle,
  MoreVertical, Send, CornerDownRight, Camera, Eye, ThumbsUp, ThumbsDown, Target, ChevronDown, History, Shuffle,
  TrendingUp, Swords, Volume2, Pause, Play, Square, Mic, Phone, Gamepad2, Medal,
  ShoppingBag, ExternalLink, Shirt, Package, Menu, Star, Flame, Award, Sparkles, Coins,
  Zap, Repeat, Rocket, CreditCard,
} from "lucide-react";

const THEME_KEY = "efootball-theme-v1";
const ACCENT_KEY = "efootball-accent-v1";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_ROUND_PERIOD_HOURS = 48;
// A two-legged (home & away) knockout tie always gets a fixed 4-day window
// to play both matches, regardless of whatever the league's own
// round_period_hours is set to for single-leg fixtures. It used to be
// derived as roundPeriodMs(league) * 2 — but that silently gave ties a
// shorter (or longer) window than 4 days whenever a league's round period
// was configured to something other than the 48-hour default, since that
// setting was never meant to double as the two-legged tie window too.
export const KNOCKOUT_TIE_WINDOW_MS = 4 * ONE_DAY_MS;
// Older leagues created before this setting existed have no round_period_hours
// column value — fall back to the original fixed 48-hour (2-day) gap so their
// schedules don't shift.
function roundPeriodMs(league) {
  const hours = league?.round_period_hours;
  return (typeof hours === "number" && hours > 0 ? hours : DEFAULT_ROUND_PERIOD_HOURS) * ONE_HOUR_MS;
}

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
export const ENTRY_FEE_MIN = 10;
export const ENTRY_FEE_MAX = 200;
const ENTRY_FEE_STEP = 10;
const ENTRY_FEE_PRESETS = [10, 20, 50, 100, 150, 200];
export const formatRand = (n) => `R${Number(n).toLocaleString("en-ZA")}`;

// "Cards accepted" indicator for the card payment option — renders the
// Mastercard/Visa logo image the site owner supplies at
// /public/card-brands.png (drop the real file in yourself; nothing here
// reproduces the artwork).
function CardBrandsBadge({ c }) {
  return <img src="/card-brands.png" alt="Mastercard, Visa" className="h-5 w-auto object-contain" />;
}

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

// iKhokha Pay-by-Link — a hosted checkout page someone can pay into with a
// card, no bank app or reference number needed. Chosen over a static QR
// image or a Pay-by-Proxy number because it's just a URL: it drops straight
// into the same "here are your options" card as the bank/Mukuru details
// below with no extra image asset, and works the same whether someone taps
// it on their phone or a desktop.
// TODO: replace payLink with your real iKhokha Pay-by-Link URL (generate
// one from the iKhokha merchant dashboard or app — Payment Links / Pay by
// Link). Left blank for now so the option is hidden until it's set — see
// the `IKHOKHA_DETAILS.payLink &&` check in PaymentModal below.
const IKHOKHA_DETAILS = {
  payLink: "https://pay.ikhokha.com/weafrica/mpr/weafrica",
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
export const LADDER_THEME = {
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
export const FORMATS = [
  { id: "single_round_robin", label: "Single Round Robin", kind: "round_robin", desc: "Every club plays every other club once.", available: true },
  { id: "double_round_robin", label: "Double Round Robin", kind: "round_robin", desc: "Home and away — every club plays every other club twice.", available: true },
  { id: "knockout", label: "Knockout", kind: "knockout", desc: "Single elimination. Lose and you're out.", available: true },
  { id: "survivor", label: "Survivor", kind: "round_robin", desc: "Play a set number of matches, cut the bottom %, repeat until a target number remain, then finish with a round robin.", available: true },
  { id: "groups_knockout", label: "Groups + Knockout", kind: "groups_knockout", desc: "Split into groups for a round robin, then top clubs advance to a knockout stage.", available: true },
  // Own `kind` (not "round_robin") so it doesn't interact with the
  // one-active-fun-league-per-kind join lock the other formats share —
  // ladder cup's challenge-based flow is different enough that stacking
  // it against round robin/survivor activity doesn't make sense.
  // Step 7: CreateLeague now has a cutoff picker and league/join creation
  // builds ladder_cup_entries rows (see createLeague/ensureLadderCupEntry
  // below), so this is selectable. Standings (Step 8) and the challenge
  // board (Step 9) still aren't wired up — LeagueDetail shows a holding
  // panel (LadderCupPendingPanel) for ladder_cup leagues until then.
  { id: "ladder_cup", label: "Survival Ladder Cup", kind: "ladder_cup", desc: "Ranked ladder, one elimination life each. Most points by the Sunday cutoff wins.", available: true },
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
  return !isLeagueCompleted(l);
}

// Recomputes a knockout bracket's most recent round to figure out whether
// it's already down to a single winner — mirroring advanceKnockout's own
// tie-resolution rules (aggregate score, no-show forfeits, final-round
// penalties) so this agrees with what the "Advance round" button and its
// "this league already has a champion" check already conclude.
//
// This deliberately does NOT rely on team.eliminated: applyKnockoutElimination
// only ever updates that flag once every leg of a tie is either played or
// expired — a tie with one leg actually played and the other simply expiring
// unplayed (nobody ever submits anything for it) never re-triggers that
// function again after the fact, since nothing about it is event-driven once
// time alone is what resolves it. team.eliminated can stay stuck stale on a
// finished bracket's runner-up indefinitely as a result — recomputing from
// the fixtures directly is what actually stays correct.
export function knockoutBracketWinners(fixtures, bracketStage) {
  const bracketFixtures = (fixtures || []).filter((f) => f.stage === bracketStage);
  if (bracketFixtures.length === 0) return null;
  const maxRound = Math.max(...bracketFixtures.map((f) => f.round));
  const currentRoundFixtures = bracketFixtures.filter((f) => f.round === maxRound);
  const unplayed = currentRoundFixtures.filter((f) => !f.played && !isExpired(f));
  if (unplayed.length > 0) return null; // this round's still in progress

  const ties = {};
  currentRoundFixtures.forEach((f) => {
    const key = f.away_team_id === null ? `bye-${f.home_team_id}` : [f.home_team_id, f.away_team_id].sort().join("~");
    (ties[key] = ties[key] || []).push(f);
  });
  const isFinal = isFinalRoundFixtures(currentRoundFixtures);
  const winners = [];
  Object.values(ties).forEach((legs) => {
    if (legs[0].away_team_id === null) { winners.push(legs[0].home_team_id); return; }
    const totals = {};
    legs.forEach((f) => {
      // An expired-unplayed leg contributes nothing to either side's
      // aggregate (same no-points, no-winner treatment computeStandings
      // already gives it) — so a tie with one leg genuinely played still
      // resolves off that leg's real score rather than staying stuck.
      totals[f.home_team_id] = (totals[f.home_team_id] || 0) + (f.played ? f.home_score : 0);
      totals[f.away_team_id] = (totals[f.away_team_id] || 0) + (f.played ? f.away_score : 0);
    });
    const [teamA, teamB] = Object.keys(totals);
    if (totals[teamA] === totals[teamB]) {
      const allLegsNoShow = legs.every((f) => !f.played && isExpired(f));
      if (allLegsNoShow) return; // both sides knocked out — neither is a winner
      if (!isFinal) { winners.push(teamA, teamB); return; }
      const pensA = pensAggregateFor(legs, teamA);
      const pensB = pensAggregateFor(legs, teamB);
      if (pensA !== null && pensB !== null && pensA !== pensB) { winners.push(pensA > pensB ? teamA : teamB); return; }
      return; // final still needs a penalty score entered — not decided yet
    }
    winners.push(totals[teamA] > totals[teamB] ? teamA : teamB);
  });
  return winners;
}

// General "is this league over" check across every format — used to move a
// league out of the current-leagues sections and into Completed Leagues.
// Deliberately mirrors the same signals LeagueDetail.jsx already uses to
// decide when to show a champion banner for each format, rather than a
// single generic "every fixture played" check — that check alone misses
// knockout/groups+knockout leagues, since a bracket can finish (one club
// standing) while irrelevant fixtures elsewhere in the tree — especially
// group-stage fixtures that stopped mattering once a club advanced or was
// eliminated — never get marked played themselves. isExpired auto-forfeit
// fixtures also count as resolved here, same as the champion banners do.
function isLeagueCompleted(l) {
  if (l.format === "ladder_cup") return !!l.ladder_cup_finalized_at;

  const teams = l.teams || [];
  const fixtures = l.fixtures || [];
  const isKnockout = l.format === "knockout";
  const isGroupsKnockout = l.format === "groups_knockout";
  const isSurvivor = l.format === "survivor";
  const inKnockoutBracket = isKnockout || (isGroupsKnockout && l.final_stage_started);

  if (inKnockoutBracket) {
    const bracketStage = isGroupsKnockout ? 2 : 1;
    const winners = knockoutBracketWinners(fixtures, bracketStage);
    return teams.length > 0 && winners !== null && winners.length <= 1;
  }

  if (isSurvivor) {
    if (!l.final_stage_started) return false;
    const stageFixtures = fixtures.filter((f) => f.stage === l.current_stage);
    return stageFixtures.length > 0 && stageFixtures.every((f) => f.played || isExpired(f));
  }

  // Single/double round robin — and groups_knockout still mid group-stage,
  // which by definition isn't complete yet either way.
  return fixtures.length > 0 && fixtures.every((f) => f.played || isExpired(f));
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
export function groupLabel(n) {
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

// dueBase: Date the clock starts counting from. Each round gets +periodMs on top of the previous
// (periodMs defaults to the original fixed 2-day gap when not given).
function toFixtureRows(leagueId, rounds, stage, dueBase, roundOffset = 0, periodMs = TWO_DAYS_MS, isWeekend = false) {
  const rows = [];
  rounds.forEach((round, ri) => {
    const roundNumber = ri + 1 + roundOffset;
    const dueAt = addPausableDuration(dueBase, roundNumber * periodMs, isWeekend).toISOString();
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
// A round that pairs down to exactly one real matchup IS the final — it's
// always played as a single decisive match, regardless of the league's
// home/away legs setting, since a drawn final goes to penalties instead of
// a second leg (see isFinalRoundFixtures / advanceKnockout).
// dueOffset controls how many periodMs get added to dueBase for THIS round's
// due date — defaults to roundNumber so existing callers that pass a fixed
// anchor date (the league's start date, or a bracket's start date) and let
// roundNumber climb 1, 2, 3... keep working unchanged. Callers that instead
// reset dueBase to "right now" every time a round advances (see
// advanceKnockout) need to pass dueOffset: 1 explicitly — otherwise the
// round's real number (2, 3, 4...) gets used as the multiplier against
// "now," pushing each new round's deadline further and further out instead
// of the intended one-period gap from whenever it was actually generated.
export function knockoutRoundFixtures(leagueId, teamIds, stage, roundNumber, dueBase, legs, periodMs = TWO_DAYS_MS, dueOffset = roundNumber, isWeekend = false) {
  const pairs = knockoutRound1(teamIds);
  const isFinalRound = pairs.length === 1 && pairs[0].away !== null;
  if (isFinalRound) legs = 1;
  const singleLegDue = addPausableDuration(dueBase, dueOffset * periodMs, isWeekend);
  // Two-legged ties share ONE deadline covering both matches — double the
  // normal single-round window (e.g. 4 days instead of 2) — instead of each
  // leg getting its own separate due date. Either leg can be played any
  // time within that shared window; the tie only counts as expired once
  // this one date passes.
  const tieDue = addPausableDuration(dueBase, dueOffset * KNOCKOUT_TIE_WINDOW_MS, isWeekend);
  // starts_at records the round's real start moment directly, rather than
  // making the UI reconstruct it later by subtracting the window back off
  // due_at. That reconstruction silently goes wrong the moment due_at is
  // ever adjusted after creation (a dispute extension, a manual edit) —
  // storing the true start here means the display never has to guess it.
  const startsAt = dueBase.toISOString();
  const rows = [];
  pairs.forEach(({ home, away }) => {
    const bye = away === null;
    if (bye || legs !== 2) {
      rows.push({
        league_id: leagueId, round: roundNumber, leg: 1, stage,
        home_team_id: home, away_team_id: away,
        played: bye, home_score: bye ? 1 : 0, away_score: 0,
        due_at: singleLegDue.toISOString(), starts_at: startsAt,
      });
    } else {
      rows.push({
        league_id: leagueId, round: roundNumber, leg: 1, stage,
        home_team_id: home, away_team_id: away,
        played: false, home_score: 0, away_score: 0,
        due_at: tieDue.toISOString(), starts_at: startsAt,
      });
      rows.push({
        league_id: leagueId, round: roundNumber, leg: 2, stage,
        home_team_id: away, away_team_id: home,
        played: false, home_score: 0, away_score: 0,
        due_at: tieDue.toISOString(), starts_at: startsAt,
      });
    }
  });
  return rows;
}

function generateOpeningFixtures(league, teamIds, dueBase) {
  const { id: leagueId, format, survivor_matches_per_stage, survivor_target_count, survivor_final_format, group_size, knockout_legs } = league;
  const periodMs = roundPeriodMs(league);
  // Weekend leagues get deadlines that skip over the nightly 9pm-9am SAST
  // pause (see addPausableDuration) — every fixture-row builder below is
  // given this so every format respects it consistently.
  const isWeekend = isWeekendLeague(league);
  if (format === "single_round_robin") return { fixtureRows: toFixtureRows(leagueId, roundRobin(teamIds), 1, dueBase, 0, periodMs, isWeekend), startsInFinal: false, groups: null };
  if (format === "double_round_robin") return { fixtureRows: toFixtureRows(leagueId, doubleRoundRobin(teamIds), 1, dueBase, 0, periodMs, isWeekend), startsInFinal: false, groups: null };
  if (format === "knockout") return { fixtureRows: knockoutRoundFixtures(leagueId, teamIds, 1, 1, dueBase, knockout_legs || 1, periodMs, undefined, isWeekend), startsInFinal: false, groups: null };
  if (format === "survivor") {
    if (teamIds.length <= survivor_target_count) {
      return { fixtureRows: toFixtureRows(leagueId, finalStageSchedule(teamIds, survivor_final_format), 1, dueBase, 0, periodMs, isWeekend), startsInFinal: true, groups: null };
    }
    return { fixtureRows: toFixtureRows(leagueId, stageSchedule(teamIds, survivor_matches_per_stage), 1, dueBase, 0, periodMs, isWeekend), startsInFinal: false, groups: null };
  }
  if (format === "groups_knockout") {
    // Groups are sized to the admin's chosen "players per group" — the number of
    // groups this actually produces depends on how many clubs are in by the time
    // the league starts, so it's worked out here rather than fixed up front.
    const desiredSize = Math.max(2, group_size || 4);
    const groupsCount = Math.max(2, Math.round(teamIds.length / desiredSize));
    const groups = assignGroups(teamIds, groupsCount);
    const fixtureRows = groups.flatMap((groupTeamIds) => toFixtureRows(leagueId, roundRobin(groupTeamIds), 1, dueBase, 0, periodMs, isWeekend));
    return { fixtureRows, startsInFinal: false, groups, groupsCount };
  }
  return { fixtureRows: [], startsInFinal: false, groups: null };
}

// Builds the knockout bracket fixtures from a set of already-qualified team ids.
// Knockout fixtures always live in stage 2, separate from the stage-1 group fixtures.
function knockoutBracketFixtures(leagueId, teamIds, roundOffset, dueBase, legs, league) {
  return knockoutRoundFixtures(leagueId, teamIds, 2, roundOffset + 1, dueBase, legs || 1, roundPeriodMs(league), undefined, isWeekendLeague(league));
}

// A knockout round is "the final" when it comes down to exactly one real
// tie — no other simultaneous tie, and not a bye — because whoever wins
// that tie becomes champion. Only the final ever needs penalties: every
// earlier round instead lets both sides through when level on aggregate,
// since there's always a next round to sort it out further either way.
export function isFinalRoundFixtures(roundFixtures) {
  const ties = new Set();
  let hasBye = false;
  roundFixtures.forEach((f) => {
    if (f.away_team_id === null) { hasBye = true; return; }
    ties.add([f.home_team_id, f.away_team_id].sort().join("~"));
  });
  return !hasBye && ties.size === 1;
}

// Same check, scoped down to whichever tie a single fixture belongs to —
// used by result-entry UI to decide whether to offer a penalty score field.
export function isFinalFixture(fixture, league) {
  if (!fixture || fixture.away_team_id === null) return false;
  const roundFixtures = (league.fixtures || []).filter((f) => f.stage === fixture.stage && f.round === fixture.round);
  return isFinalRoundFixtures(roundFixtures);
}

// Sums a penalty-shootout score the same way aggregateFor sums regulation
// goals, but returns null (rather than 0) the moment either leg is missing
// a penalty entry for that side — unlike a goal, "no penalties recorded
// yet" and "lost the shootout 0-0" are different things, and callers need
// to tell them apart.
function pensAggregateFor(legs, teamId) {
  let total = 0, any = false;
  for (const f of legs) {
    const val = f.home_team_id === teamId ? f.pens_home : f.away_team_id === teamId ? f.pens_away : null;
    if (val === null || val === undefined) return null;
    total += val; any = true;
  }
  return any ? total : null;
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

export function isExpired(fixture) {
  return !fixture.played && !!fixture.due_at && new Date(fixture.due_at) < new Date();
}

// Whether a fixture is part of the group stage (stage 1) of a Groups +
// Knockout league. That stage plays out across several groups at once, so a
// single match's due_at isn't a fair cutoff on its own.
function isGroupStageFixture(fixture, league) {
  return league?.format === "groups_knockout" && fixture.stage === 1;
}

// The real "can this still be submitted / does this count as a no-show
// loss" check. For every format except a Groups + Knockout group stage this
// is just isExpired (the fixture's own due_at). For a group-stage fixture,
// due_at is advisory only — still shown to nudge players on when they're
// expected to play — but it no longer blocks submission or auto-scores a
// loss. The real cutoff is the whole group's shared due date the admin sets
// on the league (league.group_stage_due_at), since group results all need
// to be in before the group as a whole can be finalized.
export function isFixtureLocked(fixture, league) {
  if (fixture.played) return false;
  if (isGroupStageFixture(fixture, league)) {
    return !!league.group_stage_due_at && new Date(league.group_stage_due_at) < new Date();
  }
  return isExpired(fixture);
}

// A no-show tie: every leg of a fixture pairing has gone past its deadline
// unplayed. Both teams are eliminated the moment that's true — regardless
// of what either side has done earlier in the league; missing this one
// match (or, for a two-legged knockout tie, both legs of it) is enough on
// its own. Legs are grouped by round + team pair, so a two-legged tie only
// counts once BOTH legs are missed — not just one, since the other leg may
// still genuinely decide it — while a plain single-match fixture (round
// robin, survivor, a group-stage game) is judged entirely on its own, even
// if the same two teams happen to meet again in a later round. This is the
// same aggregate-no-show logic advanceKnockout already applies to the round
// it's actively advancing, just running continuously across every round,
// stage, and format — not only knockout, and not only once a round is
// fully wrapped up enough for an admin to click "advance."
function findNoShowTeamIds(league) {
  // Only situations where a single missed match is genuinely "win or
  // you're out" get an instant no-show elimination: a pure knockout
  // league, or the bracket rounds of Groups + Knockout. Everywhere
  // points-based — a group stage, a Survivor stage, plain round robin —
  // who's actually through is decided by final standings once that
  // stage/group wraps up. A no-show there still counts as a loss (0 pts,
  // -4 goal difference — see computeStandings) but doesn't, on its own,
  // end a club's run early: a club that missed one match but still has
  // enough points from its other results to qualify should still
  // qualify. Found the hard way: a group-stage no-show cost Sambulo his
  // spot in the Three-Day Titans League despite him having already won
  // enough of his other group matches to top the group and go on to win
  // knockout round 1 — the exact case this guards against now.
  if (league.format !== "knockout" && league.format !== "groups_knockout") return [];
  const fixtures = (league.fixtures || [])
    .filter((f) => f.away_team_id !== null)
    .filter((f) => !isGroupStageFixture(f, league));
  const alreadyEliminated = new Set((league.teams || []).filter((t) => t.eliminated).map((t) => t.id));
  const ties = {};
  fixtures.forEach((f) => {
    const key = `${f.round}~${[f.home_team_id, f.away_team_id].sort().join("~")}`;
    (ties[key] = ties[key] || []).push(f);
  });
  const ids = new Set();
  Object.values(ties).forEach((legs) => {
    const [teamA, teamB] = legs[0].home_team_id < legs[0].away_team_id
      ? [legs[0].home_team_id, legs[0].away_team_id] : [legs[0].away_team_id, legs[0].home_team_id];
    if (alreadyEliminated.has(teamA) && alreadyEliminated.has(teamB)) return;
    const allNoShow = legs.every((f) => !f.played && isFixtureLocked(f, league));
    if (allNoShow) { ids.add(teamA); ids.add(teamB); }
  });
  return [...ids].filter((id) => !alreadyEliminated.has(id));
}

// Earliest not-yet-played, fully-paired fixture for a given team (used for
// the "next fixture" status message). Sorted by due date first so a fixture
// with no due date yet falls back to round order.
export function nextFixtureForTeam(league, teamId) {
  return (league.fixtures || [])
    .filter((f) => !f.played && !isFixtureLocked(f, league) && f.away_team_id !== null && (f.home_team_id === teamId || f.away_team_id === teamId))
    .sort((a, b) => {
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return ad !== bd ? ad - bd : a.round - b.round;
    })[0] || null;
}

// Earliest not-yet-played, fully-paired fixture across the whole league —
// used as the status message's fallback for spectators or once a member's
// own club has no games left to schedule. A fixture whose deadline has
// already passed unplayed is a resolved no-show (auto-loss), not something
// still "due" — it stays played:false forever in the DB, so it has to be
// filtered out here explicitly or it would keep winning as the "next"
// fixture by due date long after it's no longer relevant.
function nextFixtureForLeague(league) {
  return (league.fixtures || [])
    .filter((f) => !f.played && !isFixtureLocked(f, league) && f.away_team_id !== null)
    .sort((a, b) => {
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return ad !== bd ? ad - bd : a.round - b.round;
    })[0] || null;
}

// True if `league` counts as a weekend league right now — same definition
// the homepage's Weekend League spotlight uses (see the comment on
// setWeekendLeagueDates in the create-league form): admin-created, with a
// starts_at that falls in the current Fri–Sun window. Deliberately doesn't
// reuse the spotlight's extra "still has matches due this weekend" reach —
// that's about what stays visible in the spotlight card, not about which
// league a fixture's confirmation window belongs to.
export function isWeekendLeague(league, now = new Date()) {
  if (!league || !league.created_by_admin || !league.starts_at) return false;
  const [start, end] = weekendWindow(now);
  const startsAtDate = new Date(league.starts_at);
  return startsAtDate >= start && startsAtDate <= end;
}

// A submitted result gives the opponent 30 minutes to confirm or dispute it
// (see respondToResultSubmission) before it escalates to the admin override
// queue — 10 minutes instead for a weekend league (see isWeekendLeague),
// since weekend fixtures move faster and shouldn't sit unconfirmed as long.
// These three helpers are the single source of truth for that window so the
// opponent panel's countdown and the admin panel's visibility can't drift
// out of sync.
export const RESULT_CONFIRM_WINDOW_MINUTES = 30;
export const WEEKEND_RESULT_CONFIRM_WINDOW_MINUTES = 10;
export function resultConfirmDeadline(submission, league) {
  const minutes = isWeekendLeague(league) ? WEEKEND_RESULT_CONFIRM_WINDOW_MINUTES : RESULT_CONFIRM_WINDOW_MINUTES;
  return new Date(new Date(submission.created_at).getTime() + minutes * 60 * 1000);
}
function resultConfirmExpired(submission, league) {
  return Date.now() >= resultConfirmDeadline(submission, league).getTime();
}
function resultConfirmMinutesLeft(submission, league) {
  const ms = resultConfirmDeadline(submission, league).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 1000));
}

// Direct/ladder challenges and open (random) challenges get the same
// 30-minute window as league fixtures above — both tables store the report
// time in result_reported_at, so one set of helpers covers both. Once
// expired, the result is no longer the opponent's to confirm/dispute; it
// moves into the admin review queue instead (see adminApproveChallengeResult
// and friends).
function challengeResultConfirmDeadline(ch) {
  return new Date(new Date(ch.result_reported_at).getTime() + RESULT_CONFIRM_WINDOW_MINUTES * 60 * 1000);
}
export function challengeResultConfirmExpired(ch) {
  if (!ch.result_reported_at) return false;
  return Date.now() >= challengeResultConfirmDeadline(ch).getTime();
}
export function challengeResultMinutesLeft(ch) {
  if (!ch.result_reported_at) return null;
  const ms = challengeResultConfirmDeadline(ch).getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / (60 * 1000));
}

// If the same fixture has already had this many submissions disputed by the
// opponent, the next one skips the 30-minute window entirely and goes
// straight to the admin queue — two honest mistakes is a reasonable benefit
// of the doubt, a third attempt at the same fixture is a real disagreement
// that needs a referee, not another round of opponent back-and-forth.
const DISPUTE_ESCALATION_THRESHOLD = 2;
function priorRejectedCount(league, submission) {
  return (league.result_submissions || []).filter(
    (s) => s.fixture_id === submission.fixture_id && s.status === "rejected"
  ).length;
}
// null = not escalated yet (opponent's turn); "timeout" = the 30-minute
// window passed; "dispute-cap" = this fixture's been disputed too many times
// already.
export function resultEscalationReason(league, submission) {
  if (priorRejectedCount(league, submission) >= DISPUTE_ESCALATION_THRESHOLD) return "dispute-cap";
  if (resultConfirmExpired(submission, league)) return "timeout";
  return null;
}

// Ladder Cup matches get the same submit -> confirm/dispute ->
// admin-escalation shape as everything above, but ladder_cup_matches is a
// single evolving row per match (like `challenges`), not one row per
// attempt (like `result_submissions`) — so there's no submissions list to
// scan. challengeResultConfirmDeadline/Expired/MinutesLeft below already
// only read `.result_reported_at` off whatever's passed in, so they're
// reused as-is; only the dispute-count check needs a ladder-cup-specific
// version, since that count lives on the match row itself
// (result_dispute_count) rather than being derived from history.
const LADDER_CUP_DISPUTE_ESCALATION_THRESHOLD = 2;
export function ladderCupResultEscalationReason(match) {
  if (!match || match.result_status !== "pending") return null;
  if ((match.result_dispute_count || 0) >= LADDER_CUP_DISPUTE_ESCALATION_THRESHOLD) return "dispute-cap";
  if (challengeResultConfirmExpired(match)) return "timeout";
  return null;
}

// The signed-in player's next `limit` opponents across every league they've
// fielded a club in — used for the "Up next" strip at the top of Home.
// Pulled straight off each league's live fixtures (not scoped to one stage),
// so it naturally follows the player from group stage into a knockout
// bracket once those fixtures exist. Byes (away_team_id === null),
// already-played fixtures, and fixtures whose confirm/due window has
// expired are all skipped — an expired fixture isn't something the player
// can act on anymore (it's on its way to auto-forfeit/admin review, same as
// everywhere else expired fixtures disappear from actionable lists), so it
// no longer earns a strip slot; fixtures with no due_at yet sort to the end
// rather than falling out of the list.
function computeMyUpcomingFixtures(leagues, myTeam, limit = 5) {
  const rows = [];
  (leagues || []).forEach((l) => {
    const team = myTeam ? myTeam(l) : null;
    if (!team) return;
    (l.fixtures || []).forEach((f) => {
      if (f.played || f.away_team_id === null) return;
      if (f.home_team_id !== team.id && f.away_team_id !== team.id) return;
      if (isFixtureLocked(f, l)) return;
      const opponentId = f.home_team_id === team.id ? f.away_team_id : f.home_team_id;
      const opponent = (l.teams || []).find((t) => t.id === opponentId);
      if (!opponent) return;
      rows.push({
        fixtureId: f.id, leagueId: l.id, leagueName: l.name, team, opponent,
        isHome: f.home_team_id === team.id, round: f.round, due_at: f.due_at,
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

// Resolves which team a given user_id owns in a given league, via that
// league's members list — the same lookup myTeam() does for the signed-in
// user (matched by session), just parameterized so it works for any
// member, not only "me". Used to aggregate a club's owner's XP/level
// across every league they've fielded a team in, not just the one whose
// standings table you happened to click into.
export function teamForUserInLeague(league, userId) {
  if (!userId) return null;
  const m = (league.members || []).find((mm) => mm.user_id === userId);
  if (!m || !m.team_id) return null;
  return (league.teams || []).find((t) => t.id === m.team_id) || null;
}

export function computeMyProgress(leagues, myTeam) {
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
export const ACHIEVEMENTS_DEF = [
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
  // Gates the Wall of Fame (see computeWallOfFame) — only members holding
  // this badge show up there. "Won" means owning (via `members`) the team
  // that ends up champion of a completed league, any format — see
  // computeMyLeagueWins.
  { id: "league_champion", icon: Crown, color: "#FFD700", tier: "platinum", category: "leagues", label: "League Champion", desc: "Win a league", target: 1, value: (ctx) => ctx.leaguesWon },
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
// to their name. Restricted to actual league winners: a member only makes
// the board if they hold the league_champion badge (see
// computeMyLeagueWins), everyone else is filtered out regardless of how
// many other badges they've earned. Members with rows we can't match to a
// profile (memberAvatars only lists other members — the signed-in player's
// own name/photo is merged in by the caller) are left out too.
// championshipsByUserId (see computeAllLeagueChampionships) attaches which
// specific league(s) each winner actually won, and when — the badge alone
// only says "won something," this is what says "won WHAT, and WHEN."
function computeWallOfFame(allAchievements, profileByUserId, championshipsByUserId) {
  const byUser = {};
  (allAchievements || []).forEach((row) => {
    const def = ACHIEVEMENTS_DEF.find((d) => d.id === row.achievement_id);
    if (!def) return; // ignore rows for a badge id that no longer exists
    if (!byUser[row.user_id]) byUser[row.user_id] = { userId: row.user_id, count: 0, score: 0, bestBadge: null, isLeagueWinner: false };
    const entry = byUser[row.user_id];
    entry.count += 1;
    entry.score += TIER_WEIGHT[def.tier] || 1;
    if (def.id === "league_champion") entry.isLeagueWinner = true;
    if (!entry.bestBadge || TIER_ORDER[def.tier] > TIER_ORDER[entry.bestBadge.tier]) entry.bestBadge = def;
  });
  return Object.values(byUser)
    .filter((e) => e.isLeagueWinner)
    .map((e) => ({ ...e, profile: profileByUserId.get(e.userId), titles: (championshipsByUserId && championshipsByUserId.get(e.userId)) || [] }))
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
// trophy score among actual league winners only (see computeWallOfFame),
// podium-styled like the Leaderboard/Ladder strips it sits next to.
// Renders nothing until someone has actually won a league, same "don't
// show an empty shelf" reasoning as those strips.
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
              {row.titles.length > 0 ? (
                <span className="font-mono text-[10px] truncate max-w-[130px]" style={{ color: "#FFD700" }}>
                  👑 {row.titles[0].leagueName}
                </span>
              ) : (
                <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{row.count} badges</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// The full Wall of Fame — every member who's actually won a league (holds
// the league_champion badge — see computeWallOfFame), ranked by trophy
// score across all their badges (rarer badges count for more, so it
// rewards chasing hard badges, not just racking up easy ones), each row
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
            const hasTitles = row.titles.length > 0;
            return (
              <div key={row.userId} className="rounded-xl px-2.5 py-2" style={{
                background: isMe ? `${c.accent}14` : hasTitles ? "linear-gradient(135deg, #FFD70014, transparent)" : "transparent",
                border: `1px solid ${isMe ? c.accent + "55" : hasTitles ? "#FFD70033" : "transparent"}`,
              }}>
                <div className="flex items-center gap-2.5">
                  <span className="w-6 text-center font-mono text-xs font-bold shrink-0" style={{ color: rankColor }}>
                    {row.rank <= 3 ? <Crown size={13} style={{ color: rankColor, display: "inline" }} /> : row.rank}
                  </span>
                  <MemberAvatar url={row.profile.avatar_url} username={row.profile.username} size={30} c={c} />
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="font-body font-semibold text-sm truncate" style={{ color: c.text }}>{row.profile.username}{isMe ? " (you)" : ""}</div>
                    <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>
                      {hasTitles ? `${row.titles.length} title${row.titles.length > 1 ? "s" : ""} · ${row.count} badges` : `${row.count} badges`}
                    </div>
                  </div>
                  {row.bestBadge && (
                    <span className="flex items-center justify-center rounded-full shrink-0" style={{ width: 26, height: 26, background: `linear-gradient(135deg, ${row.bestBadge.color}, ${row.bestBadge.color}99)`, border: `1.5px solid ${row.bestBadge.color}` }} title={row.bestBadge.label}>
                      <row.bestBadge.icon size={13} style={{ color: "#fff" }} />
                    </span>
                  )}
                </div>
                {hasTitles && (
                  <div className="flex flex-col gap-1 mt-2 pl-8">
                    {row.titles.map((t) => (
                      <div key={t.leagueId} className="flex items-center gap-1.5 font-body text-xs" style={{ color: c.text }}>
                        <Crown size={11} className="shrink-0 animate-achievement-glow" style={{ color: "#FFD700", "--badge-glow": "#FFD700" }} />
                        <span className="font-semibold truncate">{t.leagueName}</span>
                        <span className="shrink-0" style={{ color: c.textFaint }}>· {formatTitleDate(t.wonAt)}</span>
                      </div>
                    ))}
                  </div>
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
export function computeStandings(teams, fixtures, league) {
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
    } else if (isFixtureLocked(f, league)) {
      h.p++; a.p++; h.l++; a.l++;
      h.ga += 4; a.ga += 4; // no-show penalty: both concede 4, no points either way
    }
  });
  const rows = Object.values(table);
  rows.forEach((r) => { r.gd = r.gf - r.ga; });
  // Teams that haven't actually played a single fixture yet in this stage
  // (0 pts, 0 gd — nothing on the board either way) would otherwise tie
  // with, or even outrank, a team that played and genuinely struggled (real
  // losses drag gd negative). A team with zero games played always sits
  // below any team that's played at least one, so a club that never showed
  // up isn't mistaken for one that's merely had a bad run.
  rows.sort((a, b) => {
    const aPlayed = a.p > 0 ? 1 : 0;
    const bPlayed = b.p > 0 ? 1 : 0;
    if (aPlayed !== bPlayed) return bPlayed - aPlayed;
    return b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name);
  });
  return rows;
}

// How many of `leagues` the given user has actually won — checked the same
// way each league's own page decides its champion (knockoutChampion /
// survivorChampion / round-robin standings winner), just run across every
// league at once so it can feed the League Champion achievement. A user
// "wins" a league by owning (via `members`) the team that ends up champion;
// leagues that haven't finished yet contribute nothing.
function computeMyLeagueWins(leagues, userId) {
  if (!userId) return 0;
  let wins = 0;
  for (const league of leagues || []) {
    // Defensive: don't let one league row with a missing teams/fixtures
    // join (a brand-new league mid-creation, a stale/partial row) crash
    // this useMemo for the whole homepage — just skip it for the win count.
    const leagueFixtures = league.fixtures || [];
    const leagueTeams = league.teams || [];
    const isKnockout = league.format === "knockout";
    const isSurvivor = league.format === "survivor";
    const isGroupsKnockout = league.format === "groups_knockout";
    const inKnockoutBracket = isKnockout || (isGroupsKnockout && league.final_stage_started);

    let championTeamId = null;
    if (inKnockoutBracket) {
      const bracketStage = isGroupsKnockout ? 2 : 1;
      const stageFixtures = leagueFixtures.filter((f) => f.stage === bracketStage);
      const stageDone = stageFixtures.length > 0 && stageFixtures.every((f) => f.played || isExpired(f));
      const activeTeams = leagueTeams.filter((t) => !t.eliminated);
      if (stageDone && activeTeams.length === 1) championTeamId = activeTeams[0].id;
    } else if (isSurvivor) {
      if (league.final_stage_started) {
        const stageFixtures = leagueFixtures.filter((f) => f.stage === league.current_stage);
        const stageDone = stageFixtures.length > 0 && stageFixtures.every((f) => f.played || isExpired(f));
        if (stageDone) {
          const displayTeams = leagueTeams.filter((t) => !t.eliminated);
          championTeamId = computeStandings(displayTeams, stageFixtures, league)[0]?.id ?? null;
        }
      }
    } else {
      const leagueComplete = leagueFixtures.length > 0 && leagueFixtures.every((f) => f.played);
      if (leagueComplete) championTeamId = computeStandings(leagueTeams, leagueFixtures, league)[0]?.id ?? null;
    }

    if (!championTeamId) continue;
    const championMember = (league.members || []).find((m) => m.team_id === championTeamId);
    if (championMember?.user_id === userId) wins += 1;
  }
  return wins;
}

// "Jul 2026" — deliberately coarser than a full date. A trophy cabinet
// remembers the season, not the exact afternoon.
function formatTitleDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

// Same champion-determination logic as computeMyLeagueWins just above —
// same three branches (knockout bracket / survivor final stage / round-
// robin standings), same "team owner via members" attribution — but run
// across every league for every user at once, and capturing which league
// it was and when the deciding fixture was played, instead of just a
// count for one user. This is what lets the Wall of Fame say WHICH league
// someone won and WHEN, not just THAT they've won one. Kept as a genuinely
// separate pass (not built by generalizing computeMyLeagueWins itself) so
// a future edit to one doesn't silently drift out of sync with the other
// without at least touching two clearly-linked comments to notice.
function computeAllLeagueChampionships(leagues) {
  const byUser = new Map();
  for (const league of leagues || []) {
    // Defensive: same reasoning as computeMyLeagueWins above.
    const leagueFixtures = league.fixtures || [];
    const leagueTeams = league.teams || [];
    const isKnockout = league.format === "knockout";
    const isSurvivor = league.format === "survivor";
    const isGroupsKnockout = league.format === "groups_knockout";
    const inKnockoutBracket = isKnockout || (isGroupsKnockout && league.final_stage_started);

    let championTeamId = null;
    let deciderFixtures = null;
    if (inKnockoutBracket) {
      const bracketStage = isGroupsKnockout ? 2 : 1;
      const stageFixtures = leagueFixtures.filter((f) => f.stage === bracketStage);
      const stageDone = stageFixtures.length > 0 && stageFixtures.every((f) => f.played || isExpired(f));
      const activeTeams = leagueTeams.filter((t) => !t.eliminated);
      if (stageDone && activeTeams.length === 1) { championTeamId = activeTeams[0].id; deciderFixtures = stageFixtures; }
    } else if (isSurvivor) {
      if (league.final_stage_started) {
        const stageFixtures = leagueFixtures.filter((f) => f.stage === league.current_stage);
        const stageDone = stageFixtures.length > 0 && stageFixtures.every((f) => f.played || isExpired(f));
        if (stageDone) {
          const displayTeams = leagueTeams.filter((t) => !t.eliminated);
          championTeamId = computeStandings(displayTeams, stageFixtures, league)[0]?.id ?? null;
          deciderFixtures = stageFixtures;
        }
      }
    } else {
      const leagueComplete = leagueFixtures.length > 0 && leagueFixtures.every((f) => f.played);
      if (leagueComplete) {
        championTeamId = computeStandings(leagueTeams, leagueFixtures, league)[0]?.id ?? null;
        deciderFixtures = leagueFixtures;
      }
    }

    if (!championTeamId) continue;
    const championMember = (league.members || []).find((m) => m.team_id === championTeamId);
    if (!championMember?.user_id) continue;

    const wonAt = (deciderFixtures || []).reduce((latest, f) => {
      if (!f.played) return latest;
      const d = fixturePlayedDate(f);
      return !latest || d > latest ? d : latest;
    }, null);
    if (!wonAt) continue;

    const title = {
      leagueId: league.id,
      leagueName: league.name,
      formatLabel: FORMATS.find((f) => f.id === league.format)?.label,
      wonAt,
    };
    if (!byUser.has(championMember.user_id)) byUser.set(championMember.user_id, []);
    byUser.get(championMember.user_id).push(title);
  }
  byUser.forEach((titles) => titles.sort((a, b) => new Date(b.wonAt) - new Date(a.wonAt)));
  return byUser;
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
  if (!isKnockout) return computeStandings(league.teams, league.fixtures, league).map((r) => r.id);

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
    rankedIds.push(...computeStandings(groupOnlyTeams, groupFixtures, league).map((r) => r.id));
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
export function fixturePlayedDate(f) { return f.played_at || f.created_at; }

// The date of the first match anyone ever played, across every league —
// this is what Season 1 starts from. Returns null if nothing's been played
// yet (nothing to anchor a season to).
export function seasonAnchor(leagues) {
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
export function seasonBounds(idx, anchor) {
  return { start: new Date(anchor.getTime() + idx * SEASON_LENGTH_MS), end: new Date(anchor.getTime() + (idx + 1) * SEASON_LENGTH_MS) };
}
export function currentSeason(anchor) { return anchor ? seasonIndexForDate(new Date(), anchor) : 0; }
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
export function computeGlobalLeaderboard(leagues, bounds) {
  const byKey = new Map();
  (leagues || []).forEach((l) => {
    const ownerByTeamId = new Map();
    (l.members || []).forEach((m) => { if (m.team_id) ownerByTeamId.set(m.team_id, m); });
    // Defensive: same reasoning as computeMyLeagueWins/computeAllLeagueChampionships
    // above — don't let one league row with a missing fixtures join crash
    // this pass (and take the Leaderboard strip down with it).
    const leagueFixtures = l.fixtures || [];
    (l.teams || []).forEach((team) => {
      const owner = ownerByTeamId.get(team.id);
      const key = owner ? `u:${owner.user_id}` : `t:${team.id}`;
      const name = owner ? owner.display_name : team.name;
      const played = leagueFixtures.filter((f) => {
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

// Same "follow the person, not the club" identity computeGlobalLeaderboard
// uses (grouped by user_id so a rivalry survives a club rename or the same
// two people meeting again in a completely different league later). A club
// nobody has claimed yet falls back to its own team id, same as the
// Leaderboard's unclaimed-club fallback — that just means an unclaimed
// opponent's history is scoped to whatever they've played under that exact
// team row, since there's no user to follow them by.
export function playerKeyForTeam(league, teamId) {
  if (!teamId) return null;
  const owner = (league?.members || []).find((m) => m.team_id === teamId);
  return owner ? `u:${owner.user_id}` : `t:${teamId}`;
}

// The head-to-head record between two players, across every league they've
// ever met in — not just the one currently open. Mirrors
// computeGlobalLeaderboard's per-league owner lookup so this stays correct
// even for a club whose current owner has changed since an old fixture was
// played. Returns null for a same-person matchup (keyA === keyB, e.g. two
// unclaimed placeholder clubs that happen to share a fallback key) since
// there's no rivalry to show. Matches come back most-recent-first so the
// streak calculation below and the match-history list can both just walk
// forward from index 0.
export function computeHeadToHead(leagues, keyA, keyB) {
  if (!keyA || !keyB || keyA === keyB) return null;
  const matches = [];
  (leagues || []).forEach((l) => {
    const ownerByTeamId = new Map();
    (l.members || []).forEach((m) => { if (m.team_id) ownerByTeamId.set(m.team_id, m.user_id); });
    const keyForTeam = (teamId) => (ownerByTeamId.has(teamId) ? `u:${ownerByTeamId.get(teamId)}` : `t:${teamId}`);
    (l.fixtures || []).forEach((f) => {
      if (!f.played || f.away_team_id === null) return;
      const hKey = keyForTeam(f.home_team_id);
      const aKey = keyForTeam(f.away_team_id);
      const aIsHome = hKey === keyA && aKey === keyB;
      const aIsAway = hKey === keyB && aKey === keyA;
      if (!aIsHome && !aIsAway) return;
      matches.push({
        leagueId: l.id, leagueName: l.name, round: f.round, date: fixturePlayedDate(f),
        gfA: aIsHome ? f.home_score : f.away_score,
        gfB: aIsHome ? f.away_score : f.home_score,
      });
    });
  });
  matches.sort((x, y) => new Date(y.date) - new Date(x.date));

  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  matches.forEach((m) => {
    gf += m.gfA; ga += m.gfB;
    if (m.gfA > m.gfB) w++; else if (m.gfA < m.gfB) l++; else d++;
  });

  // Current run, read backwards from the most recent match — stops at the
  // first result that breaks the streak (or the end of the history).
  let streak = 0, streakType = null;
  for (const m of matches) {
    const result = m.gfA > m.gfB ? "W" : m.gfA < m.gfB ? "L" : "D";
    if (streakType === null) { streakType = result; streak = 1; }
    else if (result === streakType) streak++;
    else break;
  }

  return { played: matches.length, w, d, l, gf, ga, streak, streakType, matches };
}

// Picks out the top scorer and the best defensive record (fewest goals
// conceded) from a set of leaderboard/standings rows that already expose
// { name, gf, ga }. Requires at least one goal-scoring row to name a top
// scorer, and at least two qualifying rows before naming a separate
// defensive team (otherwise it would just be the same person twice). Ties
// break alphabetically so the result is stable rather than
// order-of-insertion dependent.
export function goalExtremes(rows) {
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
export function isResultComment(body, isResultFlag) {
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
export function splitCommentsByRoot(comments) {
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
export function findSubmissionOpponentId(league, submission) {
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

// Fixed to Africa/Johannesburg (UTC+2, no DST) rather than each viewer's own
// device timezone — so every player and admin sees the exact same time for
// a fixture regardless of what timezone their phone/browser happens to be
// set to. This league runs on SAST, not "whatever device opened the app."
export function fmtDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" });
}

// Returns [start, end] Date objects spanning the nearest Friday 00:00 through
// Sunday 23:59:59 — "this weekend" if today already falls in that window,
// otherwise the upcoming one. Used by the guest homepage's Weekend League
// spotlight to surface whatever's kicking off or already in play over it.
export function weekendWindow(now = new Date()) {
  const day = now.getDay(); // 0 Sun .. 6 Sat
  const toFriday = day === 5 ? 0 : day === 6 ? -1 : day === 0 ? -2 : 5 - day;
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + toFriday);
  const end = new Date(start); end.setDate(start.getDate() + 2); end.setHours(23, 59, 59, 999);
  return [start, end];
}

// The league runs on SAST (see fmtDate above), so the nightly pause is a SAST
// wall-clock window too — not whatever timezone the visitor's device happens
// to be in. South Africa doesn't observe DST, so SAST is a fixed UTC+2.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// True from 9pm through 8:59am SAST — the overnight stretch the Weekend
// League spotlight shows as "Paused" rather than "Live". Only the spotlight's
// live/paused badge reads this; it never gates joining a league or submitting
// a result, so players can still upload results for a match played overnight.
// `override` ("paused" | "live" | null) is an admin's manual call — see
// weekendOverride in App() — and always wins over the clock when set, so an
// admin can force an early resume or an extra-long pause when necessary.
function isWeekendPauseHour(now = new Date(), override = null) {
  if (override === "paused") return true;
  if (override === "live") return false;
  const sastHour = new Date(now.getTime() + SAST_OFFSET_MS).getUTCHours();
  return sastHour >= 21 || sastHour < 9;
}

// Next real moment (as a Date, in UTC) at which SAST wall-clock time reaches
// `hour`:00, at or after `now`. Used to count down to the next 9pm pause or
// 9am resume without ever constructing a Date in the visitor's own timezone.
function nextSastHourBoundary(now, hour) {
  const sastNow = new Date(now.getTime() + SAST_OFFSET_MS);
  const candidate = new Date(Date.UTC(sastNow.getUTCFullYear(), sastNow.getUTCMonth(), sastNow.getUTCDate(), hour, 0, 0, 0) - SAST_OFFSET_MS);
  return candidate >= now ? candidate : new Date(candidate.getTime() + 86400000);
}

// Adds `durationMs` of real elapsed time on top of `startDate`, but for
// weekend leagues the 9pm-9am SAST pause doesn't count toward that time —
// the countdown effectively freezes at 9pm and resumes at 9am, so a
// deadline that would otherwise land overnight gets pushed out by however
// many paused hours it crossed. Non-weekend leagues (isWeekend: false) get
// plain addition, unaffected. Walks forward in "active" and "paused"
// stretches rather than computing this in one shot, since a long enough
// durationMs can span more than one overnight pause.
function addPausableDuration(startDate, durationMs, isWeekend) {
  if (!isWeekend) return new Date(startDate.getTime() + durationMs);
  let cursor = new Date(startDate.getTime());
  let remaining = durationMs;
  // Safety cap so a bad input (e.g. a negative or absurd durationMs) can
  // never spin this into an infinite loop.
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard++;
    if (isWeekendPauseHour(cursor)) {
      // Currently in the paused window — jump straight to 9am, none of
      // this stretch counts against `remaining`.
      cursor = nextSastHourBoundary(cursor, 9);
      continue;
    }
    // Active window — consume time up to the next 9pm pause, or all of
    // what's left, whichever comes first.
    const nextPause = nextSastHourBoundary(cursor, 21);
    const step = Math.min(nextPause.getTime() - cursor.getTime(), remaining);
    cursor = new Date(cursor.getTime() + step);
    remaining -= step;
  }
  return cursor;
}

// Ladder Cup's weekly cutoff defaults to the *upcoming* Sunday 10PM SAST
// (Africa/Johannesburg, UTC+2 fixed, no DST — same rule as fmtDate/
// isWeekendPauseHour above: always SAST wall-clock, never the visitor's own
// device timezone). Used by CreateLeague to prefill the cutoff picker for a
// new ladder_cup league; admins can still override it. Mirrors
// nextSastHourBoundary's technique but also walks to the right day, not
// just the right hour.
export function nextSundayCutoffSAST(now = new Date()) {
  const sastNow = new Date(now.getTime() + SAST_OFFSET_MS);
  const day = sastNow.getUTCDay(); // 0 Sun .. 6 Sat, in SAST wall-clock terms
  const daysToSunday = day === 0 ? 0 : 7 - day;
  const candidate = new Date(Date.UTC(sastNow.getUTCFullYear(), sastNow.getUTCMonth(), sastNow.getUTCDate() + daysToSunday, 22, 0, 0, 0) - SAST_OFFSET_MS);
  return candidate >= now ? candidate : new Date(candidate.getTime() + 7 * ONE_DAY_MS);
}

// Converts a stored ISO timestamp into the "YYYY-MM-DDTHH:mm" shape a
// <input type="datetime-local"> expects, in the browser's local time — the
// exact inverse of how CreateLeague turns that same input's value back into
// an ISO string (`new Date(value).toISOString()`), so editing round-trips
// without drifting by a timezone offset.
export function toDatetimeLocalValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Short relative timestamp for comments/replies — falls back to the full
// date once something's more than a week old, where "how many days ago"
// stops being useful and the actual date is what you want.
export function timeAgo(iso) {
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
export function ladderDaysLeft(fromISO, windowDays) {
  if (!fromISO) return null;
  const deadline = new Date(fromISO).getTime() + windowDays * 24 * 60 * 60 * 1000;
  const ms = deadline - Date.now();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
export function avatarColor(seed) {
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

// How long a member's row stays highlighted red after an admin taps their
// WhatsApp icon (see markWaReminder / isWaReminderActive below). Simple
// "I messaged them recently" flag — not tied to any fixture due date.
const WA_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

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
export function firstMatchdayNote(round) {
  if (round !== 1) return "";
  return `\n👆 Also, jump on ${SITE_URL} — you'll find your opponent right at the top of the homepage`;
}

// Small pill button used anywhere we offer to message a club's registered
// number. Renders nothing if there's no usable phone number, so callers can
// place it directly after a phone number without an extra guard. With
// iconOnly, renders as a plain round icon button and drops the text label —
// used in fixtures where we show the WhatsApp entry point but not the raw
// number itself.
export function WhatsAppLink({ phone, text, label, iconOnly, onClick, title, c }) {
  const href = waLink(phone, text);
  if (!href) return null;
  if (iconOnly) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title={title || "Message on WhatsApp"} onClick={onClick}
        className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0"
        style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
        <MessageCircle size={14} />
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title || "Message on WhatsApp"} onClick={onClick}
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
export function WhatsAppCallLink({ phone, text, label, iconOnly, onClick, c }) {
  const href = waLink(phone, text);
  if (!href) return null;
  if (iconOnly) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" title="Call to arrange the match on WhatsApp" onClick={onClick}
        className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0"
        style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
        <Phone size={13} />
      </a>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title="Call to arrange the match on WhatsApp" onClick={onClick}
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

export function Loader({ c }) {
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
function PaymentModal({ league, member, onCancel, onSubmit, onPayByCard, c }) {
  const [fee, setFee] = useState(clampFee(member?.entry_fee || 50));
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [cardSaving, setCardSaving] = useState(false);
  const inputStyle = { background: c.surfaceHover, borderColor: c.border, color: c.text };
  const isResubmit = !!member;

  const submit = async () => {
    if (!file || saving) return;
    setSaving(true);
    await onSubmit(fee, file);
    setSaving(false);
  };

  const submitCard = async () => {
    if (cardSaving || isResubmit) return;
    setCardSaving(true);
    await onPayByCard(fee);
    setCardSaving(false);
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
          {IKHOKHA_DETAILS.payLink && !isResubmit && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <CreditCard size={14} style={{ color: c.accent }} />
                <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Pay by card</span>
              </div>
              <button type="button" onClick={submitCard} disabled={cardSaving}
                className="inline-flex items-center gap-1.5 font-body text-xs font-semibold px-3.5 py-2 rounded-full disabled:opacity-60"
                style={{ background: c.accent, color: c.accentText }}>
                <CreditCard size={13} /> {cardSaving ? "Starting checkout…" : "Pay by card"}
              </button>
              <div className="mt-2">
                <CardBrandsBadge c={c} />
              </div>
              <div className="font-body text-[10px] mt-1.5 mb-3" style={{ color: c.textFaint }}>
                Opens a secure card checkout page. You'll be joined automatically the moment payment is confirmed — no proof needed.
              </div>
            </>
          )}
          <div className="flex items-center gap-2 mb-2">
            <img src="/capitec-logo.png" alt="Capitec Bank" className="h-4 w-auto object-contain" />
            <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Or via bank transfer</span>
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
  const [ph, setPh] = useState(existing?.pens_home ?? "");
  const [pa, setPa] = useState(existing?.pens_away ?? "");
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  // The final is always a single decisive match — if it's tied, penalties
  // are the only way through, so this modal asks for them right here
  // instead of sending the admin off to a separate screen.
  const isFinal = isFinalFixture(fixture, league);
  const needsPens = isFinal && Number(h) === Number(a);
  const pensReady = !needsPens || (ph !== "" && pa !== "" && Number(ph) !== Number(pa));

  const submit = async () => {
    if (!file || saving || !pensReady) return;
    setSaving(true);
    await onSubmit(h, a, file, needsPens ? Number(ph) : null, needsPens ? Number(pa) : null);
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

        {needsPens && (
          <div className="mb-5">
            <div className="font-mono text-xs mb-2" style={{ color: c.red }}>This is the final — level after regulation goes to penalties.</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{homeTeam?.name || "Home"} (pens)</div>
                <input type="number" min={0} value={ph} onChange={(e) => setPh(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
              </div>
              <span className="self-end pb-2" style={{ color: c.textFaint }}>–</span>
              <div className="flex-1 min-w-0">
                <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{awayTeam?.name || "Away"} (pens)</div>
                <input type="number" min={0} value={pa} onChange={(e) => setPa(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
              </div>
            </div>
            {ph !== "" && pa !== "" && Number(ph) === Number(pa) && (
              <div className="font-mono text-[10px] mt-1" style={{ color: c.red }}>Penalties can't be level too — someone has to win.</div>
            )}
          </div>
        )}

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Photo proof (required)</label>
        <label className="flex items-center gap-2 border border-dashed rounded-lg px-4 py-3 mb-1 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
          <Camera size={15} style={{ color: c.textFaint }} />
          {file ? file.name : "Upload a screenshot of the final scoreboard"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <div className="font-mono text-[11px] mb-5" style={{ color: c.textFaint }}>
          The admin reviews this before it counts — once approved it's posted to the comments under your name automatically.
        </div>

        <button disabled={!file || saving || !pensReady} onClick={submit} className="w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full"
          style={file && !saving && pensReady ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
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

// Step 10: logs a played (non-walkover) Ladder Cup match result. This modal
// itself is unchanged by the submit -> confirm/dispute -> admin-escalation
// pipeline (submitLadderCupMatchResult below) — it just collects the
// scoreline and photo and calls onSubmit; whether that lands as a pending
// report awaiting the opponent, same as everywhere else in this app, is
// entirely the caller's business. Extra time and penalty scores only
// show once the stage before them is level, and decidedBy itself isn't a
// manual choice — resolveMatchWinner derives it from whichever scoreline
// actually broke the tie, so there's nothing for the scoreline and the
// stage label to disagree about.
function LadderCupResultModal({ match, homeTeam, awayTeam, onCancel, onSubmit, c }) {
  const [h, setH] = useState(0);
  const [a, setA] = useState(0);
  const [eth, setEth] = useState(0);
  const [eta, setEta] = useState(0);
  const [ph, setPh] = useState("");
  const [pa, setPa] = useState("");
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);

  const regulationLevel = Number(h) === Number(a);
  const extraTimeLevel = Number(eth) === Number(eta);
  const needsPens = regulationLevel && extraTimeLevel;
  const pensReady = !needsPens || (ph !== "" && pa !== "" && Number(ph) !== Number(pa));

  const submit = async () => {
    if (!file || saving || !pensReady) return;
    setSaving(true);
    await onSubmit({
      homeGoals: Number(h), awayGoals: Number(a),
      extraTimeHomeGoals: Number(eth), extraTimeAwayGoals: Number(eta),
      pensHome: needsPens ? Number(ph) : null, pensAway: needsPens ? Number(pa) : null,
      file,
    });
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
        <div className="font-body text-sm mb-4" style={{ color: c.textDim }}>{homeTeam?.name || "Home"} (home) vs {awayTeam?.name || "Away"}</div>

        <div className="flex items-center gap-2 mb-4">
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

        {regulationLevel && (
          <div className="mb-4">
            <div className="font-mono text-xs mb-2" style={{ color: c.textDim }}>Level after regulation — extra time score</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{homeTeam?.name || "Home"} (ET)</div>
                <input type="number" min={0} value={eth} onChange={(e) => setEth(Number(e.target.value))}
                  className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
              </div>
              <span className="self-end pb-2" style={{ color: c.textFaint }}>–</span>
              <div className="flex-1 min-w-0">
                <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{awayTeam?.name || "Away"} (ET)</div>
                <input type="number" min={0} value={eta} onChange={(e) => setEta(Number(e.target.value))}
                  className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
              </div>
            </div>
          </div>
        )}

        {needsPens && (
          <div className="mb-4">
            <div className="font-mono text-xs mb-2" style={{ color: c.red }}>Still level after extra time — penalties</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{homeTeam?.name || "Home"} (pens)</div>
                <input type="number" min={0} value={ph} onChange={(e) => setPh(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
              </div>
              <span className="self-end pb-2" style={{ color: c.textFaint }}>–</span>
              <div className="flex-1 min-w-0">
                <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{awayTeam?.name || "Away"} (pens)</div>
                <input type="number" min={0} value={pa} onChange={(e) => setPa(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full text-center rounded font-mono px-1 py-2 outline-none" style={{ background: c.surfaceHover, color: c.text }} />
              </div>
            </div>
            {ph !== "" && pa !== "" && Number(ph) === Number(pa) && (
              <div className="font-mono text-[10px] mt-1" style={{ color: c.red }}>Penalties can't be level too — someone has to win.</div>
            )}
          </div>
        )}

        <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Photo proof (required)</label>
        <label className="flex items-center gap-2 border border-dashed rounded-lg px-4 py-3 mb-1 cursor-pointer font-body text-sm" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
          <Camera size={15} style={{ color: c.textFaint }} />
          {file ? file.name : "Upload a screenshot of the final scoreboard"}
          <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <div className="font-mono text-[11px] mb-5" style={{ color: c.textFaint }}>
          This posts straight to the ladder — points, streaks, and elimination update immediately, no admin review.
        </div>

        <button disabled={!file || saving || !pensReady} onClick={submit} className="w-full flex items-center justify-center gap-2 font-body font-semibold px-5 py-3 rounded-full"
          style={file && !saving && pensReady ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {saving ? "Saving…" : "Log result"}
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

export const commentSpeech = {
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
export function useCommentSpeakingId() {
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
export function useVoiceRecorder() {
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
export function VoiceRecorderButton({ recorder, c, size = 40, iconSize = 15 }) {
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
export function VoiceNotePlayer({ url, duration, c, compact = false }) {
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
      // Same fix as photos/avatars — old voice notes recorded before the
      // proxy existed still hold a raw Supabase URL in the database, so
      // this rewrites it to the cached proxy path right at playback time.
      const audio = new Audio(toProxiedUrl(url));
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
export function RulesButton({ label, onClick, c }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider px-2.5 py-1.5 rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}>
      <Info size={11} /> {label}
    </button>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  // Supabase's onAuthStateChange fires — and hands back a brand-new session
  // object, even when nothing about the signed-in user actually changed —
  // on every TOKEN_REFRESHED event (roughly hourly per tab, more with
  // several tabs open), not just real sign-in/sign-out. Any effect that
  // lists `session` itself in its dependency array reruns on every one of
  // those refreshes, because React compares by reference. sessionKey
  // collapses that down to a primitive that only changes on a genuine
  // identity transition (nobody -> user A, user A -> nobody, user A -> user
  // B), so effects keyed on it correctly ignore token refreshes. This is
  // what was behind loadLeagues() (and the rest of the sign-in load
  // battery below) dominating PostgREST egress: it was re-running its full
  // whole-platform fetch every time any open tab silently refreshed its
  // token, not once per session as intended.
  const sessionKey = session === undefined ? "loading" : session === null ? "signed-out" : session.user.id;
  const [profile, setProfile] = useState(undefined);
  const [isAdmin, setIsAdmin] = useState(false);
  const [leagues, setLeagues] = useState(null);
  // Ticks once a minute purely so time-derived values that don't have a DB
  // row to change underneath them — like a challenge result's 30-minute
  // confirm window lapsing — get re-evaluated even if nothing else caused
  // a re-render. See adminEscalatedResultCount below for what this feeds.
  const [appNow, setAppNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAppNow(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  // Admin override for the Weekend League spotlight's nightly auto-pause
  // (see isWeekendPauseHour / WeekendLeagueSpotlight). null = follow the
  // 9pm–9am SAST schedule as usual; "paused" / "live" forces that state
  // regardless of the clock, until an admin clears it back to null. Lives
  // in a single-row `app_settings` table (id=1) rather than per-league,
  // since the spotlight's live/paused badge is one global state shared by
  // every weekend league at once — see APP-SETTINGS-MIGRATION.md.
  const [weekendOverride, setWeekendOverrideState] = useState(null);
  // A hard refresh re-mounts the whole app from scratch, so React state
  // always starts from these defaults — but the browser itself preserves
  // window.history.state across a reload of the same entry (it's tied to
  // the URL/history entry, not the page's in-memory state). Reading it here
  // means a refresh lands back on whichever screen the appNav effect below
  // last recorded, instead of always bouncing to Home.
  const [view, setView] = useState(() => (window.history.state?.appView ? window.history.state.view : null) || "home");
  // Quick actions dock — floating on every screen (see the root return
  // below), open/closed state lives here rather than inside Home now that
  // it's no longer scoped to a single screen.
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
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
  const [ladderCupResultModal, setLadderCupResultModal] = useState(null); // { league, match } — step 10, logging a Ladder Cup match result
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [accounts, setAccounts] = useState(null); // admin-only: every profile on the platform
  const [activityLog, setActivityLog] = useState(null); // admin-only: recent user_activity_log rows
  const [challengeMembers, setChallengeMembers] = useState(null); // every other member, for the challenge picker
  const [allAchievements, setAllAchievements] = useState(null); // every earned badge, every member — feeds the Wall of Fame
  const [teamAvatars, setTeamAvatars] = useState({}); // team_id -> avatar_url, for club photos on the Table (mirrors the guest view's version)
  const [challenges, setChallenges] = useState(null); // every challenge involving the signed-in member, either side
  const [openChallenges, setOpenChallenges] = useState(null); // broadcast "random challenge" pool — open to whoever accepts first
  const [recentResults, setRecentResults] = useState(null); // last 100 confirmed challenge results, platform-wide (community feed)
  const [boardComments, setBoardComments] = useState(null); // platform-wide comment wall shown under Challenges
  const [ladderComments, setLadderComments] = useState(null); // comment wall shown on the full Ladder page
  const [ladderResults, setLadderResults] = useState(null); // last 100 confirmed ladder-challenge results, for the full Ladder page
  const [ladder, setLadder] = useState(null); // the whole permanent ladder, ordered by rank_position — never resets. Only ever loaded for the Ladder page itself now — see ladderTop5/myLadderRank below for the lightweight Home equivalents.
  // Home's LadderStrip only ever renders the top 5 rows plus the viewer's
  // own — these two replace loadLadder() there (see below), which used to
  // poll the *entire* ladder_ranks table every 60s from Home, the busiest
  // screen in the app, for that same handful of rows.
  const [ladderTop5, setLadderTop5] = useState(null);
  const [myLadderRankRow, setMyLadderRankRow] = useState(null);
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
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Step 1 of activity tracking — just sign-in/sign-out for now, more
      // event types get added incrementally from here (see activityLog.js).
      if (event === "SIGNED_IN") logActivity("sign_in");
      if (event === "SIGNED_OUT") logActivity("sign_out");
    });
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

  // This is the single source of truth for every league across the whole
  // signed-in app (Home, league lists, LeagueDetail, achievements, admin
  // screens).
  // LEAGUE_LIST_SELECT is everything the bulk, whole-platform load
  // (loadLeagues) needs — every field genuinely read from a Home league
  // card or from anywhere that iterates *all* leagues (attentionScore's
  // result_submissions check, LeagueReactionBar's compact reaction bar,
  // computeMyUpcomingFixtures/computeMyProgress's fixtures scan), so none
  // of those stayed narrowed further. `comments` (+ nested comment_likes)
  // is the one collection that is genuinely detail-only — it's read
  // exclusively by CommentNode/CommentsSection/LeagueDetail, never by
  // anything that scans every league — and it's also the single largest,
  // fastest-growing nested collection (unbounded free-text replies plus a
  // nested comment_likes join), so it's the one piece split out of the
  // bulk load and fetched lazily instead, per open league, below.
  const LEAGUE_LIST_SELECT =
    "*, teams!teams_league_id_fkey(*), fixtures(*), members(*), ladder_cup_entries(*), ladder_cup_matches(*), ladder_cup_walkover_claims(*), ladder_cup_second_life_offers(*), ladder_cup_pool_sightings(*), " +
    "result_submissions(id, fixture_id, status, created_at, submitted_by, submitted_by_username, photo_path, home_score, away_score, pens_home, pens_away), " +
    "league_reactions(id, user_id, reaction)";

  const LEAGUE_COMMENTS_SELECT =
    "id, league_id, parent_comment_id, user_id, username, body, created_at, photo_url, is_result, voice_url, voice_duration, fixture_id, ladder_cup_match_id, " +
    "comment_likes(id, user_id, reaction)";

  // Full per-league shape (LEAGUE_LIST_SELECT + comments) — used by
  // refreshLeague/refreshLeagues below, which only ever re-fetch one or a
  // few leagues at a time after a mutation (often a comment mutation
  // itself), so paying for comments there is cheap and keeps them fresh
  // without a second round trip.
  const LEAGUE_SELECT =
    LEAGUE_LIST_SELECT + ", comments(" + LEAGUE_COMMENTS_SELECT + ")";

  const loadLeagues = useCallback(async () => {
    const { data, error } = await supabase
      .from("leagues")
      .select(LEAGUE_LIST_SELECT)
      .order("created_at", { ascending: false });
    if (error) { showToast("Couldn't load leagues."); setLeagues([]); return; }
    setLeagues(data || []);
  }, [showToast]);

  // Every mutation used to follow itself with a full loadLeagues() — a
  // re-fetch of every league on the whole platform (every team, fixture,
  // member, comment, like, result, reaction) just to reflect one comment
  // getting liked or one result getting recorded. That cost scaled with
  // total platform content AND with how often anyone did anything.
  // refreshLeague/refreshLeagues below re-fetch only the specific league(s)
  // a given action actually touched, using the exact same LEAGUE_SELECT
  // shape, and merge the result(s) into local state by id — so the "server
  // is the source of truth, just re-fetch" safety property every call site
  // already relied on is unchanged, only the scope of what gets re-fetched.
  // Doubles as the merge path for a brand-new league (createLeague): a
  // league whose id isn't in local state yet gets appended, not just
  // replaced, so callers don't need a separate "add" case.
  // Merges by id, not replaces — the lazy comments-only fetch below calls
  // this with a stub row ({ id, comments }), and a full replace would wipe
  // every other field (teams, fixtures, members, result_submissions...) off
  // the already-loaded league the instant someone opened it, crashing
  // anything downstream that reads league.teams/fixtures for that league.
  // refreshLeague/refreshLeagues pass complete rows (full LEAGUE_SELECT), so
  // merging is a no-op difference for them — every field they carry just
  // overwrites the old value as before.
  const mergeLeaguesById = useCallback((rows) => {
    setLeagues((prev) => {
      const base = prev || [];
      const byId = new Map(base.map((l) => [l.id, l]));
      rows.forEach((row) => byId.set(row.id, { ...(byId.get(row.id) || {}), ...row }));
      // Preserve the same order loadLeagues would produce (newest created
      // first) rather than however Map iteration/insertion happens to land.
      return [...byId.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    });
  }, []);

  // Lazily fills in `comments` for whichever league is actually open,
  // rather than every league carrying its full comment history in memory
  // and over the wire on every load (see LEAGUE_LIST_SELECT above). Skips
  // the fetch if this league already has comments loaded — e.g. right
  // after refreshLeague/refreshLeagues ran and merged them in already.
  useEffect(() => {
    if (!activeLeagueId) return;
    const current = (leagues || []).find((l) => l.id === activeLeagueId);
    if (current && current.comments) return;
    let cancelled = false;
    supabase
      .from("comments")
      .select(LEAGUE_COMMENTS_SELECT)
      .eq("league_id", activeLeagueId)
      .then(({ data, error }) => {
        if (cancelled || error) return;
        mergeLeaguesById([{ id: activeLeagueId, comments: data || [] }]);
      });
    return () => { cancelled = true; };
  }, [activeLeagueId, leagues, mergeLeaguesById]);

  const refreshLeague = useCallback(async (leagueId) => {
    if (!leagueId) return;
    const { data, error } = await supabase.from("leagues").select(LEAGUE_SELECT).eq("id", leagueId).maybeSingle();
    if (error) { showToast("Couldn't refresh the league — try reloading."); return; }
    if (!data) { setLeagues((prev) => (prev || []).filter((l) => l.id !== leagueId)); return; } // deleted/no longer visible
    mergeLeaguesById([data]);
  }, [showToast, mergeLeaguesById]);

  const refreshLeagues = useCallback(async (leagueIds) => {
    const ids = [...new Set((leagueIds || []).filter(Boolean))];
    if (ids.length === 0) return;
    const { data, error } = await supabase.from("leagues").select(LEAGUE_SELECT).in("id", ids);
    if (error) { showToast("Couldn't refresh leagues — try reloading."); return; }
    mergeLeaguesById(data || []);
  }, [showToast, mergeLeaguesById]);



  // Public setting (no auth required to read — guests need it too, see
  // PublicHome's own copy of this query), so this loads regardless of
  // sign-in state rather than waiting on the session/isAdmin effect below.
  const loadWeekendOverride = useCallback(async () => {
    const { data, error } = await supabase.from("app_settings").select("weekend_league_override").eq("id", 1).maybeSingle();
    if (error) return; // table may not exist yet if the migration hasn't been run — fail quiet, spotlight just falls back to the auto schedule
    setWeekendOverrideState(data?.weekend_league_override ?? null);
  }, []);

  // Admin-only. Writing null clears the override and hands control back to
  // the 9pm–9am SAST auto schedule.
  const setWeekendOverride = useCallback(async (value) => {
    const { error } = await supabase.from("app_settings")
      .update({ weekend_league_override: value, weekend_league_override_at: new Date().toISOString(), weekend_league_override_by: session?.user?.id || null })
      .eq("id", 1);
    if (error) { showToast(`Couldn't update Weekend League override: ${error.message}`); return; }
    setWeekendOverrideState(value);
    showToast(value === "paused" ? "Weekend League forced to Paused." : value === "live" ? "Weekend League forced to Live." : "Weekend League back on the auto schedule.");
  }, [session, showToast]);

  useEffect(() => { loadWeekendOverride(); }, [loadWeekendOverride]);
  // Realtime rather than a poll — an admin toggling this on one device
  // (or another admin, elsewhere) should flip everyone's spotlight badge
  // immediately, not on the next visibility-poll tick.
  useRealtimeRefresh("app_settings", loadWeekendOverride, true);

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

  // Admin-only — same shape as loadAccounts above: routed through a
  // security-definer RPC (get_activity_log) rather than a direct select,
  // so the admin check happens server-side and this table never needs a
  // client-readable RLS policy at all.
  const loadActivityLog = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_activity_log", { p_limit: 200 });
    if (error) { showToast("Couldn't load the activity log."); setActivityLog([]); return; }
    setActivityLog(data || []);
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
    // Admins need every row, not just ones they're a participant in — the
    // 30-minute-expired admin-review queue (see adminApproveChallengeResult)
    // depends on this. The admin-only UPDATE calls already assume this same
    // full access with no participant filter, so this just matches that on
    // the read side too.
    let query = supabase.from("challenges").select("*").order("created_at", { ascending: false });
    if (!isAdmin) query = query.or(`challenger_id.eq.${session.user.id},opponent_id.eq.${session.user.id}`);
    const { data, error } = await query;
    if (error) { showToast("Couldn't load challenges."); setChallenges([]); return; }
    setChallenges(data || []);
  }, [session, isAdmin, showToast]);

  // The permanent ladder — every member, ordered by rank_position. Never
  // resets (that's the whole point), unlike seasons/leagues elsewhere in the
  // app. RLS only allows reading this while signed in; the homepage shows
  // its own public_ladder_full view instead (see PublicLadderSection).
  const loadLadder = useCallback(async () => {
    const { data, error } = await supabase.from("ladder_ranks").select("*").order("rank_position", { ascending: true });
    if (error) { console.error("Couldn't load the ladder:", error.message); setLadder([]); return; }
    setLadder(data || []);
  }, []);

  // Lightweight stand-ins for the two things Home's LadderStrip actually
  // needs — the top 5 rows and the viewer's own row — instead of the full
  // unbounded table loadLadder above fetches. See ladderTop5/myLadderRankRow
  // state comments for why this split exists.
  const loadLadderTop5 = useCallback(async () => {
    const { data, error } = await supabase.from("ladder_ranks").select("*").order("rank_position", { ascending: true }).limit(5);
    if (error) { console.error("Couldn't load the ladder top 5:", error.message); return; }
    setLadderTop5(data || []);
  }, []);

  const loadMyLadderRank = useCallback(async () => {
    if (!session) { setMyLadderRankRow(null); return; }
    const { data, error } = await supabase.from("ladder_ranks").select("*").eq("user_id", session.user.id).maybeSingle();
    if (error) { console.error("Couldn't load your ladder rank:", error.message); return; }
    setMyLadderRankRow(data || null);
  }, [session]);

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
  // Used to come from the full ladder list (ladder.find(...)) — but that
  // list is now only loaded on the Ladder page itself (see ladder state
  // comment above), while myLadderRank is also needed on Home (the rank
  // badge, achievement checks). myLadderRankRow is its own targeted
  // single-row fetch, so it stays available regardless of which page is
  // actually loading the full table.
  const myLadderRank = myLadderRankRow;

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
    await loadMyLadderRank();
    if (view === "ladder") await loadLadder(); // keeps ladderTargets' pause filter current if the full list is on screen
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
    logActivity("challenge_sent", { opponent_username: opponent.username, is_ladder: isLadder });
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
    logActivity(accept ? "challenge_accepted" : "challenge_declined", { challenger_username: challenge.challenger_username, is_ladder: challenge.is_ladder });
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
    let photoUrl;
    try {
      photoUrl = await uploadToBlob("result-proofs", path, file);
    } catch (uploadErr) {
      showToast(`Couldn't upload photo: ${uploadErr.message}`);
      return;
    }

    const iAmChallenger = challenge.challenger_id === session.user.id;
    const update = {
      challenger_score: iAmChallenger ? myScore : theirScore,
      opponent_score: iAmChallenger ? theirScore : myScore,
      result_status: "pending",
      result_reported_by: session.user.id,
      result_reported_at: new Date().toISOString(),
      result_photo_path: photoUrl,
    };
    const { error } = await supabase.from("challenges").update(update).eq("id", challenge.id);
    if (error) { showToast(`Couldn't log result: ${error.message}`); return; }
    logActivity("match_result_submitted", { context: "challenge", challenge_id: challenge.id });

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
    // New rows store a permanent Blob URL directly — open it as-is. Rows
    // from before the result-proofs migration still hold a Supabase storage
    // path, so fall back to signing those.
    if (challenge.result_photo_path.startsWith("http")) {
      window.open(challenge.result_photo_path, "_blank", "noopener,noreferrer");
      return;
    }
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
  // the opponent had 30 minutes to confirm/dispute and didn't, so an admin can
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
    // Same reasoning as loadChallenges above — an admin reviewing a random
    // challenge they weren't personally part of otherwise never receives
    // that row at all, no matter how expired its confirm window is.
    let query = supabase.from("open_challenges").select("*").order("created_at", { ascending: false }).limit(50);
    if (!isAdmin) query = query.or(`status.eq.open,creator_id.eq.${session.user.id},accepted_by.eq.${session.user.id}`);
    const { data, error } = await query;
    if (error) { showToast("Couldn't load random challenges."); setOpenChallenges([]); return; }
    setOpenChallenges(data || []);
  }, [session, isAdmin, showToast]);

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
      try {
        voice_url = await uploadToBlob("comment-voice-notes", path, voiceClip.blob, voiceClip.blob.type || "audio/webm");
      } catch (uploadErr) { showToast(`Couldn't upload voice note: ${uploadErr.message}`); return false; }
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
    setLadderResults(data || []);
    // Deliberately not fetching/signing result photos here: once a ladder
    // result is confirmed, the screenshot should only ever be visible to
    // the opponent during their confirm step and to an admin during the
    // approval-queue step (both handled separately via onViewResultProof,
    // a 120s single-click signed link) — never in this public recent-
    // matches feed that every ladder viewer sees.
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
      try {
        voice_url = await uploadToBlob("comment-voice-notes", path, voiceClip.blob, voiceClip.blob.type || "audio/webm");
      } catch (uploadErr) { showToast(`Couldn't upload voice note: ${uploadErr.message}`); return false; }
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
    let photoUrl;
    try {
      photoUrl = await uploadToBlob("result-proofs", path, file);
    } catch (uploadErr) {
      showToast(`Couldn't upload photo: ${uploadErr.message}`);
      return;
    }

    const iAmCreator = challenge.creator_id === session.user.id;
    const update = {
      creator_score: iAmCreator ? myScore : theirScore,
      accepted_by_score: iAmCreator ? theirScore : myScore,
      result_status: "pending",
      result_reported_by: session.user.id,
      result_reported_at: new Date().toISOString(),
      result_photo_path: photoUrl,
    };
    const { error } = await supabase.from("open_challenges").update(update).eq("id", challenge.id);
    if (error) { showToast(`Couldn't log result: ${error.message}`); return; }
    logActivity("match_result_submitted", { context: "open_challenge", challenge_id: challenge.id });

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

  // Lets an admin correct a mis-typed score on an escalated (30-minute-
  // expired) result before approving/rejecting it — same idea as
  // editResultForFixture's score correction for league results, but
  // simpler: there's no fixture/standings recompute here, this just
  // overwrites the two stored score columns so Approve then confirms the
  // corrected number instead of whatever was originally (mis)reported.
  const adminEditChallengeResult = async (challenge, homeScore, awayScore) => {
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
      showToast("Enter a valid score for both players.");
      return false;
    }
    const { data, error } = await supabase.from("challenges")
      .update({ challenger_score: homeScore, opponent_score: awayScore })
      .eq("id", challenge.id).select().maybeSingle();
    if (error) { showToast(`Couldn't update the score: ${error.message}`); return false; }
    if (!data) { showToast("Couldn't update — you don't have permission to edit this result."); return false; }
    await loadChallenges();
    showToast("Score corrected.");
    return true;
  };
  const adminEditOpenChallengeResult = async (challenge, homeScore, awayScore) => {
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
      showToast("Enter a valid score for both players.");
      return false;
    }
    const { data, error } = await supabase.from("open_challenges")
      .update({ creator_score: homeScore, accepted_by_score: awayScore })
      .eq("id", challenge.id).select().maybeSingle();
    if (error) { showToast(`Couldn't update the score: ${error.message}`); return false; }
    if (!data) { showToast("Couldn't update — you don't have permission to edit this result."); return false; }
    await loadOpenChallenges();
    showToast("Score corrected.");
    return true;
  };

  useEffect(() => {
    if (session === undefined) return;
    if (!session) { setProfile(undefined); setLeagues(null); setIsAdmin(false); return; }
    supabase.from("profiles").select("*").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setProfile(data || null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on sessionKey, not session; see sessionKey comment above
  }, [sessionKey]);

  useEffect(() => {
    if (!session || !profile) return;
    supabase.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
    loadLeagues();
    loadChallenges();
    loadOpenChallenges();
    loadLadderTop5(); // Home's LadderStrip only — see ladderTop5 comment; the full loadLadder() is loaded on-demand by openLadderScreen instead
    loadMyLadderRank();
    loadChallengeMembers(); // also feeds the Leaderboard's profile photos
    loadTeamAvatars(); // also feeds the Table's club photos
    loadAllAchievements(); // feeds the Wall of Fame
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on sessionKey, not session; see sessionKey comment above
  }, [sessionKey, profile, loadLeagues, loadChallenges, loadOpenChallenges, loadLadderTop5, loadMyLadderRank, loadChallengeMembers, loadTeamAvatars, loadAllAchievements]);

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

  // Full unbounded ladder_ranks table — this used to also run continuously
  // on Home (every 60s, plus on every realtime change from anyone's rank
  // moving anywhere on the platform) even though Home's LadderStrip only
  // ever renders 5-6 rows out of it. That was the single largest recurring
  // PostgREST egress source in the app: an unbounded select("*"), polled
  // from the busiest, most-often-open screen there is. Now scoped to the
  // Ladder page itself, which is the only place that genuinely needs every
  // row (the full leaderboard and the "who can I challenge" target list).
  useRealtimeRefresh("ladder_ranks", loadLadder, view === "ladder" && !!profile);
  useVisibilityPoll(loadLadder, 60000, view === "ladder" && !!profile);

  // Home's lightweight equivalents — top 5 rows plus the viewer's own row,
  // instead of the whole table above. myLadderRankRow (1 row) also needs to
  // stay live everywhere it's read (Home's badge/achievements, and the
  // Ladder page's pause toggle), not just on Home, so it isn't view-gated.
  useRealtimeRefresh("ladder_ranks", loadLadderTop5, view === "home" && !!profile);
  useVisibilityPoll(loadLadderTop5, 60000, view === "home" && !!profile);
  useRealtimeRefresh("ladder_ranks", loadMyLadderRank, !!session);
  useVisibilityPoll(loadMyLadderRank, 60000, !!session);

  // The Challenges screen is a genuine "race to accept" — members watching
  // that screen want the pool to move without a manual refresh, so it stays
  // on the fast realtime + 30s poll. Kept live for admins on every screen
  // too (not just Home/Challenges), otherwise a random-challenge result
  // reported while an admin is off reviewing a league elsewhere would sit
  // stale in state — undercounting adminEscalatedResultCount's header badge
  // until they happened to visit Home or Challenges and trigger a reload.
  useRealtimeRefresh("open_challenges", loadOpenChallenges, view === "challenges" || isAdmin);
  useVisibilityPoll(loadOpenChallenges, 30000, view === "challenges" || isAdmin);

  // Home only needs this for the header's grabbable-count badge and the
  // "still up for grabs" banner — neither is a race the way the Challenges
  // screen above is, so it doesn't need realtime. A realtime subscription
  // here would mean every open Home tab on the platform re-fetching the
  // moment *anyone, anywhere* creates/accepts/cancels a random challenge —
  // for a badge that's fine to be up to two minutes stale. Non-admins only:
  // admins already get the fast realtime+30s combo above on every screen.
  useVisibilityPoll(loadOpenChallenges, 120000, view === "home" && !isAdmin);

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

  const completeProfile = async (phone, username, age, photoFile) => {
    const { data, error } = await supabase.from("profiles")
      .insert({ user_id: session.user.id, phone, efootball_username: username, age })
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
    let avatar_url;
    try {
      avatar_url = await uploadToBlob("avatars", path, file, file.type);
    } catch (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return; }
    const { data, error } = await supabase.from("profiles")
      .update({ avatar_url }).eq("user_id", session.user.id)
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

  // Step 13 will add a proper scheduled job for the hard cutoff; second-life
  // offers get their lazy check here in the meantime (per the integration
  // notes: "call on read, or on a cron"). Runs whenever a ladder_cup league
  // becomes the active one — if any entry's 24h window has lapsed with no
  // response, it converts straight to eliminated, same outcome as an
  // explicit decline. Guarded with a ref so a re-render (or refreshLeague
  // picking up its own write) doesn't re-fire the same expiry twice.
  const expiredLadderCupOffersChecked = useRef(new Set());
  useEffect(() => {
    if (!activeLeague || activeLeague.format !== "ladder_cup") return;
    if (expiredLadderCupOffersChecked.current.has(activeLeague.id)) return;
    const now = new Date();
    const stale = (activeLeague.ladder_cup_entries || []).filter((r) =>
      r.status === "pending_second_life" && r.second_life_expires_at && new Date(r.second_life_expires_at) <= now);
    if (stale.length === 0) return;
    expiredLadderCupOffersChecked.current.add(activeLeague.id);
    (async () => {
      const { error } = await supabase.from("ladder_cup_entries")
        .update({ status: "eliminated", second_life_offered_at: null, second_life_expires_at: null, updated_at: now.toISOString() })
        .in("id", stale.map((r) => r.id));
      if (!error) {
        // Best-effort: record the lapse so a future recompute (see
        // recomputeLadderCupLeague) can tell this was a silent expiry
        // rather than an explicit decline — doesn't change what happened,
        // just what a replay can reconstruct about it later.
        await Promise.all(stale.map((r) => supabase.rpc("record_ladder_cup_second_life_response", {
          p_entry_id: r.id, p_league_id: activeLeague.id, p_team_id: r.team_id, p_response_type: "expired",
        })));
        await refreshLeague(activeLeague.id);
      }
    })();
  }, [activeLeague, refreshLeague]);

  // Self-heal for clubs that ended up on the team list without a matching
  // ladder_cup_entries row — e.g. this league's pre-listed clubs were added
  // before the bulk-insert-at-creation code (see createLeague) existed, so
  // they never got placed on the ladder. Same lazy-check-on-read shape as
  // the two effects above: runs once per league the first time it's
  // active, backfills every missing row via ensureLadderCupEntry (which
  // already no-ops safely if a row exists), then refreshes so standings/
  // the opponent board/Find your opponent all pick the clubs up immediately
  // rather than waiting for their first match.
  const backfilledLadderCupEntriesChecked = useRef(new Set());
  useEffect(() => {
    if (!activeLeague || activeLeague.format !== "ladder_cup") return;
    if (backfilledLadderCupEntriesChecked.current.has(activeLeague.id)) return;
    const entryTeamIds = new Set((activeLeague.ladder_cup_entries || []).map((r) => r.team_id));
    const missing = (activeLeague.teams || []).filter((t) => !entryTeamIds.has(t.id));
    if (missing.length === 0) return;
    backfilledLadderCupEntriesChecked.current.add(activeLeague.id);
    (async () => {
      await Promise.all(missing.map((t) => ensureLadderCupEntry(activeLeague, t.id)));
      await refreshLeague(activeLeague.id);
    })();
  }, [activeLeague, refreshLeague]);
  // the second-life expiry above — fires once per league, the first time
  // it's the active one after hasLadderCupCutoffPassed is true and
  // ladder_cup_finalized_at is still null. No separate scheduled job:
  // every write path already refuses to touch a ladder_cup league once
  // its cutoff has passed (see hasLadderCupCutoffPassed call sites above),
  // so nothing on the board can change between the deadline and whenever
  // someone next opens the league — running this on read rather than on a
  // timer costs nothing.
  //
  // crownChampion only reads club_id/pts/gd/toughest_opponent_beaten_pts/
  // status off each entry, so this maps straight off the raw rows rather
  // than the fuller ladderCupEntryFromRow round-trip (that one's for
  // callers that write a match/claim result back). finalizeAtCutoff's
  // finalizedMatches/finalizedClaims aren't used to change anything — per
  // its own doc comment they never undo points already applied — they're
  // purely to tell players how many in-flight matches/claims got cut off,
  // via the same postComment announcement a normal result gets.
  const finalizedLadderCupCutoffChecked = useRef(new Set());
  useEffect(() => {
    if (!activeLeague || activeLeague.format !== "ladder_cup") return;
    if (activeLeague.ladder_cup_finalized_at) return;
    if (!hasLadderCupCutoffPassed(activeLeague.ladder_cup_cutoff_at)) return;
    // Bug fix: don't crown a champion off a snapshot that still has a
    // lapsed-but-not-yet-converted second-life offer sitting in it — the
    // expiry effect above hasn't necessarily finished writing
    // `eliminated` for it yet (both effects fire off the same render's
    // `activeLeague`), and crownChampion only excludes `eliminated`
    // entries, so a stale `pending_second_life` row would still count as
    // live. Skip this pass without marking it checked; once the expiry
    // effect's write lands and refreshLeague pulls the corrected
    // statuses, activeLeague changes and this effect runs again — that
    // next pass is the one that actually finalizes.
    const hasUnresolvedSecondLifeOffers = (activeLeague.ladder_cup_entries || []).some((r) =>
      r.status === "pending_second_life" && r.second_life_expires_at && new Date(r.second_life_expires_at) <= new Date());
    if (hasUnresolvedSecondLifeOffers) return;
    if (finalizedLadderCupCutoffChecked.current.has(activeLeague.id)) return;
    finalizedLadderCupCutoffChecked.current.add(activeLeague.id);
    (async () => {
      const rows = activeLeague.ladder_cup_entries || [];
      const mapped = rows.map((r) => ({
        club_id: r.team_id, pts: r.pts, gd: r.gd,
        toughest_opponent_beaten_pts: r.toughest_opponent_beaten_pts, status: r.status,
      }));
      const champion = crownChampion(mapped);
      const matches = activeLeague.ladder_cup_matches || [];
      const claims = activeLeague.ladder_cup_walkover_claims || [];
      const { finalizedMatches, finalizedClaims } = finalizeAtCutoff({
        matches, walkoverClaims: claims, cutoff: activeLeague.ladder_cup_cutoff_at,
      });
      const droppedMatches = matches.length - finalizedMatches.length;
      const droppedClaims = claims.length - finalizedClaims.length;

      // Bug fix: this write used to go straight to `leagues` from
      // whichever member's browser got here first — but the RLS UPDATE
      // policy on `leagues` only allows the league's creator or an admin
      // to write to it, so a regular member's browser would silently
      // fail here (no error, `wonRace` just empty) and the league would
      // stay stuck unfinalized until an admin happened to open it. Routed
      // through a SECURITY DEFINER RPC (see finalize-ladder-cup-rpc.sql)
      // that any signed-in user can call, but which can only ever perform
      // this exact narrow update — nothing else on `leagues` is opened up.
      // The RPC's own WHERE clause (format = 'ladder_cup', cutoff passed,
      // not already finalized) does the same "first one here wins" race
      // guard the old `.is("ladder_cup_finalized_at", null)` did.
      const { data: wonRace, error: leagueErr } = await supabase.rpc("finalize_ladder_cup", {
        p_league_id: activeLeague.id,
        p_champion_team_id: champion?.club_id ?? null,
      });
      if (leagueErr) {
        showToast(`Couldn't finalize the Ladder Cup: ${leagueErr.message}`);
        finalizedLadderCupCutoffChecked.current.delete(activeLeague.id); // let a later read retry
        return;
      }
      if (!wonRace || wonRace.length === 0) {
        // Someone else's read already finalized this league between our
        // check above and this write — nothing left for us to do.
        await refreshLeague(activeLeague.id);
        return;
      }
      // The RPC sets this server-side (now()) rather than us passing a
      // client-side timestamp — read it back off the returned row so the
      // champion-row write below stays consistent with what's actually
      // stored on `leagues`.
      const finalizedAt = wonRace[0].ladder_cup_finalized_at;

      if (champion) {
        const champRow = rows.find((r) => r.team_id === champion.club_id);
        if (champRow) {
          // Bug fix: this write was previously unchecked — a failure here
          // left leagues.ladder_cup_champion_team_id (and the finalized
          // banner that reads it) correct while the standings table's
          // crown icon (which reads this row's own `status`) silently
          // never appeared, with no error surfaced anywhere. Now it at
          // least tells the person who finalized the cup that the two
          // views are out of sync, so it can be manually corrected.
          const { error: champErr } = await supabase.from("ladder_cup_entries")
            .update({ status: "champion", updated_at: finalizedAt }).eq("id", champRow.id);
          if (champErr) {
            showToast(`Champion crowned, but their ladder status couldn't be updated: ${champErr.message}`);
          }
        }
      }

      const teamsById = Object.fromEntries((activeLeague.teams || []).map((t) => [t.id, t]));
      const championName = champion ? (teamsById[champion.club_id]?.name || "Unknown club") : null;
      let announcement = championName
        ? `Ladder Cup cutoff reached — ${championName} crowned champion with ${champion.pts} pts.`
        : "Ladder Cup cutoff reached — no eligible champion (every club was eliminated).";
      const droppedBits = [
        droppedMatches > 0 && `${droppedMatches} match${droppedMatches === 1 ? "" : "es"} still in progress`,
        droppedClaims > 0 && `${droppedClaims} walkover claim${droppedClaims === 1 ? "" : "s"} not yet approved`,
      ].filter(Boolean);
      if (droppedBits.length > 0) announcement += ` ${droppedBits.join(" and ")} didn't count.`;
      await postComment(activeLeague, announcement, null, null, null, false, null, null);

      await refreshLeague(activeLeague.id);
    })();
  }, [activeLeague, refreshLeague, showToast]);

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
    if (isFixtureLocked(fixture, activeLeague)) {
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

  // Results (regular challenges and random/open challenges alike) whose
  // 30-minute opponent-confirm window has lapsed move into the admin queue
  // shown at the top of ChallengesScreen — but until now nothing surfaced
  // that anywhere else, so an admin not already sitting on that screen the
  // moment the window lapsed had no way to know it needed them. Folding
  // this into the header badge (below) means it's visible from any screen.
  const adminEscalatedResultCount = useMemo(() => {
    if (!isAdmin) return 0;
    const expiredPending = (ch) => ch.result_status === "pending" && challengeResultConfirmExpired(ch);
    return (challenges || []).filter(expiredPending).length + (openChallenges || []).filter(expiredPending).length;
  }, [isAdmin, challenges, openChallenges, appNow]);

  const myMembership = (league) => (session ? (league.members || []).find((m) => m.user_id === session.user.id) : null);
  const isMemberOf = (league) => !!myMembership(league);
  // null for fun leagues / non-members; "pending" | "approved" | "rejected" for cash league members.
  const myPaymentStatus = (league) => myMembership(league)?.payment_status || null;
  // Creating a league or being a platform admin gives management rights,
  // but doesn't by itself count as having joined — the creator/admin can
  // still choose to register a club and join like any other player.
  const canManageLeague = (league) => !!session && (isAdmin || league.created_by === session.user.id);

  // Sweeps every league the signed-in member can manage, the moment league
  // data loads (or reloads), and auto-eliminates any club caught in a
  // no-show tie — see findNoShowTeamIds. This is what makes the cut
  // automatic: it doesn't wait for a round/stage to fully finish or for an
  // admin to hit an "advance" button, and it runs across every league and
  // every format, not just knockout/survivor/groups where a manual
  // elimination path already existed. Re-runs whenever `leagues` changes;
  // once a league's no-shows are eliminated they no longer match
  // findNoShowTeamIds (they're marked eliminated), so the follow-up
  // loadLeagues() this triggers doesn't loop.
  useEffect(() => {
    if (!leagues || !session) return;
    const targets = leagues
      .map((l) => ({ league: l, ids: canManageLeague(l) ? findNoShowTeamIds(l) : [] }))
      .filter(({ ids }) => ids.length > 0);
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      const allIds = targets.flatMap(({ ids }) => ids);
      // Same permission-check pattern as advanceKnockout/advanceSurvivor/
      // finalizeGroups: don't just trust the update call succeeded — count
      // what actually came back and say so if RLS quietly blocked some rows,
      // instead of the admin only finding out because a club is still
      // showing as active days later.
      const { data: updatedRows, error } = await supabase.from("teams").update({ eliminated: true }).in("id", allIds).select("id");
      if (cancelled) return;
      if (error) { showToast(`Couldn't auto-eliminate no-show clubs: ${error.message}`); return; }
      const updatedIds = new Set((updatedRows || []).map((r) => r.id));
      if (updatedIds.size === 0) return; // every row blocked — nothing changed, nothing to reload or announce

      // Drop an auto-posted comment in each affected league's feed — the
      // same "isResult" system-comment mechanism already used for
      // auto-posted matchday results — so the eliminated club sees it
      // directly next time they open that league, instead of only finding
      // out passively via their own "you've been eliminated" status line.
      const announcedLeagueNames = [];
      for (const { league, ids } of targets) {
        const eliminatedHere = ids.filter((id) => updatedIds.has(id));
        if (eliminatedHere.length === 0) continue;
        announcedLeagueNames.push(league.name);
        const names = eliminatedHere.map((id) => {
          const team = league.teams.find((t) => t.id === id);
          const owner = (league.members || []).find((m) => m.team_id === id);
          return owner?.display_name ? `${team?.name || "A club"} (${owner.display_name})` : (team?.name || "A club");
        });
        const body = names.length === 1
          ? `${names[0]} was automatically eliminated — missed a match past its deadline, and the no-show penalty already put them at -4 on it.`
          : `${names.join(", ")} were automatically eliminated — missed a match past its deadline, and the no-show penalty already put them at -4 on it.`;
        await postComment(league, body, null, null, null, true);
      }

      await refreshLeagues(targets.map(({ league }) => league.id));
      const updatedCount = updatedIds.size;
      const where = announcedLeagueNames.length === 1 ? ` in "${announcedLeagueNames[0]}"` : ` across ${announcedLeagueNames.length} leagues`;
      if (updatedCount < allIds.length) {
        showToast(`${updatedCount} of ${allIds.length} no-show clubs${where} were auto-eliminated — the rest hit a permissions issue and will retry next reload.`);
        return;
      }
      showToast(`${updatedCount} club${updatedCount === 1 ? "" : "s"} eliminated automatically${where} — no-show on a match past its deadline.`);
    })();
    return () => { cancelled = true; };
  }, [leagues, session, isAdmin, refreshLeagues, showToast]);

  // Same lazy-sweep shape as the no-show effect just above, for a
  // different rule: a Ladder Cup club that's gone 24h since joining
  // without ever tapping a WhatsApp icon to make contact (see
  // hasMissedJoinContactWindow / markLadderCupFirstContact) is removed
  // from the league entirely — not just marked eliminated. There's no run
  // on the board to preserve (they never played), so this deletes the
  // teams row outright, same call removeTeam already makes for an
  // admin-initiated removal — and deliberately does NOT backfill or
  // replace them with anyone else; the ladder just runs one club short.
  useEffect(() => {
    if (!leagues || !session) return;
    const now = new Date();
    const targets = leagues
      .map((l) => ({
        league: l,
        ids: (canManageLeague(l) && l.format === "ladder_cup")
          ? (l.ladder_cup_entries || []).filter((row) => hasMissedJoinContactWindow(row, now)).map((row) => row.team_id)
          : [],
      }))
      .filter(({ ids }) => ids.length > 0);
    if (targets.length === 0) return;
    let cancelled = false;
    (async () => {
      const allIds = targets.flatMap(({ ids }) => ids);
      await supabase.from("members").delete().in("team_id", allIds);
      // Same "count what actually came back" pattern as the no-show sweep —
      // an RLS block on some rows shouldn't silently look like success.
      const { data: deletedRows, error } = await supabase.from("teams").delete().in("id", allIds).select("id");
      if (cancelled) return;
      if (error) { showToast(`Couldn't auto-remove inactive clubs: ${error.message}`); return; }
      const deletedIds = new Set((deletedRows || []).map((r) => r.id));
      if (deletedIds.size === 0) return;

      const announcedLeagueNames = [];
      for (const { league, ids } of targets) {
        const removedHere = ids.filter((id) => deletedIds.has(id));
        if (removedHere.length === 0) continue;
        announcedLeagueNames.push(league.name);
        const names = removedHere.map((id) => league.teams.find((t) => t.id === id)?.name || "A club");
        const body = names.length === 1
          ? `${names[0]} was automatically removed from the Ladder Cup — no contact with an opponent within 24h of joining. Not replaced.`
          : `${names.join(", ")} were automatically removed from the Ladder Cup — no contact with an opponent within 24h of joining. Not replaced.`;
        await postComment(league, body, null, null, null, true);
      }

      await refreshLeagues(targets.map(({ league }) => league.id));
      const removedCount = deletedIds.size;
      const where = announcedLeagueNames.length === 1 ? ` in "${announcedLeagueNames[0]}"` : ` across ${announcedLeagueNames.length} leagues`;
      if (removedCount < allIds.length) {
        showToast(`${removedCount} of ${allIds.length} inactive clubs${where} were auto-removed — the rest hit a permissions issue and will retry next reload.`);
        return;
      }
      showToast(`${removedCount} club${removedCount === 1 ? "" : "s"} auto-removed${where} — no contact made within 24h of joining.`);
    })();
    return () => { cancelled = true; };
  }, [leagues, session, isAdmin, refreshLeagues, showToast]);


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
  // "Entry closed" covers two independent reasons: the admin set a manual
  // entry_closes_at cutoff (any format other than ladder_cup), or this is a
  // ladder_cup league whose own hard cutoff has already passed. Survival
  // Ladder Cup has no separate entry-close date of its own — clubs can join
  // right up until the ladder's weekly cutoff — so entry_closes_at is
  // deliberately ignored for that format even if an old row still has one
  // set. Extending this single function (rather than adding a parallel
  // check) means the fix reaches every place that already gates on it: the
  // Join button's visibility on LeagueCard, Home's isJoinable sort, and
  // both join handlers below.
  // ladder_cup_started_at (see startLadderCupLeague below) is a status
  // marker only — clubs keep registering right up to the cutoff/finalize,
  // same as before the Start button existed. It intentionally does NOT
  // factor into entryClosed.
  const entryClosed = (league) =>
    (league.format !== "ladder_cup" && league.entry_closes_at && new Date(league.entry_closes_at) < new Date())
    || (league.format === "ladder_cup" && hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at));

  // Admin-created leagues (except Knockout and Survival Ladder Cup itself —
  // gating entry to a Ladder Cup on having already placed top 20% in one
  // would lock out anyone who hasn't qualified yet from ever getting the
  // chance to) require the joining club to have finished in the top 20% of
  // some completed Survival Ladder Cup at least once. "The club" is
  // resolved the same way joinLeague itself resolves team identity — by
  // matching the profile's efootball_username against a league's team
  // names — since that's the only identity a club carries across leagues.
  // Only finalized Ladder Cups count (an in-progress one hasn't produced a
  // real final standing yet); ties share a rank_position
  // (rankLadderCupStandings' "1224" ranking), so the qualifying cutoff is
  // ceil(entries * 0.2), and anyone whose rank_position falls at or inside
  // that cutoff qualifies, ties included.
  const hasQualifyingLadderCupFinish = useMemo(() => {
    const myName = profile?.efootball_username?.trim().toLowerCase();
    if (!myName) return false;
    return (leagues || []).some((l) => {
      if (l.format !== "ladder_cup" || !l.ladder_cup_finalized_at) return false;
      const teamsById = Object.fromEntries((l.teams || []).map((t) => [t.id, t]));
      const entries = (l.ladder_cup_entries || []).map((r) => ({
        club_id: r.team_id,
        club_name: teamsById[r.team_id]?.name || "",
        pts: r.pts, gd: r.gd, toughest_opponent_beaten_pts: r.toughest_opponent_beaten_pts,
      }));
      if (entries.length === 0) return false;
      const qualifyingCount = Math.max(1, Math.ceil(entries.length * 0.2));
      return rankLadderCupStandings(entries).some((e) =>
        e.rank_position <= qualifyingCount && e.club_name.trim().toLowerCase() === myName);
    });
  }, [leagues, profile]);

  const qualifiesForLeague = (league) =>
    !league.created_by_admin || league.format === "knockout" || league.format === "ladder_cup" || hasQualifyingLadderCupFinish;

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
    const { name, teamNames, format, survivor, groups, knockoutLegs, ladderCupCutoffAt, entryClosesAt, startsAt, description, leagueType, roundPeriodHours } = input;
    const insertPayload = {
      name, created_by: session.user.id, format,
      // Survival Ladder Cup has no entry-close date of its own — clubs join
      // until the ladder's own cutoff, not a separate registration window —
      // so entry_closes_at is always stored as null for this format,
      // regardless of what CreateLeague happened to pass in.
      entry_closes_at: format === "ladder_cup" ? null : entryClosesAt, starts_at: startsAt,
      description: description || null,
      round_period_hours: roundPeriodHours || DEFAULT_ROUND_PERIOD_HOURS,
      // Drives the guest homepage's Weekend League spotlight — only leagues
      // an admin actually created should ever show up there, so this is
      // captured once at creation time rather than re-derived later (a
      // league's creator obviously doesn't change, but who counts as an
      // admin could, and we don't want that retroactively flipping which
      // past leagues appear).
      created_by_admin: isAdmin,
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
    if (format === "ladder_cup") {
      insertPayload.ladder_cup_cutoff_at = ladderCupCutoffAt;
    }

    const { data: league, error } = await supabase.from("leagues").insert(insertPayload).select().single();
    if (error) { showToast(`Couldn't create league: ${error.message}`); return; }
    logActivity("league_created", { league_id: league.id, league_name: league.name, format });

    // Pre-listed clubs are added as registered teams. For every other
    // format, fixtures are NOT generated yet — the league stays open for
    // registration so the admin gets a chance to remove any club before
    // starting, and "Start league & generate fixtures" does that later.
    // Ladder Cup has no such start step: a club is live on the ladder (i.e.
    // has a ladder_cup_entries row) the instant it's registered, whether
    // pre-listed here or self-joined later — see ensureLadderCupEntry.
    if (teamNames.length >= 2) {
      const { data: newTeams, error: teamErr } = await supabase.from("teams")
        .insert(teamNames.map((n) => ({ league_id: league.id, name: n }))).select();
      if (teamErr) { showToast(`Couldn't add clubs: ${teamErr.message}`); return; }
      if (format === "ladder_cup") {
        // Same RLS-safe RPC as ensureLadderCupEntry — a raw bulk insert here
        // hits the identical "new row violates row-level security policy"
        // rejection a self-join's insert did, since it's the same table and
        // the same missing client-side INSERT grant.
        const results = await Promise.all(newTeams.map((t) =>
          supabase.rpc("ensure_ladder_cup_entry", { p_league_id: league.id, p_team_id: t.id })));
        const entryErr = results.find((r) => r.error)?.error;
        if (entryErr) showToast(`Clubs added, but their ladder entries failed to set up: ${entryErr.message}. Contact support.`);
      }
      showToast(format === "ladder_cup"
        ? `League created — ${teamNames.length} club${teamNames.length === 1 ? "" : "s"} pre-listed and live on the ladder now. More clubs can join until entry closes.`
        : `League created — ${teamNames.length} club${teamNames.length === 1 ? "" : "s"} pre-listed. Review the list, then start the league when ready.`);
    } else {
      showToast(format === "ladder_cup"
        ? "League created — open for registration. Clubs are live on the ladder the moment they join."
        : "League created — open for registration. Players can join, then you can start it.");
    }

    await refreshLeague(league.id);
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
    await refreshLeague(league.id);
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
      .from("leagues").select("format, groups_count, group_stage_due_at, group_qualifiers, knockout_legs, round_period_hours, teams!teams_league_id_fkey(*), fixtures(*)").eq("id", league.id).single();
    if (freshErr || !fresh) { showToast("Couldn't confirm the latest results — try again."); return; }

    const groupFixtures = fresh.fixtures.filter((f) => f.stage === 1);
    const unplayed = groupFixtures.filter((f) => !f.played && !isFixtureLocked(f, fresh));
    if (unplayed.length > 0) { showToast(`${unplayed.length} group match(es) still need a result.`); return; }

    const groupsCount = fresh.groups_count;
    const qualifiers = [];
    const eliminatedIds = [];
    for (let g = 0; g < groupsCount; g++) {
      const groupTeams = fresh.teams.filter((t) => t.group_number === g);
      if (groupTeams.length === 0) continue;
      const groupFx = groupFixtures.filter((f) => groupTeams.some((t) => t.id === f.home_team_id));
      const standings = computeStandings(groupTeams, groupFx, fresh);
      // A club auto-eliminated mid-group-stage (findNoShowTeamIds — no-show
      // penalties) can still out-rank an opponent on points/gd earned
      // before it was cut. Its already-played fixtures still have to count
      // for real toward every OTHER team's standings (hence filtering
      // AFTER computeStandings, not before, which would silently drop
      // those fixtures for everyone), but the eliminated club itself can never
      // be a qualifier — bug: without this filter, an already-eliminated
      // club could rank in the top N and get pushed straight into the
      // knockout bracket as a "qualifier" despite eliminated: true.
      const eligible = standings.filter((r) => !r.eliminated);
      const n = Math.min(fresh.group_qualifiers, eligible.length);
      eligible.slice(0, n).forEach((r) => qualifiers.push(r.id));
      eligible.slice(n).forEach((r) => eliminatedIds.push(r.id));
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

    // Pass the outer `league` (not `fresh`) here — knockoutBracketFixtures
    // needs created_by_admin/starts_at to know if this is a weekend league
    // (see isWeekendLeague), and those never go stale the way scores/teams
    // do, so the outer object is fine and `fresh` doesn't select them.
    const fixtureRows = knockoutBracketFixtures(league.id, shuffle(qualifiers), 0, new Date(), fresh.knockout_legs, { ...league, round_period_hours: fresh.round_period_hours });
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;

    const { error: updErr } = await supabase.from("leagues")
      .update({ current_stage: 2, final_stage_started: true }).eq("id", league.id);
    if (updErr) { showToast(`Couldn't update league: ${updErr.message}`); return; }

    await refreshLeague(league.id);
    showToast(`Knockout stage started — ${qualifiers.length} clubs through.`);
  };

  const joinInFlight = useRef(new Set());
  // Same idea as joinInFlight, for the admin-side actions that generate or
  // advance fixtures — a double-tap here (easy to do on mobile) would fire
  // the insert twice before the button's derived `disabled` state catches
  // up, which can duplicate a whole round of fixtures.
  const stageActionInFlight = useRef(new Set());
  // Ladder Cup has no separate "start the league" step (unlike the
  // fixtures-based formats) — a club is live in the ladder the moment its
  // `teams` row exists, whether that happened via a pre-listed club at
  // creation (see createLeague) or a fresh self-join here. Called right
  // after a brand-new team row is inserted; a no-op for every other format.
  // Routed through the ensure_ladder_cup_entry RPC rather than a direct
  // table insert — regular authenticated clients don't have INSERT
  // privileges on ladder_cup_entries (RLS rejects it: "new row violates
  // row-level security policy"), so this needs the same SECURITY DEFINER
  // treatment already used for the finalize write. The RPC's own
  // ON CONFLICT DO NOTHING makes a retry (e.g. after a network hiccup, or
  // the backfill effect re-checking a team that got an entry moments ago)
  // a safe no-op — no error code to swallow client-side anymore.
  const ensureLadderCupEntry = async (league, teamId) => {
    if (league.format !== "ladder_cup" || !teamId) return;
    const { error } = await supabase.rpc("ensure_ladder_cup_entry", { p_league_id: league.id, p_team_id: teamId });
    if (error) {
      showToast(`Club registered, but its ladder entry failed to set up: ${error.message}. Contact the league admin.`);
    }
  };

  // Fires the moment a club taps ANY WhatsApp icon on its Ladder Cup
  // opponent board (the "Challenge" call icon or the walkover one) — that's
  // the "made contact" signal the 24h join-contact window is watching for
  // (see hasMissedJoinContactWindow / the join-contact sweep effect below).
  // Best-effort and silent: this rides along with a wa.me link that's
  // already opening in a new tab, so a failed write here shouldn't show an
  // error over what the person is actually doing. No refreshLeague either —
  // nothing about the visible board changes from this alone; the sweep
  // effect picks up the new timestamp next time leagues reload.
  const markLadderCupFirstContact = async (league, teamId) => {
    if (!teamId || league.format !== "ladder_cup") return;
    await supabase.rpc("mark_ladder_cup_first_contact", { p_league_id: league.id, p_team_id: teamId });
  };

  // Records "club X has now been shown club Y as a possible opponent" —
  // starts that pairing's 12h POOL_CONTACT_WINDOW_HOURS clock, if/when it
  // becomes the "live" one (see ladderCupOpponentTimerState /
  // ladder_cup_pool_sightings). Idempotent
  // server-side (on-conflict-do-nothing), but LeagueDetail.jsx also dedupes
  // client-side against sightings already in league.ladder_cup_pool_sightings
  // before calling this, so it's only actually fired once per newly-seen
  // pairing rather than on every render. Optimistic local insert first, same
  // reasoning as every other ladder cup write here — the UI (and the
  // dedupe check on the next render) shouldn't have to wait on the network
  // round-trip to know this pairing is now being tracked.
  const ensureLadderCupPoolSighting = async (league, teamId, opponentTeamId) => {
    if (!teamId || !opponentTeamId || league.format !== "ladder_cup") return;
    const seenAt = new Date().toISOString();
    setLeagues((prev) => (prev || []).map((lg) => {
      if (lg.id !== league.id) return lg;
      const already = (lg.ladder_cup_pool_sightings || []).some((s) => s.team_id === teamId && s.opponent_team_id === opponentTeamId);
      if (already) return lg;
      return {
        ...lg,
        ladder_cup_pool_sightings: [...(lg.ladder_cup_pool_sightings || []), { league_id: league.id, team_id: teamId, opponent_team_id: opponentTeamId, first_seen_at: seenAt, contacted_at: null }],
      };
    }));
    await supabase.rpc("ensure_ladder_cup_pool_sighting", { p_league_id: league.id, p_team_id: teamId, p_opponent_team_id: opponentTeamId });
  };

  // Per-opponent version of markLadderCupFirstContact, fired alongside it
  // from the same WhatsApp icon tap — this is the signal that exempts THIS
  // specific opponent from expiring off the caller's own board (see
  // ladderCupOpponentTimerState), distinct from the club-wide "made contact with
  // someone" signal the join-contact window watches for.
  const markLadderCupPoolContact = async (league, teamId, opponentTeamId) => {
    if (!teamId || !opponentTeamId || league.format !== "ladder_cup") return;
    const contactedAt = new Date().toISOString();
    setLeagues((prev) => (prev || []).map((lg) => (
      lg.id !== league.id ? lg : {
        ...lg,
        ladder_cup_pool_sightings: (lg.ladder_cup_pool_sightings || []).some((s) => s.team_id === teamId && s.opponent_team_id === opponentTeamId)
          ? lg.ladder_cup_pool_sightings.map((s) => (s.team_id === teamId && s.opponent_team_id === opponentTeamId ? { ...s, contacted_at: s.contacted_at || contactedAt } : s))
          : [...(lg.ladder_cup_pool_sightings || []), { league_id: league.id, team_id: teamId, opponent_team_id: opponentTeamId, first_seen_at: contactedAt, contacted_at: contactedAt }],
      }
    )));
    await supabase.rpc("mark_ladder_cup_pool_contact", { p_league_id: league.id, p_team_id: teamId, p_opponent_team_id: opponentTeamId });
  };

  // Step 9: opponent slate + challenge flow. Tapping an opponent on the
  // board doesn't create a "pending" invite the way the platform-wide
  // Ladder's `challenges` table does — Ladder Cup has no accept/decline
  // step (see the ruleset: matching is by ladder-points band, not mutual
  // consent) — so this goes straight to a `ladder_cup_matches` row with
  // home/away already decided. That row IS the "challenge is live" state;
  // there's no separate table for it.
  const ladderCupPendingMatchWith = (league, myTeamId, opponentTeamId) =>
    (league.ladder_cup_matches || []).find((m) =>
      !m.finalized_at &&
      ((m.home_team_id === myTeamId && m.away_team_id === opponentTeamId) ||
       (m.away_team_id === myTeamId && m.home_team_id === opponentTeamId)));

  const initiateLadderCupMatch = async (league, myTeamId, opponentTeamId) => {
    if (!myTeamId || !opponentTeamId) return;
    if (hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) { showToast("The Ladder Cup cutoff has passed — no new matches."); return; }
    // Belt-and-suspenders against a double-tap creating two rows for the
    // same pairing before refreshLeague's response lands — the DB has no
    // unique constraint on this table (a rematch after a finalized result
    // is legitimate), so the check has to happen here too (the RPC below
    // re-checks it server-side against the race a client-only check can't
    // close).
    if (ladderCupPendingMatchWith(league, myTeamId, opponentTeamId)) {
      showToast("You've already got a match set up with them.");
      return;
    }
    // Routed through the initiate_ladder_cup_match RPC rather than a direct
    // insert — same RLS-safe pattern as ensure_ladder_cup_entry (see
    // supabase/migrations/20260815_ladder_cup_match_rpc.sql). Home/away is
    // now decided inside the function, so the client's own assignHomeTeam
    // call is gone — its result would have no bearing on what's actually
    // inserted.
    const { data, error } = await supabase.rpc("initiate_ladder_cup_match",
      { p_league_id: league.id, p_team_id: myTeamId, p_opponent_team_id: opponentTeamId });
    if (error) {
      // The client-side ladderCupPendingMatchWith check above is only as
      // fresh as this league's last refreshLeague — if a match was created
      // in a session/tab that didn't feed back into this one, the RPC's own
      // "already set up" guard catches what the client-side check missed.
      // Treat it the same way as if the client-side check had caught it
      // (refresh so the row re-renders in the right state) instead of
      // showing the raw RPC error.
      if (/already set up/i.test(error.message)) {
        await refreshLeague(league.id);
        showToast("You've already got a match set up with them.");
        return;
      }
      showToast(`Couldn't set up the match: ${error.message}`);
      return;
    }
    await refreshLeague(league.id);
    showToast("Challenge set up — go play it.");
  };

  // Either side can back out of a match that hasn't had its length set yet
  // (no result exists to protect at that point — recordLadderCupWin only
  // ever runs on a completed result, so nothing on the standings depends
  // on this row). Once a length's set the row stays as-is; result logging
  // (step 10) is what moves it forward from there.
  const cancelLadderCupMatch = async (league, match) => {
    const { error } = await supabase.from("ladder_cup_matches").delete().eq("id", match.id);
    if (error) { showToast(`Couldn't cancel the match: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast("Match cancelled.");
  };

  // Full round-trip conversion between a raw ladder_cup_entries row and the
  // pure engine's entry shape. The standings table's own mapper
  // (toLadderCupEngineEntries in LeagueDetail.jsx) only carries the handful
  // of fields rendering needs — recordLadderCupWin needs the complete
  // shape (w/l/streak/status/second-life state/badge counts), so this is a
  // separate, fuller mapper living next to the handler that actually
  // writes results back. badge_walkover isn't part of the round trip —
  // recordLadderCupWin never touches it, that's step 12's column.
  const ladderCupEntryFromRow = (row, clubName) => ({
    club_id: row.team_id,
    club_name: clubName,
    pts: row.pts, w: row.w, l: row.l, gd: row.gd, streak: row.streak,
    // Separate from pts — see formats/ladderCup.js. Falls back to the
    // starting rating for any row written before this column existed.
    ladder_rating: row.ladder_rating ?? LADDER_CUP_RULES.RATING_START,
    status: row.status,
    second_life_used: row.second_life_used,
    second_life_offer: row.second_life_offered_at
      ? { offered_at: row.second_life_offered_at, expires_at: row.second_life_expires_at }
      : null,
    toughest_opponent_beaten_pts: row.toughest_opponent_beaten_pts,
    badge_counts: {
      heater_wins: row.badge_heater_tier,
      giant_slayer: row.badge_giant_slayer,
      second_life: row.badge_second_life,
      bounty_hunter: row.badge_bounty_hunter,
    },
    // Step 14 (rebirth) — display-only, see formats/ladderCup.js. Falls
    // back for any row written before these columns existed.
    rebirth_count: row.rebirth_count || 0,
    past_lives: row.past_lives || [],
  });
  const ladderCupRowPatchFromEntry = (entry) => ({
    pts: entry.pts, w: entry.w, l: entry.l, gd: entry.gd, streak: entry.streak,
    ladder_rating: entry.ladder_rating,
    status: entry.status,
    second_life_used: entry.second_life_used,
    second_life_offered_at: entry.second_life_offer?.offered_at ?? null,
    second_life_expires_at: entry.second_life_offer?.expires_at ?? null,
    toughest_opponent_beaten_pts: entry.toughest_opponent_beaten_pts,
    badge_heater_tier: entry.badge_counts.heater_wins,
    badge_giant_slayer: entry.badge_counts.giant_slayer,
    badge_second_life: entry.badge_counts.second_life,
    badge_bounty_hunter: entry.badge_counts.bounty_hunter,
    updated_at: new Date().toISOString(),
  });

  // Routed through apply_ladder_cup_entry_result (RPC, security definer —
  // see supabase/migrations/20260819_ladder_cup_entry_result_rpc.sql)
  // instead of a direct .update() on ladder_cup_entries. That table
  // already rejects a plain client INSERT under RLS (see
  // ensure_ladder_cup_entry's comment), and the same policy blocks these
  // UPDATEs too — which is why confirmed results were silently failing to
  // land on the standings table / elimination status despite the match
  // itself finalizing fine. teamAId/teamBId are the two clubs the RPC
  // checks caller membership against (self-serve paths) alongside
  // leagues.created_by (admin paths).
  // badgeWalkoverCount is passed separately (not part of entry.badge_counts,
  // same asymmetry ladderCupRowPatchFromEntry's callers already work
  // around — see the badge_walkover comment at the approve-claim call
  // site below) — defaults to the row's existing count so ordinary result
  // confirms leave it untouched.
  const applyLadderCupEntryPatch = async (leagueId, entryId, teamAId, teamBId, entry, badgeWalkoverCount) => {
    const { error } = await supabase.rpc("apply_ladder_cup_entry_result", {
      p_entry_id: entryId, p_league_id: leagueId, p_team_a_id: teamAId, p_team_b_id: teamBId,
      p_pts: entry.pts, p_w: entry.w, p_l: entry.l, p_gd: entry.gd, p_streak: entry.streak,
      p_status: entry.status,
      p_second_life_used: entry.second_life_used,
      p_second_life_offered_at: entry.second_life_offer?.offered_at ?? null,
      p_second_life_expires_at: entry.second_life_offer?.expires_at ?? null,
      p_toughest_opponent_beaten_pts: entry.toughest_opponent_beaten_pts,
      p_ladder_rating: entry.ladder_rating,
      p_badge_heater_tier: entry.badge_counts.heater_wins,
      p_badge_giant_slayer: entry.badge_counts.giant_slayer,
      p_badge_second_life: entry.badge_counts.second_life,
      p_badge_walkover: badgeWalkoverCount,
      p_badge_bounty_hunter: entry.badge_counts.bounty_hunter,
    });
    return !error ? true : (showToast(`Result saved, but the ladder standings couldn't be fully updated: ${error.message}`), false);
  };

  // Step 10: result logging — now a proper submit -> opponent
  // confirm-or-dispute -> admin-escalation pipeline, same shape every other
  // result path in this app (result_submissions, challenges,
  // open_challenges) already uses, instead of the old first-submit-wins
  // flow (whoever tapped "Log result" first had it applied to standings
  // instantly, with no chance for the other side to catch a mistake).
  //
  // submitLadderCupMatchResult (either side, once) reports a scoreline —
  // resolves the winner client-side (same validation as before), uploads
  // the mandatory proof photo, and writes it via the submit_ladder_cup_match_result
  // RPC, which is what actually enforces "only one side's report can land"
  // (see 20260818_ladder_cup_result_pipeline.sql) — nothing here touches
  // ladder_cup_entries or finalized_at yet.
  //
  // applyLadderCupMatchResult (shared by the opponent's confirm and an
  // admin's approve, below) is what used to be the back half of the old
  // function: applies the win/loss via recordLadderCupWin and marks the
  // match finalized. clearLadderCupMatchResult (shared by the opponent's
  // dispute and an admin's reject) wipes a reported-but-not-yet-applied
  // result back to scratch so either side can re-log it, same as
  // disputeChallengeResult/adminRejectChallengeResult do for challenges.
  const submitLadderCupMatchResult = async (league, match, teamId, { homeGoals, awayGoals, extraTimeHomeGoals, extraTimeAwayGoals, pensHome, pensAway, file }) => {
    if (hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) { showToast("The Ladder Cup cutoff has passed — this result can't be logged."); return false; }
    if (!file) { showToast("Attach a photo of the final scoreboard before saving."); return false; }
    if (!teamId) { showToast("Couldn't tell which club you're logging this for — try refreshing."); return false; }

    let winnerSide, decidedBy;
    try {
      ({ winnerSide, decidedBy } = resolveMatchWinner({ homeGoals, awayGoals, extraTimeHomeGoals, extraTimeAwayGoals, pensHome, pensAway }));
    } catch (err) {
      showToast(err.message);
      return false;
    }
    const winnerTeamId = winnerSide === "home" ? match.home_team_id : match.away_team_id;

    const compressed = await compressImage(file, { maxDimension: 1600, quality: 0.85 });
    const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${session.user.id}/${match.id}-${Date.now()}.${ext}`;
    let proofUrl;
    try {
      proofUrl = await uploadToBlob("result-proofs", path, compressed);
    } catch (uploadErr) {
      showToast(`Couldn't upload photo: ${uploadErr.message}`);
      return false;
    }

    const { error } = await supabase.rpc("submit_ladder_cup_match_result", {
      p_match_id: match.id, p_team_id: teamId,
      p_home_goals: homeGoals, p_away_goals: awayGoals,
      p_extra_time_home_goals: decidedBy === "regulation" ? null : extraTimeHomeGoals,
      p_extra_time_away_goals: decidedBy === "regulation" ? null : extraTimeAwayGoals,
      p_pens_home: decidedBy === "penalties" ? pensHome : null,
      p_pens_away: decidedBy === "penalties" ? pensAway : null,
      p_decided_by: decidedBy, p_winner_team_id: winnerTeamId, p_proof_url: proofUrl,
    });
    if (error) {
      // Mirrors initiateLadderCupMatch's handling of the same race one step
      // earlier in this flow — someone else's report already landed while
      // this one was uploading, so refresh so it renders in the right
      // state instead of showing the raw RPC error.
      if (/already been reported/i.test(error.message)) {
        await refreshLeague(league.id);
        showToast("They already logged a result for this match — check it below.");
        return false;
      }
      showToast(`Couldn't log the result: ${error.message}`);
      return false;
    }
    logActivity("match_result_submitted", { context: "ladder_cup", league_id: league.id, match_id: match.id, winner_team_id: winnerTeamId });

    await refreshLeague(league.id);
    showToast("Result logged — waiting for them to confirm or dispute it.");
    return true;
  };

  // Applies a reported-but-unconfirmed result to both clubs' ladder
  // standings and marks the match finalized. Shared by the opponent's
  // confirm (respondLadderCupMatchResult) and an admin's approve
  // (adminResolveLadderCupMatchResult) — those are the only two ways a
  // pending result can become official, so this is the single place that
  // logic lives. Reads the scoreline straight off `match` (already
  // persisted by submitLadderCupMatchResult) rather than taking it as
  // arguments, since by this point it's just replaying what was reported.
  const applyLadderCupMatchResult = async (league, match) => {
    const decidedBy = match.decided_by;
    const winnerTeamId = match.winner_team_id;
    const winnerSide = winnerTeamId === match.home_team_id ? "home" : "away";
    const loserTeamId = winnerSide === "home" ? match.away_team_id : match.home_team_id;
    const winnerGoals = winnerSide === "home" ? match.home_goals : match.away_goals;
    const loserGoals = winnerSide === "home" ? match.away_goals : match.home_goals;
    const extraTimeGoalsWinner = winnerSide === "home" ? match.extra_time_home_goals : match.extra_time_away_goals;
    const extraTimeGoalsLoser = winnerSide === "home" ? match.extra_time_away_goals : match.extra_time_home_goals;

    const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
    const rowsById = Object.fromEntries((league.ladder_cup_entries || []).map((r) => [r.team_id, r]));
    const winnerRow = rowsById[winnerTeamId];
    const loserRow = rowsById[loserTeamId];
    if (!winnerRow || !loserRow) { showToast("Couldn't find both clubs' ladder entries — try refreshing."); return false; }

    const mapped = (league.ladder_cup_entries || []).map((r) => ladderCupEntryFromRow(r, teamsById[r.team_id]?.name || "Unknown club"));
    const standingsBeforeMatch = rankLadderCupStandings(mapped);
    const winnerEntry = ladderCupEntryFromRow(winnerRow, teamsById[winnerTeamId]?.name || "Unknown club");
    const loserEntry = ladderCupEntryFromRow(loserRow, teamsById[loserTeamId]?.name || "Unknown club");

    const { winner, loser } = recordLadderCupWin({
      winner: winnerEntry, loser: loserEntry, standingsBeforeMatch,
      winnerGoals, loserGoals, decidedBy, extraTimeGoalsWinner, extraTimeGoalsLoser,
    });

    // Routed through confirm_ladder_cup_match_result (RPC, security
    // definer — see supabase/migrations/20260820_ladder_cup_match_admin_rpc.sql)
    // instead of a direct .update() on ladder_cup_matches. The plain
    // client update here was written assuming it'd work the same way for
    // an admin's approve as it does for the reporting side's own confirm
    // — but an admin resolving an *escalated* match (timeout or dispute
    // cap, see ladderCupResultEscalationReason) is often not a member of
    // either club, and nothing ever granted that caller write access to
    // this row. That's why an admin's Approve silently did nothing and
    // the match sat in the review queue forever: this update was failing
    // exactly the way the ladder_cup_entries updates were (see
    // 20260819's migration) — just without a visible fallback toast,
    // since a failed match update stops the whole result from applying
    // (never reaches the entries update or the "couldn't be fully
    // updated" toast below it).
    const { error: matchErr } = await supabase.rpc("confirm_ladder_cup_match_result", {
      p_match_id: match.id, p_league_id: league.id,
      p_team_a_id: match.home_team_id, p_team_b_id: match.away_team_id,
    });
    if (matchErr) { showToast(`Couldn't save the match result: ${matchErr.message}`); return false; }

    await Promise.all([
      applyLadderCupEntryPatch(league.id, winnerRow.id, winnerTeamId, loserTeamId, winner, winnerRow.badge_walkover),
      applyLadderCupEntryPatch(league.id, loserRow.id, winnerTeamId, loserTeamId, loser, loserRow.badge_walkover),
    ]);

    const homeName = teamsById[match.home_team_id]?.name || "Home";
    const awayName = teamsById[match.away_team_id]?.name || "Away";
    let scoreLine = `${homeName} ${match.home_goals} – ${match.away_goals} ${awayName}`;
    if (decidedBy === "extra_time") scoreLine += ` (aet ${match.extra_time_home_goals}-${match.extra_time_away_goals})`;
    if (decidedBy === "penalties") scoreLine += ` (pens ${match.penalties_home}-${match.penalties_away})`;
    await postComment(league, `Ladder Cup — ${scoreLine}`, null, null, match.proof_url, true, null, null, match.id);

    await refreshLeague(league.id);
    showToast(loser.status === "eliminated"
      ? `Result confirmed — ${teamsById[loserTeamId]?.name || "they"} are eliminated.`
      : loser.status === "pending_second_life"
      ? `Result confirmed — ${teamsById[loserTeamId]?.name || "they"} have 24h to accept a second life.`
      : "Result confirmed.");
    return true;
  };

  // Wipes a reported-but-unconfirmed result back to scratch — same shape
  // as disputeChallengeResult, but also bumps result_dispute_count so
  // ladderCupResultEscalationReason can send a match straight to the admin
  // queue once it's been disputed too many times (see
  // LADDER_CUP_DISPUTE_ESCALATION_THRESHOLD), same benefit-of-the-doubt
  // rule league fixtures already give a fixture that keeps getting
  // rejected. finalized_at was never set on a merely-pending result, so
  // there's nothing to unwind there — only the reported fields need
  // clearing.
  const clearLadderCupMatchResult = async (league, match) => {
    // Same fix as confirm_ladder_cup_match_result just above — a plain
    // client update failed the same way for a non-participant admin
    // rejecting an escalated match, so this goes through an RPC too. See
    // supabase/migrations/20260820_ladder_cup_match_admin_rpc.sql.
    const { error } = await supabase.rpc("clear_ladder_cup_match_result", {
      p_match_id: match.id, p_league_id: league.id,
      p_team_a_id: match.home_team_id, p_team_b_id: match.away_team_id,
    });
    return !error;
  };

  // The player who *didn't* report the score confirms or disputes it —
  // enforced here (teamId must be the match's other side, not the
  // reporter) and should be enforced again in RLS (result_reported_by_team_id
  // <> the acting club) so a reporter can't confirm their own number. Once
  // challengeResultConfirmExpired(match) is true this stops being offered
  // client-side (see LadderCupOpponentRow) — from there it's admin-only
  // via adminResolveLadderCupMatchResult below.
  const respondLadderCupMatchResult = async (league, match, teamId, accept) => {
    if (!teamId || match.result_status !== "pending") return;
    if (match.result_reported_by_team_id === teamId) return; // reporter can't confirm/dispute their own report
    if (accept) {
      await applyLadderCupMatchResult(league, match);
      return;
    }
    const ok = await clearLadderCupMatchResult(league, match);
    if (!ok) { showToast("Couldn't dispute the result — try refreshing."); return; }
    await refreshLeague(league.id);
    showToast("Result disputed — ask them to re-log it.");
  };

  // Admin-only fallback once ladderCupResultEscalationReason(match) is
  // truthy (opponent had their window/dispute allowance and it wasn't
  // resolved) — same two outcomes as the opponent's own confirm/dispute,
  // just triggered by an admin reviewing the screenshot directly instead.
  const adminResolveLadderCupMatchResult = async (league, match, approve) => {
    if (approve) {
      await applyLadderCupMatchResult(league, match);
      return;
    }
    const ok = await clearLadderCupMatchResult(league, match);
    if (!ok) { showToast("Couldn't reject the result — try refreshing."); return; }
    await refreshLeague(league.id);
    showToast("Result rejected — they'll need to log it again.");
  };

  // Step 11: second-life accept/decline. Either action ends the 24h window
  // immediately — accept re-enters the ladder at -6 points (floored at 0,
  // per acceptSecondLife), decline is final elimination, same outcome the
  // lazy expiry effect above applies automatically if the window lapses
  // with no response. `accept` false covers both an explicit decline and
  // (as far as this function's concerned) is indistinguishable from one —
  // declineOrExpireSecondLife is the same call the lazy-expiry effect uses.
  const respondLadderCupSecondLife = async (league, teamId, accept) => {
    if (!league || !teamId) return;
    if (hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) { showToast("The Ladder Cup cutoff has passed — second life offers are closed."); return; }
    const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
    const row = (league.ladder_cup_entries || []).find((r) => r.team_id === teamId);
    if (!row) { showToast("Couldn't find your ladder entry — try refreshing."); return; }
    if (row.status !== "pending_second_life") return;

    const entry = ladderCupEntryFromRow(row, teamsById[teamId]?.name || "Unknown club");
    const updated = accept ? acceptSecondLife(entry) : declineOrExpireSecondLife(entry);

    const ok = await applyLadderCupEntryPatch(league.id, row.id, teamId, teamId, updated, row.badge_walkover);
    if (!ok) return;
    // Records which way this club's one-and-only second-life offer actually
    // went (see supabase/migrations/20260821_ladder_cup_second_life_history.sql)
    // — without this, a future correction to an earlier match couldn't tell
    // a replay whether this club accepted or declined when it replays this
    // loss again. Best-effort: a failure here shouldn't block the
    // accept/decline itself, which already landed via applyLadderCupEntryPatch.
    const { error: historyErr } = await supabase.rpc("record_ladder_cup_second_life_response", {
      p_entry_id: row.id, p_league_id: league.id, p_team_id: teamId,
      p_response_type: accept ? "accepted" : "declined",
    });
    if (historyErr) console.error("Couldn't record second-life response history:", historyErr.message);
    await refreshLeague(league.id);
    showToast(accept ? `Back in it — re-entered at ${updated.pts} pts.` : "Second life declined — you're eliminated from this cup.");
  };

  // Step 14: rebirth. A fully eliminated club (second life already spent,
  // or its first offer declined/expired) never stopped showing on the
  // standings table — it just dropped out of matchmaking, same as any
  // other "eliminated" row. This is the missing other half: let that club
  // choose to rejoin. reborn() (formats/ladderCup.js) archives the
  // finished life and resets live stats to a fresh day-one run; the RPC
  // (supabase/migrations/20260823_ladder_cup_rebirth.sql) is what actually
  // persists it — same RLS-safe pattern as every other ladder_cup_entries
  // write, self-serve only (no admin path; reviving your own club isn't
  // something an admin does on your behalf). badge_walkover isn't part of
  // the engine's badge_counts (see applyLadderCupEntryPatch's comment on
  // that same asymmetry), so it's folded into the archived life here,
  // straight off the row, before it's sent to the RPC.
  const rejoinLadderCup = async (league, teamId) => {
    if (!league || !teamId) return;
    if (hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) { showToast("The Ladder Cup cutoff has passed — rebirth is closed."); return; }
    const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
    const row = (league.ladder_cup_entries || []).find((r) => r.team_id === teamId);
    if (!row) { showToast("Couldn't find your ladder entry — try refreshing."); return; }
    if (row.status !== "eliminated") return;

    const clubName = teamsById[teamId]?.name || "Unknown club";
    const entry = ladderCupEntryFromRow(row, clubName);
    let updated;
    try {
      updated = reborn(entry);
    } catch (e) {
      showToast(e.message);
      return;
    }
    const finishedLife = { ...updated.past_lives[updated.past_lives.length - 1], badge_walkover: row.badge_walkover ?? 0 };

    const { error } = await supabase.rpc("rebirth_ladder_cup_entry", {
      p_entry_id: row.id, p_league_id: league.id, p_team_id: teamId, p_past_life: finishedLife,
    });
    if (error) { showToast(`Couldn't complete the rebirth: ${error.message}`); return; }

    await refreshLeague(league.id);
    showToast(rebirthAnnouncement(clubName, finishedLife));
  };

  // Step 12: walkover claims (message → 24h wait → claim with screenshot →
  // admin review). "Message opponent" is a purely local bookkeeping step —
  // the actual message happens outside the app (WhatsApp) — createWalkoverClaim
  // just computes claimable_at, 24h out. The DB's partial unique index on
  // (claimant_team_id, target_team_id) for status in (messaged, pending_review)
  // is what actually blocks a second open claim against the same target;
  // 23505 here means one's already in flight. The "up to 10 concurrent claims"
  // cap from the ruleset falls out for free since this is only ever called
  // from a shown-opponent row and getOpponentPool shows at most 10.
  const messageLadderCupWalkoverOpponent = async (league, myTeamId, opponentTeamId) => {
    if (!myTeamId || !opponentTeamId) return;
    if (hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) { showToast("The Ladder Cup cutoff has passed — no new walkover claims."); return; }
    const claim = createWalkoverClaim(myTeamId, opponentTeamId);
    // Routed through the start_ladder_cup_walkover_claim RPC rather than a
    // direct insert — same RLS-safe pattern as ensure_ladder_cup_entry and
    // initiate_ladder_cup_match (see
    // supabase/migrations/20260816_ladder_cup_walkover_claim_rpc.sql). The
    // table's partial unique index still enforces "one open claim per
    // target" server-side, so a duplicate still comes back as a 23505.
    const { error } = await supabase.rpc("start_ladder_cup_walkover_claim", {
      p_league_id: league.id, p_claimant_team_id: myTeamId, p_target_team_id: opponentTeamId,
      p_messaged_at: claim.messaged_at, p_claimable_at: claim.claimable_at,
    });
    if (error) {
      showToast(error.code === "23505" ? "You've already got an open walkover claim against them." : `Couldn't start the claim: ${error.message}`);
      return;
    }
    await refreshLeague(league.id);
    showToast("Opponent messaged — claimable in 24h if they still haven't played.");
  };

  // Screenshot proof is mandatory, same as a played result. isWalkoverClaimable
  // is re-checked here (not just trusted from the button being shown) since
  // the 24h window could've lapsed between render and tap.
  const submitLadderCupWalkoverClaim = async (league, claimRow, file) => {
    if (hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) { showToast("The Ladder Cup cutoff has passed — this claim no longer counts."); return; }
    if (!file) { showToast("Attach a screenshot before submitting the claim."); return; }
    if (!isWalkoverClaimable(claimRow)) { showToast("Not claimable yet — still inside the 24h wait."); return; }

    const compressed = await compressImage(file, { maxDimension: 1600, quality: 0.85 });
    const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${session.user.id}/walkover-${claimRow.id}-${Date.now()}.${ext}`;
    let proofUrl;
    try {
      proofUrl = await uploadToBlob("result-proofs", path, compressed);
    } catch (uploadErr) {
      showToast(`Couldn't upload screenshot: ${uploadErr.message}`);
      return;
    }

    const { error } = await supabase.from("ladder_cup_walkover_claims")
      .update({ status: "pending_review", proof_url: proofUrl }).eq("id", claimRow.id);
    if (error) { showToast(`Couldn't submit the claim: ${error.message}`); return; }
    logActivity("walkover_claim_submitted", { league_id: league.id, claim_id: claimRow.id });
    await refreshLeague(league.id);
    showToast("Walkover claim submitted — waiting on admin review.");
  };

  // Admin approval: flips the claim, then applies the walkover exactly the
  // way LADDER_CUP_INTEGRATION.md's own sample does — recordLadderCupWin
  // with isWalkover: true, base 3pts only, and the target goes through the
  // same loss/second-life path a played defeat would. badge_walkover isn't
  // part of recordLadderCupWin's round trip (see ladderCupRowPatchFromEntry's
  // comment above) so it's bumped here, the one place a walkover win is
  // actually recorded.
  const approveLadderCupWalkoverClaim = async (league, claimRow) => {
    if (hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) { showToast("The Ladder Cup cutoff has passed — this claim can no longer be approved."); return; }
    try {
      approveWalkoverClaim(claimRow);
    } catch (err) {
      showToast(err.message);
      return;
    }

    const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
    const rowsById = Object.fromEntries((league.ladder_cup_entries || []).map((r) => [r.team_id, r]));
    const winnerRow = rowsById[claimRow.claimant_team_id];
    const loserRow = rowsById[claimRow.target_team_id];
    if (!winnerRow || !loserRow) { showToast("Couldn't find both clubs' ladder entries — try refreshing."); return; }

    const mapped = (league.ladder_cup_entries || []).map((r) => ladderCupEntryFromRow(r, teamsById[r.team_id]?.name || "Unknown club"));
    const standingsBeforeMatch = rankLadderCupStandings(mapped);
    const winnerEntry = ladderCupEntryFromRow(winnerRow, teamsById[claimRow.claimant_team_id]?.name || "Unknown club");
    const loserEntry = ladderCupEntryFromRow(loserRow, teamsById[claimRow.target_team_id]?.name || "Unknown club");

    const { winner, loser } = recordLadderCupWin({
      winner: winnerEntry, loser: loserEntry, standingsBeforeMatch, isWalkover: true, winnerGoals: 0, loserGoals: 0,
    });

    const { error: claimErr } = await supabase.from("ladder_cup_walkover_claims").update({
      status: "approved", approved_at: new Date().toISOString(), reviewed_by: session.user.id,
    }).eq("id", claimRow.id);
    if (claimErr) { showToast(`Couldn't approve the claim: ${claimErr.message}`); return; }

    await Promise.all([
      applyLadderCupEntryPatch(league.id, winnerRow.id, claimRow.claimant_team_id, claimRow.target_team_id, winner, winnerRow.badge_walkover + 1),
      applyLadderCupEntryPatch(league.id, loserRow.id, claimRow.claimant_team_id, claimRow.target_team_id, loser, loserRow.badge_walkover),
    ]);

    const winnerName = teamsById[claimRow.claimant_team_id]?.name || "A club";
    const loserName = teamsById[claimRow.target_team_id]?.name || "their opponent";
    await postComment(league, `Ladder Cup — walkover win for ${winnerName} over ${loserName}`, null, null, claimRow.proof_url, true, null, null);

    await refreshLeague(league.id);
    showToast("Walkover approved — result applied to the ladder.");
  };

  const applyLadderCupWalkoverRejection = async (league, claimRow) => {
    try {
      rejectWalkoverClaim(claimRow);
    } catch (err) {
      showToast(err.message);
      return;
    }
    const { error } = await supabase.from("ladder_cup_walkover_claims")
      .update({ status: "rejected", reviewed_by: session.user.id }).eq("id", claimRow.id);
    if (error) { showToast(`Couldn't reject the claim: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast("Walkover claim rejected.");
  };

  const rejectLadderCupWalkoverClaim = (league, claimRow) => {
    requestConfirm([
      "Reject this walkover claim? The claimant stays as-is and the target keeps their spot on the ladder.",
      "Are you sure? This can't be undone once confirmed.",
    ], () => applyLadderCupWalkoverRejection(league, claimRow));
  };

  const joinLeague = async (leagueId) => {
    if (joinInFlight.current.has(leagueId)) return;
    joinInFlight.current.add(leagueId);
    try {
    const league = (leagues || []).find((l) => l.id === leagueId);
    if (league.format === "ladder_cup" && hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) {
      showToast("This Ladder Cup has already reached its cutoff — no new clubs can join.");
      return;
    }
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return; }
    if (!qualifiesForLeague(league)) {
      showToast("You need a top-20% finish in a completed Survival Ladder Cup to join this league.");
      return;
    }

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
    // Ladder Cup: every claimed-or-created team needs a ladder_cup_entries
    // row before it shows up anywhere ladder-related (standings, Find your
    // opponent, the opponent board). This used to only run for brand-new
    // self-registered teams (the branch above) — a team claimed by name
    // from a pre-listed list (the `match` branch) never got one, so a club
    // whose creation-time bulk insert had failed (or was pre-listed before
    // that bulk insert existed) stayed permanently un-placed the moment
    // someone claimed it, with nothing left to trigger the self-heal
    // backfill effect for it. ensureLadderCupEntry already no-ops for
    // non-ladder_cup leagues and is idempotent (ON CONFLICT DO NOTHING), so
    // it's safe to call unconditionally here for both branches.
    if (match) await ensureLadderCupEntry(league, match.id);

    const { error } = await supabase.from("members").insert({
      league_id: leagueId, user_id: session.user.id,
      display_name: profile.efootball_username, phone: profile.phone,
      team_id: match ? match.id : null,
    });
    if (error) { showToast("Couldn't join — you may already be a member."); return; }
    logActivity("league_joined", { league_id: leagueId, league_name: league.name, as_team: !!match });
    await refreshLeague(leagueId);
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
      // See the matching comment in joinLeague — a claimed pre-listed team
      // needs this exactly as much as a freshly created one does.
      await ensureLadderCupEntry(league, match.id);
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
    await ensureLadderCupEntry(league, newTeam.id);
    return { team: newTeam };
  };

  // Joins a cash league: registers/claims the club, uploads the proof of payment to
  // private storage, and creates the member row with payment_status "pending" —
  // it only becomes a confirmed registration once an admin approves it.
  const joinCashLeague = async (league, fee, rawFile) => {
    if (league.format === "ladder_cup" && hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) {
      showToast("This Ladder Cup has already reached its cutoff — no new clubs can join.");
      return false;
    }
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return false; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return false; }
    if (!rawFile) { showToast("Attach your proof of payment before submitting."); return false; }

    const result = await claimOrRegisterTeam(league);
    if (result.error) return false;

    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
    const feeNum = clampFee(fee);
    const ext = (file.name.split(".").pop() || "dat").toLowerCase();
    const path = `${session.user.id}/${league.id}-${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from("payment-proofs").upload(path, file, { cacheControl: "31536000" });
    if (uploadErr) { showToast(`Couldn't upload proof of payment: ${uploadErr.message}`); return false; }
    // payment-proofs stays on Supabase Storage (private, never went through
    // the Blob migration — see api/blob-upload.js's comment), so it needs
    // its own log line here rather than getting it for free from uploadToBlob.
    logActivity("storage_upload", { bucket: "payment-proofs", league_id: league.id, bytes: file.size ?? null });

    const { error } = await supabase.from("members").insert({
      league_id: league.id, user_id: session.user.id,
      display_name: profile.efootball_username, phone: profile.phone,
      team_id: result.team ? result.team.id : null,
      entry_fee: feeNum, payment_status: "pending", payment_proof_path: path,
    });
    if (error) { showToast("Couldn't submit registration — you may already be a member."); return false; }

    await refreshLeague(league.id);
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
    const { error: uploadErr } = await supabase.storage.from("payment-proofs").upload(path, file, { cacheControl: "31536000" });
    if (uploadErr) { showToast(`Couldn't upload proof of payment: ${uploadErr.message}`); return false; }
    logActivity("storage_upload", { bucket: "payment-proofs", league_id: league.id, bytes: file.size ?? null });

    const { error } = await supabase.from("members").update({
      entry_fee: feeNum, payment_status: "pending", payment_proof_path: path,
      payment_reviewed_at: null, payment_reviewed_by: null,
    }).eq("id", member.id);
    if (error) { showToast(`Couldn't resubmit: ${error.message}`); return false; }

    await refreshLeague(league.id);
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

  // Card payments skip the proof-upload + admin-review flow entirely: a
  // pending member row is created immediately, iKhokha's webhook flips it
  // straight to "approved" the instant the card payment succeeds.
  const handlePayByCard = async (fee) => {
    if (!paymentModal) return;
    const { league } = paymentModal;
    if (league.format === "ladder_cup" && hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) {
      showToast("This Ladder Cup has already reached its cutoff — no new clubs can join.");
      return;
    }
    if (entryClosed(league)) { showToast("Entry to this league has closed."); return; }
    if (isMemberOf(league)) { showToast("You've already joined this league."); return; }

    const result = await claimOrRegisterTeam(league);
    if (result.error) return;

    const feeNum = clampFee(fee);
    const { data: memberRow, error } = await supabase.from("members").insert({
      league_id: league.id, user_id: session.user.id,
      display_name: profile.efootball_username, phone: profile.phone,
      team_id: result.team ? result.team.id : null,
      entry_fee: feeNum, payment_status: "pending",
    }).select().single();

    if (error) {
      showToast("Couldn't start registration — you may already be a member.");
      return;
    }

    const { data: { session: currentSession } } = await supabase.auth.getSession();
    const response = await fetch(
      "https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/create-entry-payment",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({ member_id: memberRow.id }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || "Couldn't start card payment. Please try again.");
      return;
    }

    showToast("Redirecting to secure card checkout — you'll be joined automatically once payment confirms.");
    window.location.href = data.paylinkUrl;
  };

  // Admin/creator only — downloads via a short-lived signed URL since the bucket is private.
  const downloadPaymentProof = async (member) => {
    if (!member.payment_proof_path) { showToast("No proof of payment on file for this member."); return; }
    const { data, error } = await supabase.storage.from("payment-proofs").createSignedUrl(member.payment_proof_path, 120);
    if (error || !data) { showToast("Couldn't generate a download link."); return; }
    // Unlike the image/voice-note buckets, payment-proofs is private with no
    // CDN proxy in front of it (see api/image.js's comment on why), so every
    // one of these opens a fresh, uncached hit against Supabase egress.
    logActivity("payment_proof_viewed", { member_id: member.id, league_id: member.league_id });
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };

  const applyPaymentReview = async (member, status) => {
    const { error } = await supabase.from("members").update({
      payment_status: status, payment_reviewed_at: new Date().toISOString(), payment_reviewed_by: session.user.id,
    }).eq("id", member.id);
    if (error) { showToast(`Couldn't update payment status: ${error.message}`); return; }
    await refreshLeague(member.league_id);
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
  // member red (for every admin) for WA_REMINDER_WINDOW_MS. Just "someone
  // messaged them recently" — not tied to a fixture due date, so it fires
  // every time regardless of the member's or league's state.
  //
  // This write races the browser navigating away to open WhatsApp (the
  // link's href starts loading the instant it's tapped). On some phones the
  // tab/page context survives that handoff long enough for a normal
  // supabase-js call to finish; on others it gets torn down first and the
  // write is silently cut off mid-flight — same code, purely device/browser
  // timing. A raw fetch with keepalive:true is what a normal client update
  // can't do: it tells the browser to keep the request alive independent of
  // the page's lifecycle, so it still lands even if this tab is unloaded a
  // moment later. Scoped to just this call (not the shared supabase client)
  // since keepalive requests cap out at 64KB — fine for this tiny patch, but
  // wrong to apply blanket to calls elsewhere that upload scoreboard photos.
  //
  // IMPORTANT: the token comes straight from the `session` state already
  // held by this component — never `await supabase.auth.getSession()` here.
  // That call can itself trigger a real (non-keepalive) network request to
  // refresh a near-expired token, and if THAT gets cut off by the same
  // navigation race, the actual write never even starts. Reading `session`
  // synchronously keeps this to exactly one network call — the keepalive
  // one — instead of stacking a second, unprotected one in front of it.
  const markWaReminder = async (member) => {
    const token = session?.access_token;
    if (!token) { console.warn("[wa-reminder] skipped — no session token"); return; }
    const sentAt = new Date().toISOString();

    // Update the highlight LOCALLY, immediately, before firing the network
    // call. On mobile, tapping this icon hands off to the WhatsApp app right
    // away — the browser tab can get backgrounded mid-request, which can cut
    // off the full loadLeagues() re-fetch this used to depend on to show the
    // highlight. That made the write land in Supabase (visible on next
    // manual reload) while the screen itself never visibly updated. Setting
    // local state first means the row turns red instantly regardless of
    // what happens to the tab a moment later; the PATCH below still makes it
    // durable/visible to other admins.
    setLeagues((prev) => (prev || []).map((lg) => (
      lg.id !== member.league_id ? lg : {
        ...lg,
        members: lg.members.map((mm) => (mm.id === member.id ? { ...mm, wa_reminder_due_at: sentAt } : mm)),
      }
    )));

    try {
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/members?id=eq.${member.id}`, {
        method: "PATCH",
        keepalive: true,
        headers: {
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ wa_reminder_due_at: sentAt }),
      });
      // TEMP DEBUG — remove once confirmed working. keepalive responses can't
      // always be read, but when they can, this surfaces the real failure
      // (missing column, RLS rejection, etc.) instead of eating it silently.
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error("[wa-reminder] PATCH failed", res.status, body);
      } else {
        console.log("[wa-reminder] PATCH ok for", member.id, sentAt);
      }
    } catch (err) {
      console.error("[wa-reminder] PATCH threw", err);
      // Local highlight already applied above, so the admin still sees it
      // even if this network call got cut off by the app handoff — no toast
      // here on purpose, same as before, so it doesn't interrupt the send.
    }
  };

  // Manually clears a member's WhatsApp "reminded" highlight before its
  // normal WA_REMINDER_WINDOW_MS auto-clear (see markWaReminder /
  // isWaReminderActive above) — e.g. once the admin knows the member has
  // replied or sorted themselves out and the red flag is no longer useful.
  // No navigation race here (unlike markWaReminder, this button doesn't
  // hand off to WhatsApp), so a normal supabase-js call is fine.
  const clearWaReminder = async (member) => {
    setLeagues((prev) => (prev || []).map((lg) => (
      lg.id !== member.league_id ? lg : {
        ...lg,
        members: lg.members.map((mm) => (mm.id === member.id ? { ...mm, wa_reminder_due_at: null } : mm)),
      }
    )));
    const { error } = await supabase.from("members").update({ wa_reminder_due_at: null }).eq("id", member.id);
    if (error) { console.error("[wa-reminder] clear failed", error); showToast(`Couldn't clear the highlight: ${error.message}`); }
  };

  // Bulk version of clearWaReminder — clears every currently-highlighted
  // member in one league at once, e.g. after a round of messaging is done
  // and the admin wants a clean slate rather than clicking each × one at
  // a time.
  const clearAllWaReminders = async (league) => {
    setLeagues((prev) => (prev || []).map((lg) => (
      lg.id !== league.id ? lg : { ...lg, members: lg.members.map((mm) => ({ ...mm, wa_reminder_due_at: null })) }
    )));
    const { error } = await supabase.from("members").update({ wa_reminder_due_at: null }).eq("league_id", league.id);
    if (error) { console.error("[wa-reminder] clear-all failed", error); showToast(`Couldn't clear highlights: ${error.message}`); }
  };

  // Admin/creator entering a result directly (no approval step needed, it's
  // their own call) — but a photo of the final scoreboard is required here
  // too, same as submitMatchResult's rule for regular players. Once saved,
  // it's posted to the comments as scoreline + photo, same as an approved
  // player submission, so the evidence is visible to the whole league either way.
  // Shared by every path that can finish a knockout-bracket fixture —
  // admin direct entry (recordResult), player-submit-then-admin-approve
  // (approveResult), and opponent-confirms (respondToResultSubmission's
  // accept branch). All three end with the fixture row holding a final
  // score; this is the one place that turns that into eliminated/still-in
  // status on the teams table, so a club can't slip through "out" just
  // because its result came in via a different path than another club's.
  const applyKnockoutElimination = async (league, fixture, homeScore, awayScore, pensHome = null, pensAway = null) => {
    const inKnockoutBracket = league.format === "knockout" || (league.format === "groups_knockout" && league.final_stage_started);
    if (!inKnockoutBracket || !fixture.away_team_id) return;
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
      .map((f) => (f.id === fixture.id ? { ...f, played: true, home_score: homeScore, away_score: awayScore, pens_home: pensHome, pens_away: pensAway } : f));
    if (!tieFixtures.every((f) => f.played)) return;
    const totals = {};
    tieFixtures.forEach((f) => {
      totals[f.home_team_id] = (totals[f.home_team_id] || 0) + f.home_score;
      totals[f.away_team_id] = (totals[f.away_team_id] || 0) + f.away_score;
    });
    const [teamA, teamB] = Object.keys(totals);
    // Level on aggregate outside the final just leaves both sides as they
    // are (advanceKnockout lets both through when the round advances). In
    // the final, a penalty score — if one's been entered — decides it now.
    const isFinal = isFinalRoundFixtures(tieFixtures);
    let winnerId = null, loserId = null;
    if (totals[teamA] !== totals[teamB]) {
      winnerId = totals[teamA] > totals[teamB] ? teamA : teamB;
      loserId = winnerId === teamA ? teamB : teamA;
    } else if (isFinal) {
      const pensA = pensAggregateFor(tieFixtures, teamA);
      const pensB = pensAggregateFor(tieFixtures, teamB);
      if (pensA !== null && pensB !== null && pensA !== pensB) {
        winnerId = pensA > pensB ? teamA : teamB;
        loserId = winnerId === teamA ? teamB : teamA;
      }
    }
    if (winnerId) {
      // Explicitly set BOTH sides' elimination status from this tie's
      // outcome — not just marking the loser eliminated. This matters
      // when a result gets corrected after the fact (admin re-logs a
      // new score on an already-decided tie, like here): without also
      // resetting the winner back to not-eliminated, a team that was
      // wrongly eliminated by the earlier incorrect result stays stuck
      // eliminated forever, even once the correction says they won.
      const { error: elimLoserErr } = await supabase.from("teams").update({ eliminated: true }).eq("id", loserId);
      const { error: elimWinnerErr } = await supabase.from("teams").update({ eliminated: false }).eq("id", winnerId);
      if (elimLoserErr || elimWinnerErr) showToast("Result saved, but a club's elimination status couldn't be fully updated — check permissions.");
    }
  };

  const recordResult = async (league, fixture, homeScore, awayScore, file = null, pensHome = null, pensAway = null) => {
    if (!file) { showToast("Attach a photo of the final scoreboard before saving."); return; }
    const { error } = await supabase.from("fixtures")
      .update({ played: true, home_score: homeScore, away_score: awayScore, pens_home: pensHome, pens_away: pensAway, played_at: new Date().toISOString() }).eq("id", fixture.id);
    if (error) { showToast("Couldn't save result."); return; }

    await applyKnockoutElimination(league, fixture, homeScore, awayScore, pensHome, pensAway);
    const homeName = league.teams.find((t) => t.id === fixture.home_team_id)?.name || "Home";
    const awayName = league.teams.find((t) => t.id === fixture.away_team_id)?.name || "Away";
    await postComment(league, `Matchday ${fixture.round} — ${homeName} ${homeScore} – ${awayScore} ${awayName}`, null, file, null, true, null, fixture.id);
    await refreshLeague(league.id);
    await loadLadder(); // league results count toward ladder points, when eligible (see describeLadderOutcome)
    const outcome = await describeLadderOutcome("fixture", fixture.id);
    showToast(outcome ? `Saved: ${homeName} ${homeScore} – ${awayScore} ${awayName} — ${outcome}` : `Saved: ${homeName} ${homeScore} – ${awayScore} ${awayName}`);
  };

  // A joined, non-managing player's version of recordResult: same score
  // entry, but it lands as a pending row instead of writing the fixture
  // directly, and a photo of the scoreboard is mandatory. The fixture itself
  // is only updated once an admin/creator approves it (see approveResult).
  const submitMatchResult = async (league, fixture, homeScore, awayScore, rawFile, pensHome = null, pensAway = null) => {
    if (!rawFile) { showToast("Attach a photo of the final scoreboard before submitting."); return false; }
    const file = await compressImage(rawFile, { maxDimension: 1600, quality: 0.85 });
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${session.user.id}/${fixture.id}-${Date.now()}.${ext}`;
    let photoUrl;
    try {
      photoUrl = await uploadToBlob("result-proofs", path, file);
    } catch (uploadErr) {
      showToast(`Couldn't upload photo: ${uploadErr.message}`);
      return false;
    }

    const { error } = await supabase.from("result_submissions").insert({
      league_id: league.id, fixture_id: fixture.id, submitted_by: session.user.id,
      submitted_by_username: profile?.efootball_username || session.user.email,
      home_score: homeScore, away_score: awayScore, pens_home: pensHome, pens_away: pensAway, photo_path: photoUrl,
    });
    if (error) {
      if (error.code === "23505") showToast("Someone already submitted a result for this match — it's waiting on their opponent (or an admin) to review.");
      else showToast(`Couldn't submit result: ${error.message}`);
      return false;
    }
    logActivity("match_result_submitted", { league_id: league.id, fixture_id: fixture.id, home_score: homeScore, away_score: awayScore });
    await refreshLeague(league.id);
    showToast("Result submitted — pending admin approval.");
    return true;
  };

  const handleResultModalSubmit = async (homeScore, awayScore, file, pensHome, pensAway) => {
    if (!resultModal) return;
    const ok = await submitMatchResult(resultModal.league, resultModal.fixture, homeScore, awayScore, file, pensHome, pensAway);
    if (ok) setResultModal(null);
  };

  // Admin/creator only — downloads a submitted result's photo proof via a
  // short-lived signed URL, same pattern as downloadPaymentProof.
  const downloadResultProof = async (submission) => {
    // New rows store a permanent Blob URL directly — open it as-is. Rows
    // from before the result-proofs migration still hold a Supabase storage
    // path, so fall back to signing those.
    if (submission.photo_path?.startsWith("http")) {
      window.open(submission.photo_path, "_blank", "noopener,noreferrer");
      return;
    }
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

    // approve_result_submission is a DB-side RPC (not in this repo) that
    // only copies the score into the fixtures row — it doesn't know about
    // knockout elimination, so that has to happen here too, same as
    // recordResult. Without this, a club eliminated via the player-submit
    // -then-admin-approve path never gets its `eliminated` flag flipped and
    // keeps showing as still in the bracket.
    const fixture = league.fixtures.find((f) => f.id === submission.fixture_id);
    if (fixture) await applyKnockoutElimination(league, fixture, submission.home_score, submission.away_score, submission.pens_home, submission.pens_away);

    if (submission.photo_path) {
      const homeName = league.teams.find((t) => t.id === fixture?.home_team_id)?.name || "Home";
      const awayName = league.teams.find((t) => t.id === fixture?.away_team_id)?.name || "Away";
      // New rows already hold a permanent Blob URL — use it directly. Rows
      // from before the result-proofs migration still hold a Supabase
      // storage path, so fall back to a long-lived signed URL for those.
      let photoUrl = submission.photo_path.startsWith("http") ? submission.photo_path : null;
      if (!photoUrl) {
        const { data } = await supabase.storage.from("result-proofs")
          .createSignedUrl(submission.photo_path, 60 * 60 * 24 * 365 * 5); // ~5 years
        photoUrl = data?.signedUrl ? proxiedSignedUrl(data.signedUrl) : null;
      }
      if (photoUrl) {
        await postComment(
          league,
          `Photo proof for ${submission.submitted_by_username}'s approved result — Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName}`,
          null, null, photoUrl, true, null, fixture?.id || null,
        );
      }
    }

    await refreshLeague(league.id);
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
        // New rows already hold a permanent Blob URL — use it directly.
        // Rows from before the result-proofs migration still hold a
        // Supabase storage path, so fall back to a long-lived signed URL.
        if (submission.photo_path.startsWith("http")) {
          photoUrl = submission.photo_path;
        } else {
          const { data } = await supabase.storage.from("result-proofs")
            .createSignedUrl(submission.photo_path, 60 * 60 * 24 * 365 * 5); // ~5 years
          photoUrl = data?.signedUrl ? proxiedSignedUrl(data.signedUrl) : null;
        }
      }
      await postComment(
        league,
        `${submission.submitted_by_username}'s result was rejected — Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName}`,
        null, null, photoUrl, true,
      );

      await refreshLeague(league.id);
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
      // Same reasoning as approveResult: respond_to_result_submission is a
      // DB-side RPC that only writes the score to fixtures, so an opponent
      // confirming (not disputing) a knockout result needs this club run
      // through the elimination check too, or it never gets marked out.
      if (accept && fixture) await applyKnockoutElimination(league, fixture, submission.home_score, submission.away_score, submission.pens_home, submission.pens_away);
      const homeName = league.teams.find((t) => t.id === fixture?.home_team_id)?.name || "Home";
      const awayName = league.teams.find((t) => t.id === fixture?.away_team_id)?.name || "Away";
      let photoUrl = null;
      if (submission.photo_path) {
        // New rows already hold a permanent Blob URL — use it directly.
        // Rows from before the result-proofs migration still hold a
        // Supabase storage path, so fall back to a long-lived signed URL.
        if (submission.photo_path.startsWith("http")) {
          photoUrl = submission.photo_path;
        } else {
          const { data } = await supabase.storage.from("result-proofs")
            .createSignedUrl(submission.photo_path, 60 * 60 * 24 * 365 * 5); // ~5 years
          photoUrl = data?.signedUrl ? proxiedSignedUrl(data.signedUrl) : null;
        }
      }
      await postComment(
        league,
        accept
          ? `Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName} (confirmed by opponent)`
          : `${submission.submitted_by_username}'s result was disputed by their opponent — Matchday ${fixture?.round} — ${homeName} ${submission.home_score} – ${submission.away_score} ${awayName}`,
        null, null, photoUrl, true, null, accept ? (fixture?.id || null) : null,
      );

      await refreshLeague(league.id);
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
      .from("leagues").select("knockout_legs, round_period_hours, fixtures(*)").eq("id", league.id).single();
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

    // Whether this round IS the final — see isFinalRoundFixtures. Only the
    // final ever needs a single decisive winner (via penalties); every
    // earlier round just advances both sides on a level tie, so points
    // earned by drawing at home and away aren't wasted on a coin-flip edit.
    const isFinal = isFinalRoundFixtures(currentRoundFixtures);

    const winners = [];
    // A tie where every leg went unplayed past its deadline is level on
    // aggregate for the same reason both sides no-showed — nobody actually
    // played to earn advancement, so both clubs are knocked out instead.
    const bothEliminatedIds = [];
    let finalNeedsPens = false;
    Object.values(ties).forEach((legs) => {
      if (legs[0].away_team_id === null) { winners.push(legs[0].home_team_id); return; }
      const totals = {};
      legs.forEach((f) => {
        totals[f.home_team_id] = (totals[f.home_team_id] || 0) + f.home_score;
        totals[f.away_team_id] = (totals[f.away_team_id] || 0) + f.away_score;
      });
      const [teamA, teamB] = Object.keys(totals);
      if (totals[teamA] === totals[teamB]) {
        const allLegsNoShow = legs.every((f) => !f.played && isFixtureLocked(f, league));
        if (allLegsNoShow) { bothEliminatedIds.push(teamA, teamB); return; }
        if (!isFinal) {
          // Level on aggregate outside the final: both clubs earned it home
          // and away, so both go through rather than forcing an admin to
          // arbitrarily break the tie with a manual score edit.
          winners.push(teamA, teamB);
          return;
        }
        // The final always needs exactly one winner — fall back to penalties.
        const pensA = pensAggregateFor(legs, teamA);
        const pensB = pensAggregateFor(legs, teamB);
        if (pensA !== null && pensB !== null && pensA !== pensB) {
          winners.push(pensA > pensB ? teamA : teamB);
          return;
        }
        finalNeedsPens = true;
        return;
      }
      winners.push(totals[teamA] > totals[teamB] ? teamA : teamB);
    });
    if (finalNeedsPens) { showToast("The final is level after regulation — enter the penalty shootout score to decide a winner."); return; }

    if (bothEliminatedIds.length > 0) {
      const { data: updatedRows, error } = await supabase.from("teams").update({ eliminated: true }).in("id", bothEliminatedIds).select("id");
      if (error) { showToast(`Couldn't eliminate the no-show teams: ${error.message}`); return; }
      if ((updatedRows?.length || 0) < bothEliminatedIds.length) {
        showToast(`Only ${updatedRows?.length || 0} of ${bothEliminatedIds.length} no-show clubs were actually eliminated (permissions issue) — round NOT advanced. Try again or check with support.`);
        return;
      }
    }
    if (winners.length <= 1) { showToast("This league already has a champion."); return; }

    // dueOffset: 1 — dueBase here is "right now" (the moment this round is
    // generated), not the bracket's original start date, so the new round's
    // deadline should always be exactly one period out from now, regardless
    // of what the actual round number (maxRound + 1) is. See
    // knockoutRoundFixtures for why this can't just default to roundNumber
    // here the way the opening round's call does.
    const fixtureRows = knockoutRoundFixtures(league.id, winners, bracketStage, maxRound + 1, new Date(), fresh.knockout_legs || 1, roundPeriodMs(fresh), 1, isWeekendLeague(league));
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;
    await refreshLeague(league.id);
    const eliminatedTiesCount = bothEliminatedIds.length / 2;
    showToast(eliminatedTiesCount > 0
      ? `Round ${maxRound + 1} created. ${bothEliminatedIds.length} club${bothEliminatedIds.length === 1 ? "" : "s"} eliminated — no-show on both sides in ${eliminatedTiesCount} tie${eliminatedTiesCount === 1 ? "" : "s"}.`
      : `Round ${maxRound + 1} created.`);
  };

  const advanceSurvivor = async (league) => {
    // Pull this league's teams/fixtures fresh right before deciding who's
    // cut — not the `league` object already sitting in the browser's state.
    // If a result was recorded (by anyone, in any tab) since this admin's
    // page last loaded, the local copy is stale, and computing the cut
    // against it can eliminate a club that had actually won its match —
    // it just hadn't shown up on this screen yet.
    const { data: fresh, error: freshErr } = await supabase
      .from("leagues").select("current_stage, final_stage_started, teams!teams_league_id_fkey(*), fixtures(*)").eq("id", league.id).single();
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
    const fixtureRows = toFixtureRows(league.id, rounds, nextStage, new Date(), 0, roundPeriodMs(league), isWeekendLeague(league));
    const ok = await insertChunked("fixtures", fixtureRows, showToast);
    if (!ok) return;

    const { error: updErr } = await supabase.from("leagues")
      .update({ current_stage: nextStage, final_stage_started: goingFinal }).eq("id", league.id);
    if (updErr) { showToast(`Couldn't update league: ${updErr.message}`); return; }

    await refreshLeague(league.id);
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

  const updateTeamPhone = async (teamId, leagueId, phone) => {
    const { error } = await supabase.from("teams").update({ phone }).eq("id", teamId);
    if (error) { showToast("Couldn't save number."); return; }
    await refreshLeague(leagueId);
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
      await refreshLeague(team.league_id);
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
      await refreshLeague(league.id);
      showToast(`You left ${league.name}.`);
    });
  };

  const updateLeaguePhoto = async (league, rawFile) => {
    const file = await compressImage(rawFile, { maxDimension: 1000, quality: 0.85 });
    const ext = file.name.split(".").pop();
    const path = `${league.id}-${Date.now()}.${ext}`;
    let photo_url;
    try {
      photo_url = await uploadToBlob("league-photos", path, file, file.type);
    } catch (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return; }
    const { error } = await supabase.from("leagues").update({ photo_url }).eq("id", league.id);
    if (error) { showToast(`Couldn't save photo: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast("League photo updated.");
  };

  const updateLeagueDescription = async (league, text) => {
    const { error } = await supabase.from("leagues").update({ description: text || null }).eq("id", league.id);
    if (error) { showToast(`Couldn't save description: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast("Description updated.");
  };

  // Lets whoever can manage the league (its creator, or an admin) push the
  // entry-close and kickoff dates back — plans change, a WhatsApp group is
  // slow to fill, whatever. Both are required, same as at creation, so a
  // league can never end up with one set and the other blank.
  // Admin fill-in for leagues created before creator_phone existed (or before
  // the creator had a phone on their profile) — without this, the "message
  // the admin about this result" WhatsApp icon on the Results tab has no
  // number to link to and just stays hidden (see CommentRow in
  // LeagueDetail.jsx). Setting it here retroactively turns that icon on for
  // older leagues with no other code change needed.
  const updateLeagueCreatorPhone = async (league, phone) => {
    const trimmed = (phone || "").trim();
    const { error } = await supabase.from("leagues").update({ creator_phone: trimmed || null }).eq("id", league.id);
    if (error) { showToast(`Couldn't save number: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast(trimmed ? "Organizer WhatsApp number updated." : "Organizer WhatsApp number cleared.");
  };

  const updateLeagueSchedule = async (league, { entryClosesAt, startsAt }) => {
    // Survival Ladder Cup never has an entry-close date (see entryClosed
    // above) — LeagueScheduleLine doesn't even offer the field for this
    // format, so entryClosesAt arrives empty here and is kept null rather
    // than parsed into an invalid date.
    const { error } = await supabase.from("leagues")
      .update({
        entry_closes_at: league.format === "ladder_cup" ? null : new Date(entryClosesAt).toISOString(),
        starts_at: new Date(startsAt).toISOString(),
      })
      .eq("id", league.id);
    if (error) { showToast(`Couldn't save dates: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast("League dates updated.");
  };

  // Lets whoever can manage the league change how many days each round gets
  // once fixtures open, but only while the league hasn't started yet — once
  // generateFixtures has run, every fixture's due_at is already baked in from
  // whatever the period was at that moment, so changing it after the fact
  // wouldn't touch existing fixtures and would just be confusing.
  const updateLeagueRoundPeriod = async (league, hours) => {
    const { error } = await supabase.from("leagues").update({ round_period_hours: hours }).eq("id", league.id);
    if (error) { showToast(`Couldn't save match period: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast("Match due-date period updated.");
  };

  // Groups + Knockout only: the shared deadline for the whole group stage.
  // Individual matchday due_at values stay advisory (they still show as
  // "Due X" and never block a submission or auto-score a loss) — this date
  // is the real cutoff. Pass null to clear it.
  const updateLeagueGroupStageDueAt = async (league, dueAt) => {
    const { error } = await supabase.from("leagues")
      .update({ group_stage_due_at: dueAt ? new Date(dueAt).toISOString() : null }).eq("id", league.id);
    if (error) { showToast(`Couldn't save the group stage due date: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast(dueAt ? "Group stage due date updated." : "Group stage due date cleared.");
  };

  // Admin-triggered "Start League" for Survival Ladder Cup. Ladder Cup has
  // no fixtures to generate (see generateFixtures — that's for the other
  // formats only) and clubs are already live on the ladder the moment they
  // join, so starting it doesn't create anything — it just flips a status
  // marker (ladder_cup_started_at) so the league shows as "Started" instead
  // of "Open for joining". Registration is NOT affected: clubs keep
  // registering right up to the cutoff/finalize either way (see
  // entryClosed above).
  const startLadderCupLeague = async (league) => {
    const key = `start-ladder-${league.id}`;
    if (stageActionInFlight.current.has(key)) return;
    stageActionInFlight.current.add(key);
    try {
      if (league.teams.length < 2) { showToast("Need at least 2 registered clubs to start the league."); return; }
      const { error } = await supabase.from("leagues")
        .update({ ladder_cup_started_at: new Date().toISOString() }).eq("id", league.id);
      if (error) { showToast(`Couldn't start the league: ${error.message}`); return; }
      await refreshLeague(league.id);
      showToast(`League started with ${league.teams.length} clubs on the ladder — new clubs can still join anytime before the cutoff.`);
    } finally {
      stageActionInFlight.current.delete(key);
    }
  };


  // Overrides the auto-generated WhatsApp nudge text (see adminStatusMessage)
  // for every member's WA icon in this league. Persists on the league row —
  // once set, every member gets this exact wording (with {name} swapped in
  // per member) instead of the default status-based message, and it stays
  // that way until whoever manages the league edits or clears it again; it
  // doesn't expire or revert on its own. Pass null/empty to go back to the
  // default auto-generated message.
  const updateLeagueMemberMessage = async (league, text) => {
    const { error } = await supabase.from("leagues").update({ wa_message_template: text || null }).eq("id", league.id);
    if (error) { showToast(`Couldn't save the member message: ${error.message}`); return; }
    await refreshLeague(league.id);
    showToast(text ? "Member message updated — used for every WhatsApp nudge in this league from now on." : "Member message cleared — back to the default auto message.");
  };

  // Broadcasts the league's saved custom message to every member right
  // now, at no cost — no SMS/WhatsApp Business API involved. It posts as
  // an auto-generated comment (same "isResult" mechanic already used for
  // auto-posted matchday results and no-show eliminations) in the league's
  // own comment feed, which every member already reads. That's the honest
  // tradeoff: it's instant and genuinely free, but it's an in-app
  // notification, not a push straight to someone's phone — a member sees
  // it the next time they open this league, same as every other
  // auto-posted comment in the app. Requires a saved custom message first:
  // there's no single sensible "broadcast" version of the default status
  // message, since that one reads differently per member (eliminated vs.
  // upcoming fixture vs. league not started yet).
  const notifyAllMembers = (league) => {
    if (!league.wa_message_template) { showToast("Set a custom message first, then you can notify everyone with it."); return; }
    const memberCount = (league.members || []).length;
    requestConfirm([
      `Notify all ${memberCount} member${memberCount === 1 ? "" : "s"} of "${league.name}" right now? Posts your saved message to the league's comment feed for everyone to see.`,
    ], async () => {
      // No single member to derive {round}/{due} from for a broadcast — use
      // the league's own next unplayed fixture (same source as the editor's
      // preview) so a template written with those placeholders still reads
      // sensibly when posted to the whole feed at once.
      const broadcastFixture = nextFixtureForLeague(league);
      const broadcastRound = broadcastFixture ? String(broadcastFixture.round) : "";
      const broadcastDue = broadcastFixture ? fmtDate(broadcastFixture.due_at) : league.starts_at ? fmtDate(league.starts_at) : "";
      const broadcastStart = broadcastFixture ? fixtureStartsAt(broadcastFixture, league) : league.starts_at;
      const body = league.wa_message_template
        .replace(/\{name\}/g, "everyone")
        .replace(/\{league\}/g, league.name)
        .replace(/\{round\}/g, broadcastRound)
        .replace(/\{due\}/g, broadcastDue)
        .replace(/\{start\}/g, broadcastStart ? fmtDate(broadcastStart) : "");
      const posted = await postComment(league, body, null, null, null, true);
      if (posted) {
        // Same red "reminded" highlight the per-member WhatsApp icon sets
        // (see markWaReminder) — a broadcast is still notifying every
        // member, so every member's row gets flagged too.
        (league.members || []).forEach((mm) => markWaReminder(mm));
        showToast(`Notified ${memberCount} member${memberCount === 1 ? "" : "s"} — posted to the league feed.`);
      }
    });
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
  const postComment = async (league, body, parentComment = null, file = null, photoUrl = null, isResult = false, voiceClip = null, fixtureId = null, ladderCupMatchId = null) => {
    const trimmed = (body || "").trim();
    if (!trimmed && !file && !photoUrl && !voiceClip) return;
    const username = profile?.efootball_username || session.user.email;
    let photo_url = photoUrl || null;
    if (!photo_url && file) {
      const compressed = await compressImage(file, { maxDimension: 900, quality: 0.85 });
      const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      try {
        photo_url = await uploadToBlob("comment-photos", path, compressed, compressed.type);
      } catch (uploadErr) { showToast(`Couldn't upload photo: ${uploadErr.message}`); return false; }
    }
    let voice_url = null;
    let voice_duration = null;
    if (voiceClip) {
      const ext = (voiceClip.blob.type || "").includes("mp4") ? "m4a" : (voiceClip.blob.type || "").includes("ogg") ? "ogg" : "webm";
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      try {
        voice_url = await uploadToBlob("comment-voice-notes", path, voiceClip.blob, voiceClip.blob.type || "audio/webm");
      } catch (uploadErr) { showToast(`Couldn't upload voice note: ${uploadErr.message}`); return false; }
      voice_duration = voiceClip.duration || null;
    }
    const { error } = await supabase.from("comments").insert({
      league_id: league.id, user_id: session.user.id, username, body: trimmed,
      parent_comment_id: parentComment?.id || null, photo_url, is_result: isResult,
      voice_url, voice_duration, fixture_id: fixtureId, ladder_cup_match_id: ladderCupMatchId,
    });
    if (error) { showToast(`Couldn't post ${parentComment ? "reply" : "comment"}: ${error.message}`); return false; }
    await refreshLeague(league.id);
    return true;
  };

  // Admin-only correction for a posted result line (Results tab) — edits the
  // comment's text in place. This does NOT touch the fixture's home_score/
  // away_score or recompute standings/knockout progress; it only fixes what's
  // displayed in the results history. If the actual match score was wrong,
  // that still needs correcting separately via the Fixtures tab.
  const editComment = async (comment, league, newBody) => {
    const trimmed = newBody.trim();
    if (!trimmed) return false;
    // .select().maybeSingle() is deliberate: Supabase RLS blocks a row
    // silently — an update whose WHERE clause the policy filters out still
    // comes back with no error, just 0 rows affected. Without asking for
    // the row back we'd show "Result updated" even when nothing changed.
    const { data, error } = await supabase.from("comments").update({ body: trimmed }).eq("id", comment.id).select().maybeSingle();
    if (error) { showToast(`Couldn't update result: ${error.message}`); return false; }
    if (!data) { showToast("Couldn't update — you don't have permission to edit this result (check the comments UPDATE policy in Supabase)."); return false; }
    await refreshLeague(league.id);
    showToast("Result updated.");
    return true;
  };

  // Admin correction for a posted result that's linked to a real fixture
  // (comment.fixture_id — only set on results posted after the fixture_id
  // column was added; see supabase-edit-results-followup.sql). Unlike
  // editComment above, this actually rewrites the fixture's home_score/
  // away_score (so standings/knockout progress move too), re-runs the same
  // knockout-elimination and ladder-outcome side effects recordResult does,
  // then regenerates the comment text from the new score so the two never
  // drift apart.
  const editResultForFixture = async (comment, league, fixture, homeScore, awayScore) => {
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || awayScore < 0) {
      showToast("Enter a valid score for both teams.");
      return false;
    }
    const { data: fxData, error: fxError } = await supabase.from("fixtures")
      .update({ home_score: homeScore, away_score: awayScore })
      .eq("id", fixture.id).select().maybeSingle();
    if (fxError) { showToast(`Couldn't update the match score: ${fxError.message}`); return false; }
    if (!fxData) { showToast("Couldn't update — you don't have permission to edit this fixture (check the fixtures UPDATE policy in Supabase)."); return false; }

    await applyKnockoutElimination(league, fixture, homeScore, awayScore, fixture.pens_home, fixture.pens_away);

    const homeName = league.teams.find((t) => t.id === fixture.home_team_id)?.name || "Home";
    const awayName = league.teams.find((t) => t.id === fixture.away_team_id)?.name || "Away";
    const newBody = `Matchday ${fixture.round} — ${homeName} ${homeScore} – ${awayScore} ${awayName}`;
    const { data: cmData, error: cmError } = await supabase.from("comments").update({ body: newBody }).eq("id", comment.id).select().maybeSingle();
    if (cmError) showToast(`Score saved, but couldn't update the posted text: ${cmError.message}`);
    else if (!cmData) showToast("Score saved, but you don't have permission to edit the posted text (check the comments UPDATE policy).");

    await refreshLeague(league.id);
    await loadLadder(); // league results count toward ladder points, when eligible (see describeLadderOutcome)
    const outcome = await describeLadderOutcome("fixture", fixture.id);
    if (!cmError && cmData) showToast(outcome ? `Result updated — ${outcome}` : "Result updated — table refreshed.");
    return true;
  };

  // Ladder Cup's version of editResultForFixture — but a Ladder Cup result
  // can't be corrected the same way a fixture is (overwrite the score,
  // patch two rows). pts/gd/streak/status/badges/ladder_rating are all
  // PATH-DEPENDENT: streak and badges depend on the order matches
  // happened in, Elo depends on both clubs' ratings at the moment of each
  // result, and a loss can trigger a second-life offer that ripples into
  // everything after it. Patching the one corrected match in place risks
  // quietly corrupting every result that came after it. So instead:
  // replay the WHOLE league from scratch through the same pure engine
  // (formats/ladderCup.js) every live result already goes through, with
  // the corrected score swapped in, and rebuild every club's entry.
  //
  // computeLadderCupRecompute is the pure replay step (no Supabase calls,
  // easy to reason about / test in isolation); recomputeLadderCupLeague
  // wraps it with the bulk write; editLadderCupMatchResult is the actual
  // onEditLadderCupResult handler wired up from LeagueDetail.
  //
  // Second-life accept/decline/expiry is the one piece of state this
  // replay can't derive purely from the match/walkover event log — that's
  // a human decision, not a computed result — so it leans on
  // ladder_cup_second_life_offers (see
  // supabase/migrations/20260821_ladder_cup_second_life_history.sql) to
  // know how each club's one-and-only offer actually went. A club with no
  // history row there (an offer resolved before that migration existed)
  // falls back to its CURRENT second_life_used flag / status, which is a
  // safe stand-in specifically because every club only ever gets one such
  // offer in its lifetime — that flag alone already records how it went.
  const computeLadderCupRecompute = (league) => {
    const teams = league.teams || [];
    const entryRows = league.ladder_cup_entries || [];
    const offersByTeam = Object.fromEntries((league.ladder_cup_second_life_offers || []).map((o) => [o.team_id, o]));
    const teamsById = Object.fromEntries(teams.map((t) => [t.id, t]));

    // Every club with an entry row today gets a fresh, zeroed-out seed —
    // clubs get an entry the moment they join (ensureLadderCupEntry),
    // independent of whether they've played, so this is the right seed
    // set: every possible winner/loser below already has a row here.
    const entries = new Map(entryRows.map((r) => [r.team_id, createLadderCupEntry(r.team_id, teamsById[r.team_id]?.name || "Unknown club")]));

    const events = [];
    for (const m of (league.ladder_cup_matches || [])) {
      if (!m.finalized_at) continue; // never confirmed, or disputed away — never happened
      const winnerIsHome = m.winner_team_id === m.home_team_id;
      events.push({
        at: new Date(m.finalized_at).getTime(),
        isWalkover: false,
        winnerTeamId: m.winner_team_id,
        loserTeamId: winnerIsHome ? m.away_team_id : m.home_team_id,
        winnerGoals: winnerIsHome ? m.home_goals : m.away_goals,
        loserGoals: winnerIsHome ? m.away_goals : m.home_goals,
        decidedBy: m.decided_by || "regulation",
        extraTimeGoalsWinner: winnerIsHome ? m.extra_time_home_goals : m.extra_time_away_goals,
        extraTimeGoalsLoser: winnerIsHome ? m.extra_time_away_goals : m.extra_time_home_goals,
      });
    }
    for (const c of (league.ladder_cup_walkover_claims || [])) {
      if (c.status !== "approved" || !c.approved_at) continue;
      events.push({
        at: new Date(c.approved_at).getTime(),
        isWalkover: true,
        winnerTeamId: c.claimant_team_id, loserTeamId: c.target_team_id,
        winnerGoals: 0, loserGoals: 0, decidedBy: "regulation",
        extraTimeGoalsWinner: 0, extraTimeGoalsLoser: 0,
      });
    }
    events.sort((a, b) => a.at - b.at);

    const walkoverBadgeCount = new Map(); // team_id -> count; recordLadderCupWin doesn't touch this counter itself

    for (const ev of events) {
      const winnerEntry = entries.get(ev.winnerTeamId);
      const loserEntry = entries.get(ev.loserTeamId);
      // Missing club (removed from the league since?) — skip this one
      // event rather than aborting the whole recompute.
      if (!winnerEntry || !loserEntry) continue;
      // A club that's still sitting on an unresolved second-life offer
      // can't have a next match in real life — but if the corrected
      // timeline reshuffled who won an earlier match, that's exactly the
      // state we might be replaying into. Skip rather than feed a
      // pending_second_life club into another result — same "can't be
      // matched" rule the real app enforces via getOpponentPool.
      if (winnerEntry.status === "pending_second_life" || loserEntry.status === "pending_second_life") continue;

      const standingsBeforeMatch = rankLadderCupStandings([...entries.values()]);
      const { winner, loser } = recordLadderCupWin({
        winner: winnerEntry, loser: loserEntry, standingsBeforeMatch,
        isWalkover: ev.isWalkover,
        winnerGoals: ev.winnerGoals || 0, loserGoals: ev.loserGoals || 0,
        decidedBy: ev.decidedBy, extraTimeGoalsWinner: ev.extraTimeGoalsWinner || 0, extraTimeGoalsLoser: ev.extraTimeGoalsLoser || 0,
      });
      entries.set(ev.winnerTeamId, winner);

      let resolvedLoser = loser;
      if (loser.status === "pending_second_life") {
        const offer = offersByTeam[ev.loserTeamId];
        const currentRow = entryRows.find((r) => r.team_id === ev.loserTeamId);
        if (offer?.response_type === "accepted") {
          resolvedLoser = acceptSecondLife(loser);
        } else if (offer?.response_type === "declined" || offer?.response_type === "expired") {
          resolvedLoser = declineOrExpireSecondLife(loser);
        } else if (offer && !offer.responded_at && offer.expires_at && new Date(offer.expires_at) <= new Date()) {
          // No recorded response, but the 24h window's already lapsed —
          // same silent-expiry conversion the lazy-expiry effect does on
          // read.
          resolvedLoser = declineOrExpireSecondLife(loser);
        } else if (!offer) {
          // Predates the history table (see the migration comment): fall
          // back to what the row's CURRENT state already tells us, since
          // a club only ever gets one such offer in its lifetime.
          if (currentRow?.second_life_used) resolvedLoser = acceptSecondLife(loser);
          else if (currentRow?.status === "eliminated") resolvedLoser = declineOrExpireSecondLife(loser);
          // else: no record either way and the row isn't eliminated —
          // treat as a genuinely still-open offer, same as the real-time case below.
        }
        // else: a real, still-open offer — leave the club pending_second_life.
      }
      entries.set(ev.loserTeamId, resolvedLoser);

      if (ev.isWalkover) walkoverBadgeCount.set(ev.winnerTeamId, (walkoverBadgeCount.get(ev.winnerTeamId) || 0) + 1);
    }

    return { entries, walkoverBadgeCount };
  };

  // Runs the replay above and writes the rebuilt table back in one round
  // trip via bulk_apply_ladder_cup_entries (admin-only RPC — see
  // supabase/migrations/20260822_ladder_cup_result_correction.sql).
  const recomputeLadderCupLeague = async (league) => {
    const { entries, walkoverBadgeCount } = computeLadderCupRecompute(league);
    const entryRows = league.ladder_cup_entries || [];
    const payload = entryRows.map((row) => {
      const entry = entries.get(row.team_id);
      if (!entry) return null;
      return {
        entry_id: row.id,
        ...ladderCupRowPatchFromEntry(entry),
        badge_walkover: walkoverBadgeCount.get(row.team_id) ?? row.badge_walkover ?? 0,
      };
    }).filter(Boolean);

    const { error } = await supabase.rpc("bulk_apply_ladder_cup_entries", { p_league_id: league.id, p_entries: payload });
    if (error) { showToast(`Score corrected, but the ladder couldn't be fully recomputed: ${error.message}`); return false; }
    return true;
  };

  // Admin correction for a posted Ladder Cup result comment
  // (comment.ladder_cup_match_id) — see the recompute functions above for
  // why this can't just overwrite the one match's score. Only offered for
  // a regulation-time correction (matches the score-box UI in
  // LeagueDetail's CommentRow); extra time/penalties carry over unchanged
  // from the original result unless the new regulation scoreline is level
  // again, in which case there's nothing on record to break the tie with.
  const editLadderCupMatchResult = async (comment, league, match, homeGoals, awayGoals) => {
    if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) {
      showToast("Enter a valid score for both teams.");
      return false;
    }
    let decidedBy = match.decided_by;
    let winnerTeamId = match.winner_team_id;
    if (homeGoals !== awayGoals) {
      decidedBy = "regulation";
      winnerTeamId = homeGoals > awayGoals ? match.home_team_id : match.away_team_id;
    } else if (match.decided_by === "regulation") {
      showToast("That scoreline is level — this match has no extra time or penalties on record to decide it.");
      return false;
    }

    const { error: matchErr } = await supabase.rpc("correct_ladder_cup_match_result", {
      p_match_id: match.id, p_league_id: league.id,
      p_home_goals: homeGoals, p_away_goals: awayGoals,
      p_extra_time_home_goals: match.extra_time_home_goals, p_extra_time_away_goals: match.extra_time_away_goals,
      p_penalties_home: match.penalties_home, p_penalties_away: match.penalties_away,
      p_decided_by: decidedBy, p_winner_team_id: winnerTeamId,
    });
    if (matchErr) { showToast(`Couldn't correct the result: ${matchErr.message}`); return false; }

    // Re-fetch rather than patching the local `league` object by hand —
    // the recompute needs every finalized match/approved walkover claim
    // in the league, not just this one.
    const { data: freshLeague, error: fetchErr } = await supabase.from("leagues").select(LEAGUE_SELECT).eq("id", league.id).maybeSingle();
    if (fetchErr || !freshLeague) { showToast("Score corrected, but couldn't reload the league to recompute standings — try refreshing."); return false; }
    const recomputeOk = await recomputeLadderCupLeague(freshLeague);

    const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
    const homeName = teamsById[match.home_team_id]?.name || "Home";
    const awayName = teamsById[match.away_team_id]?.name || "Away";
    let scoreLine = `${homeName} ${homeGoals} – ${awayGoals} ${awayName}`;
    if (decidedBy === "extra_time") scoreLine += ` (aet ${match.extra_time_home_goals}-${match.extra_time_away_goals})`;
    if (decidedBy === "penalties") scoreLine += ` (pens ${match.penalties_home}-${match.penalties_away})`;
    const { data: cmData, error: cmError } = await supabase.from("comments").update({ body: `Ladder Cup — ${scoreLine}` }).eq("id", comment.id).select().maybeSingle();
    if (cmError) showToast(`Score saved, but couldn't update the posted text: ${cmError.message}`);
    else if (!cmData) showToast("Score saved, but you don't have permission to edit the posted text (check the comments UPDATE policy).");

    await refreshLeague(league.id);
    if (recomputeOk && !cmError && cmData) showToast("Result corrected — the whole ladder was recomputed from scratch.");
    else if (recomputeOk) showToast("Standings recomputed — but the posted text couldn't be updated.");
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
      await refreshLeague(comment.league_id);
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
    await refreshLeague(comment.league_id);
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
    await refreshLeague(league.id);
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
      setLeagues((prev) => (prev || []).filter((l) => l.id !== league.id)); // already gone server-side — no need to refetch
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
  if (profile === null) return <ProfileGate c={c} theme={theme} toggleTheme={toggleTheme} onSubmit={completeProfile} userEmail={session.user.email} onSignOut={signOut} />;

  // loadRecentResults and loadBoardComments aren't called here even though
  // this is "opening" the screen — the effects that poll them already fire
  // immediately the moment `view` becomes "challenges" (see below), so
  // calling them again here just fired the same two requests twice back to
  // back on every single visit to this screen.
  // Admins get accounts (with phone numbers) loaded alongside the usual
  // challenge data — feeds the WhatsApp icon on the escalated-results panel
  // below, which needs a phone number for whoever reported the disputed
  // result. Non-admins never fetch this (get_all_accounts is admin-gated
  // server-side anyway), same privacy boundary loadChallengeMembers already
  // draws by leaving phone off the everyone-sees-everyone member picker.
  const openChallengesScreen = () => { setView("challenges"); loadChallengeMembers(); loadChallenges(); loadOpenChallenges(); if (isAdmin) loadAccounts(); };
  const openLadderScreen = () => { setView("ladder"); loadLadder(); loadLadderComments(); loadLadderResults(); };

  // Everything reachable from the header's hamburger menu or Home's old
  // action grid, now assembled once here so the floating Quick actions dock
  // (rendered below, outside the header/view switch) really does carry
  // "everything" and shows up the same way no matter which screen it's
  // opened from.
  const grabbableCount = (openChallenges || []).filter((ch) => ch.status === "open" && ch.creator_id !== session?.user?.id).length;
  const quickActionItems = [
    { icon: Plus, label: "New league", onClick: () => setView("create") },
    { icon: Shuffle, label: "Random", badge: grabbableCount || null, onClick: openChallengesScreen },
    { icon: TrendingUp, label: "Ladder", onClick: openLadderScreen },
    { icon: Trophy, label: "Leaderboard", onClick: () => setView("leaderboard") },
    { icon: ShoppingBag, label: "Shop", external: true, onClick: () => setView("shop") },
    { icon: Repeat, label: "Transfers", external: true, onClick: () => setView("transferMarket") },
    { icon: MessageCircle, label: "Suggest something", onClick: () => setSuggestionOpen(true) },
    { icon: theme === "dark" ? Sun : Moon, label: theme === "dark" ? "Light mode" : "Dark mode", onClick: toggleTheme },
    ...(isAdmin ? [{ icon: Shield, label: "All accounts", onClick: () => { setView("accounts"); loadAccounts(); } }] : []),
    ...(isAdmin ? [{ icon: History, label: "Activity log", onClick: () => { setView("activity"); loadActivityLog(); } }] : []),
  ];

  return (
    <div className="min-h-screen transition-colors duration-200" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      {view !== "shop" && (
        <Header view={view} setView={setView} activeLeague={activeLeague} theme={theme} toggleTheme={toggleTheme} c={c} onSignOut={signOut} userEmail={session.user.email}
          avatarUrl={profile?.avatar_url}
          onEditProfile={() => setEditProfileOpen(true)} isAdmin={isAdmin} onOpenAccounts={() => { setView("accounts"); loadAccounts(); }}
          onOpenActivity={() => { setView("activity"); loadActivityLog(); }}
          onOpenChallenges={openChallengesScreen}
          challengeBadge={incomingPendingCount + adminEscalatedResultCount}
          onOpenCreate={() => setView("create")}
          grabbableCount={grabbableCount}
          onOpenSuggestion={() => setSuggestionOpen(true)} onOpenLeaderboard={() => setView("leaderboard")} onOpenLadder={openLadderScreen} />
      )}
      {/* Quick actions — floating on every screen (not gated behind
          `view !== "shop"` the way Header is above), so it's reachable no
          matter where in the app someone is. */}
      <QuickActionsDock open={quickActionsOpen} onToggle={() => setQuickActionsOpen((v) => !v)} items={quickActionItems} c={c} />
      <main className="max-w-3xl mx-auto px-4 pb-24">
        <ErrorBoundary resetKey={view} onGoHome={() => setView("home")}>
        {view === "accounts" && isAdmin ? (
          <AccountsPanel accounts={accounts} leagues={leagues} session={session} onDelete={deleteAccount} onApprove={approveAccount} onBack={goBack} showToast={showToast} c={c} />
        ) : view === "activity" && isAdmin ? (
          <ActivityLogPanel activityLog={activityLog} onBack={goBack} c={c} />
        ) : view === "challenges" ? (
          <Suspense fallback={<Loader c={c} />}>
          <ChallengesScreen session={session} members={challengeMembers} challenges={challenges} openChallenges={openChallenges} recentResults={recentResults}
            accounts={isAdmin ? accounts : null}
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
            onAdminEditResult={adminEditChallengeResult} onAdminEditResultOpen={adminEditOpenChallengeResult}
            onAdminGrantLadderWalkover={adminGrantLadderWalkover} onAdminCancelLadderChallenge={adminCancelLadderChallenge}
            onViewResultProof={viewChallengeResultProof}
            onSendRandom={sendRandomChallenge} onAcceptOpen={acceptOpenChallenge} onCancelOpen={cancelOpenChallenge} onRemoveOpen={removeOpenChallenge}
            onBack={goBack} showToast={showToast} c={c} />
          </Suspense>
        ) : leagues === null ? <Loader c={c} /> : (
          <>
            {view === "home" && (
              <Home leagues={leagues} isAdmin={isAdmin} isMemberOf={isMemberOf} entryClosed={entryClosed} qualifiesForLeague={qualifiesForLeague} myPaymentStatus={myPaymentStatus}
                canManageLeague={canManageLeague} myTeam={myTeam} session={session} onToggleLeagueReaction={toggleLeagueReaction}
                challenges={challenges} openChallenges={openChallenges} onOpenChallenges={openChallengesScreen}
                onOpenLogResult={(ch) => setChallengeResultModal({ kind: "challenge", challenge: ch })}
                onOpenLogResultOpen={(ch) => setChallengeResultModal({ kind: "open", challenge: ch })}
                ladder={ladderTop5} myLadderRank={myLadderRank} onOpenLadder={openLadderScreen} onOpenLeaderboard={() => setView("leaderboard")}
                onOpen={(id, fixtureId) => { setActiveLeagueId(id); setView("league"); if (fixtureId) setPendingLogFixtureId(fixtureId); }}
                onCreate={() => setView("create")} onJoin={startJoin} onOpenShop={() => setView("shop")} onOpenTransferMarket={() => setView("transferMarket")} memberAvatars={challengeMembers} allAchievements={allAchievements} onAchievementsSynced={loadAllAchievements} myAvatarUrl={profile?.avatar_url}
                weekendOverride={weekendOverride} onSetWeekendOverride={setWeekendOverride} showToast={showToast} quickActions={quickActionItems} c={c} />
            )}
            {view === "create" && (
              <Suspense fallback={<Loader c={c} />}>
                <CreateLeague onCancel={goBack} onCreate={createLeague} isAdmin={isAdmin} c={c} />
              </Suspense>
            )}
            {view === "league" && activeLeague && (
              <Suspense fallback={<Loader c={c} />}>
              <LeagueDetail league={activeLeague} leagues={leagues} allAchievements={allAchievements} session={session} isAdmin={isAdmin} joined={isMemberOf(activeLeague)}
                myUsername={profile?.efootball_username || session.user.email}
                canSeePhones={canSeePhones(activeLeague)} myTeam={myTeam(activeLeague)} entryClosed={entryClosed(activeLeague)}
                myPaymentStatus={myPaymentStatus(activeLeague)}
                blockedByLeague={isMemberOf(activeLeague) ? null : blockingLeagueFor(activeFunLeaguesByKindMap, activeLeague)}
                qualified={qualifiesForLeague(activeLeague)}
                onBack={goBack} onJoin={() => startJoin(activeLeague.id)}
                onResubmitPayment={(member) => openResubmitPayment(activeLeague, member)}
                onDownloadProof={downloadPaymentProof} onReviewPayment={reviewPayment} onMarkWaReminder={markWaReminder} onClearWaReminder={clearWaReminder} onClearAllWaReminders={clearAllWaReminders}
                onRecordResult={recordResult} onUpdateTeamPhone={updateTeamPhone} onRemoveTeam={removeTeam} onUpdatePhoto={updateLeaguePhoto} onUpdateDescription={updateLeagueDescription} onUpdateCreatorPhone={updateLeagueCreatorPhone} onUpdateSchedule={updateLeagueSchedule} onUpdateRoundPeriod={updateLeagueRoundPeriod} onUpdateGroupStageDueAt={updateLeagueGroupStageDueAt} onStartLadderCup={startLadderCupLeague} onUpdateMemberMessage={updateLeagueMemberMessage} onNotifyAllMembers={notifyAllMembers}
                onMarkLadderCupFirstContact={() => markLadderCupFirstContact(activeLeague, myTeam(activeLeague)?.id)}
                onEnsureLadderCupPoolSighting={(opponentTeamId) => ensureLadderCupPoolSighting(activeLeague, myTeam(activeLeague)?.id, opponentTeamId)}
                onMarkLadderCupPoolContact={(opponentTeamId) => markLadderCupPoolContact(activeLeague, myTeam(activeLeague)?.id, opponentTeamId)}
                onInitiateLadderCupMatch={(opponentTeamId) => initiateLadderCupMatch(activeLeague, myTeam(activeLeague)?.id, opponentTeamId)}
                onCancelLadderCupMatch={(match) => cancelLadderCupMatch(activeLeague, match)}
                onOpenLadderCupResult={(match) => setLadderCupResultModal({ league: activeLeague, match })}
                onRespondLadderCupMatchResult={(match, accept) => respondLadderCupMatchResult(activeLeague, match, myTeam(activeLeague)?.id, accept)}
                onAdminResolveLadderCupMatchResult={(match, approve) => adminResolveLadderCupMatchResult(activeLeague, match, approve)}
                onRespondLadderCupSecondLife={(accept) => respondLadderCupSecondLife(activeLeague, myTeam(activeLeague)?.id, accept)}
                onRejoinLadderCup={() => rejoinLadderCup(activeLeague, myTeam(activeLeague)?.id)}
                onMessageLadderCupWalkoverOpponent={(opponentTeamId) => messageLadderCupWalkoverOpponent(activeLeague, myTeam(activeLeague)?.id, opponentTeamId)}
                onSubmitLadderCupWalkoverClaim={(claim, file) => submitLadderCupWalkoverClaim(activeLeague, claim, file)}
                onApproveLadderCupWalkoverClaim={(claim) => approveLadderCupWalkoverClaim(activeLeague, claim)}
                onRejectLadderCupWalkoverClaim={(claim) => rejectLadderCupWalkoverClaim(activeLeague, claim)}
                onAdvance={advanceStage} onGenerateFixtures={generateFixtures}
                onDelete={deleteLeague} onShare={shareLeague} onLeave={leaveLeague}
                onOpenSubmitResult={(fixture, homeTeam, awayTeam, existing) => setResultModal({ league: activeLeague, fixture, homeTeam, awayTeam, existing })}
                onDownloadResultProof={downloadResultProof} onApproveResult={approveResult} onRejectResult={rejectResult}
                onRespondToResultSubmission={respondToResultSubmission}
                onPostComment={postComment} onDeleteComment={deleteComment} onEditComment={editComment} onEditResult={editResultForFixture} onEditLadderCupResult={editLadderCupMatchResult} onToggleReaction={toggleCommentReaction}
                onToggleLeagueReaction={toggleLeagueReaction} avatarByTeamId={teamAvatars} c={c} />
              </Suspense>
            )}
            {view === "leaderboard" && (
              <Suspense fallback={<Loader c={c} />}>
                {/* Same quickActionItems the floating dock uses everywhere else —
                    minus the "Leaderboard" tile itself, since that would just
                    reopen the screen already open. */}
                <LeaderboardPage leagues={leagues} session={session} memberAvatars={challengeMembers} myAvatarUrl={profile?.avatar_url} onBack={goBack}
                  quickActions={quickActionItems.filter((it) => it.label !== "Leaderboard")} c={c} />
              </Suspense>
            )}
            {view === "ladder" && (
              <Suspense fallback={<Loader c={c} />}>
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
                memberAvatars={challengeMembers} myAvatarUrl={profile?.avatar_url}
                c={c} />
              </Suspense>
            )}
            {view === "shop" && (
              <Suspense fallback={<Loader c={c} />}>
                <ShopPage c={c} session={session} profile={profile} isAdmin={isAdmin} onBack={goBack} initialProductId={shopDeepLinkProductId} />
              </Suspense>
            )}
            {view === "transferMarket" && (
              <Suspense fallback={<Loader c={c} />}>
                <TransferMarketPage c={c} session={session} profile={profile} leagues={leagues} onBack={goBack} showToast={showToast} />
              </Suspense>
            )}
            {view === "terms" && (
              <Suspense fallback={<Loader c={c} />}>
                <TermsPage c={c} onBack={goBack} />
              </Suspense>
            )}
          </>
        )}
        </ErrorBoundary>
      </main>
      {paymentModal && (
        <PaymentModal league={paymentModal.league} member={paymentModal.member}
          onCancel={() => setPaymentModal(null)} onSubmit={handlePaymentModalSubmit} onPayByCard={handlePayByCard} c={c} />
      )}
      {resultModal && (
        <SubmitResultModal league={resultModal.league} fixture={resultModal.fixture} homeTeam={resultModal.homeTeam} awayTeam={resultModal.awayTeam} existing={resultModal.existing}
          onCancel={() => setResultModal(null)} onSubmit={handleResultModalSubmit} c={c} />
      )}
      {ladderCupResultModal && (() => {
        const { league, match } = ladderCupResultModal;
        const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
        return (
          <LadderCupResultModal match={match} homeTeam={teamsById[match.home_team_id]} awayTeam={teamsById[match.away_team_id]}
            onCancel={() => setLadderCupResultModal(null)}
            onSubmit={async (result) => { const ok = await submitLadderCupMatchResult(league, match, myTeam(league)?.id, result); if (ok) setLadderCupResultModal(null); }}
            c={c} />
        );
      })()}
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

  // Every guest page load (every visitor, every refresh — not gated behind
  // sign-in) was firing this whole bundle fresh, with `select("*")` pulling
  // every column even where only one or two are ever read. That scales with
  // both total content (leagues/teams/fixtures only grow) and traffic, and
  // was a real contributor to Supabase Egress climbing well before the
  // Vercel Blob media migration was even in the picture.
  //
  // Two independent fixes here:
  //   1. Every one of the eight queries below is narrowed to the exact
  //      columns its guest-tree consumer(s) actually read — traced through
  //      computeStandings, isFixtureLocked/isGroupStageFixture,
  //      StandingsPanel, GroupTables, WeekendLeagueSpotlight,
  //      PublicLeagueCard, leagueGoalExtremes, GuestLadderStrip, and
  //      CommunityResultRow (see the comment on each query below for the
  //      specific reasoning). computeStandings/StandingsPanel/GroupTables
  //      are also used by the signed-in league page elsewhere in this file,
  //      but against a SEPARATE query there — narrowing the guest-only
  //      selects here doesn't touch that code path at all, so this is safe
  //      without needing to know what that other query returns.
  //      FixtureScoreRow (phone numbers, penalty scores) is never rendered
  //      on the guest page, so those columns are excluded entirely here.
  //   2. GUEST_DATA_CACHE_MS: cache the whole bundle in sessionStorage for a
  //      short window, so a guest refreshing the page, opening a second tab,
  //      or bouncing back from the shop within that window reuses the last
  //      fetch instead of re-querying every table again. Short enough that
  //      nobody sees meaningfully stale standings/ladder data.
  const GUEST_DATA_CACHE_MS = 90 * 1000;
  const GUEST_DATA_CACHE_KEY = "guestDataCacheV1";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cachedRaw = sessionStorage.getItem(GUEST_DATA_CACHE_KEY);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw);
          if (cached?.data && Date.now() - cached.ts < GUEST_DATA_CACHE_MS) {
            if (!cancelled) setGuestData(cached.data);
            return;
          }
        }
      } catch { /* corrupt/unavailable sessionStorage — just refetch */ }

      const [leaguesRes, teamsRes, fixturesRes, extraRes, ladderRes, resultsRes, teamAvatarsRes, settingsRes] = await Promise.all([
        // Traced through every guest-tree consumer of a league object
        // (computeStandings, isFixtureLocked/isGroupStageFixture,
        // StandingsPanel, GroupTables, WeekendLeagueSpotlight,
        // PublicLeagueCard, leagueGoalExtremes) — these are the only
        // columns any of them read. Deliberately excludes admin/member-only
        // fields like description, wa_message_template, created_by,
        // round_period_hours, entry_closes_at, comments/members/
        // result_submissions joins, etc. — none of those are touched by the
        // guest render path, only by the signed-in league page elsewhere.
        supabase.from("public_leagues").select(
          "id, name, format, starts_at, group_stage_due_at, current_stage, final_stage_started, survivor_elimination_percent, survivor_target_count, groups_count, group_qualifiers"
        ),
        // id/name/eliminated feed computeStandings; league_id is the join
        // key; group_number is read directly by GroupTables. No other team
        // field is touched anywhere in the guest tree (in particular: phone
        // is only used by FixtureScoreRow's WhatsApp call links, which the
        // guest page never renders).
        supabase.from("public_league_teams").select("id, name, eliminated, league_id, group_number"),
        // played/home_score/away_score/home_team_id/away_team_id feed
        // computeStandings and the match-history list; stage/due_at feed
        // isFixtureLocked and the weekend-window checks above. pens_home/
        // pens_away are deliberately excluded — nothing in the guest tree
        // reads them (that's FixtureScoreRow's final-penalties display,
        // also never rendered for guests).
        supabase.from("public_league_fixtures").select(
          "id, league_id, home_team_id, away_team_id, home_score, away_score, played, stage, due_at"
        ),
        // Only photo_url and league_type (isCashLeague) are ever read from
        // this view — see PublicLeagueCard / isCashLeague above.
        supabase.from("public_league_extra").select("league_id, photo_url, league_type"),
        // GuestLadderStrip is the only consumer of this data on the guest
        // page, and only ever reads these five fields off each row.
        supabase.from("public_ladder_full").select("user_id, username, points, wins, losses")
          .order("rank_position", { ascending: true }),
        // CommunityResultRow (via PublicActivityFeed) is the only consumer
        // here, and only reads these fields — same component the signed-in
        // Challenges screen uses against its own, separate query, so this
        // narrowing is scoped to just the guest fetch below.
        supabase.from("public_challenge_results")
          .select("kind, player_one, player_two, player_one_id, player_two_id, score_one, score_two, confirmed, result_confirmed_at")
          .order("result_confirmed_at", { ascending: false }).limit(50),
        // Club-owner photos for the standings tables below — team_id ->
        // avatar_url only (see public_team_avatars view), nothing else about
        // the owning member is exposed to guests.
        supabase.from("public_team_avatars").select("team_id, avatar_url"),
        // Admin's manual override of the Weekend League auto pause/resume
        // (see isWeekendPauseHour) — read-only here, guests never see the
        // toggle itself, just the resulting Live/Paused badge.
        supabase.from("app_settings").select("weekend_league_override").eq("id", 1).maybeSingle(),
      ]);
      if (cancelled) return;
      const avatarByTeamId = {};
      (teamAvatarsRes.data || []).forEach((row) => { if (row.avatar_url) avatarByTeamId[row.team_id] = row.avatar_url; });
      const nextGuestData = {
        leagues: leaguesRes.data || [],
        teams: teamsRes.data || [],
        fixtures: fixturesRes.data || [],
        extras: extraRes.data || [],
        ladder: ladderRes.data || [],
        results: resultsRes.data || [],
        avatarByTeamId,
        weekendOverride: settingsRes.data?.weekend_league_override ?? null,
      };
      setGuestData(nextGuestData);
      // Only cache a bundle where every query actually succeeded. A 400/RLS
      // error on any one of these (e.g. a view missing a column the code
      // asks for) resolves as { data: null, error: {...} }, not a thrown
      // rejection — so Promise.all still "succeeds" and nextGuestData
      // silently gets [] for that slice via the `|| []` above. Caching that
      // would freeze the broken empty state in sessionStorage for
      // GUEST_DATA_CACHE_MS on every reload, masking the real error behind
      // what looks like a fast, working page. Skipping the cache write here
      // means a real failure is visible (and re-fetched) on every reload
      // instead of being locked in.
      const anyErrored = [leaguesRes, teamsRes, fixturesRes, extraRes, ladderRes, resultsRes, teamAvatarsRes, settingsRes]
        .some((res) => res.error);
      if (anyErrored) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Guest data fetch had errors, not caching:",
            [leaguesRes, teamsRes, fixturesRes, extraRes, ladderRes, resultsRes, teamAvatarsRes, settingsRes]
              .map((res) => res.error).filter(Boolean));
        }
      } else {
        try {
          sessionStorage.setItem(GUEST_DATA_CACHE_KEY, JSON.stringify({ data: nextGuestData, ts: Date.now() }));
        } catch { /* storage full/unavailable — not worth failing the page over */ }
      }
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

  // Weekend League spotlight: whichever fun leagues an admin created either
  // kick off fresh over the coming Fri–Sun, or already have unplayed matches
  // due in that window — sorted so whatever's happening soonest leads.
  // Restricted to admin-created leagues (created_by_admin) so this stays a
  // curated, "official" highlight rather than surfacing whatever any member
  // happened to schedule for the weekend. Recomputed from the same
  // guestData already loaded above, no extra round trip.
  const [weekendStart, weekendEnd] = weekendWindow();
  // public_leagues' WHERE clause (is_platform_admin(created_by)) already
  // restricts every row this view returns to admin-created leagues — it
  // doesn't select a created_by_admin column at all, so filtering on one
  // here (like Home does against the raw leagues table) would silently
  // zero out every league instead of narrowing anything.
  const weekendLeagues = guestData ? funLeagues.reduce((items, l) => {
    const startsAtDate = l.starts_at ? new Date(l.starts_at) : null;
    const kicksOffThisWeekend = startsAtDate && startsAtDate >= weekendStart && startsAtDate <= weekendEnd;
    // Mirrors Home's logic: a groups_knockout league's real cutoff is its
    // shared group_stage_due_at, not each match's own advisory due_at.
    const groupStageDueDate = l.group_stage_due_at ? new Date(l.group_stage_due_at) : null;
    const groupStageDueThisWeekend = l.format === "groups_knockout" && groupStageDueDate && groupStageDueDate >= weekendStart && groupStageDueDate <= weekendEnd;
    const dueFixtures = groupStageDueThisWeekend
      ? guestData.fixtures.filter((f) => f.league_id === l.id && !f.played && f.stage === 1)
      : guestData.fixtures.filter((f) => f.league_id === l.id && !f.played && f.due_at && new Date(f.due_at) >= weekendStart && new Date(f.due_at) <= weekendEnd);
    if (!kicksOffThisWeekend && dueFixtures.length === 0) return items;
    const earliest = kicksOffThisWeekend ? startsAtDate.getTime() : groupStageDueThisWeekend ? groupStageDueDate.getTime() : Math.min(...dueFixtures.map((f) => new Date(f.due_at).getTime()));
    // WeekendLeagueCard (shared with the signed-in Home spotlight) reads
    // league.teams / league.fixtures / league.photo_url directly, the way
    // Home's own league objects carry them nested. The guest dataset keeps
    // those as separate top-level arrays instead (same reason PublicLeagueCard
    // derives leagueTeams/allLeagueFixtures below) — so without this, l.teams
    // and l.fixtures are simply undefined here and the card crashes reading
    // .filter off them the moment a weekend league is live for a guest.
    const leagueTeams = guestData.teams.filter((t) => t.league_id === l.id);
    const leagueFixtures = guestData.fixtures.filter((f) => f.league_id === l.id);
    const photoUrl = guestData.extras.find((e) => e.league_id === l.id)?.photo_url ?? null;
    items.push({ league: { ...l, teams: leagueTeams, fixtures: leagueFixtures, photo_url: photoUrl }, kicksOffThisWeekend, matchCount: dueFixtures.length, earliest });
    return items;
  }, []).sort((a, b) => a.earliest - b.earliest) : [];
  const weekendLeagueIds = new Set(weekendLeagues.map((it) => it.league.id));
  // The general Leagues list below excludes anything already shown in the
  // Weekend League spotlight above — so a weekend league gets one true home
  // on the page instead of appearing twice.
  const otherFunLeagues = funLeagues.filter((l) => !weekendLeagueIds.has(l.id));

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
        <ErrorBoundary resetKey={`${shopOpen}-${termsOpen}`} onGoHome={() => { setShopOpen(false); setTermsOpen(false); }}>
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

        {/* Weekend League spotlight — the most time-sensitive thing on the
            page, so it leads right after the hero rather than waiting down
            with the general Leagues list. Hidden entirely outside a
            qualifying window rather than showing an empty promo. */}
        {weekendLeagues.length > 0 && (
          <WeekendLeagueSpotlight items={weekendLeagues} weekendStart={weekendStart} weekendEnd={weekendEnd} override={guestData?.weekendOverride ?? null} onCardClick={() => onRequireAuth("Sign in to join this weekend's action.")} c={c} />
        )}

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
          {guestData && weekendLeagues.length > 0 && (
            <GuestLeagueSection title="Weekend Leagues" icon={Calendar} leagues={weekendLeagues.map((it) => it.league)} data={guestData}
              onJoin={() => onRequireAuth("Sign in to join this weekend's action.")} avatarByTeamId={guestData.avatarByTeamId} c={c} />
          )}

          {guestData && otherFunLeagues.length === 0 && (
            <section className="mt-8">
              <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
                No leagues running yet — sign in and start the first one.
              </div>
            </section>
          )}

          {guestData && (
            <GuestLeagueSection title="Leagues" icon={Gamepad2} leagues={otherFunLeagues} data={guestData}
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
        </ErrorBoundary>
      </main>
      <SupportWhatsAppButton context={shopOpen ? SHOP_NAME : "the Matchday app"} />
      <TermsFooterLink onOpen={() => setTermsOpen(true)} c={c} />
    </div>
  );
}

// Time-boxed highlight of whatever's happening over the coming Fri–Sun —
// leagues kicking off fresh, or leagues with matches already due — surfaced
// right after the hero so the "play this weekend" moment doesn't get buried
// scrolled down with the general Leagues list. items come pre-filtered and
// sorted (soonest first) from PublicHome's weekendLeagues.
//
// Gamified with: a live ticking countdown to kickoff/close, medal ranks for
// the top 3 most-active leagues (same gold/silver/bronze language as the
// Ladder), a "Hottest" flame badge on whichever league has the most matches
// due, and a per-card heat bar so activity is visible at a glance, not just
// a number.
function WeekendLeagueSpotlight({ items, weekendStart, weekendEnd, onCardClick, isJoined, override, isAdmin, onSetOverride, c }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const isWithinWeekend = now >= weekendStart && now <= weekendEnd;
  const isPaused = isWithinWeekend && isWeekendPauseHour(now, override);
  const isLiveNow = isWithinWeekend && !isPaused;
  const isOverridden = isWithinWeekend && (override === "paused" || override === "live");

  // Paused: counting down to the 9am SAST resume — unless the weekend
  // window itself wraps up first (Sunday night's pause has no Monday
  // morning to resume into), in which case it's just counting down to the
  // end. Live: counting down to whichever comes first — the 9pm SAST pause
  // or the weekend ending. Not started: counting down to weekendStart.
  let targetTime, liveTargetIsEnd = true, pausedTargetIsEnd = false;
  if (isPaused) {
    const resumeAt = nextSastHourBoundary(now, 9);
    if (resumeAt > weekendEnd) { targetTime = weekendEnd; pausedTargetIsEnd = true; }
    else { targetTime = resumeAt; }
  } else if (isLiveNow) {
    const nextPause = nextSastHourBoundary(now, 21);
    if (nextPause < weekendEnd) { targetTime = nextPause; liveTargetIsEnd = false; }
    else { targetTime = weekendEnd; }
  } else {
    targetTime = weekendStart;
  }
  const diffMs = Math.max(0, targetTime.getTime() - now.getTime());
  const diffDays = Math.floor(diffMs / 86400000);
  const diffHours = Math.floor((diffMs % 86400000) / 3600000);
  const diffMins = Math.floor((diffMs % 3600000) / 60000);
  const countdownLabel = diffDays > 0 ? `${diffDays}d ${diffHours}h` : diffHours > 0 ? `${diffHours}h ${diffMins}m` : `${diffMins}m`;

  const totalMatches = items.reduce((sum, it) => sum + it.matchCount, 0);
  const maxMatches = Math.max(1, ...items.map((it) => it.matchCount));
  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];

  return (
    <section className="relative mt-4 rounded-2xl overflow-hidden" style={{ background: `linear-gradient(120deg, ${c.accent}22, ${c.surface})`, border: `1px solid ${c.accent}55` }}>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-glow-drift absolute -top-16 -right-10 w-40 h-40 rounded-full blur-3xl" style={{ background: c.accent, opacity: 0.22 }} />
      </div>
      <div className="relative px-4 pt-3.5 pb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] uppercase shrink-0" style={{ color: c.accent }}>
          <Calendar size={12} /> Weekend League
        </div>
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0" style={{ background: c.surfaceHover, color: c.text }}>
          {isPaused ? (
            <><Pause size={10} /> Paused · {isOverridden ? "admin override" : `${pausedTargetIsEnd ? "ends" : "resumes"} in ${countdownLabel}`}</>
          ) : isLiveNow ? (
            <>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full" style={{ background: c.accent }} />
              </span>
              Live · {isOverridden ? "admin override" : `${liveTargetIsEnd ? "ends" : "pauses"} in ${countdownLabel}`}
            </>
          ) : (
            <><Clock size={10} /> Starts in {countdownLabel}</>
          )}
        </div>
      </div>
      <div className="relative px-4 pb-1.5 flex items-center gap-1.5 font-body text-xs" style={{ color: c.textDim }}>
        {isPaused
          ? "Overnight break — results can still be uploaded"
          : `${items.length === 1 ? "One league" : `${items.length} leagues`} in action Friday through Sunday`}
        {totalMatches > 0 && (
          <span className="flex items-center gap-0.5 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: `${c.accent}22`, color: c.accent }}>
            <Zap size={9} /> {totalMatches} match{totalMatches === 1 ? "" : "es"}
          </span>
        )}
      </div>
      {/* Admin-only manual override of the 9pm–9am auto pause/resume — for
          the odd weekend where the schedule needs a nudge (e.g. keep it
          live late for a big final, or pause early for maintenance).
          Hidden entirely for everyone else, including logged-in players. */}
      {isAdmin && onSetOverride && (
        <div className="relative px-4 pb-1.5 flex items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-wide shrink-0" style={{ color: c.textFaint }}>Admin:</span>
          {[
            { key: null, label: "Auto" },
            { key: "live", label: "Force live" },
            { key: "paused", label: "Force pause" },
          ].map((opt) => {
            const active = (override ?? null) === opt.key;
            return (
              <button key={opt.label} onClick={() => onSetOverride(opt.key)}
                className="font-mono text-[9px] uppercase tracking-wide px-2 py-0.5 rounded-full transition-transform active:scale-95"
                style={active
                  ? { background: c.accent, color: "#fff" }
                  : { background: c.surfaceHover, color: c.textDim, border: `1px solid ${c.border}` }}>
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="relative no-scrollbar flex items-stretch gap-3 overflow-x-auto px-4 pb-4 pt-1.5">
        {items.map((item, i) => {
          const isHottest = item.matchCount > 0 && item.matchCount === maxMatches && items.filter((it) => it.matchCount === maxMatches).length === 1;
          const heatPct = Math.round((item.matchCount / maxMatches) * 100);
          return (
            <WeekendLeagueCard key={item.league.id} item={item} index={i} isHottest={isHottest} heatPct={heatPct}
              isJoined={isJoined} onCardClick={onCardClick} rankColors={rankColors} c={c} />
          );
        })}
      </div>
    </section>
  );
}

// The weekend spotlight's own take on a league card — deliberately built to
// echo LeagueCard's real info (crest, format/stage, club count, progress,
// leader) rather than the old name-only chip, but with its own silhouette
// (a clipped "pass"/ticket shape with a folded corner) so it never reads as
// just another entry in the regular Leagues list — this is the one league
// the spotlight is telling you not to miss.
function WeekendLeagueCard({ item, index, isHottest, heatPct, isJoined, onCardClick, rankColors, c }) {
  const { league: l, kicksOffThisWeekend, matchCount } = item;
  // Defensive fallbacks: the signed-in Home spotlight's league objects
  // always carry these nested, but belt-and-suspenders against any caller
  // (guest homepage included — see its item-building code) that doesn't.
  const teams = l.teams || [];
  const fixtures = l.fixtures || [];
  const isLadderCup = l.format === "ladder_cup";
  const ladderMatches = isLadderCup ? (l.ladder_cup_matches || []) : [];
  const ladderPlayedCount = ladderMatches.filter((m) => m.finalized_at).length;
  const played = isLadderCup ? ladderPlayedCount : fixtures.filter((f) => f.played).length;
  const isStaged = l.format === "survivor" || l.format === "groups_knockout";
  const activeTeams = l.format === "survivor" ? teams.filter((t) => !t.eliminated) : teams;
  const leader = computeStandings(activeTeams, fixtures.filter((f) => !isStaged || f.stage === l.current_stage), l)[0];
  const formatLabel = FORMATS.find((f) => f.id === l.format)?.label || l.format;
  const stageLabel = l.format === "survivor" ? (l.final_stage_started ? "Final stage" : `Stage ${l.current_stage}`)
    : l.format === "groups_knockout" ? (l.final_stage_started ? "Knockout stage" : "Group stage") : null;
  const initial = (l.name || "?").trim().charAt(0).toUpperCase();
  const joined = isJoined?.(l);
  const rankColor = index < 3 ? rankColors[index] : null;

  return (
    <button onClick={() => onCardClick(l)} className="relative shrink-0 w-[184px] text-left cursor-pointer transition-transform active:scale-[0.97]"
      style={{ filter: isHottest ? `drop-shadow(0 0 8px ${c.accent}66)` : "none" }}>
      <div className="relative overflow-hidden"
        style={{
          clipPath: "polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 16px 100%, 0 calc(100% - 16px))",
          background: c.surface,
          border: `1px solid ${rankColor ? rankColor + "77" : c.accent + "55"}`,
        }}>
        {/* Folded-corner accent — the visual signature that makes this read
            as a "pass" rather than a plain card, colored by weekend rank. */}
        <div className="absolute top-0 right-0 w-[22px] h-[22px]"
          style={{ background: rankColor || c.accent, clipPath: "polygon(100% 0, 0 0, 100% 100%)" }} />

        <div className="relative h-[76px] flex items-center justify-center overflow-hidden"
          style={{ background: l.photo_url ? undefined : `linear-gradient(150deg, ${c.accent}33, ${c.accent}0D)` }}>
          {l.photo_url ? (
            <img src={toProxiedUrl(l.photo_url)} alt="" loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <span className="font-extrabold text-2xl" style={{ color: c.accent, opacity: 0.85 }}>{initial}</span>
          )}
          {isHottest && (
            <span className="absolute top-1.5 left-1.5 flex items-center gap-0.5 font-mono text-[9px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: c.red, color: "#fff" }}>
              <Flame size={9} /> Hottest
            </span>
          )}
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full pl-1 pr-1.5 py-0.5"
            style={{ background: `${c.bg}CC`, border: `1px solid ${rankColor ? rankColor + "66" : c.border}` }}>
            {rankColor ? (
              index === 0 ? <Crown size={11} style={{ color: rankColors[0] }} /> : <Medal size={11} style={{ color: rankColor }} />
            ) : (
              <span className="w-3.5 text-center font-mono text-[9px] font-bold" style={{ color: c.textFaint }}>{index + 1}</span>
            )}
            <span className="font-mono text-[9px] font-bold" style={{ color: c.text }}>#{index + 1}</span>
          </div>
        </div>

        <div className="p-2.5 pb-3">
          <div className="font-extrabold text-sm leading-tight truncate">{l.name}</div>
          <div className="font-mono text-[9px] uppercase tracking-wider truncate mt-0.5" style={{ color: c.textFaint }}>
            {stageLabel || formatLabel}
          </div>

          <div className="flex items-center gap-1 mt-1.5 font-mono text-[9px]" style={{ color: c.textDim }}>
            <Shield size={9} /> {teams.length}
            {isLadderCup
              ? ladderMatches.length > 0 && <span className="ml-1">· {played} played</span>
              : fixtures.length > 0 && <span className="ml-1">· {played}/{fixtures.length}</span>}
          </div>

          {leader && leader.p > 0 && (
            <div className="flex items-center gap-1 font-mono text-[9px] truncate mt-1" style={{ color: c.textFaint }}>
              <Crown size={9} style={{ color: c.accent }} /> <span className="truncate">{leader.name}</span>
            </div>
          )}

          <div className="font-mono text-[10px] uppercase tracking-wide mt-1.5" style={{ color: c.accent }}>
            {kicksOffThisWeekend ? "Kicks off this weekend" : `${matchCount} match${matchCount === 1 ? "" : "es"} due`}
          </div>
          {matchCount > 0 && (
            <div className="w-full h-1 rounded-full overflow-hidden mt-1" style={{ background: c.surfaceHover }}>
              <div className="h-full rounded-full" style={{ width: `${heatPct}%`, background: c.accent }} />
            </div>
          )}

          <div className="flex items-center gap-1 font-mono text-[10px] mt-2" style={{ color: c.textFaint }}>
            {joined ? <><ChevronRight size={9} /> View league</> : <><Lock size={9} /> Join the action</>}
          </div>
        </div>
      </div>
    </button>
  );
}

// One equal-weight tile in the guest quick-action grid — same visual as the
// signed-in Home's MenuTile, plus a small lock badge on anything that needs
// an account. Ladder just scrolls down to content that's already public;
// Shop carries an "external" badge instead of a lock since it needs no
// account, it just leaves the app.
function GuestMenuTile({ icon: Icon, label, locked, external, onClick, c }) {  return (
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
      <img src={toProxiedUrl(extra.photo_url)} alt="" loading="lazy" decoding="async" className="w-full h-32 object-cover rounded-lg mb-2" />
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
  const standings = computeStandings(activeTeams, leagueFixtures, l);
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
                  <img src={toProxiedUrl(p.image_url)} alt={p.name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
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

function ProfileGate({ c, theme, toggleTheme, onSubmit, userEmail, onSignOut }) {
  const [phone, setPhone] = useState("");
  const [username, setUsername] = useState("");
  const [age, setAge] = useState("");
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const fileInputRef = useRef(null);
  const usernameTrimmed = username.trim();
  const usernameIsOneWord = usernameTrimmed.length > 0 && !/\s/.test(usernameTrimmed);
  const usernameValid = usernameTrimmed.length >= 2 && usernameIsOneWord;
  const ageNum = parseInt(age, 10);
  const ageValid = Number.isInteger(ageNum) && ageNum > 0;
  const phoneTrimmed = phone.trim();
  const phoneValid = phoneTrimmed.startsWith("+") && phoneTrimmed.length >= 8;
  const valid = usernameValid && ageValid && phoneValid && agreedToTerms;

  // Surfaces the single most relevant reason the button is disabled, in the
  // same top-to-bottom order as the fields, so people aren't left guessing
  // which of several issues to fix first.
  const disabledReason = !usernameValid
    ? "Enter your eFootball username"
    : !ageValid
    ? "Enter your age to continue"
    : !phoneValid
    ? "Enter a valid phone number with country code"
    : !agreedToTerms
    ? "Agree to the Terms & Conditions to continue"
    : undefined;

  const handlePhoto = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  };

  // Object URLs aren't garbage-collected automatically — without this, picking
  // a photo then changing it (or leaving this screen, e.g. via the sign-out
  // link above) leaks the blob for the life of the tab. Runs on every change
  // AND on unmount, since the cleanup closes over whichever URL was current.
  useEffect(() => {
    return () => { if (photoPreview) URL.revokeObjectURL(photoPreview); };
  }, [photoPreview]);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    await onSubmit(phoneTrimmed, usernameTrimmed, ageNum, photoFile);
    setSubmitting(false);
  };

  // Lets people finish onboarding by pressing Enter in any field instead of
  // having to reach for the button — there's no <form> here (this component
  // is embedded, not a standalone page), so Enter wouldn't submit otherwise.
  const handleKeyDown = (e) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: c.bg, color: c.text, fontFamily: "'Barlow Condensed', 'Oswald', sans-serif" }}>
      <button onClick={toggleTheme} aria-label="Toggle dark mode" className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
        {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <div className="w-14 h-14 rounded-xl flex items-center justify-center mb-5" style={{ background: c.green }}><Lock size={24} color={c.accent} /></div>
      <h1 className="text-3xl font-extrabold uppercase tracking-tight text-center leading-none mb-2">One more step</h1>
      <p className="font-body text-center max-w-sm mb-6" style={{ color: c.textDim }}>
        Confirm your age, phone number and eFootball username before you can access leagues. Other players use these to reach you for matches.
      </p>
      {userEmail && onSignOut && (
        <p className="font-mono text-[11px] text-center mb-6" style={{ color: c.textFaint }}>
          Signed in as {userEmail} ·{" "}
          <button type="button" onClick={onSignOut} className="underline">Not you? Sign out</button>
        </p>
      )}
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-5">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhoto} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} aria-label={photoPreview ? "Change profile photo" : "Add profile photo"}
            className="relative w-20 h-20 rounded-full overflow-hidden flex items-center justify-center mb-2"
            style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            {photoPreview ? <img src={photoPreview} alt="" className="w-full h-full object-cover" /> : <Camera size={20} style={{ color: c.textFaint }} />}
          </button>
          <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>
            {photoPreview ? "Change photo" : "Add profile photo (optional)"}
          </span>
        </div>
        <label htmlFor="pg-username" className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>eFootball username <span style={{ color: c.textFaint }}>(one word, exactly as it appears in-game)</span></label>
        <input id="pg-username" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={handleKeyDown}
          placeholder="e.g. Ndosi_123" autoFocus autoComplete="username" required
          aria-invalid={usernameTrimmed.length > 0 && !usernameIsOneWord}
          aria-describedby={usernameTrimmed.length > 0 && !usernameIsOneWord ? "pg-username-error" : undefined}
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        {usernameTrimmed.length > 0 && !usernameIsOneWord && (
          <p id="pg-username-error" className="font-body text-xs mb-1.5" style={{ color: c.red }}>No spaces — use one word, like your actual in-game username (e.g. "Bounce_Academy" not "Bounce Academy").</p>
        )}
        <div className="mb-4" />
        <label htmlFor="pg-age" className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Age</label>
        <input id="pg-age" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, "").slice(0, 3))} onKeyDown={handleKeyDown}
          placeholder="e.g. 24" type="text" inputMode="numeric" autoComplete="off" required
          aria-invalid={age.length > 0 && !ageValid}
          aria-describedby={age.length > 0 && !ageValid ? "pg-age-error" : undefined}
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        {age.length > 0 && !ageValid && (
          <p id="pg-age-error" className="font-body text-xs mb-1.5" style={{ color: c.red }}>Enter a valid age.</p>
        )}
        <div className="mb-4" />
        <label htmlFor="pg-phone" className="block font-mono text-xs uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Phone number <span style={{ color: c.textFaint }}>(with country code)</span></label>
        <input id="pg-phone" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={handleKeyDown}
          placeholder="+27 82 123 4567" type="tel" autoComplete="tel" required
          aria-invalid={phoneTrimmed.length > 0 && !phoneValid}
          aria-describedby="pg-phone-hint"
          className="w-full border rounded-lg px-4 py-2.5 font-body outline-none mb-1.5" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
        <p id="pg-phone-hint" className="font-body text-xs mb-5" style={{ color: phoneTrimmed.length > 0 && !phoneValid ? c.red : c.textFaint }}>Must start with + and your country code, e.g. +27, +234, +1.</p>
        <label className="flex items-start gap-2.5 mb-5 cursor-pointer">
          <input type="checkbox" checked={agreedToTerms} onChange={(e) => setAgreedToTerms(e.target.checked)}
            className="mt-0.5 w-4 h-4 shrink-0 rounded" style={{ accentColor: c.accent }} />
          <span className="font-body text-xs" style={{ color: c.textDim }}>
            I agree to the{" "}
            <button type="button" onClick={() => setTermsOpen(true)} className="underline font-semibold" style={{ color: c.text }}>
              Terms &amp; Conditions
            </button>, including how cash league entry fees, prize pools, and results work.
          </span>
        </label>
        <button disabled={!valid || submitting} onClick={submit}
          title={disabledReason}
          className="w-full font-body font-semibold px-4 py-3 rounded-full"
          style={valid ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
          {submitting ? "Saving..." : "Continue to Matchday"}
        </button>
        {disabledReason && !submitting && (
          <p className="font-body text-xs text-center mt-2" style={{ color: c.textFaint }}>{disabledReason}</p>
        )}
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
          <button aria-label="Close" onClick={onCancel} className="p-1" style={{ color: c.textFaint }}><X size={18} /></button>
        </div>
        <div className="flex flex-col items-center mb-5">
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhoto} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} disabled={uploadingPhoto}
            className="relative w-20 h-20 rounded-full overflow-hidden flex items-center justify-center mb-2"
            style={{ background: c.surface, border: `1px solid ${c.border}`, opacity: uploadingPhoto ? 0.6 : 1 }}>
            {profile?.avatar_url ? <img src={toProxiedUrl(profile.avatar_url)} alt="" className="w-full h-full object-cover" /> : <Camera size={20} style={{ color: c.textFaint }} />}
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
// Admin-only raw activity feed — step 1 of activity tracking (see
// activityLog.js and the get_activity_log RPC). Deliberately plain: no
// filtering or grouping yet, just the most recent 200 events, newest
// first. Filters/search/grouping are a good "next small step" once this
// is confirmed to be capturing the right things.
function ActivityLogPanel({ activityLog, onBack, c }) {
  if (activityLog === null) return <div className="pt-8"><Loader c={c} /></div>;

  const formatEvent = (type) => type.replace(/_/g, " ");

  return (
    <div className="pt-8">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}><ArrowLeft size={15} /> All leagues</button>
      </div>

      <div className="flex items-center gap-2 mb-1">
        <History size={20} style={{ color: c.accent }} />
        <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none">Activity log</h1>
      </div>
      <div className="font-mono text-xs mb-5" style={{ color: c.textFaint }}>
        Most recent {activityLog.length} event{activityLog.length === 1 ? "" : "s"}
      </div>

      {activityLog.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          No activity recorded yet.
        </div>
      ) : (
        <div className="space-y-1.5">
          {activityLog.map((row) => (
            <div key={row.id} className="flex items-center justify-between border rounded-lg px-3.5 py-2.5" style={{ background: c.surface, borderColor: c.border }}>
              <div className="min-w-0">
                <div className="font-body text-sm font-semibold truncate" style={{ color: c.text }}>
                  {row.efootball_username || row.email || "Unknown user"}
                </div>
                <div className="font-mono text-xs capitalize" style={{ color: c.textFaint }}>
                  {formatEvent(row.event_type)}
                </div>
              </div>
              <div className="font-mono text-xs shrink-0 pl-3" style={{ color: c.textFaint }}>
                {new Date(row.created_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountsPanel({ accounts, leagues, session, onDelete, onApprove, onBack, showToast, c }) {
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
              onDelete={() => onDelete(a, leagueCountsFor(a.user_id))} onApprove={() => onApprove(a)} showToast={showToast} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

export const LEADERBOARD_MIN_PLAYED_FOR_WINRATE = 3; // guards against one lucky match topping the win-rate view

export function rankLeaderboard(rows, metric) {
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
export function GoalExtremesBar({ top, least, c }) {
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

function AccountRow({ account, leagueCounts, isSelf, onDelete, onApprove, showToast, c }) {
  const [copiedField, setCopiedField] = useState(null); // "phone" | "username" | null
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantAmount, setGrantAmount] = useState("100");
  const [granting, setGranting] = useState(false);
  const isFlagged = (account.phone || "").includes("(DUPLICATE-");
  const digitsOnly = (account.phone || "").replace(/\D/g, "");

  const copy = (field, value) => {
    navigator.clipboard?.writeText(value || "");
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const grantNets = async () => {
    const amount = Number(grantAmount);
    if (!amount || amount <= 0) { showToast?.("Enter a Nets amount above 0."); return; }
    setGranting(true);
    try {
      await creditNets(account.user_id, amount, "admin_grant", { note: `Granted by admin to ${account.efootball_username || account.user_id}` });
      showToast?.(`Granted ${formatNets(amount)} to ${account.efootball_username || "this account"}.`);
      setGrantOpen(false);
      setGrantAmount("100");
    } catch (err) {
      showToast?.(`Couldn't grant Nets: ${err.message}`);
    } finally {
      setGranting(false);
    }
  };

  return (
    <div className="rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
    <div className="flex items-center gap-3">
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
      <button onClick={() => setGrantOpen((v) => !v)} title="Grant Nets" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ color: grantOpen ? c.accent : c.textFaint }}>
        <Coins size={13} />
      </button>
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
    {grantOpen && (
      <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t" style={{ borderColor: c.border }}>
        <Coins size={13} style={{ color: "#D4A017" }} />
        <input type="number" min="1" value={grantAmount} onChange={(e) => setGrantAmount(e.target.value)}
          className="w-24 border rounded-lg px-2 py-1 font-mono text-xs outline-none" style={{ background: c.bg, borderColor: c.border, color: c.text }} />
        <button onClick={grantNets} disabled={granting} className="font-mono text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-full font-bold shrink-0" style={{ background: c.accent, color: c.bg, opacity: granting ? 0.6 : 1 }}>
          {granting ? "Granting…" : `Grant to ${account.efootball_username || "account"}`}
        </button>
      </div>
    )}
    </div>
  );
}

// Small round avatar used on the Challenges screen — a photo if the member
// has one, otherwise the same colored-initial fallback used for comments.
export function MemberAvatar({ url, username, size = 32, c }) {
  if (url) {
    // Every avatar in the app (comments, member lists, leaderboards,
    // challenges) renders through this one component, so this single
    // toProxiedUrl call is what stops old-style direct Supabase avatar
    // URLs from costing Cached Egress on every view — see mediaUrl.js.
    return <img src={toProxiedUrl(url)} alt="" loading="lazy" decoding="async" style={{ width: size, height: size }} className="rounded-full object-cover shrink-0" />;
  }
  return (
    <div className="rounded-full flex items-center justify-center font-body font-bold shrink-0"
      style={{ width: size, height: size, background: avatarColor(username || "?"), color: "#fff", fontSize: size * 0.4 }}>
      {(username || "?")[0]?.toUpperCase()}
    </div>
  );
}

// Shared emoji medal for a numeric rank — used by the standings, ladder and
// leaderboard tables, and by PlayerProfileModal below, so the top-3 styling
// can never drift between screens the way it did when each one kept its own
// copy (Standings' copy had gone stale and always rendered null). Returns
// null for rank > 3 — callers fall back to "#rank" text themselves.
export function medalFor(rank) {
  return rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;
}

// Rating-card tier for a rank — turns the plain "top 3 get a ring" idea into
// a small FIFA/eFootball-style card system so PlayerProfileModal reads as a
// player card reveal rather than a settings sheet. Colors are fixed hex (not
// theme-derived) for the medal tiers so gold/silver/bronze read correctly in
// both light and dark mode; the two non-medal tiers fall back to the app's
// own accent color so they still look native to whichever theme is active.
const CARD_TIERS = {
  gold: { label: "🥇 GOLD CARD", ring: "#FFD700" },
  silver: { label: "🥈 SILVER CARD", ring: "#C0C0C0" },
  bronze: { label: "🥉 BRONZE CARD", ring: "#CD7F32" },
};
function tierFor(rank, c) {
  if (rank === 1) return { key: "gold", ...CARD_TIERS.gold };
  if (rank === 2) return { key: "silver", ...CARD_TIERS.silver };
  if (rank === 3) return { key: "bronze", ...CARD_TIERS.bronze };
  if (rank != null && rank <= 10) return { key: "rated", label: "⭐ IN FORM", ring: c.accent };
  return { key: "standard", label: "SQUAD PLAYER", ring: c.accent };
}

// Splits a stat value into a numeric part (for count-up animation) plus any
// fixed prefix/suffix around it — "+3" animates the 3 and keeps the "+",
// "84%" animates the 84 and keeps the "%". Multi-number strings like
// "3 · 1 · 2" (W · D · L) don't match, so those stay static; animating three
// numbers ticking independently inside one string would read as noise, not
// a game stat reveal.
function parseNumericStat(raw) {
  const str = String(raw);
  const m = str.match(/^([+-]?)(\d+)([^\d]*)$/);
  if (!m) return null;
  return { prefix: m[1], number: parseInt(m[2], 10), suffix: m[3] };
}

// Counts up from 0 to `target` on mount (ease-out), optionally after a
// stagger delay — gives each stat tile its own little "reveal" instead of
// all numbers just appearing at once. Returns `target` unchanged (no
// animation) when target is null, i.e. the stat wasn't numeric.
function useCountUp(target, { duration = 700, delay = 0 } = {}) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target == null) return;
    let raf = null;
    const timer = setTimeout(() => {
      let startTs = null;
      const step = (ts) => {
        if (startTs === null) startTs = ts;
        const progress = Math.min((ts - startTs) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        setValue(Math.round(target * eased));
        if (progress < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, delay);
    return () => { clearTimeout(timer); if (raf) cancelAnimationFrame(raf); };
  }, [target, duration, delay]);
  return target == null ? null : value;
}

// One stat tile on the player card — a plain number ticks up from 0 and the
// tile itself fades/slides in on a per-index stagger, so the stat grid reads
// as a reveal rather than a table dump.
function StatTile({ label, value, index, c, ring }) {
  const parsed = parseNumericStat(value);
  const animated = useCountUp(parsed ? parsed.number : null, { duration: 650, delay: 200 + index * 70 });
  const display = parsed ? `${parsed.prefix}${animated}${parsed.suffix}` : value;
  return (
    <div className="rounded-xl px-3 py-2.5 text-center relative overflow-hidden"
      style={{ background: c.surface, animation: "stat-tile-in 0.4s ease backwards", animationDelay: `${120 + index * 60}ms` }}>
      <div className="absolute top-0 left-0 right-0 h-[2px]" style={{ background: ring, opacity: 0.7 }} />
      <div className="font-mono text-base font-bold tabular-nums">{display}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider mt-0.5" style={{ color: c.textFaint }}>{label}</div>
    </div>
  );
}

// A read-only popup showing one player's photo and stats, styled as an
// eFootball-style rated player card — reused by the Leaderboard, Ladder and
// Standings screens so tapping any row (not just your own) feels like
// pulling a card rather than opening a settings sheet. `stats` is a plain
// list of {label, value} pairs the caller has already computed, so this
// component stays completely agnostic to whether it's showing leaderboard
// fields (W/D/L, goals) or ladder fields (points, rank) — no extra data
// fetching happens here, it only ever renders what's already in memory (the
// same row object the list itself was built from), so opening it costs
// nothing beyond the avatar image, which already goes through
// MemberAvatar's egress-safe proxying.
//
// The tier (and medal) is derived from `rank` right here rather than taken
// as a prop — callers used to compute their own medal copy and pass it in,
// which is how Standings ended up always passing null (its copy silently
// went stale). One source of truth now; callers just pass the rank they
// already have.
export function PlayerProfileModal({ username, avatarUrl, rank, isMe, stats, badges, onClose, c }) {
  const tier = tierFor(rank, c);
  const isMedal = tier.key === "gold" || tier.key === "silver" || tier.key === "bronze";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.65)" }} onClick={onClose}>
      <div
        className="relative w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5 overflow-hidden"
        style={{
          background: c.bg, color: c.text, border: `1.5px solid ${tier.ring}`,
          boxShadow: isMedal ? `0 0 0 1px ${tier.ring}33, 0 14px 40px ${tier.ring}26` : `0 12px 32px rgba(0,0,0,0.35)`,
          animation: "card-pop-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) backwards",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tier-tinted wash across the whole card — subtle for the rated/
            squad tiers, more present for medal cards. */}
        <div className="absolute inset-0 pointer-events-none" style={{ background: `linear-gradient(135deg, ${tier.ring}${isMedal ? "26" : "12"}, transparent 60%)` }} />
        {/* Pack-opening light sweep, medal tiers only, plays once on open. */}
        {isMedal && (
          <div className="absolute inset-0 pointer-events-none animate-card-shine"
            style={{ background: `linear-gradient(115deg, transparent 30%, ${tier.ring}40 48%, transparent 66%)`, backgroundSize: "250% 250%" }} />
        )}

        <div className="relative flex items-center justify-between mb-1">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] px-2 py-1 rounded-full"
            style={{ color: isMedal ? tier.ring : c.accent, background: isMedal ? `${tier.ring}1F` : c.surface }}>
            {tier.label}
          </span>
          <button aria-label="Close" onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full" style={{ background: c.surface }}><X size={14} /></button>
        </div>

        <div className="relative flex flex-col items-center text-center mt-1 mb-4">
          <div className="relative mb-2">
            <div style={{ padding: 3, borderRadius: "9999px", border: `2px solid ${tier.ring}`, ...(isMedal ? { animation: "card-tier-glow 2.2s ease-in-out infinite", "--badge-glow": tier.ring } : {}) }}>
              <MemberAvatar url={avatarUrl} username={username} size={72} c={c} />
            </div>
            {rank != null && (
              <div className="absolute -bottom-1 -right-1 min-w-[26px] h-[26px] px-1 rounded-full flex items-center justify-center font-mono text-[11px] font-extrabold border-2"
                style={{ background: c.bg, borderColor: tier.ring, color: tier.ring }}>
                #{rank}
              </div>
            )}
          </div>
          <div className="font-extrabold text-lg leading-tight">{username}{isMe ? " (you)" : ""}</div>
        </div>

        <div className="relative grid grid-cols-2 gap-2">
          {stats.map((s, i) => (
            <StatTile key={s.label} label={s.label} value={s.value} index={i} c={c} ring={tier.ring} />
          ))}
        </div>

        {/* Earned badges — same defs the caller's own compact badge row
            uses (e.g. LadderCupBadgeRow), but spelled out here with a
            label and count per chip since the card has room and everyone
            who opens it should be able to tell what each one means, not
            just squint at an icon. Only rendered when the caller actually
            passes badges, so Leaderboard/Ladder cards (no badge concept)
            are unaffected. */}
        {badges && badges.length > 0 && (
          <div className="relative mt-3 pt-3 border-t" style={{ borderColor: c.border }}>
            <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Badges</div>
            <div className="flex flex-wrap gap-1.5">
              {badges.map(({ icon: Icon, label, color, flame }, i) => (
                <span key={i} className={`inline-flex items-center gap-1 font-mono text-[10px] font-semibold px-2 py-1 rounded-full ${flame ? "animate-ladder-flame" : ""}`}
                  style={{ background: `${color}22`, color, boxShadow: `0 0 0 1px ${color}55` }}>
                  <Icon size={11} /> {label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Lets any member challenge any other member to a friendly match, and manage
// the challenges they've sent or received. A challenge starts as "pending" —
// visible to both sides, actionable only by whoever received it. Once they
// accept, both people's WhatsApp icon becomes visible to the other; nobody's
// number is exposed before that. Declining just tells the sender it was seen.

function Header({ view, setView, activeLeague, theme, toggleTheme, c, onSignOut, userEmail, avatarUrl, onEditProfile, isAdmin, onOpenAccounts, onOpenActivity, onOpenChallenges, challengeBadge, onOpenSuggestion, onOpenLeaderboard, onOpenLadder, onOpenCreate, grabbableCount }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    // touchstart as well as mousedown — mousedown alone can fire late (or
    // not at all before the next tap) on touch devices, which was part of
    // why this menu was unreliable on mobile.
    document.addEventListener("mousedown", onClick);
    document.addEventListener("touchstart", onClick);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("touchstart", onClick); };
  }, [menuOpen]);

  // Everything except Edit profile now lives in here — on a narrow phone
  // screen, the old row of 7-8 separate icon buttons ran wider than the
  // viewport itself (the page clips horizontal overflow, so anything past
  // the edge was simply never reachable). Two buttons — profile + this
  // menu — always fit.
  const menuItems = [
    { icon: TrendingUp, label: "Ladder", onClick: onOpenLadder },
    { icon: Trophy, label: "Leaderboard", onClick: onOpenLeaderboard },
    { icon: MessageCircle, label: "Suggest something", onClick: onOpenSuggestion },
    ...(isAdmin ? [{ icon: Shield, label: "All accounts", onClick: onOpenAccounts }] : []),
    ...(isAdmin ? [{ icon: History, label: "Activity log", onClick: onOpenActivity }] : []),
    { icon: theme === "dark" ? Sun : Moon, label: theme === "dark" ? "Light mode" : "Dark mode", onClick: toggleTheme },
    { icon: LogOut, label: "Sign out", onClick: onSignOut },
  ];

  return (
    <header className="border-b sticky top-0 backdrop-blur z-40" style={{ borderColor: c.border, background: `${c.bg}F2` }}>
      <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
        <button onClick={() => setView("home")} className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded flex items-center justify-center shrink-0" style={{ background: c.green }}><Trophy size={16} color={c.accent} /></div>
          <div className="text-lg font-extrabold tracking-tight uppercase truncate">Matchday</div>
        </button>
        {view === "league" && activeLeague && (
          <div className="hidden sm:block font-mono text-xs uppercase tracking-wider shrink-0" style={{ color: c.textFaint }}>
            {activeLeague.teams.length} clubs · {activeLeague.fixtures.filter((f) => f.played).length}/{activeLeague.fixtures.length} played
          </div>
        )}
        <div className="flex items-center gap-2 shrink-0">
          <NetsBadge c={c} />

          <button onClick={onEditProfile} title="Edit profile" className="w-8 h-8 flex items-center justify-center rounded-full overflow-hidden shrink-0" style={{ background: c.surface, color: c.textDim }}>
            {avatarUrl ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" /> : <Settings2 size={14} />}
          </button>

          <div ref={menuRef} className="relative shrink-0">
            <button onClick={() => setMenuOpen((v) => !v)} title="Menu" className="relative w-8 h-8 flex items-center justify-center rounded-full" style={menuOpen ? { background: c.text, color: c.bg } : { background: c.surface, color: c.textDim }}>
              <Menu size={16} />
              {(challengeBadge > 0 || grabbableCount > 0) && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center font-mono text-[8px] font-bold" style={{ background: c.red, color: "#fff" }}>{challengeBadge + grabbableCount}</span>
              )}
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-10 w-52 max-w-[85vw] rounded-xl border shadow-lg overflow-hidden z-50" style={{ background: c.bg, borderColor: c.borderStrong }}>
                {menuItems.map((it) => (
                  <button key={it.label} onClick={() => { setMenuOpen(false); it.onClick?.(); }}
                    className="w-full flex items-center gap-2.5 font-body text-sm font-semibold px-3.5 py-2.5 text-left"
                    style={{ color: c.text }}>
                    <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: c.surfaceHover }}>
                      <it.icon size={13} style={{ color: c.accent }} />
                    </span>
                    <span className="truncate">{it.label}</span>
                    {it.badge > 0 && (
                      <span className="ml-auto shrink-0 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center font-mono text-[9px] font-bold" style={{ background: c.red, color: "#fff" }}>{it.badge}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
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
          <button aria-label="Close" onClick={onCancel} style={{ color: c.textFaint }}><X size={16} /></button>
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

function Home({ leagues, isAdmin, isMemberOf, entryClosed, qualifiesForLeague, myPaymentStatus, canManageLeague, myTeam, onOpen, onCreate, onJoin, session, onToggleLeagueReaction, challenges, openChallenges, onOpenChallenges, onOpenLogResult, onOpenLogResultOpen, ladder, myLadderRank, onOpenLadder, onOpenLeaderboard, onOpenShop, onOpenTransferMarket, memberAvatars, allAchievements, onAchievementsSynced, myAvatarUrl, weekendOverride, onSetWeekendOverride, showToast, quickActions, c }) {
  // The per-minute attention-score tick (see LeagueListsSection below) used
  // to live here, which meant the achievements/Wall of Fame/XP-bar/
  // leaderboard machinery below — none of which is time-sensitive — also
  // re-ran every 60 seconds for as long as Home stayed mounted, plus on
  // every unrelated realtime ping (a challenges/ladder update elsewhere on
  // the platform) that happened to touch state Home reads. The league-card
  // lists are the only part that actually needs to notice time passing on
  // its own (a result's confirm window silently expiring), so that tick —
  // and the sort/attention-score work it drives — now lives in
  // LeagueListsSection instead, scoped to just that piece of the tree.
  const funLeagues = leagues.filter((l) => l.league_type !== "cash");
  const myId = session?.user?.id;

  // Same Weekend League spotlight PublicHome shows guests, surfaced here
  // too so a signed-in player who hasn't joined yet — or who's a member of
  // an entirely different set of leagues — still sees what's kicking off
  // this Friday–Sunday and can jump straight in with one tap instead of
  // only discovering it while logged out.
  const [weekendStart, weekendEnd] = weekendWindow();
  const weekendLeagues = funLeagues.filter((l) => l.created_by_admin).reduce((items, l) => {
    const startsAtDate = l.starts_at ? new Date(l.starts_at) : null;
    const kicksOffThisWeekend = startsAtDate && startsAtDate >= weekendStart && startsAtDate <= weekendEnd;
    // A groups_knockout league's real cutoff is its shared group_stage_due_at,
    // not each match's own (now-advisory) due_at — so if that shared deadline
    // falls this weekend, every unplayed group-stage fixture counts as due,
    // even ones whose individual due_at happens to fall on a different day.
    const groupStageDueDate = l.group_stage_due_at ? new Date(l.group_stage_due_at) : null;
    const groupStageDueThisWeekend = l.format === "groups_knockout" && groupStageDueDate && groupStageDueDate >= weekendStart && groupStageDueDate <= weekendEnd;
    // Defensive: every league fetched via LEAGUE_SELECT carries a joined
    // fixtures array, but a null/missing join on any one row (a brand-new
    // league mid-creation, a malformed row) would otherwise crash this
    // reduce for the whole page instead of just skipping that league.
    const leagueFixtures = l.fixtures || [];
    const dueFixtures = groupStageDueThisWeekend
      ? leagueFixtures.filter((f) => !f.played && f.stage === 1)
      : leagueFixtures.filter((f) => !f.played && f.due_at && new Date(f.due_at) >= weekendStart && new Date(f.due_at) <= weekendEnd);
    if (!kicksOffThisWeekend && dueFixtures.length === 0) return items;
    const earliest = kicksOffThisWeekend ? startsAtDate.getTime() : groupStageDueThisWeekend ? groupStageDueDate.getTime() : Math.min(...dueFixtures.map((f) => new Date(f.due_at).getTime()));
    items.push({ league: l, kicksOffThisWeekend, matchCount: dueFixtures.length, earliest });
    return items;
  }, []).sort((a, b) => a.earliest - b.earliest);
  // The Leagues list below already excludes these — a weekend league gets
  // one true home (the spotlight above), the same way PublicHome's
  // otherFunLeagues keeps guests from seeing it twice.
  const weekendLeagueIds = new Set(weekendLeagues.map((it) => it.league.id));

  // Accepted challenges (direct or random) sitting with no score logged yet,
  // on either the challenge or open-challenge track — surfaced right at the
  // top of Home so an opponent can log a result without first digging into
  // Challenges or the Ladder screen.
  const pendingResultItems = [
    ...(challenges || [])
      .filter((ch) => ch.status === "accepted" && !ch.result_status && (ch.challenger_id === myId || ch.opponent_id === myId))
      .map((ch) => ({
        id: `ch-${ch.id}`, kind: "challenge", isLadder: ch.is_ladder, challenge: ch,
        opponentUsername: ch.challenger_id === myId ? ch.opponent_username : ch.challenger_username,
      })),
    ...(openChallenges || [])
      .filter((ch) => ch.status === "accepted" && !ch.result_status && (ch.creator_id === myId || ch.accepted_by === myId))
      .map((ch) => ({
        id: `open-${ch.id}`, kind: "open", challenge: ch,
        opponentUsername: ch.creator_id === myId ? ch.accepted_by_username : ch.creator_username,
      })),
  ].sort((a, b) => new Date(b.challenge.created_at) - new Date(a.challenge.created_at));

  // Defensive: same reasoning as leagueFixtures above — don't let one league
  // row with a missing teams/fixtures join crash the whole homepage.
  const totalClubs = leagues.reduce((sum, l) => sum + (l.teams || []).length, 0);
  const totalMatches = leagues.reduce((sum, l) => sum + (l.fixtures || []).filter((f) => f.played).length, 0);

  const myUpcomingFixtures = computeMyUpcomingFixtures(leagues, myTeam, 5);
  const myProgress = computeMyProgress(leagues, myTeam);
  const myDisplayName = profileFirstName(session) || session?.user?.email || "";

  // Achievement badges — a second, more permanent collection layer next to
  // the level/XP bar. Recomputed from the same data Home already has, so it
  // can't drift out of sync with a player's real record. Every stat any
  // badge's value() function reads must be listed below — miss one and that
  // badge can silently fail to unlock the moment it's earned, only catching
  // up whenever some other listed stat happens to change too. Ladder rank
  // depends on rank_position only (a primitive), not the whole myLadderRank
  // object, since that object gets a new identity on every background
  // ladder poll even when the rank itself hasn't moved.
  const joinedLeagueCount = leagues.filter((l) => isMemberOf(l)).length;
  const myLeaguesWon = useMemo(() => computeMyLeagueWins(leagues, myId), [leagues, myId]);
  // Every league title, grouped by who won it and which league/when — feeds
  // the Wall of Fame's per-row titles list. Kept separate from
  // myLeaguesWon (which only needs a count, for the achievement) since this
  // one runs across every user, not just the signed-in one.
  const championshipsByUserId = useMemo(() => computeAllLeagueChampionships(leagues), [leagues]);
  const achievements = useMemo(
    () => computeAchievements({ p: myProgress, joinedCount: joinedLeagueCount, myLadderRank, leaguesWon: myLeaguesWon }),
    [myProgress.played, myProgress.w, myProgress.d, myProgress.bestStreak, myProgress.bestNoLossStreak, myProgress.cleanSheets, myProgress.biggestWinMargin, myProgress.level, joinedLeagueCount, myLadderRank?.rank_position, myLeaguesWon]
  );
  const earnedAchievementCount = achievements.filter((a) => a.earned).length;
  const [achievementsOpen, setAchievementsOpen] = useState(false);

  // Fires a one-time toast the moment a badge is newly earned, the same
  // localStorage-per-user pattern the level-up toast above uses — so a
  // badge already earned in a previous session never re-fires here, only
  // one crossed since the last time this ran on this device.
  useEffect(() => {
    if (!myId || achievements.length === 0) return;
    const key = `efootball-badges-seen-${myId}`;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { /* ignore — storage unavailable */ }
    const earnedIds = achievements.filter((a) => a.earned).map((a) => a.id);
    const newOnes = earnedIds.filter((id) => !seen.includes(id));
    if (newOnes.length > 0) {
      if (seen.length > 0 && showToast) {
        const first = achievements.find((a) => a.id === newOnes[0]);
        showToast(newOnes.length === 1 ? `Achievement unlocked: ${first.label} 🏆` : `${newOnes.length} new achievements unlocked 🏆`);
      }
      try { localStorage.setItem(key, JSON.stringify(earnedIds)); } catch (e) { /* ignore — storage unavailable */ }
    }
  }, [myId, achievements, showToast]);

  // Wall of Fame — every member's badge count/score, ranked. memberAvatars
  // only lists *other* members (see list_challengeable_members), so the
  // signed-in player's own name/photo is merged in here from session data
  // before aggregating, otherwise their own row would be silently dropped.
  const profileByUserId = useMemo(() => {
    const map = new Map();
    (memberAvatars || []).forEach((m) => { if (m.user_id) map.set(m.user_id, { username: m.username, avatar_url: m.avatar_url }); });
    if (myId) map.set(myId, { username: myDisplayName, avatar_url: myAvatarUrl });
    return map;
  }, [memberAvatars, myId, myDisplayName, myAvatarUrl]);
  const wallOfFame = useMemo(() => computeWallOfFame(allAchievements, profileByUserId, championshipsByUserId), [allAchievements, profileByUserId, championshipsByUserId]);
  const [wallOfFameOpen, setWallOfFameOpen] = useState(false);

  // Mirrors every earned badge to Supabase — this is what lets a badge
  // earned on one device show up on another, and what the Wall of Fame
  // reads from. Requires the `achievements` table from
  // supabase/achievements-migration.sql. Skips the round trip when the
  // earned set is identical to the last one actually synced (tracked in a
  // ref, not state, so comparing it doesn't itself trigger a re-render) —
  // without this, every background poll that touches myProgress/ladder
  // would re-upsert the same rows for no reason. Refreshes the Wall of
  // Fame's data on success so a badge earned just now shows up there
  // immediately, instead of waiting for the next full page load.
  const syncedBadgeIdsRef = useRef("");
  useEffect(() => {
    if (!myId) return;
    const earned = achievements.filter((a) => a.earned);
    if (earned.length === 0) return;
    const idsKey = earned.map((a) => a.id).sort().join(",");
    if (idsKey === syncedBadgeIdsRef.current) return;
    supabase.from("achievements")
      .upsert(earned.map((a) => ({ user_id: myId, achievement_id: a.id })), { onConflict: "user_id,achievement_id", ignoreDuplicates: true })
      .then(({ error }) => {
        if (error) { console.error("achievements upsert failed", error); return; }
        syncedBadgeIdsRef.current = idsKey;
        onAchievementsSynced?.();
      });
  }, [myId, achievements, onAchievementsSynced]);

  // Fires a one-time celebration the moment a player's level actually goes
  // up, instead of leaving it as a silent bar reset. The last-seen level is
  // stashed in localStorage per user so a level reached in a previous
  // session never re-fires here on a later visit — only a level crossed
  // since the last time this ran on this device.
  const [progressOpen, setProgressOpen] = useState(false);
  // The two Home widgets below (results waiting to be logged, upcoming
  // fixtures) each pop out into their own overlay instead of sitting inline
  // on the page — see the compact bars right above "Where you stand" for why
  // each opens differently. Quick actions now lives in the app-wide floating
  // dock instead (see App's root return), so it doesn't need state here.
  const [resultsToLogOpen, setResultsToLogOpen] = useState(false);
  const [upNextOpen, setUpNextOpen] = useState(false);
  useEffect(() => {
    if (!myId || myProgress.played === 0) return;
    const key = `efootball-level-seen-${myId}`;
    let lastSeen = 0;
    try { lastSeen = Number(localStorage.getItem(key)) || 0; } catch (e) { /* ignore — storage unavailable */ }
    if (myProgress.level > lastSeen) {
      if (lastSeen > 0 && showToast) showToast(`Level up! You're now Lvl ${myProgress.level} · ${myProgress.levelTitle} 🎉`);
      try { localStorage.setItem(key, String(myProgress.level)); } catch (e) { /* ignore — storage unavailable */ }
    }
  }, [myId, myProgress.level, myProgress.played, myProgress.levelTitle, showToast]);

  return (
    <div>
      {/* Player card — leads the page like a game's home dashboard: who's
          signed in, what season is live, the numbers that matter at a
          glance. Everything else below is "what do you want to do now". */}
      <section className="relative mt-1 rounded-2xl overflow-hidden" style={{ background: `linear-gradient(120deg, ${c.green}33, ${c.surface})`, border: `1px solid ${c.border}` }}>
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-glow-drift absolute -top-16 -right-10 w-40 h-40 rounded-full blur-3xl" style={{ background: c.accent, opacity: 0.25 }} />
        </div>
        <div className="relative flex items-center gap-3 px-4 py-3.5">
          <div className="relative shrink-0">
            <MemberAvatar url={myAvatarUrl} username={myDisplayName} size={44} c={c} />
            <img src="/hero-emblem.png" alt="" className="absolute -bottom-1 -right-1 w-5 h-5 object-contain drop-shadow" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] uppercase" style={{ color: c.accent }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-pulse-dot absolute inline-flex h-full w-full rounded-full" style={{ background: c.accent }} />
              </span>
              Season 2026 · Live
            </div>
            <div className="font-extrabold uppercase tracking-tight text-lg leading-tight truncate">Welcome back{myDisplayName ? `, ${myDisplayName}` : ""}</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="text-right font-mono leading-tight">
              <div className="font-bold text-sm" style={{ color: c.text }}>{leagues.length}</div>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>leagues</div>
            </div>
            <div className="w-px h-7" style={{ background: c.border }} />
            <div className="text-right font-mono leading-tight">
              <div className="font-bold text-sm" style={{ color: c.text }}>{totalClubs}</div>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>clubs</div>
            </div>
            <div className="w-px h-7" style={{ background: c.border }} />
            <div className="text-right font-mono leading-tight">
              <div className="font-bold text-sm" style={{ color: c.text }}>{totalMatches}</div>
              <div className="text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>played</div>
            </div>
          </div>
        </div>

        {/* Level + XP bar, with a streak chip when the player is on a run —
            the "there's a game underneath the leagues" layer of the page.
            Tapping it opens the full breakdown (level, XP-to-go, record).
            Before a player's first match, a quiet teaser line stands in for
            it instead of the row just not existing. */}
        {myProgress.played > 0 ? (
          <div role="button" tabIndex={0} onClick={() => setProgressOpen(true)} onKeyDown={(e) => { if (e.key === "Enter") setProgressOpen(true); }}
            className="relative px-4 pb-3.5 -mt-1 flex items-center gap-2 cursor-pointer">
            <div className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider shrink-0 rounded-full px-2 py-0.5"
              style={{ background: `${tierColorFor(myProgress.level)}1F`, color: tierColorFor(myProgress.level), border: `1px solid ${tierColorFor(myProgress.level)}55` }}>
              <Star size={10} /> Lvl {myProgress.level} · {myProgress.levelTitle}
            </div>
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: c.surfaceHover }}
              role="progressbar" aria-valuenow={myProgress.xpIntoLevel} aria-valuemin={0} aria-valuemax={myProgress.xpForNextLevel}
              aria-label={`Level ${myProgress.level} XP progress: ${myProgress.xpIntoLevel} of ${myProgress.xpForNextLevel}`}>
              <div className="h-full rounded-full transition-all" style={{ width: `${(myProgress.xpIntoLevel / myProgress.xpForNextLevel) * 100}%`, background: tierColorFor(myProgress.level) }} />
            </div>
            <div className="font-mono text-[9px] shrink-0" style={{ color: c.textFaint }}>{myProgress.xpIntoLevel}/{myProgress.xpForNextLevel} XP</div>
            {myProgress.streak >= 2 && (
              <div className="flex items-center gap-1 font-mono text-[10px] font-bold shrink-0 rounded-full px-2 py-0.5" title={`${myProgress.streak}-match win streak`}
                style={{ background: `${c.red}1F`, color: c.red, border: `1px solid ${c.red}55` }}>
                <Flame size={10} /> {myProgress.streak}
              </div>
            )}
          </div>
        ) : (
          <div className="relative px-4 pb-3.5 -mt-1 flex items-center gap-1.5 font-mono text-[10px]" style={{ color: c.textFaint }}>
            <Star size={10} /> Play your first match to start earning XP and levelling up
          </div>
        )}
      </section>

      {progressOpen && <ProgressBreakdownModal progress={myProgress} onClose={() => setProgressOpen(false)} c={c} />}

      {/* Continue playing — each of these pops out on tap instead of sitting
          inline, so the page reads top-to-bottom as: who you are, what needs
          you next, right in front of you at a glance, without two scrolling
          strips eating the fold. Results to log is urgent and needs a
          decision, so it opens as a full modal that grabs attention and
          blocks behind it. Up next is just for browsing what's ahead, so it
          opens as a lighter sheet you can flick through and dismiss. Quick
          actions used to live down here too, but now lives in a floating
          dock rendered once at the app level (see App's root return) so
          it's reachable from every screen, not just Home. */}
      <PendingResultsBar items={pendingResultItems} onOpen={() => setResultsToLogOpen(true)} c={c} />
      <UpNextBar fixtures={myUpcomingFixtures} onOpen={() => setUpNextOpen(true)} c={c} />

      {resultsToLogOpen && (
        <PendingResultsModal items={pendingResultItems} onOpenLogResult={onOpenLogResult} onOpenLogResultOpen={onOpenLogResultOpen}
          onClose={() => setResultsToLogOpen(false)} c={c} />
      )}
      {upNextOpen && (
        <UpNextModal fixtures={myUpcomingFixtures} onOpen={(leagueId, fixtureId) => { setUpNextOpen(false); onOpen(leagueId, fixtureId); }}
          onClose={() => setUpNextOpen(false)} c={c} />
      )}

      {/* Where you stand — Leaderboard preview then the Ladder banner, moved
          up to right after quick actions. This is the core eFootball-style
          competitive loop (rank, points, who's above you), so it now beats
          the collectibles below it to the top of the fold instead of trailing
          them — "how am I doing" before "what have I collected". */}
      <div className="mt-8">
        {/* Same quick-action tiles as the floating dock, placed right above
            the leaderboard preview per request — a horizontally-scrollable
            row rather than the dock's 3-col grid, since it sits inline on
            the page instead of floating over it. */}
        {quickActions && quickActions.length > 0 && (
          <div className="flex gap-2 mb-3 overflow-x-auto pb-1 -mx-1 px-1">
            {quickActions.map((it) => (
              <div key={it.label} className="w-20 shrink-0">
                <MenuTile icon={it.icon} label={it.label} badge={it.badge} external={it.external} onClick={it.onClick} c={c} />
              </div>
            ))}
          </div>
        )}
        <LeaderboardStrip leagues={leagues} session={session} memberAvatars={memberAvatars} myAvatarUrl={myAvatarUrl} onOpenLeaderboard={onOpenLeaderboard} c={c} />
      </div>
      <LadderStrip ladder={ladder} myLadderRank={myLadderRank} onOpenLadder={onOpenLadder} c={c} />

      {/* Achievements — the badge collection layer, right after "where you
          stand" so a player sees their rank first, then what they've earned
          chasing it. */}
      <AchievementsStrip achievements={achievements} earnedCount={earnedAchievementCount} onOpen={() => setAchievementsOpen(true)} c={c} />
      {achievementsOpen && <AchievementsModal achievements={achievements} earnedCount={earnedAchievementCount} onClose={() => setAchievementsOpen(false)} c={c} />}

      {/* Wall of Fame — the shared, cross-player view of the same badges,
          right under the personal Achievements strip so "what I've earned"
          and "how I stack up against everyone else" sit side by side. */}
      <WallOfFameStrip standings={wallOfFame} onOpen={() => setWallOfFameOpen(true)} c={c} />
      {wallOfFameOpen && <WallOfFameModal standings={wallOfFame} myUserId={myId} onClose={() => setWallOfFameOpen(false)} c={c} />}

      {leagues.length === 0 && (
        <section className="mt-6 rounded-2xl overflow-hidden" style={{ background: `linear-gradient(120deg, ${c.accent}22, ${c.surface})`, border: `1px solid ${c.border}` }}>
          <div className="flex flex-col items-center text-center gap-3 px-6 py-10">
            <span className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover }}>
              <Gamepad2 size={22} style={{ color: c.accent }} />
            </span>
            <div className="font-extrabold uppercase tracking-tight text-base" style={{ color: c.text }}>No leagues yet</div>
            <div className="font-body text-sm max-w-[220px]" style={{ color: c.textDim }}>Start the first one — it takes about a minute.</div>
            <button onClick={onCreate} className="mt-1 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wide rounded-lg px-4 py-2 transition-transform active:scale-95"
              style={{ background: c.accent, color: c.accentText }}>
              <Plus size={13} /> Create a league
            </button>
          </div>
        </section>
      )}

      <LeagueListsSection leagues={leagues} isAdmin={isAdmin} isMemberOf={isMemberOf} entryClosed={entryClosed} qualifiesForLeague={qualifiesForLeague}
        myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
        session={session} onToggleLeagueReaction={onToggleLeagueReaction} onCreate={onCreate} hideLeagueIds={weekendLeagueIds} c={c} />

      {/* Live event banner — sits below LeagueListsSection now, specifically
          below the Survival Ladder Cup marquee (the last thing that section
          renders), per request. */}
      {weekendLeagues.length > 0 && (
        <WeekendLeagueSpotlight items={weekendLeagues} weekendStart={weekendStart} weekendEnd={weekendEnd}
          isJoined={(l) => isMemberOf(l)} override={weekendOverride} isAdmin={isAdmin} onSetOverride={onSetWeekendOverride}
          onCardClick={(l) => (isMemberOf(l) ? onOpen(l.id) : onJoin(l.id))} c={c} />
      )}

    </div>
  );
}

// Compact "Up next" bar — sits inline on Home showing only the soonest
// fixture (plus a count of how many more are queued behind it), and pops
// the full list open in UpNextModal on tap. Renders nothing for a visitor
// with no upcoming fixtures (new signups, or someone only spectating), so
// it never leaves an empty band above the Shop banner.
function UpNextBar({ fixtures, onOpen, c }) {
  if (!fixtures || fixtures.length === 0) return null;
  const next = fixtures[0];
  const rest = fixtures.length - 1;
  return (
    <button onClick={onOpen} className="mt-4 w-full flex items-center gap-3 text-left rounded-xl px-3.5 py-3 font-body transition-transform active:scale-[0.98]"
      style={{ background: c.surface, border: `1px solid ${c.border}` }}>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] shrink-0" style={{ color: c.textFaint }}>Up next</span>
      <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
        <span className="font-semibold text-sm truncate" style={{ color: c.text }}>vs {next.opponent.name}</span>
        <span className="font-mono text-[10px] shrink-0" style={{ color: c.textDim }}>
          {next.isHome ? "Home" : "Away"}{next.due_at ? ` · Due ${fmtDate(next.due_at)}` : ""}
        </span>
      </span>
      {rest > 0 && (
        <span className="shrink-0 font-mono text-[10px] font-bold rounded-full px-1.5 py-0.5" style={{ background: c.surfaceHover, color: c.textFaint }}>+{rest}</span>
      )}
      <ChevronRight size={14} style={{ color: c.textFaint }} className="shrink-0" />
    </button>
  );
}

// The full "Up next" list, popped out into a light dismissible sheet from
// UpNextBar — this one's just for browsing what's ahead (not urgent, no
// decision needed), so unlike the results modal below it doesn't need to
// grab full attention; a flick-through-and-dismiss overlay fits better.
function UpNextModal({ fixtures, onOpen, onClose, c }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div className="w-full sm:max-w-sm sm:max-h-[80vh] max-h-[75vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-5 border" style={{ background: c.bg, borderColor: c.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="font-mono text-xs font-bold uppercase tracking-wider" style={{ color: c.accent }}>Up next</div>
          <button aria-label="Close" onClick={onClose} style={{ color: c.textFaint }}><X size={18} /></button>
        </div>
        <div className="flex flex-col gap-2">
          {fixtures.map((f) => (
            <div key={f.fixtureId} role="button" tabIndex={0} onClick={() => onOpen(f.leagueId, f.fixtureId)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpen(f.leagueId, f.fixtureId); }}
              className="text-left rounded-xl p-3 font-body cursor-pointer transition-transform active:scale-[0.98]"
              style={{ background: c.surface, border: `1px solid ${c.border}` }}>
              <div className="font-mono text-[9px] uppercase tracking-wider truncate" style={{ color: c.accent }}>{f.leagueName}</div>
              <div className="font-semibold text-sm mt-1 truncate" style={{ color: c.text }}>{f.opponent.name}</div>
              <div className="flex items-center justify-between gap-1.5 mt-1.5">
                <div className="font-mono text-[10px] min-w-0 truncate" style={{ color: c.textDim }}>
                  {f.isHome ? "Home" : "Away"}
                  {f.due_at ? ` · Due ${fmtDate(f.due_at)}` : ""}
                </div>
                {f.opponent.phone && (
                  <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                    <WhatsAppCallLink phone={f.opponent.phone} iconOnly
                      text={`Hi, it's ${f.team.name} 🔥 Call me when you're ready to play so we can lock in the time${f.due_at ? ` (due ${fmtDate(f.due_at)})` : ""} ⚽🕹️${firstMatchdayNote(f.round)}`} c={c} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Compact "Results to log" bar — sits inline on Home, right above "Up
// next", showing just the count of matches waiting on the signed-in player
// to log. Pops the full list open in PendingResultsModal on tap. Renders
// nothing when nothing's waiting.
function PendingResultsBar({ items, onOpen, c }) {
  if (!items || items.length === 0) return null;
  return (
    <button onClick={onOpen} className="mt-4 w-full flex items-center gap-3 text-left rounded-xl px-3.5 py-3 font-body transition-transform active:scale-[0.98]"
      style={{ background: c.surface, border: `1px solid ${c.red}55` }}>
      <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] shrink-0" style={{ color: c.red }}>
        <Trophy size={11} /> {items.length > 1 ? "Results to log" : "Result to log"}
      </span>
      <span className="flex-1 min-w-0 font-semibold text-sm truncate" style={{ color: c.text }}>
        {items.length === 1 ? `vs ${items[0].opponentUsername}` : `${items.length} matches waiting`}
      </span>
      <ChevronRight size={14} style={{ color: c.red }} className="shrink-0" />
    </button>
  );
}

// The full "Results to log" list, popped out into a full attention-grabbing
// modal from PendingResultsBar — unlike Up next, this one always needs an
// actual decision (a score to enter), so it opens as a modal that sits in
// front of everything else rather than a light dismissible sheet.
function PendingResultsModal({ items, onOpenLogResult, onOpenLogResultOpen, onClose, c }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl p-6 border" style={{ background: c.bg, borderColor: c.borderStrong }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wider" style={{ color: c.red }}>
            <Trophy size={13} /> {items.length > 1 ? "Results to log" : "Result to log"}
          </div>
          <button aria-label="Close" onClick={onClose} style={{ color: c.textFaint }}><X size={18} /></button>
        </div>
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <button key={item.id} onClick={() => { onClose(); (item.kind === "open" ? onOpenLogResultOpen(item.challenge) : onOpenLogResult(item.challenge)); }}
              className="text-left rounded-xl p-3 font-body transition-transform active:scale-[0.98]"
              style={{ background: c.surface, border: `1px solid ${c.red}55` }}>
              <div className="font-mono text-[9px] uppercase tracking-wider truncate" style={{ color: c.red }}>
                {item.kind === "open" ? "Random challenge" : item.isLadder ? "Ladder" : "Challenge"}
              </div>
              <div className="font-semibold text-sm mt-1 truncate" style={{ color: c.text }}>vs {item.opponentUsername}</div>
              <div className="mt-2 flex items-center justify-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide rounded-lg py-1.5" style={{ background: c.accent, color: c.accentText }}>
                <Trophy size={11} /> Log result
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Small helper — first name off the signed-in user's email, purely cosmetic
// (falls back to nothing, which the caller already handles).
function profileFirstName(session) {
  const raw = session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name;
  return raw ? raw.split(" ")[0] : "";
}

// One equal-weight tile in the quick-action menu grid — icon on top, label
// below, small badge count in the corner when relevant. Every action here
// carries the same visual weight; none is "the" highlighted button. The
// Shop tile carries an "external" badge instead of a count, since it leaves
// the app rather than opening a screen inside it.
export function MenuTile({ icon: Icon, label, badge, external, onClick, c }) {
  return (
    <button onClick={onClick} className="relative flex flex-col items-center justify-center gap-1.5 rounded-xl py-3 px-1 font-body transition-transform active:scale-[0.97]"
      style={{ background: c.surface, border: `1px solid ${c.border}` }}>
      {badge > 0 && (
        <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center font-mono text-[9px] font-bold" style={{ background: c.red, color: "#fff" }}>{badge}</span>
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

// Quick actions — a floating dock rendered once at the app root (see App's
// root return) rather than a bar or modal, and rendered on every screen
// instead of just Home. These are launch points someone might reach for
// from anywhere in the app — everything that used to live only in the
// header's hamburger menu or Home's action grid now lives in one place —
// so it makes sense for the dock to stay put as a floating button while
// scrolling/navigating instead of a one-shot overlay tied to a single
// screen. Tapping the FAB pops the same equal-weight tile grid open above
// it; tapping it again, an outside tap, or picking a tile all close it.
// `items` is a flat list of { icon, label, onClick, badge?, external? } —
// callers assemble the full set (including which admin-only tiles to
// include) once at the top of the app.
function QuickActionsDock({ open, onToggle, items, c }) {
  const runAndClose = (fn) => () => { onToggle(); fn(); };
  const totalBadge = items.reduce((sum, it) => sum + (it.badge > 0 ? it.badge : 0), 0);
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40" onClick={onToggle} />
      )}
      <div className="fixed bottom-5 right-4 z-50 flex flex-col items-end gap-2.5">
        {open && (
          <div className="rounded-2xl p-3 shadow-xl" style={{ background: c.bg, border: `1px solid ${c.borderStrong}` }}>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] mb-2 text-right" style={{ color: c.textFaint }}>Quick actions</div>
            <div className="grid grid-cols-3 gap-2 w-[210px]">
              {items.map((it) => (
                <MenuTile key={it.label} icon={it.icon} label={it.label} badge={it.badge} external={it.external} onClick={runAndClose(it.onClick)} c={c} />
              ))}
            </div>
          </div>
        )}
        <button onClick={onToggle} aria-label={open ? "Close quick actions" : "Open quick actions"}
          className="relative w-13 h-13 rounded-full flex items-center justify-center shadow-xl transition-transform active:scale-95"
          style={{ width: 52, height: 52, background: c.accent, color: c.accentText }}>
          {open ? <X size={20} /> : <Zap size={20} />}
          {!open && totalBadge > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center font-mono text-[9px] font-bold" style={{ background: c.red, color: "#fff", border: `2px solid ${c.bg}` }}>{totalBadge}</span>
          )}
        </button>
      </div>
    </>
  );
}

// The permanent ladder, sitting in front of everything else on Home — a
// horizontally-scrolling strip, not a boxed-off card, so it reads as part of
// the page rather than a widget bolted onto it. Shows the top 5 by
// rank_position (which never resets) plus, if the viewer has a spot on it
// themselves, a quiet "you're #N" line that opens the challenge picker.
function LadderStrip({ ladder, myLadderRank, onOpenLadder }) {
  const c = LADDER_THEME; // this strip always renders in the Ladder's own black/gold look
  const [rulesOpen, setRulesOpen] = useState(false);
  if (!ladder || ladder.length === 0) return null;
  const top5 = ladder.slice(0, 5);
  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  const myRankColor = myLadderRank && myLadderRank.rank_position <= 3 ? rankColors[myLadderRank.rank_position - 1] : c.accent;
  return (
    <section className="pt-5">
      <div role="button" tabIndex={0} onClick={onOpenLadder} onKeyDown={(e) => { if (e.key === "Enter") onOpenLadder(); }}
        className="relative w-full rounded-2xl p-3.5 text-left cursor-pointer overflow-hidden transition-transform active:scale-[0.99]" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-glow-drift absolute -top-14 -left-10 w-36 h-36 rounded-full blur-3xl" style={{ background: "#FFD700", opacity: 0.16 }} />
        </div>
        <div className="relative flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <img src="/ladder-battles-badge.jpg" alt="" className="w-8 h-8 rounded-full object-cover shrink-0" style={{ boxShadow: `0 0 0 1px ${c.borderStrong}` }} />
            <div className="leading-tight">
              <div className="font-mono text-[11px] tracking-[0.2em] uppercase font-bold" style={{ color: c.accent }}>Ladder Battles</div>
              <div className="font-mono text-[9px] tracking-[0.3em] uppercase" style={{ color: c.red }}>No Mercy</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            <RulesButton label="Ladder Rules" onClick={() => setRulesOpen(true)} c={c} />
            {myLadderRank && (
              <button onClick={onOpenLadder} className="font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 shrink-0 rounded-full pl-2.5 pr-2 py-1"
                style={{ background: `${myRankColor}1F`, color: myRankColor, border: `1px solid ${myRankColor}55` }}>
                {myLadderRank.rank_position <= 3 && <Crown size={10} />} You're #{myLadderRank.rank_position} <ChevronRight size={12} />
              </button>
            )}
          </div>
        </div>
        {rulesOpen && <div onClick={(e) => e.stopPropagation()}><Suspense fallback={null}><RulesModal type="ladder" onClose={() => setRulesOpen(false)} c={c} /></Suspense></div>}
        <div className="relative no-scrollbar flex items-stretch gap-2.5 overflow-x-auto pb-1" onClick={(e) => e.stopPropagation()}>
          {top5.map((row, i) => (
            <div key={row.user_id} className="relative flex items-center gap-2 shrink-0 rounded-xl pl-2 pr-3.5 py-2 overflow-hidden"
              style={{
                background: i === 0 ? `linear-gradient(135deg, ${c.accent}26, ${c.surface})` : c.surface,
                border: `1px solid ${i === 0 ? c.accent + "55" : c.border}`,
              }}>
              {i === 0 && (
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div className="animate-shine-sweep absolute top-0 -left-1/2 w-1/3 h-full" style={{ background: `linear-gradient(90deg, transparent, ${c.accent}3D, transparent)` }} />
                </div>
              )}
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
                <span className="font-body font-semibold text-sm truncate max-w-[110px]" style={{ color: c.text }}>{row.username}</span>
                <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{row.points}pts · {row.wins}W–{row.losses}L</span>
              </div>
            </div>
          ))}
          <button onClick={onOpenLadder} className="flex items-center gap-1.5 shrink-0 font-mono text-[11px] rounded-xl px-3"
            style={{ color: c.accent, background: c.surfaceHover, border: `1px dashed ${c.borderStrong}` }}>
            <Swords size={13} /> {myLadderRank && myLadderRank.rank_position > 5 ? "Climb it" : "See full ladder"}
          </button>
        </div>
      </div>
    </section>
  );
}

// Compact homepage preview of the platform-wide Leaderboard (the full
// screen lives behind the header menu) — top 5 by wins for the current
// season, styled like a podium rather than a plain list, with the same
// press-and-glow language as the rest of the dashboard. Renders nothing
// until at least one match has been played anywhere, same as the ladder.
function LeaderboardStrip({ leagues, session, memberAvatars, myAvatarUrl, onOpenLeaderboard, c }) {
  const avatarByUserId = useMemo(() => {
    const map = new Map();
    (memberAvatars || []).forEach((m) => { if (m.user_id) map.set(m.user_id, m.avatar_url || null); });
    if (session && myAvatarUrl) map.set(session.user.id, myAvatarUrl);
    return map;
  }, [memberAvatars, session, myAvatarUrl]);
  const anchor = useMemo(() => seasonAnchor(leagues), [leagues]);
  const cur = currentSeason(anchor);
  const bounds = anchor ? seasonBounds(cur, anchor) : null;
  const scopedRows = useMemo(() => computeGlobalLeaderboard(leagues, bounds), [leagues, bounds]);
  const ranked = useMemo(() => rankLeaderboard(scopedRows, "wins"), [scopedRows]);
  if (ranked.length === 0) return null;
  const top5 = ranked.slice(0, 5);
  const myRow = session ? ranked.find((r) => r.userId === session.user.id) : null;
  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  const myRankColor = myRow && myRow.rank <= 3 ? rankColors[myRow.rank - 1] : c.accent;
  return (
    <section className="pt-1">
      <div role="button" tabIndex={0} onClick={onOpenLeaderboard} onKeyDown={(e) => { if (e.key === "Enter") onOpenLeaderboard(); }}
        className="relative w-full rounded-2xl p-3.5 text-left cursor-pointer overflow-hidden transition-transform active:scale-[0.99]"
        style={{ background: c.surface, border: `1px solid ${c.border}` }}>
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-glow-drift absolute -top-14 -right-10 w-36 h-36 rounded-full blur-3xl" style={{ background: c.accent, opacity: 0.18 }} />
        </div>
        <div className="relative flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, border: `1px solid ${c.border}` }}>
              <Trophy size={15} style={{ color: c.accent }} />
            </span>
            <div className="leading-tight">
              <div className="font-extrabold uppercase tracking-tight text-sm leading-none">Leaderboard</div>
              <div className="font-mono text-[9px] uppercase tracking-wider mt-0.5" style={{ color: c.textFaint }}>This season · every league</div>
            </div>
          </div>
          {myRow && (
            <span className="font-mono text-[11px] font-bold uppercase tracking-wider flex items-center gap-1 shrink-0 rounded-full pl-2.5 pr-2 py-1"
              style={{ background: `${myRankColor}1F`, color: myRankColor, border: `1px solid ${myRankColor}55` }}>
              {myRow.rank <= 3 && <Crown size={10} />} You're #{myRow.rank}
            </span>
          )}
        </div>
        <div className="no-scrollbar flex items-stretch gap-2.5 overflow-x-auto pb-1">
          {top5.map((r, i) => (
            <div key={r.userId} className="relative flex items-center gap-2 shrink-0 rounded-xl pl-2 pr-3.5 py-2 overflow-hidden"
              style={{
                background: i === 0 ? `linear-gradient(135deg, ${c.accent}26, ${c.bg})` : c.bg,
                border: `1px solid ${i === 0 ? c.accent + "55" : c.border}`,
              }}>
              {i === 0 && (
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div className="animate-shine-sweep absolute top-0 -left-1/2 w-1/3 h-full" style={{ background: `linear-gradient(90deg, transparent, ${c.accent}3D, transparent)` }} />
                </div>
              )}
              {i < 3 ? (
                <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${rankColors[i]}22`, border: `1px solid ${rankColors[i]}66` }}>
                  {i === 0 ? <Crown size={13} style={{ color: rankColors[0] }} /> : <Medal size={13} style={{ color: rankColors[i] }} />}
                </span>
              ) : (
                <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 font-mono text-xs font-bold" style={{ background: c.surfaceHover, color: c.textFaint }}>
                  {i + 1}
                </span>
              )}
              <MemberAvatar url={r.userId ? avatarByUserId.get(r.userId) : null} username={r.name} size={26} c={c} />
              <div className="flex flex-col leading-tight">
                <span className="font-body font-semibold text-sm truncate max-w-[90px]" style={{ color: c.text }}>{r.name}</span>
                <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{r.w}W {r.d}D {r.l}L</span>
              </div>
            </div>
          ))}
          <button onClick={onOpenLeaderboard} className="flex items-center gap-1.5 shrink-0 font-mono text-[11px] rounded-xl px-3"
            style={{ color: c.accent, background: c.surfaceHover, border: `1px dashed ${c.borderStrong}` }}>
            <Trophy size={13} /> {myRow && myRow.rank > 5 ? "See your rank" : "Full leaderboard"}
          </button>
        </div>
      </div>
    </section>
  );
}

// The picker for who a member is allowed to send a ladder challenge to —
// anyone ranked above them within 10 points, closest first. A search box lets
// them type a name to jump straight to it instead of scrolling the list.
function LadderChallengeSheet({ myRank, targets, onChallenge, onCancel, c }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? targets.filter((t) => (t.username || "").toLowerCase().includes(q)) : targets;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onCancel}>
      <div className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5" style={{ background: c.bg, color: c.text }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div className="font-extrabold uppercase tracking-tight text-lg flex items-center gap-2"><Swords size={18} /> Climb the ladder</div>
          <button aria-label="Close" onClick={onCancel} className="w-7 h-7 flex items-center justify-center rounded-full" style={{ background: c.surface }}><X size={14} /></button>
        </div>
        <p className="font-body text-xs mb-4" style={{ color: c.textDim }}>
          {myRank ? `You're #${myRank.rank_position}. Beat one of these and their spot is yours.` : "You'll get a ladder spot once your profile is set up."}
        </p>
        {targets.length > 0 && (
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by eFootball username"
              className="w-full border rounded-lg pl-9 pr-3 py-2 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
          </div>
        )}
        {targets.length === 0 ? (
          <div className="font-body text-sm text-center py-6" style={{ color: c.textFaint }}>
            {myRank && myRank.rank_position === 1 ? "You're #1 — nobody left to challenge." : "No one within 10 points of you yet."}
          </div>
        ) : filtered.length === 0 ? (
          <div className="font-body text-sm text-center py-6" style={{ color: c.textFaint }}>No one eligible matches "{query}".</div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {filtered.map((t) => (
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

// ---------------------------------------------------------------------------
// Shareable leaderboard/ladder image export.
//
// Lets anyone download a themed PNG snapshot of a 10-club/10-player slice of
// the Ladder or a league's standings table — same columns, same colours as
// the on-screen table, just baked into an image they can post or send on
// WhatsApp. Rendered with plain Canvas2D (no extra dependencies): we draw a
// header, the column headings, up to 10 rows, and a small WeAfrica footer,
// all pulled from the same theme object (`c`) the rest of the app uses so a
// dark-mode screenshot looks dark and a light-mode one looks light.
const SHARE_PAGE_SIZE = 10;
const SHARE_BRAND = "weafrica.co.za";

// Shrinks `text` with a trailing ellipsis until it fits inside `maxWidth`
// for whatever font is currently set on `ctx` — canvas has no built-in
// text-overflow, so this is the manual equivalent.
function fitCanvasText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Column shape: { key, label, width (px), align: 'left'|'center',
// isRank (gets a medal for top 3), isName (bold, left-aligned, primary
// text colour), bold (points-style emphasis), get(row) => display string }.
// Column widths across a config should sum to 968 (the table width below).
const SHARE_STANDINGS_COLUMNS = [
  { key: "rank", label: "#", width: 64, align: "center", isRank: true },
  { key: "name", label: "Club", width: 456, align: "left", isName: true, get: (r) => r.name + (r.eliminated ? " · OUT" : r.atRisk ? " · AT RISK" : "") },
  { key: "p", label: "P", width: 64, align: "center", get: (r) => String(r.p) },
  { key: "w", label: "W", width: 64, align: "center", get: (r) => String(r.w) },
  { key: "d", label: "D", width: 64, align: "center", get: (r) => String(r.d) },
  { key: "l", label: "L", width: 64, align: "center", get: (r) => String(r.l) },
  { key: "gd", label: "GD", width: 96, align: "center", get: (r) => (r.gd > 0 ? `+${r.gd}` : String(r.gd)) },
  { key: "pts", label: "Pts", width: 96, align: "center", bold: true, get: (r) => String(r.pts) },
];
function drawShareCard(canvas, { c, kicker, title, subtitle, rangeLabel, totalCount, columns, rows }) {
  const W = 1080, PAD = 56, TABLE_W = W - PAD * 2;
  const TOPBAR_H = 8, HEADER_H = 214, COLHEAD_H = 58, ROW_H = 92, FOOTER_H = 104;
  const H = TOPBAR_H + HEADER_H + COLHEAD_H + Math.max(rows.length, 1) * ROW_H + FOOTER_H;

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.textBaseline = "alphabetic";

  // Background + top accent strip.
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);
  const barGrad = ctx.createLinearGradient(0, 0, W, 0);
  barGrad.addColorStop(0, c.accent);
  barGrad.addColorStop(1, c.green);
  ctx.fillStyle = barGrad;
  ctx.fillRect(0, 0, W, TOPBAR_H);

  let y = TOPBAR_H;

  ctx.fillStyle = c.textFaint;
  ctx.font = "700 24px monospace";
  ctx.textAlign = "left";
  ctx.fillText(kicker.toUpperCase(), PAD, y + 56);

  ctx.fillStyle = c.text;
  ctx.font = "800 56px Arial, sans-serif";
  ctx.fillText(fitCanvasText(ctx, title.toUpperCase(), TABLE_W), PAD, y + 118);

  ctx.fillStyle = c.textDim;
  ctx.font = "500 26px monospace";
  ctx.fillText(fitCanvasText(ctx, subtitle, TABLE_W), PAD, y + 158);

  const pillLabel = `${rangeLabel} of ${totalCount}`;
  ctx.font = "700 22px monospace";
  const pillW = ctx.measureText(pillLabel).width + 40;
  const pillH = 44, pillY = y + 178;
  roundRectPath(ctx, PAD, pillY, pillW, pillH, pillH / 2);
  ctx.fillStyle = c.surfaceHover;
  ctx.fill();
  ctx.fillStyle = c.accent;
  ctx.fillText(pillLabel, PAD + 20, pillY + 29);

  y += HEADER_H;

  // Column header row.
  ctx.fillStyle = c.surface;
  ctx.fillRect(PAD, y, TABLE_W, COLHEAD_H);
  let cx = PAD;
  ctx.font = "700 20px monospace";
  ctx.fillStyle = c.textFaint;
  columns.forEach((col) => {
    ctx.textAlign = col.align === "center" ? "center" : "left";
    ctx.fillText(col.label.toUpperCase(), col.align === "center" ? cx + col.width / 2 : cx + 18, y + 37);
    cx += col.width;
  });
  y += COLHEAD_H;

  // Data rows.
  const medalColors = ["#FFD700", "#C0C0C0", "#CD7F32"];
  rows.forEach((row, i) => {
    if (i % 2 === 0) {
      ctx.fillStyle = c.surface;
      ctx.fillRect(PAD, y, TABLE_W, ROW_H);
    }
    let colX = PAD;
    columns.forEach((col) => {
      if (col.isRank) {
        const medal = row.rank <= 3 ? medalColors[row.rank - 1] : null;
        if (medal) {
          ctx.beginPath();
          ctx.arc(colX + col.width / 2, y + ROW_H / 2, 22, 0, Math.PI * 2);
          ctx.fillStyle = medal + "33";
          ctx.fill();
          ctx.strokeStyle = medal;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = medal;
        } else {
          ctx.fillStyle = c.textFaint;
        }
        ctx.font = "800 24px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(String(row.rank), colX + col.width / 2, y + ROW_H / 2 + 8);
      } else {
        const val = col.get ? col.get(row) : String(row[col.key] ?? "");
        ctx.font = col.isName ? "700 30px Arial, sans-serif" : col.bold ? "800 28px Arial, sans-serif" : "600 26px Arial, sans-serif";
        ctx.fillStyle = col.isName ? c.text : col.bold ? c.accent : c.textDim;
        ctx.textAlign = col.align === "center" ? "center" : "left";
        const maxW = col.width - (col.align === "center" ? 16 : 32);
        const tx = col.align === "center" ? colX + col.width / 2 : colX + 18;
        ctx.fillText(fitCanvasText(ctx, val, maxW), tx, y + ROW_H / 2 + 10);
      }
      colX += col.width;
    });
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y + ROW_H);
    ctx.lineTo(PAD + TABLE_W, y + ROW_H);
    ctx.stroke();
    y += ROW_H;
  });

  // Footer.
  ctx.fillStyle = c.surface;
  ctx.fillRect(0, y, W, FOOTER_H);
  ctx.fillStyle = c.accent;
  ctx.font = "800 26px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`Visit ${SHARE_BRAND}`, W / 2, y + FOOTER_H / 2 + 9);
}

// The range-picker + live preview shown when someone taps "Download image"
// on the Ladder or a league's Standings table. `rows` should already be the
// FULL ranked list (not a filtered/search subset) with a numeric `.rank`
// field on every row — position ranges are sliced 10 at a time off of it.
export function ShareRangeModal({ onClose, kicker, title, subtitle, rows, columns, c, defaultRank }) {
  const totalCount = rows.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / SHARE_PAGE_SIZE));
  const defaultPage = defaultRank ? Math.min(pageCount - 1, Math.max(0, Math.ceil(defaultRank / SHARE_PAGE_SIZE) - 1)) : 0;
  const [page, setPage] = useState(defaultPage);
  const canvasRef = useRef(null);

  const pageRows = rows.slice(page * SHARE_PAGE_SIZE, page * SHARE_PAGE_SIZE + SHARE_PAGE_SIZE);
  const rangeStart = page * SHARE_PAGE_SIZE + 1;
  const rangeEnd = page * SHARE_PAGE_SIZE + pageRows.length;
  const rangeLabel = `#${rangeStart}–${rangeEnd}`;

  useEffect(() => {
    if (!canvasRef.current || pageRows.length === 0) return;
    drawShareCard(canvasRef.current, { c, kicker, title, subtitle, rangeLabel, totalCount, columns, rows: pageRows });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, rows, title, subtitle]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "leaderboard";
      a.href = url;
      a.download = `${safeName}-${rangeStart}-${rangeEnd}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.7)" }} onClick={onClose}>
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <Download size={16} style={{ color: c.accent }} />
            <h3 className="font-body text-sm font-bold uppercase tracking-wide">Download image</h3>
          </div>
          <button aria-label="Close" onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full" style={{ background: c.surface }}><X size={14} /></button>
        </div>

        {pageCount > 1 && (
          <div className="px-5 pb-2">
            <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Choose position range</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
              {Array.from({ length: pageCount }).map((_, i) => {
                const s = i * SHARE_PAGE_SIZE + 1;
                const e = Math.min(totalCount, s + SHARE_PAGE_SIZE - 1);
                return (
                  <button key={i} onClick={() => setPage(i)}
                    className="shrink-0 font-mono text-xs font-semibold px-3 py-1.5 rounded-full"
                    style={page === i ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textDim }}>
                    {s}–{e}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-5 py-3">
          <div className="rounded-xl overflow-hidden border" style={{ borderColor: c.border }}>
            <canvas ref={canvasRef} className="w-full h-auto block" />
          </div>
        </div>

        <div className="px-5 pb-5 pt-1 flex gap-2">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl font-body text-sm font-semibold" style={{ background: c.surface, color: c.textDim }}>Cancel</button>
          <button onClick={handleDownload} className="flex-1 py-3 rounded-xl font-body text-sm font-semibold flex items-center justify-center gap-1.5" style={{ background: c.accent, color: c.accentText }}>
            <Download size={15} /> Save image
          </button>
        </div>
      </div>
    </div>
  );
}

export const REACTIONS = [
  { key: "like", emoji: "👍" },
  { key: "love", emoji: "❤️" },
  { key: "laugh", emoji: "😂" },
  { key: "fire", emoji: "🔥" },
  { key: "wow", emoji: "😮" },
  { key: "skull", emoji: "💀" },
];
export const REACTION_EMOJI = Object.fromEntries(REACTIONS.map((r) => [r.key, r.emoji]));

// A reaction bar for the league itself — same emoji-picker pattern as a
// comment's reaction button, just scoped to league_reactions instead of
// comment_likes. Open to anyone signed in (not gated by canComment/joined),
// so the general public can react to a league without joining it.
export function LeagueReactionBar({ league, session, onToggle, c, compact = false }) {
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

export function CommunityResultRow({ result: r, myId, c }) {
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

export const BOARD_PAGE_SIZE = 8;
export const BOARD_MAX_INDENT_DEPTH = 4;

// A single platform-wide comment wall at the very bottom of the Challenges
// screen — banter, callouts, "who's on tonight" — open to any signed-in
// member regardless of which challenges they're personally involved in.
// Threads nest to unlimited depth, same as the per-league comments system —
// a reply can be replied to, and so on, with no cap on how many levels deep
// a conversation under one root comment can go. Indentation stops growing
// past a few levels purely for legibility on a phone; that's cosmetic only.
export function ChallengeBoard({ session, comments, isAdmin, myUsername, onPost, onDelete, onToggleReaction, c, heading = "Challenge board", emptyText = "No comments yet — say something to get things going." }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [visibleCount, setVisibleCount] = useState(BOARD_PAGE_SIZE);
  const [pending, setPending] = useState([]); // optimistic comments/replies, cleared once the real row lands
  const voiceRecorder = useVoiceRecorder();
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

  const submit = async (parentComment = null, body = text, voiceClip = null) => {
    const trimmed = body.trim();
    if ((!trimmed && !voiceClip) || posting) return false;
    setPosting(true);
    const tempId = `temp-${Date.now()}`;
    const optimistic = {
      id: tempId, user_id: session.user.id, username: myUsername,
      body: trimmed, created_at: new Date().toISOString(),
      parent_comment_id: parentComment?.id || null,
      voice_url: voiceClip ? URL.createObjectURL(voiceClip.blob) : null, voice_duration: voiceClip?.duration || null,
      challenge_board_comment_likes: [], pending: true,
    };
    setPending((prev) => [...prev, optimistic]);
    if (!parentComment) {
      setText("");
      voiceRecorder.discard();
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    }
    const ok = await onPost(trimmed, parentComment, voiceClip);
    setPosting(false);
    if (!ok) {
      setPending((prev) => prev.filter((p) => p.id !== tempId));
      if (!parentComment) { setText(trimmed); voiceRecorder.restore(voiceClip); }
    }
    return ok;
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(null, text, voiceRecorder.state === "recorded" ? voiceRecorder.clip : null); }
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
        <MessageCircle size={13} /> {heading} {totalCount > 0 && `(${totalCount})`}
      </div>

      {comments === null ? (
        <Loader c={c} />
      ) : (
        <>
          {roots.length === 0 ? (
            <div className="border border-dashed rounded-xl p-6 text-center mb-4" style={{ borderColor: c.borderStrong, color: c.textDim }}>
              <MessageCircle size={20} className="mx-auto mb-2" style={{ color: c.textFaint }} />
              <div className="font-body text-sm">{emptyText}</div>
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

          {voiceRecorder.state === "recorded" && voiceRecorder.clip && (
            <div className="flex items-center gap-2 mb-2 ml-10">
              <VoiceNotePlayer url={URL.createObjectURL(voiceRecorder.clip.blob)} duration={voiceRecorder.clip.duration} c={c} compact />
              <button onClick={voiceRecorder.discard} className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded-full"
                style={{ background: c.surface, color: c.textFaint }}>
                Remove
              </button>
            </div>
          )}
          {voiceRecorder.state === "denied" && (
            <div className="font-mono text-[10px] mb-2 ml-10" style={{ color: c.red }}>
              Couldn't access your microphone — check your browser's permissions.
            </div>
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
            {voiceRecorder.state !== "recorded" && <VoiceRecorderButton recorder={voiceRecorder} c={c} />}
            <button onClick={() => submit(null, text, voiceRecorder.state === "recorded" ? voiceRecorder.clip : null)}
              disabled={(!text.trim() && voiceRecorder.state !== "recorded") || posting}
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-full transition-transform active:scale-90"
              style={(text.trim() || voiceRecorder.state === "recorded") && !posting ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
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
  const speakingId = useCommentSpeakingId();
  const isSpeaking = speakingId === cm.id;

  const [pendingReaction, setPendingReaction] = useState(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const [replyOpen, setReplyOpen] = useState(false);
  const [repliesShown, setRepliesShown] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const replyVoiceRecorder = useVoiceRecorder();
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
    const voiceClip = replyVoiceRecorder.state === "recorded" ? replyVoiceRecorder.clip : null;
    if ((!trimmed && !voiceClip) || replying) return;
    setReplying(true);
    setReplyText("");
    replyVoiceRecorder.discard();
    setReplyOpen(false);
    const ok = await onPost(cm, trimmed, voiceClip);
    setReplying(false);
    if (!ok) { setReplyText(trimmed); replyVoiceRecorder.restore(voiceClip); }
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
        <div className="flex-1 min-w-0 rounded-xl px-3 py-2 transition-colors" style={{ background: isSpeaking ? c.surfaceHover : c.surface }}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-body font-semibold text-xs truncate">{cm.username}</span>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>
                {cm.pending ? "sending…" : timeAgo(cm.created_at)}
              </span>
              {!cm.pending && cm.body && (
                <button onClick={() => commentSpeech.speak(cm.id, `${cm.username} said: ${cm.body}`)} title="Read comment aloud"
                  className="transition-colors" style={{ color: isSpeaking ? c.accent : c.textFaint }}>
                  <Volume2 size={11} />
                </button>
              )}
              {!cm.pending && (isOwn || isAdmin) && (
                <button onClick={() => onDelete(cm)} title="Delete"
                  className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: c.textFaint }}>
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          </div>
          {cm.body && <div className="font-body text-sm mt-0.5 whitespace-pre-wrap break-words">{cm.body}</div>}
          {cm.voice_url && <div className="mt-2"><VoiceNotePlayer url={cm.voice_url} duration={cm.voice_duration} c={c} /></div>}
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
          {replyVoiceRecorder.state === "recorded" && replyVoiceRecorder.clip && (
            <div className="flex items-center gap-2 mb-1.5">
              <VoiceNotePlayer url={URL.createObjectURL(replyVoiceRecorder.clip.blob)} duration={replyVoiceRecorder.clip.duration} c={c} compact />
              <button onClick={replyVoiceRecorder.discard} className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded-full"
                style={{ background: c.surface, color: c.textFaint }}>
                Remove
              </button>
            </div>
          )}
          {replyVoiceRecorder.state === "denied" && (
            <div className="font-mono text-[10px] mb-1.5" style={{ color: c.red }}>
              Couldn't access your microphone — check your browser's permissions.
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea ref={replyRef} value={replyText}
              onChange={(e) => { setReplyText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px"; }}
              onKeyDown={onReplyKeyDown}
              placeholder={`Reply to ${cm.username}…`} rows={1} maxLength={1000} autoFocus
              className="board-textarea flex-1 font-body text-sm rounded-xl px-3 py-2 resize-none outline-none transition-colors"
              style={{ background: c.surface, color: c.text, border: `1px solid ${c.border}` }} />
            {replyVoiceRecorder.state !== "recorded" && <VoiceRecorderButton recorder={replyVoiceRecorder} c={c} size={36} iconSize={13} />}
            <button aria-label="Send reply" onClick={submitReply} disabled={(!replyText.trim() && replyVoiceRecorder.state !== "recorded") || replying}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-transform active:scale-90"
              style={(replyText.trim() || replyVoiceRecorder.state === "recorded") && !replying ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
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

export function ChallengeRow({ challenge: ch, myId, myUsername, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onViewResultProof, onOpenChat, c }) {
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
          {ch.status === "pending" && ch.is_ladder && (() => { const d = ladderDaysLeft(ch.created_at, 5); return d !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: d <= 2 ? c.red : c.textFaint }}>
              {iAmChallenger ? `Goes to admin in ${d}d if they don't respond` : `Accept within ${d}d or it goes to admin for a walkover decision`}
            </div>
          ); })()}
          {ch.status === "accepted" && ch.result_status === "confirmed" && (
            <div className="font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.greenText }}>
              Final: you {myScore} – {theirScore} {counterpartUsername}
              {ch.auto_verified && <span title="Screenshot verified automatically">· auto-approved</span>}
            </div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && iReported && !challengeResultConfirmExpired(ch) && (
            <div className="font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.textFaint }}><Clock size={10} /> You {myScore} – {theirScore} them · waiting for confirmation</div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && !iReported && !challengeResultConfirmExpired(ch) && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.accent }}>They reported you {myScore} – {theirScore} them</div>
          )}
          {ch.status === "accepted" && ch.result_status === "pending" && !challengeResultConfirmExpired(ch) && (() => { const m = challengeResultMinutesLeft(ch); return m !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: m <= 5 ? c.red : c.textFaint }}>
              {iReported ? `Goes to admin in ${m}m if they don't respond` : `Confirm within ${m}m or it goes to admin`}
            </div>
          ); })()}
          {ch.status === "accepted" && ch.result_status === "pending" && challengeResultConfirmExpired(ch) && (
            <div className="font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.red }}><Clock size={10} /> You {myScore} – {theirScore} them · escalated to admin for review</div>
          )}
          {ch.status === "accepted" && !ch.result_status && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.greenText }}>Accepted — say hi and set a time</div>}
          {ch.status === "declined" && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.red }}>{iAmChallenger ? "They declined" : "You declined"}</div>}
          {ch.status === "expired" && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.red }}>{iAmChallenger ? "Walkover — admin closed it out" : "Expired — you didn't respond in time"}</div>}
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
            <WhatsAppCallLink phone={counterpartPhone} iconOnly text={`Hi, this is ${myUsername} 🔥 Game's on! Call me when you're ready to play so we can lock in the time ⚽🕹️`} c={c} />
            <button onClick={() => onRemove(ch)} title="Remove" className="w-7 h-7 flex items-center justify-center rounded-full" style={{ color: c.textFaint }}><Trash2 size={12} /></button>
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "pending" && iReported && (
          <div className="flex items-center gap-1.5 shrink-0">
            <WhatsAppCallLink phone={counterpartPhone} iconOnly text={`Hi, this is ${myUsername} 🔥 Game's on! Call me when you're ready to play so we can lock in the time ⚽🕹️`} c={c} />
          </div>
        )}
        {ch.status === "accepted" && ch.result_status === "pending" && !iReported && !challengeResultConfirmExpired(ch) && (
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

// Lets two people already matched — an accepted direct challenge or a
// grabbed random challenge — message each other without leaving the site.
// Backed by a small `challenge_messages` table (see
// supabase/chat-migration.sql) plus Supabase Realtime, so new messages show
// up live on both ends without a refresh. History loads once on open; the
// realtime subscription only needs to carry what happens after that.

export function ChallengeChatModal({ challengeId, kind, myId, counterpartUsername, onClose, showToast, c }) {
  const [messages, setMessages] = useState(null);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase.from("challenge_messages")
        .select("*")
        .eq("challenge_id", challengeId)
        .eq("challenge_kind", kind)
        .order("created_at", { ascending: true });
      if (!active) return;
      if (error) {
        console.error("Couldn't load chat:", error.message);
        showToast?.(`Couldn't load chat: ${error.message}`);
        setMessages([]);
        return;
      }
      setMessages(data || []);
    })();

    // Live updates: postgres_changes filters can only match one column, so
    // it's filtered by challenge_id here and challenge_kind is re-checked in
    // the handler — direct and open challenges never actually share an id
    // (both are uuids from separate tables) but this keeps it airtight.
    const channel = supabase.channel(`challenge-chat-${kind}-${challengeId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "challenge_messages", filter: `challenge_id=eq.${challengeId}` },
        (payload) => {
          if (payload.new.challenge_kind !== kind) return;
          setMessages((prev) => ((prev || []).some((m) => m.id === payload.new.id) ? prev : [...(prev || []), payload.new]));
        })
      .subscribe((status, err) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error("Chat realtime subscription failed:", status, err?.message);
          showToast?.("Live chat updates aren't connecting — try reopening the chat.");
        }
      });

    return () => { active = false; supabase.removeChannel(channel); };
  }, [challengeId, kind]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setBody("");
    const { error } = await supabase.from("challenge_messages").insert({
      challenge_id: challengeId, challenge_kind: kind, sender_id: myId, body: text,
    });
    setSending(false);
    if (error) {
      console.error("Couldn't send message:", error.message);
      showToast?.(`Couldn't send: ${error.message}`);
      setBody(text); // send failed — put the draft back rather than lose it
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl flex flex-col" style={{ background: c.bg, border: `1px solid ${c.border}`, height: "min(80vh, 640px)" }}>
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: c.border }}>
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircle size={18} style={{ color: c.accent }} />
            <h2 className="text-lg font-extrabold uppercase tracking-tight truncate">{counterpartUsername || "Chat"}</h2>
          </div>
          <button aria-label="Close chat" onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2">
          {messages === null ? (
            <Loader c={c} />
          ) : messages.length === 0 ? (
            <div className="font-body text-xs text-center mt-6" style={{ color: c.textFaint }}>Say hi — messages stay right here, no need to leave the site.</div>
          ) : (
            messages.map((m) => {
              const mine = m.sender_id === myId;
              return (
                <div key={m.id} className="max-w-[80%] px-3 py-2 rounded-2xl font-body text-sm break-words"
                  style={mine
                    ? { background: c.accent, color: c.accentText, alignSelf: "flex-end" }
                    : { background: c.surface, color: c.text, alignSelf: "flex-start" }}>
                  {m.body}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t shrink-0" style={{ borderColor: c.border }}>
          <input value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder="Message…" maxLength={1000}
            className="flex-1 min-w-0 border rounded-full px-4 py-2 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
          <button onClick={send} disabled={!body.trim() || sending} title="Send"
            className="w-9 h-9 flex items-center justify-center rounded-full shrink-0"
            style={body.trim() ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Owns the one piece of Home that genuinely needs to notice time passing on
// its own: a league's attention badge (a result gone unconfirmed past its
// 30/10-minute window, a pending payment, etc.) has no other trigger to
// reappear once its deadline quietly elapses. Everything else Home renders —
// achievements, Wall of Fame, the XP bar, the leaderboard/ladder previews —
// only changes when the underlying data actually changes, so it doesn't
// need this tick and shouldn't pay for it. Splitting this out means the
// once-a-minute re-sort (and the attention-score pass over every league on
// the platform that goes with it) only re-renders this list, not all of
// Home — which used to redo that same work on every unrelated re-render
// too (a challenges/ladder realtime update, an achievement sync, anything),
// not just the tick.
function LeagueListsSection({ leagues, isAdmin, isMemberOf, entryClosed, qualifiesForLeague, myPaymentStatus, canManageLeague, onOpen, onJoin, session, onToggleLeagueReaction, onCreate, hideLeagueIds, c }) {
  useNow(60000);
  // hideLeagueIds excludes whatever's already shown in the Weekend League
  // spotlight above (see Home) — otherwise a weekend league appeared both
  // there and again in the plain "Leagues" list below it. Cash leagues are
  // never weekend leagues (the spotlight only ever draws from fun leagues),
  // so this only needs to apply to the fun-leagues filter.
  // Survival Ladder Cup lives in the plain "Leagues" grid like every other
  // format — LeagueCard already has full ladder_cup-aware rendering (see
  // isLadderCup branches below), so no separate section is needed.
  const funLeagues = leagues.filter((l) => l.league_type !== "cash" && !isLeagueCompleted(l) && !(hideLeagueIds && hideLeagueIds.has(l.id)));
  const cashLeagues = leagues.filter((l) => l.league_type === "cash" && !isLeagueCompleted(l));

  // Finished leagues move here instead of lingering in the sections above —
  // a completed round robin/knockout/cash league or a finalized Ladder Cup
  // has nothing left for anyone to act on, so it no longer belongs among
  // the leagues someone might still join or play in. One combined section
  // covers every format, same as the plain "Leagues" grid does.
  const completedLeagues = leagues.filter((l) => isLeagueCompleted(l) && !(hideLeagueIds && hideLeagueIds.has(l.id)));

  // Leagues that need the viewer's attention (something to review, or their
  // own payment needs sorting out) float to the top of each section; the
  // rest stay newest-first.
  const attentionScore = (l) => {
    const pendingCount = l.league_type === "cash" ? (l.members || []).filter((m) => m.payment_status === "pending").length : 0;
    const pendingResultsCount = (l.result_submissions || []).filter((s) => s.status === "pending" && resultEscalationReason(l, s)).length
      + (l.format === "ladder_cup" ? (l.ladder_cup_matches || []) : []).filter((m) => ladderCupResultEscalationReason(m)).length;
    const myStatus = l.league_type === "cash" ? myPaymentStatus(l) : null;
    let score = 0;
    if (canManageLeague(l) && (pendingCount > 0 || pendingResultsCount > 0)) score += 2;
    if (myStatus === "rejected" || myStatus === "pending") score += 1;
    return score;
  };

  // Same fun-league "active in this format-kind" map the join guard uses —
  // needed here to know whether a fun league is actually joinable (not just
  // not-yet-joined) before deciding whether to lead with it.
  const activeByKindForSort = activeFunLeaguesByKind(leagues, session);
  const isJoinable = (l) => {
    if (isMemberOf(l) || entryClosed(l) || !qualifiesForLeague(l)) return false;
    return l.league_type !== "fun" || !blockingLeagueFor(activeByKindForSort, l);
  };

  // Ordering priority: a league the player can actually join goes first —
  // that's the one action worth surfacing. If nothing in this list is
  // joinable right now, lead with the league they're currently active in
  // instead, so they can jump back into their live match. Attention score
  // and recency remain the tiebreaker within whichever bucket wins.
  const sortLeagues = (list) => {
    const anyJoinable = list.some(isJoinable);
    return [...list].sort((a, b) => {
      const priorityDiff = anyJoinable
        ? (isJoinable(b) ? 1 : 0) - (isJoinable(a) ? 1 : 0)
        : (isActiveMember(b, session) ? 1 : 0) - (isActiveMember(a, session) ? 1 : 0);
      if (priorityDiff !== 0) return priorityDiff;
      return attentionScore(b) - attentionScore(a) || new Date(b.created_at) - new Date(a.created_at);
    });
  };

  return (
    <>
      <LeagueSection title="Leagues" icon={Gamepad2} leagues={sortLeagues(funLeagues)} isAdmin={isAdmin} isMemberOf={isMemberOf}
        entryClosed={entryClosed} qualifiesForLeague={qualifiesForLeague} myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
        session={session} onToggleLeagueReaction={onToggleLeagueReaction} onCreate={onCreate} c={c} />

      {cashLeagues.length > 0 && (
        <LeagueSection title="Cash leagues" icon={Wallet} leagues={sortLeagues(cashLeagues)} isAdmin={isAdmin} isMemberOf={isMemberOf}
          entryClosed={entryClosed} qualifiesForLeague={qualifiesForLeague} myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
          session={session} onToggleLeagueReaction={onToggleLeagueReaction} c={c} />
      )}

      {completedLeagues.length > 0 && (
        <LeagueSection title="Completed Leagues" icon={Trophy} leagues={sortLeagues(completedLeagues)} isAdmin={isAdmin} isMemberOf={isMemberOf}
          entryClosed={entryClosed} qualifiesForLeague={qualifiesForLeague} myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
          session={session} onToggleLeagueReaction={onToggleLeagueReaction} c={c} />
      )}
    </>
  );
}

function LeagueSection({ title, icon: Icon, leagues, isAdmin, isMemberOf, entryClosed, qualifiesForLeague, myPaymentStatus, canManageLeague, onOpen, onJoin, session, onToggleLeagueReaction, onCreate, c }) {
  const pendingReviewCount = leagues.filter(canManageLeague).reduce((sum, l) =>
    sum + (l.members || []).filter((m) => m.payment_status === "pending").length, 0);
  const activeFunLeaguesByKindMap = useMemo(() => activeFunLeaguesByKind(leagues, session), [leagues, session]);
  if (leagues.length === 0 && !onCreate) return null;
  return (
    <section className="mt-8 first:mt-0">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, border: `1px solid ${c.border}` }}><Icon size={15} style={{ color: c.accent }} /></span>
          <div className="font-extrabold uppercase tracking-tight text-lg leading-none flex items-center gap-2">
            {title}
            <span className="font-mono text-[10px] font-normal tracking-wider px-1.5 py-0.5 rounded" style={{ background: c.surfaceHover, color: c.textFaint }}>{leagues.length}</span>
          </div>
        </div>
        {pendingReviewCount > 0 && (
          <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded shrink-0" style={{ background: c.redSoft, color: c.red }}>
            {pendingReviewCount} to review
          </span>
        )}
      </div>
      <div className="no-scrollbar flex items-stretch gap-3 overflow-x-auto -mx-4 px-4 pb-1">
        {leagues.map((l) => (
          <LeagueCard key={l.id} league={l} isAdmin={isAdmin} joined={isMemberOf(l)} closed={entryClosed(l)}
            blockedByLeague={isMemberOf(l) ? null : blockingLeagueFor(activeFunLeaguesByKindMap, l)}
            qualified={qualifiesForLeague(l)}
            myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
            session={session} onToggleLeagueReaction={onToggleLeagueReaction} c={c} />
        ))}
        {onCreate && (
          <button onClick={onCreate} className="shrink-0 w-[132px] flex flex-col items-center justify-center gap-2 border border-dashed rounded-2xl font-body text-xs font-semibold transition-transform active:scale-[0.97]"
            style={{ borderColor: c.borderStrong, color: c.textFaint }}>
            <span className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: c.surfaceHover }}>
              <Plus size={16} strokeWidth={2.5} style={{ color: c.textDim }} />
            </span>
            New league
          </button>
        )}
      </div>
    </section>
  );
}

function LeagueCard({ league: l, isAdmin, joined, closed, blockedByLeague, qualified, myPaymentStatus, canManageLeague, onOpen, onJoin, session, onToggleLeagueReaction, c }) {
  // Ladder Cup never writes to `fixtures` — it plays entirely through
  // `ladder_cup_matches` (see ensureLadderCupEntry / initiateLadderCupMatch
  // in App.jsx). Every count below that used to read straight off
  // l.fixtures needs a ladder_cup-aware branch, or the card reads as
  // permanently unstarted ("Open") no matter how many matches have been
  // played, since l.fixtures.length is always 0 for this format.
  const isLadderCup = l.format === "ladder_cup";
  // Defensive: a league row with a missing teams/fixtures join (see the
  // homepage crash fixes elsewhere in this file) shouldn't take down every
  // other card in the list — fall back to empty arrays for just this one.
  const teams = l.teams || [];
  const fixtures = l.fixtures || [];
  const ladderMatches = isLadderCup ? (l.ladder_cup_matches || []) : [];
  const ladderPlayedCount = ladderMatches.filter((m) => m.finalized_at).length;
  const played = isLadderCup ? ladderPlayedCount : fixtures.filter((f) => f.played).length;
  const paymentStatus = l.league_type === "cash" ? myPaymentStatus(l) : null;
  const isCash = l.league_type === "cash";
  const canSeePool = canManageLeague(l) || paymentStatus === "approved";
  const approvedMembers = isCash ? (l.members || []).filter((m) => m.payment_status === "approved") : [];
  const pool = approvedMembers.reduce((sum, m) => sum + (m.entry_fee || 0), 0);
  const pendingCount = isCash ? (l.members || []).filter((m) => m.payment_status === "pending").length : 0;
  const pendingResultsCount = (l.result_submissions || []).filter((s) => s.status === "pending" && resultEscalationReason(l, s)).length
    + ladderMatches.filter((m) => ladderCupResultEscalationReason(m)).length;
  const isStaged = l.format === "survivor" || l.format === "groups_knockout";
  const activeTeams = l.format === "survivor" ? teams.filter((t) => !t.eliminated) : teams;
  const leader = computeStandings(activeTeams, fixtures.filter((f) => !isStaged || f.stage === l.current_stage), l)[0];
  const formatLabel = FORMATS.find((f) => f.id === l.format)?.label || l.format;
  const stageLabel = l.format === "survivor" ? (l.final_stage_started ? "Final stage" : `Stage ${l.current_stage}`)
    : l.format === "groups_knockout" ? (l.final_stage_started ? "Knockout stage" : "Group stage") : null;
  const progressPct = fixtures.length > 0 ? Math.round((played / fixtures.length) * 100) : 0;
  const initial = (l.name || "?").trim().charAt(0).toUpperCase();
  const attentionCount = (isAdmin ? pendingCount : 0) + (canManageLeague(l) ? pendingResultsCount : 0);
  const needsAttention = attentionCount > 0;
  return (
    <div onClick={() => onOpen(l.id)} className="group relative shrink-0 w-[168px] rounded-2xl cursor-pointer border overflow-hidden transition-transform active:scale-[0.97]"
      style={{
        background: c.surface,
        borderColor: isCash ? "#B8860B55" : c.border,
        boxShadow: isCash ? "0 0 0 1px rgba(184,134,11,0.12)" : "none",
      }}>
      {/* Crest banner */}
      <div className="relative h-[86px] flex items-center justify-center overflow-hidden"
        style={{ background: isCash ? "linear-gradient(150deg, #B8860B33, #B8860B0D)" : `linear-gradient(150deg, ${c.accent}33, ${c.accent}0D)` }}>
        {l.photo_url ? (
          <img src={toProxiedUrl(l.photo_url)} alt="" loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span className="font-extrabold text-3xl" style={{ color: isCash ? "#B8860B" : c.accent, opacity: 0.85 }}>{initial}</span>
        )}
        <div className="absolute top-1.5 left-1.5 flex flex-col gap-1 items-start">
          {isCash && (
            <span className="font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: "#B8860B", color: "#fff" }}>Cash</span>
          )}
          {needsAttention && (
            <span className="min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center font-mono text-[9px] font-bold" style={{ background: c.red, color: "#fff" }}>{attentionCount}</span>
          )}
        </div>
        <div className="absolute top-1.5 right-1.5">
          <LeagueReactionBar league={l} session={session} onToggle={onToggleLeagueReaction} c={c} compact />
        </div>
        {isLadderCup ? (
          // No fixed match count to show a progress bar against — Ladder
          // Cup is either waiting on its first club, or already live (it
          // has no separate start step; see LadderCupPendingPanel).
          teams.length === 0 ? (
            <span className="absolute bottom-1.5 left-1.5 font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: c.greenSoft, color: c.greenText }}>Open</span>
          ) : (
            <span className="absolute bottom-1.5 left-1.5 font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: c.greenSoft, color: c.greenText }}>Live</span>
          )
        ) : fixtures.length === 0 ? (
          <span className="absolute bottom-1.5 left-1.5 font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: c.greenSoft, color: c.greenText }}>Open</span>
        ) : (
          <div className="absolute bottom-0 left-0 right-0 h-1" style={{ background: c.bg + "55" }}>
            <div className="h-full" style={{ width: `${progressPct}%`, background: c.accent }} />
          </div>
        )}
      </div>

      <div className="p-2.5">
        <div className="font-extrabold text-sm leading-tight truncate">{l.name}</div>
        <div className="font-mono text-[9px] uppercase tracking-wider truncate mt-0.5" style={{ color: c.textFaint }}>
          {stageLabel || formatLabel}
        </div>

        <div className="flex items-center gap-1 mt-2 font-mono text-[9px]" style={{ color: c.textDim }}>
          <Shield size={9} /> {teams.length}
          {isLadderCup
            ? ladderMatches.length > 0 && <span className="ml-1">· {played} played</span>
            : fixtures.length > 0 && <span className="ml-1">· {played}/{fixtures.length}</span>}
        </div>

        {isCash && canSeePool && (
          <div className="font-mono text-[9px] font-bold mt-1" style={{ color: "#B8860B" }}>{formatRand(pool)} pool</div>
        )}
        {leader && leader.p > 0 && (
          <div className="flex items-center gap-1 font-mono text-[9px] truncate mt-1" style={{ color: c.textFaint }}>
            <Crown size={9} style={{ color: c.accent }} /> <span className="truncate">{leader.name}</span>
          </div>
        )}

        <div className="mt-2">
          {joined ? (
            paymentStatus === "pending" ? (
              <span className="block text-center font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>Pending</span>
            ) : paymentStatus === "rejected" ? (
              <span className="block text-center font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.redSoft, color: c.red }}>Rejected</span>
            ) : (
              <span className="block text-center font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.greenSoft, color: c.greenText }}>Joined</span>
            )
          ) : closed ? (
            <span className="block text-center font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.redSoft, color: c.red }}>Closed</span>
          ) : blockedByLeague ? (
            <span title={`Active in "${blockedByLeague.name}" — finish or get eliminated there first`}
              className="block text-center font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.surfaceHover, color: c.textFaint }}>Locked</span>
          ) : !qualified ? (
            <span title="Requires a top-20% finish in a completed Survival Ladder Cup"
              className="block text-center font-mono text-[9px] uppercase tracking-wider px-2 py-1 rounded" style={{ background: c.surfaceHover, color: c.textFaint }}>Locked</span>
          ) : (
            <button onClick={(e) => { e.stopPropagation(); onJoin(l.id); }} className="w-full font-body text-[11px] font-bold px-2 py-1.5 rounded-full"
              style={{ background: c.accent, color: c.accentText }}>Join</button>
          )}
        </div>
      </div>
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

// externalQuery lets a parent (e.g. GroupTables, searching across every
// group from one shared box) drive the filtering instead of this panel's
// own search input. Pass a string (even "") to take over; leave it
// undefined and the panel manages its own "Search a club..." box as before.
export function StandingsPanel({ standings, zoneFor, stageFixtures, isSurvivor, league, avatarByTeamId, session, myTeamId, c, externalQuery }) {
  const [localQuery, setLocalQuery] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [profileRow, setProfileRow] = useState(null); // the standings row currently shown in PlayerProfileModal, or null
  const isExternallyControlled = externalQuery !== undefined;
  const query = isExternallyControlled ? externalQuery : localQuery;
  const q = query.trim().toLowerCase();
  const ranked = standings.map((r, i) => ({ ...r, rank: i + 1 }));
  const filtered = q ? ranked.filter((r) => r.name.toLowerCase().includes(q)) : ranked;
  const scrolls = filtered.length > STANDINGS_VISIBLE_ROWS;
  const { top: leagueTopScorer, least: leagueLeastScorer } = useMemo(() => leagueGoalExtremes(standings, league), [standings, league]);

  // In an active (non-final) survivor stage, work out exactly which clubs
  // are currently sitting in the cut zone for this stage. Gated on at least
  // one match actually being played/expired in the stage — with 0 played,
  // every club is tied 0-0-0 and the "bottom N" would just be an arbitrary
  // alphabetical slice, wrongly painting untouched clubs red as if they
  // were already doomed.
  const stageHasResults = stageFixtures.some((f) => f.played || isExpired(f));
  const showsCutLine = isSurvivor && !league.final_stage_started && standings.length > 0 && stageHasResults;
  let atRiskCount = 0;
  if (showsCutLine) {
    atRiskCount = Math.max(1, Math.round(standings.length * (league.survivor_elimination_percent / 100)));
    if (standings.length - atRiskCount < league.survivor_target_count) {
      atRiskCount = standings.length - league.survivor_target_count;
    }
    atRiskCount = Math.max(0, atRiskCount);
  }
  const cutoffRank = showsCutLine && atRiskCount > 0 ? standings.length - atRiskCount + 1 : null;
  const shareRows = ranked.map((r) => ({ ...r, atRisk: cutoffRank !== null && r.rank >= cutoffRank && !r.eliminated }));

  return (
    <div className="-mx-4 px-4">
      <div className="flex items-center justify-between gap-3 mb-3 px-2">
        <div className="font-mono text-xs" style={{ color: c.textFaint }}>
          {stageFixtures.filter((f) => f.played).length} of {stageFixtures.length} matches played
          {isSurvivor ? ` · ${league.final_stage_started ? "final stage" : `stage ${league.current_stage}`}` : ""}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {standings.length > STANDINGS_VISIBLE_ROWS && (
            <div className="font-mono text-[11px]" style={{ color: c.textFaint }}>{filtered.length} club{filtered.length === 1 ? "" : "s"}</div>
          )}
          <button onClick={() => setShareOpen(true)} title="Download image" disabled={standings.length === 0}
            className="w-7 h-7 flex items-center justify-center rounded-full disabled:opacity-40" style={{ background: c.surfaceHover, color: c.textDim }}>
            <Download size={13} />
          </button>
        </div>
      </div>
      {shareOpen && (
        <ShareRangeModal onClose={() => setShareOpen(false)} kicker={isSurvivor ? "Survivor Mode" : "League Standings"} title={league.name}
          subtitle={`${stageFixtures.filter((f) => f.played).length} of ${stageFixtures.length} matches played`}
          rows={shareRows} columns={SHARE_STANDINGS_COLUMNS} c={c} />
      )}

      {cutoffRank && (
        <div className="flex items-center gap-1.5 mb-3 px-2 font-mono text-[11px]" style={{ color: c.red }}>
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.redSoft, border: `1px solid ${c.red}` }} />
          Bottom {league.survivor_elimination_percent}% ({atRiskCount} club{atRiskCount === 1 ? "" : "s"}) eliminated when this stage ends
        </div>
      )}

      <GoalExtremesBar top={leagueTopScorer} least={leagueLeastScorer} c={c} />

      {!isExternallyControlled && (
        <div className="relative mb-3">
          <input value={localQuery} onChange={(e) => setLocalQuery(e.target.value)} placeholder="Search a club..."
            className="w-full border rounded-lg pl-9 pr-3 py-2 font-body text-sm outline-none"
            style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.textFaint} strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        </div>
      )}

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
                  <tr key={r.id} role="button" tabIndex={0} onClick={() => setProfileRow(r)} onKeyDown={(e) => { if (e.key === "Enter") setProfileRow(r); }}
                    className="border-b cursor-pointer" style={{ borderColor: c.border, opacity: r.eliminated ? 0.4 : 1, height: STANDINGS_ROW_HEIGHT, background: atRisk ? c.redSoft : (myTeamId && r.id === myTeamId ? c.surfaceHover : "transparent") }}>
                    <td className="py-2.5 pl-2 relative"><span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: atRisk ? c.red : zoneFor(r.rank - 1) }} /><span style={{ color: c.textFaint }}>{r.rank}</span></td>
                    <td className="py-2.5 font-body font-medium">
                      <div className="flex items-center gap-2">
                        {avatarByTeamId && <MemberAvatar url={avatarByTeamId[r.id]} username={r.name} size={20} c={c} />}
                        <span className="truncate">{r.name}</span>
                        {r.eliminated ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>OUT</span> : atRisk ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>AT RISK</span> : ""}
                      </div>
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

      {profileRow && (
        <PlayerProfileModal
          username={profileRow.name}
          avatarUrl={avatarByTeamId ? avatarByTeamId[profileRow.id] : null}
          isMe={!!myTeamId && profileRow.id === myTeamId}
          rank={profileRow.rank}
          stats={[
            { label: "Played", value: profileRow.p },
            { label: "Points", value: profileRow.pts },
            { label: "W · D · L", value: `${profileRow.w} · ${profileRow.d} · ${profileRow.l}` },
            { label: "Goal diff", value: `${profileRow.gd >= 0 ? "+" : ""}${profileRow.gd}` },
            { label: "Goals for", value: profileRow.gf },
            { label: "Goals against", value: profileRow.ga },
          ]}
          onClose={() => setProfileRow(null)}
          c={c}
        />
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
//
// showContact (knockout only, see KnockoutFixturesList) adds a small WhatsApp
// call icon next to each side of an unplayed fixture, so either club can ring
// the other directly off the bracket instead of hunting them down through
// "Find yourself" — each icon calls the OTHER team's number and is signed
// with the icon-owner's own club name.
function FixtureScoreRow({ fixture, homeTeam, awayTeam, canManage, onSave, legLabel, joined, submission, onOpenSubmitResult, showContact, hideDueDate, league, c }) {
  const [h, setH] = useState(fixture.home_score);
  const [a, setA] = useState(fixture.away_score);
  const [ph, setPh] = useState(fixture.pens_home ?? "");
  const [pa, setPa] = useState(fixture.pens_away ?? "");
  const [saveState, setSaveState] = useState("idle");
  const [photo, setPhoto] = useState(null); // photo proof, required before saving — same rule as regular players
  const photoInputRef = useRef(null);

  useEffect(() => {
    setH(fixture.home_score); setA(fixture.away_score);
    setPh(fixture.pens_home ?? ""); setPa(fixture.pens_away ?? "");
    setSaveState("idle"); setPhoto(null);
  }, [fixture.id, fixture.played, fixture.home_score, fixture.away_score, fixture.pens_home, fixture.pens_away]);

  if (!homeTeam || !awayTeam) return null;

  // The final is always a single decisive match — a level scoreline here
  // needs a penalty score before it can be saved, since there's no second
  // leg to fall back on.
  const isFinal = isFinalFixture(fixture, league);
  const needsPens = isFinal && Number(h) === Number(a);
  const pensReady = !needsPens || (ph !== "" && pa !== "" && Number(ph) !== Number(pa));

  const save = async () => {
    if (!photo || !pensReady) return;
    setSaveState("saving");
    await onSave(fixture, h, a, photo, needsPens ? Number(ph) : null, needsPens ? Number(pa) : null);
    setPhoto(null);
    setSaveState("saved");
  };

  const callText = (fromTeam) =>
    `Hi, it's ${fromTeam.name} 🔥 Call me when you're ready to play — matchday ${fixture.round} is due ${fmtDate(fixture.due_at)}, let's lock in the time ⚽🕹️${firstMatchdayNote(fixture.round)}`;
  const offerContact = showContact && !fixture.played;

  return (
    <div className="flex flex-wrap items-center gap-2 py-2">
      {legLabel && <span className="font-mono text-[10px] uppercase tracking-wide shrink-0 w-12" style={{ color: c.textFaint }}>{legLabel}</span>}
      <span className="flex-1 min-w-0 truncate font-body text-sm text-right">{homeTeam.name}</span>
      {offerContact && awayTeam.phone && (
        <WhatsAppCallLink phone={awayTeam.phone} iconOnly text={callText(homeTeam)} c={c} />
      )}
      {canManage ? (
        <>
          <input type="number" min={0} value={h} onChange={(e) => { setH(Number(e.target.value)); setSaveState("idle"); }}
            className="w-11 text-center rounded font-mono text-sm px-1 py-1 outline-none shrink-0" style={{ background: c.surfaceHover, color: c.text }} />
          <span className="shrink-0" style={{ color: c.textFaint }}>–</span>
          <input type="number" min={0} value={a} onChange={(e) => { setA(Number(e.target.value)); setSaveState("idle"); }}
            className="w-11 text-center rounded font-mono text-sm px-1 py-1 outline-none shrink-0" style={{ background: c.surfaceHover, color: c.text }} />
          {needsPens && (
            <>
              <span className="shrink-0 font-mono text-[10px]" style={{ color: c.red }}>pens</span>
              <input type="number" min={0} value={ph} onChange={(e) => { setPh(e.target.value === "" ? "" : Number(e.target.value)); setSaveState("idle"); }}
                className="w-9 text-center rounded font-mono text-xs px-1 py-1 outline-none shrink-0" style={{ background: c.surfaceHover, color: c.text }} />
              <span className="shrink-0" style={{ color: c.textFaint }}>–</span>
              <input type="number" min={0} value={pa} onChange={(e) => { setPa(e.target.value === "" ? "" : Number(e.target.value)); setSaveState("idle"); }}
                className="w-9 text-center rounded font-mono text-xs px-1 py-1 outline-none shrink-0" style={{ background: c.surfaceHover, color: c.text }} />
            </>
          )}
        </>
      ) : (
        <span className="font-mono text-sm w-14 text-center shrink-0" style={{ color: c.text }}>
          {fixture.played ? `${fixture.home_score} – ${fixture.away_score}` : "– : –"}
          {fixture.played && fixture.pens_home != null && fixture.pens_away != null && (
            <span className="block font-mono text-[9px]" style={{ color: c.textFaint }}>pens {fixture.pens_home}-{fixture.pens_away}</span>
          )}
        </span>
      )}
      {offerContact && homeTeam.phone && (
        <WhatsAppCallLink phone={homeTeam.phone} iconOnly text={callText(awayTeam)} c={c} />
      )}
      <span className="flex-1 min-w-0 truncate font-body text-sm">{awayTeam.name}</span>
      {/* For a two-legged tie, both legs now share one due_at — showing it
          on every row would just repeat the same date twice. The shared
          start–expiry window is shown once instead, at the tie level (see
          KnockoutFixturesList) — this column is skipped here via
          hideDueDate, except "Expired" still shows per row since a
          leg-specific played/unplayed state is still worth flagging. */}
      <span className="shrink-0 font-mono text-[10px] w-20 text-right" style={{ color: isFixtureLocked(fixture, league) ? c.red : c.textFaint }}>
        {fixture.played ? "" : isFixtureLocked(fixture, league) ? "Expired" : hideDueDate ? "" : fmtDate(fixture.due_at)}
      </span>
      {canManage && (
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <input ref={photoInputRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { setPhoto(e.target.files?.[0] || null); setSaveState("idle"); }} />
          <button onClick={() => photoInputRef.current?.click()} title={photo ? photo.name : "Attach photo proof (required)"}
            className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full"
            style={photo ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
            <Camera size={12} />
          </button>
          <button onClick={save} disabled={saveState === "saving" || !photo || !pensReady} title={!photo ? "Attach a photo proof to save" : !pensReady ? "Enter a decisive penalty score" : undefined}
            className="shrink-0 font-body text-xs font-semibold px-2.5 py-1 rounded-full"
            style={{ background: saveState === "saved" ? c.greenSoft : c.accent, color: saveState === "saved" ? c.greenText : c.accentText, opacity: (saveState === "saving" || !photo || !pensReady) ? 0.5 : 1 }}>
            {saveState === "saved" ? <Check size={12} /> : saveState === "saving" ? "…" : "Save"}
          </button>
        </div>
      )}
      {!canManage && joined && !fixture.played && (
        submission?.status === "pending" ? (
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded flex items-center gap-1 w-full sm:w-auto justify-center" style={{ background: "rgba(217,164,6,0.18)", color: "#B8860B" }}>
            <Clock size={11} /> Pending
          </span>
        ) : (
          <button onClick={() => onOpenSubmitResult(fixture, homeTeam, awayTeam, submission?.status === "rejected" ? submission : null)}
            className="shrink-0 font-body text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1 w-full sm:w-auto justify-center"
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
export function GroupFixturesList({ league, groupStageFixtures, canManage, joined, getSubmission, onOpenSubmitResult, onRecordResult, c }) {
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
                        joined={joined} submission={getSubmission?.(f.id)} onOpenSubmitResult={onOpenSubmitResult} league={league} c={c} />;
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
export function KnockoutFixturesList({ league, bracketFixtures, canManage, joined, getSubmission, onOpenSubmitResult, onRecordResult, canSeePhones, c }) {
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
                const isFinalTie = isFinalRoundFixtures(fx);
                const allPlayed = legs.every((f) => f.played);
                const hAgg = aggregateFor(legs, f0.home_team_id);
                const aAgg = aggregateFor(legs, f0.away_team_id);
                const level = allPlayed && hAgg === aAgg;
                const pensH = pensAggregateFor(legs, f0.home_team_id);
                const pensA = pensAggregateFor(legs, f0.away_team_id);
                // Two-legged ties now carry ONE shared due_at across both
                // legs (see knockoutRoundFixtures), so this shows as one
                // "start → expiry (N days)" range instead of two separate
                // per-leg dates. f0.starts_at is the real recorded start
                // moment; only fall back to reconstructing it from due_at
                // for older fixtures created before that column existed.
                const tieDueAt = twoLegged ? f0.due_at : null;
                const tieWindowMs = twoLegged ? KNOCKOUT_TIE_WINDOW_MS : 0;
                const tieStartAt = !tieDueAt ? null : f0.starts_at ? new Date(f0.starts_at) : new Date(new Date(tieDueAt).getTime() - tieWindowMs);
                const tieWindowDays = tieWindowMs / ONE_DAY_MS;
                const tieExpired = twoLegged && !allPlayed && isFixtureLocked(f0, league);
                return (
                  <div key={f0.id} className="px-4 py-2.5">
                    {twoLegged && !allPlayed && (
                      <div className="font-mono text-[10px] mb-1.5" style={{ color: tieExpired ? c.red : c.textDim }}>
                        {tieExpired
                          ? "Expired"
                          : `${fmtDate(tieStartAt)} → ${fmtDate(tieDueAt)} (${tieWindowDays} day${tieWindowDays === 1 ? "" : "s"})`}
                      </div>
                    )}
                    {legs.map((f) => {
                      const legHome = league.teams.find((t) => t.id === f.home_team_id);
                      const legAway = league.teams.find((t) => t.id === f.away_team_id);
                      return <FixtureScoreRow key={f.id} fixture={f} homeTeam={legHome} awayTeam={legAway} canManage={canManage}
                        onSave={onRecordResult} legLabel={twoLegged ? `Leg ${f.leg || 1}` : null} showContact={canSeePhones}
                        hideDueDate={twoLegged}
                        joined={joined} submission={getSubmission?.(f.id)} onOpenSubmitResult={onOpenSubmitResult} league={league} c={c} />;
                    })}
                    {(twoLegged || level) && (
                      <div className="font-mono text-[10px] mt-1" style={{ color: c.textDim }}>
                        {twoLegged && <>Aggregate: {home?.name} {hAgg} – {aAgg} {away?.name}</>}
                        {level && isFinalTie && pensH !== null && pensA !== null && pensH !== pensA && (
                          <span style={{ color: c.textDim }}> · pens {pensH}-{pensA}</span>
                        )}
                        {level && isFinalTie && !(pensH !== null && pensA !== null && pensH !== pensA) && (
                          <span style={{ color: c.red }}> · level — needs a penalty shootout score to decide the winner</span>
                        )}
                        {level && !isFinalTie && (
                          <span style={{ color: c.greenText }}> · level on aggregate — both clubs advance</span>
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

export function GroupTables({ league, groupStageFixtures, avatarByTeamId, session, myTeamId, c }) {
  const groupsCount = league.groups_count || 0;
  // Show the viewer's own group's table first, then the rest of the groups
  // in their normal order — so a club opening the group stage lands on
  // their own standings before scrolling past every other group to find it.
  const myGroupNumber = myTeamId != null ? (league.teams || []).find((t) => t.id === myTeamId)?.group_number : null;
  const groupNumbers = Array.from({ length: groupsCount }, (_, i) => i)
    .sort((a, b) => (a === myGroupNumber ? -1 : b === myGroupNumber ? 1 : 0));

  // One search box for the whole group stage instead of one per group
  // table — searching a club used to mean opening each group's table in
  // turn to check it. Groups with no matching club are hidden entirely
  // while a search is active, so the matching club's table surfaces
  // immediately regardless of which group it's in.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matchesQuery = (teams) => !q || teams.some((t) => t.name.toLowerCase().includes(q));

  return (
    <div className="space-y-6">
      {groupsCount > 1 && (
        <div className="relative">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a club across all groups..."
            className="w-full border rounded-lg pl-9 pr-3 py-2 font-body text-sm outline-none"
            style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.textFaint} strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        </div>
      )}
      {q && !groupNumbers.some((g) => matchesQuery(league.teams.filter((t) => t.group_number === g))) && (
        <div className="text-center font-body text-sm py-6" style={{ color: c.textFaint }}>No club matches "{query}".</div>
      )}
      {groupNumbers.map((g) => {
        const groupTeams = league.teams.filter((t) => t.group_number === g);
        if (groupTeams.length === 0) return null;
        if (!matchesQuery(groupTeams)) return null;
        const groupFx = groupStageFixtures.filter((f) => groupTeams.some((t) => t.id === f.home_team_id));
        const standings = computeStandings(groupTeams, groupFx, league);
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
            <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={groupFx} isSurvivor={false} league={league} avatarByTeamId={avatarByTeamId} session={session} myTeamId={myTeamId} c={c}
              externalQuery={groupsCount > 1 ? q : undefined} />
          </div>
        );
      })}
    </div>
  );
}

export function LeaguePhotoBanner({ league, canManage, onUpdatePhoto, c }) {
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
        <img src={toProxiedUrl(league.photo_url)} alt="" className="w-full h-40 sm:h-48 object-cover" />
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

// The entry-close and kickoff dates, shown as plain text to everyone; for
// whoever can manage the league, a pencil next to it expands into two
// datetime-local inputs (same control CreateLeague uses) so plans can
// change after the league already exists, without needing to delete and
// recreate it. Mirrors LeagueDescriptionBlock's edit-in-place pattern.
export function LeagueScheduleLine({ league, canManage, onUpdateSchedule, onUpdateRoundPeriod, c }) {
  // Survival Ladder Cup has no entry-close date of its own — clubs join
  // until the ladder's own weekly cutoff (shown separately in
  // LadderCupPendingPanel), not a generic registration window — so this
  // field is hidden and unrequired for that format. See entryClosed in
  // App.jsx for the matching join-gating logic.
  const isLadderCup = league.format === "ladder_cup";
  const [editing, setEditing] = useState(false);
  const [entryClosesAt, setEntryClosesAt] = useState(toDatetimeLocalValue(league.entry_closes_at));
  const [startsAt, setStartsAt] = useState(toDatetimeLocalValue(league.starts_at));
  const [roundPeriodHours, setRoundPeriodHours] = useState(league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS);
  const [saving, setSaving] = useState(false);
  const inputStyle = { background: c.surfaceHover, borderColor: c.border, color: c.text };
  // Fixtures only exist once the admin has started the league — the due-date
  // period is baked into each fixture's due_at at that point, so it can only
  // still be changed for a league that hasn't started yet.
  const notStartedYet = (league.fixtures || []).length === 0;

  useEffect(() => {
    setEntryClosesAt(toDatetimeLocalValue(league.entry_closes_at));
    setStartsAt(toDatetimeLocalValue(league.starts_at));
    setRoundPeriodHours(league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS);
  }, [league.entry_closes_at, league.starts_at, league.round_period_hours]);

  const datesOutOfOrder = !isLadderCup && entryClosesAt && startsAt && new Date(startsAt) < new Date(entryClosesAt);
  const roundPeriodValid = isLadderCup || (Number(roundPeriodHours) >= 1 && Number(roundPeriodHours) <= 720);

  const save = async () => {
    if ((!isLadderCup && !entryClosesAt) || !startsAt || datesOutOfOrder || (notStartedYet && !roundPeriodValid)) return;
    setSaving(true);
    await onUpdateSchedule(league, { entryClosesAt, startsAt });
    const newPeriod = Number(roundPeriodHours);
    if (!isLadderCup && notStartedYet && newPeriod !== (league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS)) {
      await onUpdateRoundPeriod(league, newPeriod);
    }
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="mt-2 rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
        <div className={`grid grid-cols-1 ${isLadderCup ? "" : "sm:grid-cols-2"} gap-3 mb-1.5`}>
          {!isLadderCup && (
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textDim }}>Entry closes</label>
              <input type="datetime-local" value={entryClosesAt} onChange={(e) => setEntryClosesAt(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            </div>
          )}
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textDim }}>League starts</label>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
          </div>
        </div>
        {isLadderCup && (
          <div className="font-mono text-[11px] mb-2" style={{ color: c.textFaint }}>Clubs can join anytime — Survival Ladder Cup has no entry-close date, only its own weekly cutoff.</div>
        )}
        {datesOutOfOrder && (
          <div className="font-mono text-[11px] mb-2" style={{ color: c.red }}>Start date must be on or after entry closes.</div>
        )}
        {!isLadderCup && (notStartedYet ? (
          <div className="mb-1.5">
            <label className="block font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textDim }}>Hours per round (match due-date period)</label>
            <input type="number" min={1} max={720} value={roundPeriodHours} onChange={(e) => setRoundPeriodHours(e.target.value)} className="w-full sm:w-32 border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
            {!roundPeriodValid && (
              <div className="font-mono text-[11px] mt-1.5" style={{ color: c.red }}>Enter a number of days between 1 and 30.</div>
            )}
          </div>
        ) : (
          <div className="font-mono text-[11px] mb-1.5" style={{ color: c.textFaint }}>
            Match due-date period ({league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS} hour{(league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS) === 1 ? "" : "s"}) is locked in — the league has already started.
          </div>
        ))}
        <div className="flex items-center gap-2 justify-end">
          <button onClick={() => { setEntryClosesAt(toDatetimeLocalValue(league.entry_closes_at)); setStartsAt(toDatetimeLocalValue(league.starts_at)); setRoundPeriodHours(league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS); setEditing(false); }}
            className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ color: c.textFaint }}>Cancel</button>
          <button onClick={save} disabled={saving || (!isLadderCup && !entryClosesAt) || !startsAt || datesOutOfOrder || (notStartedYet && !roundPeriodValid)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.accent, color: c.accentText, opacity: saving || (!isLadderCup && !entryClosesAt) || !startsAt || datesOutOfOrder || (notStartedYet && !roundPeriodValid) ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center flex-wrap gap-x-1.5 gap-y-1 mt-1">
      <div className="font-mono text-[11px] flex items-center gap-1.5" style={{ color: c.textFaint }}>
        <Clock size={11} /> {isLadderCup ? `${league.ladder_cup_started_at ? "Started" : "Open for joining"} · Starts ${fmtDate(league.starts_at)}` : `Entry closes ${fmtDate(league.entry_closes_at)} · Starts ${fmtDate(league.starts_at)}`}
      </div>
      {canManage && (
        <button onClick={() => setEditing(true)} className="flex items-center gap-1 font-mono text-[11px] font-semibold px-1.5 py-0.5 -my-0.5 rounded"
          style={{ color: c.accent }}>
          <Settings2 size={11} /> Edit
        </button>
      )}
    </div>
  );
}

// Groups + Knockout only: lets whoever manages the league set (or clear) the
// shared deadline for submitting every result in the group stage. Each
// matchday's own due_at stays purely advisory once this exists — it's still
// shown on every fixture as a nudge, but this date is what actually decides
// when unplayed matches get locked out and auto-scored as a no-show loss.
export function GroupStageDueLine({ league, canManage, onUpdateGroupStageDueAt, c }) {
  const [editing, setEditing] = useState(false);
  const [dueAt, setDueAt] = useState(toDatetimeLocalValue(league.group_stage_due_at));
  const [saving, setSaving] = useState(false);
  const passed = league.group_stage_due_at && new Date(league.group_stage_due_at) < new Date();

  useEffect(() => { setDueAt(toDatetimeLocalValue(league.group_stage_due_at)); }, [league.group_stage_due_at]);

  const save = async () => {
    setSaving(true);
    await onUpdateGroupStageDueAt(league, dueAt || null);
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="mt-2 rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
        <label className="block font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textDim }}>
          Group stage due date (all groups)
        </label>
        <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)}
          className="w-full sm:w-64 border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <div className="font-mono text-[11px] mt-1.5 mb-2" style={{ color: c.textFaint }}>
          Individual matchday due dates stay advisory — this is the real cutoff for the whole group stage.
        </div>
        <div className="flex items-center gap-2 justify-end">
          <button onClick={() => { setDueAt(toDatetimeLocalValue(league.group_stage_due_at)); setEditing(false); }}
            className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ color: c.textFaint }}>Cancel</button>
          {league.group_stage_due_at && (
            <button onClick={async () => { setSaving(true); await onUpdateGroupStageDueAt(league, null); setSaving(false); setEditing(false); }} disabled={saving}
              className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.redSoft, color: c.red, opacity: saving ? 0.6 : 1 }}>Clear</button>
          )}
          <button onClick={save} disabled={saving || !dueAt} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full"
            style={{ background: c.accent, color: c.accentText, opacity: saving || !dueAt ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center flex-wrap gap-x-1.5 gap-y-1 mt-1">
      <div className="font-mono text-[11px] flex items-center gap-1.5" style={{ color: passed ? c.red : c.textFaint }}>
        <Clock size={11} />
        {league.group_stage_due_at ? `Group stage due ${fmtDate(league.group_stage_due_at)}${passed ? " · expired" : ""}` : "Group stage due date not set"}
      </div>
      {canManage && (
        <button onClick={() => setEditing(true)} className="flex items-center gap-1 font-mono text-[11px] font-semibold px-1.5 py-0.5 -my-0.5 rounded"
          style={{ color: c.accent }}>
          <Settings2 size={11} /> {league.group_stage_due_at ? "Edit" : "Set"}
        </button>
      )}
    </div>
  );
}

export function LeagueDescriptionBlock({ league, canManage, joined, onUpdateDescription, descOpen, setDescOpen, c }) {
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

// Lets whoever manages the league (creator or admin) override the
// auto-generated WhatsApp nudge text — see adminStatusMessage — with their
// own wording for every member in this league. Mirrors
// LeagueDescriptionBlock's edit-in-place pattern. {name} and {league} are
// swapped in per member when the message is actually sent, so the saved
// template can still read as personal even though it's the same text for
// everyone. Admin-only — this is an internal tool for whoever's sending
// the nudges, not something the rest of the league needs to see.
export function MemberMessageEditor({ league, onUpdateMemberMessage, onNotifyAllMembers, c }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(league.wa_message_template || "");
  const [saving, setSaving] = useState(false);
  const MAX_LEN = 500;

  useEffect(() => { setText(league.wa_message_template || ""); }, [league.wa_message_template]);

  const save = async () => {
    setSaving(true);
    await onUpdateMemberMessage(league, text.trim());
    setSaving(false);
    setEditing(false);
  };

  const clear = async () => {
    setSaving(true);
    await onUpdateMemberMessage(league, "");
    setText("");
    setSaving(false);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="rounded-lg px-3 py-2 mb-3 flex items-center justify-between gap-2 flex-wrap" style={{ background: c.surface }}>
        <div className="min-w-0 font-mono text-[11px] uppercase tracking-wide" style={{ color: c.textFaint }}>
          {league.wa_message_template ? "Custom WhatsApp message active for this league" : "Using the default auto WhatsApp message"}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {league.wa_message_template && (
            <button onClick={() => onNotifyAllMembers(league)} className="font-mono text-[11px] uppercase tracking-wide flex items-center gap-1" style={{ color: WHATSAPP_GREEN }}>
              <MessageCircle size={11} /> Notify everyone now
            </button>
          )}
          <button onClick={() => setEditing(true)} className="font-mono text-[11px] uppercase tracking-wide" style={{ color: c.accent }}>
            {league.wa_message_template ? "Edit" : "Customize"}
          </button>
        </div>
      </div>
    );
  }

  // A real member's display_name if one's already joined, so the preview
  // reads like an actual message rather than a placeholder — falls back to
  // a generic name for a brand-new league with no members yet.
  const sampleName = (league.members || []).find((m) => m.display_name)?.display_name || "Alex";
  const sampleFixture = nextFixtureForLeague(league);
  const sampleDue = sampleFixture ? fmtDate(sampleFixture.due_at) : league.starts_at ? fmtDate(league.starts_at) : "Fri";
  const sampleRound = sampleFixture ? String(sampleFixture.round) : "1";
  const sampleStartRaw = sampleFixture ? fixtureStartsAt(sampleFixture, league) : league.starts_at;
  const sampleStart = sampleStartRaw ? fmtDate(sampleStartRaw) : "Fri";
  const preview = text.trim()
    ? text.replace(/\{name\}/g, sampleName).replace(/\{league\}/g, league.name).replace(/\{round\}/g, sampleRound).replace(/\{due\}/g, sampleDue).replace(/\{start\}/g, sampleStart)
    : "";

  return (
    <div className="rounded-xl p-4 mb-3 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="font-mono text-[11px] uppercase tracking-wide mb-2" style={{ color: c.textDim }}>
        Sent to every member's WhatsApp icon in this league — use <strong>{"{name}"}</strong> for their name, <strong>{"{league}"}</strong> for the league name,
        <strong> {"{round}"}</strong> for their next round number, <strong> {"{due}"}</strong> for its deadline, and <strong> {"{start}"}</strong> for when that round actually kicks off. Round, due, and start all update automatically each round.
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))} rows={4} maxLength={MAX_LEN}
        placeholder="Hey {name}! Round {round} of {league} is due {due} — lock it in! 🔥⚽"
        className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none resize-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
      <div className="font-mono text-[10px] text-right mb-2" style={{ color: text.length >= MAX_LEN ? c.red : c.textFaint }}>
        {text.length}/{MAX_LEN}
      </div>
      {preview && (
        <div className="rounded-lg px-3 py-2 mb-2 font-body text-xs whitespace-pre-wrap" style={{ background: c.surfaceHover, color: c.textDim }}>
          <span className="font-mono text-[10px] uppercase tracking-wide block mb-1" style={{ color: c.textFaint }}>
            Preview — as {sampleName} would see it
          </span>
          {preview}
        </div>
      )}
      <div className="flex items-center gap-2 justify-end">
        {league.wa_message_template && (
          <button onClick={clear} disabled={saving} className="mr-auto font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ color: c.red, opacity: saving ? 0.6 : 1 }}>
            Reset to default
          </button>
        )}
        <button onClick={() => { setText(league.wa_message_template || ""); setEditing(false); }} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ color: c.textFaint }}>Cancel</button>
        <button onClick={save} disabled={saving || !text.trim()} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.accent, color: c.accentText, opacity: saving || !text.trim() ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
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
export function PendingResultsPanel({ league, submissions, onDownloadProof, onApprove, onReject, c,
  title = `${submissions.length} result${submissions.length === 1 ? "" : "s"} awaiting your review`,
  approveLabel = "Approve", rejectLabel = "Reject", showDeadline = false, showEscalationReason = false, showSubmitterWhatsApp = false }) {
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
          // The club that submitted this result, resolved via the member row
          // that matches submitted_by (a user id, same as members.user_id) —
          // result_submissions carries no team_id of its own, so this is the
          // only path from "who submitted this" to "which club's WhatsApp".
          const submitterMember = showSubmitterWhatsApp
            ? (league.members || []).find((m) => m.user_id === s.submitted_by)
            : null;
          const submitterTeam = submitterMember
            ? league.teams.find((t) => t.id === submitterMember.team_id)
            : null;
          const submitterWhatsAppText = submitterTeam
            ? `Hi ${submitterTeam.name}, your result for${fixture ? ` Matchday ${fixture.round}:` : ""} ${home?.name || "Home"} ${s.home_score} – ${s.away_score} ${away?.name || "Away"} in "${league.name}" is with me for approval now — I'll get to it shortly.`
            : null;
          return (
            <div key={s.id} className="rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
              <div className="flex items-center gap-3">
                <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>
                  {s.submitted_by_username[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="font-body text-sm truncate">{home?.name || "Home"} {s.home_score} – {s.away_score} {away?.name || "Away"}</div>
                    {showSubmitterWhatsApp && submitterTeam?.phone && (
                      <WhatsAppLink phone={submitterTeam.phone} text={submitterWhatsAppText} iconOnly
                        title={`Message ${submitterTeam.name} about this result`} c={c} />
                    )}
                  </div>
                  <div className="font-mono text-[11px]" style={{ color: c.textFaint }}>Submitted by {s.submitted_by_username}{fixture ? ` · Matchday ${fixture.round}` : ""} · {timeAgo(s.created_at)}</div>
                  {showDeadline && (() => {
                    const reason = resultEscalationReason(league, s);
                    return (
                      <div className="font-mono text-[11px] mt-0.5" style={{ color: reason ? c.red : (resultConfirmMinutesLeft(s, league) <= 5 ? c.red : "#B8860B") }}>
                        {reason === "dispute-cap"
                          ? "This fixture's been disputed too many times already — sent straight to the admin"
                          : reason === "timeout"
                          ? "Confirmation window passed — this has been sent to the admin"
                          : `${resultConfirmMinutesLeft(s, league)}m left to respond — after that it goes to the admin`}
                      </div>
                    );
                  })()}
                  {!showDeadline && showEscalationReason && resultEscalationReason(league, s) === "dispute-cap" && (
                    <div className="font-mono text-[11px] mt-0.5" style={{ color: c.red }}>Escalated — this fixture's been disputed too many times already</div>
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

// Single status line at the top of every league (any format, cash or fun):
// before kickoff it names the start date; once fixtures exist it switches
// automatically to the next unplayed fixture's due date — the viewer's own
// club's next game if they have one, otherwise the league's next game overall.
export function LeagueStatusBanner({ league, notStarted, myTeam, c }) {
  if (notStarted) {
    return (
      <div className="rounded-xl p-3 mb-5 font-body text-xs flex items-center gap-2" style={{ background: c.surface, color: c.textDim }}>
        <Clock size={13} style={{ color: c.accent }} />
        {league.starts_at ? <>League starts {fmtDate(league.starts_at)}.</> : "Start date to be confirmed by the organizer."}
      </div>
    );
  }
  const upcoming = (myTeam && !myTeam.eliminated ? nextFixtureForTeam(league, myTeam.id) : null) || nextFixtureForLeague(league);
  if (!upcoming) return null;
  return (
    <div className="rounded-xl p-3 mb-5 font-body text-xs flex items-center gap-2" style={{ background: c.surface, color: c.textDim }}>
      <Clock size={13} style={{ color: c.accent }} />
      Next fixture due {fmtDate(upcoming.due_at)}.
    </div>
  );
}

// Builds the admin's WhatsApp icon message for a member, based on that
// member's club status right now: eliminated, not-yet-started league, or
// the next fixture due date. Kept upbeat on purpose — this is the message
// that lands in a player's WhatsApp, not a formal notice.
// Whether THIS member would actually get the league's saved custom
// template, or fall back to the automated status message — shared by
// adminStatusMessage (to decide what to send) and the members tab (to
// decide which of the two lists a member belongs in), so the two can never
// disagree about which bucket a member is in.
//
// A template that references {round}/{due} needs real fixture data to fill
// them — for a member with none (eliminated, or nothing left to play),
// sending it would read as a broken half-blank line like "Round is due ".
// Rather than inventing filler text for that gap, such members fall back to
// automated. Templates that don't reference {round} or {due} at all apply
// unconditionally, to every member.
export function usesCustomMessage(t, league) {
  if (!league.wa_message_template) return false;
  const usesRoundOrDue = /\{round\}|\{due\}|\{start\}/.test(league.wa_message_template);
  if (!usesRoundOrDue) return true;
  const upcoming = t ? nextFixtureForTeam(league, t.id) : null;
  const notStarted = league.fixtures.length === 0;
  const due = upcoming ? upcoming.due_at : notStarted ? league.starts_at : null;
  return !!(upcoming || due);
}

// The real kickoff moment for a fixture — when players should actually
// start playing it, as opposed to due_at (the deadline by which it must be
// done). Knockout fixtures record this directly in starts_at (see
// knockoutRoundFixtures); round-robin/group fixtures don't have their own
// column for it, so it's derived by stepping due_at back by one round
// period — same fallback logic already used for two-legged knockout ties
// elsewhere (NextOpponentCard, OpponentFinder) when starts_at is missing on
// an older fixture.
function fixtureStartsAt(fixture, league) {
  if (!fixture) return null;
  if (fixture.starts_at) return fixture.starts_at;
  if (!fixture.due_at) return null;
  return new Date(new Date(fixture.due_at).getTime() - roundPeriodMs(league)).toISOString();
}

function adminStatusMessage(m, t, league) {
  const name = m.display_name || "there";
  // An admin-edited template on the league overrides the status-based
  // message entirely, for every eligible member (see usesCustomMessage
  // above), until it's edited or cleared again — see
  // updateLeagueMemberMessage. {name} and {league} get swapped in per
  // member so a single saved template still reads as personal. {round} and
  // {due} are also live — sourced from this member's own next unplayed
  // fixture (same lookup the default message uses), so a custom template
  // still tracks the bracket forward each round instead of freezing on
  // whatever round it was written during. {start} is that same fixture's
  // real kickoff moment (see fixtureStartsAt) — blank if there's no
  // upcoming fixture yet to attach one to.
  if (usesCustomMessage(t, league)) {
    const upcoming = t ? nextFixtureForTeam(league, t.id) : null;
    const notStarted = league.fixtures.length === 0;
    const due = upcoming ? upcoming.due_at : notStarted ? league.starts_at : null;
    const start = upcoming ? fixtureStartsAt(upcoming, league) : notStarted ? league.starts_at : null;
    return league.wa_message_template
      .replace(/\{name\}/g, name)
      .replace(/\{league\}/g, league.name)
      .replace(/\{round\}/g, upcoming ? String(upcoming.round) : "")
      .replace(/\{due\}/g, due ? fmtDate(due) : "")
      .replace(/\{start\}/g, start ? fmtDate(start) : "");
  }
  if (t?.eliminated) {
    return `Hey ${name}! 👋\n🔴 Tough one — you've been eliminated from ${league.name}.\n🔥 Try again on the next one — jump into one of our other available leagues and get straight back in the fight!\n👉 ${SITE_URL}`;
  }
  const notStarted = league.fixtures.length === 0;
  if (notStarted) {
    return league.starts_at
      ? `Hey ${name}! 🎉\n🏆 ${league.name} kicks off ${fmtDate(league.starts_at)}.\n⚽ Get ready, it's going to be a good one!`
      : `Hey ${name}! 🎉\n📋 ${league.name} is filling up fast.\n⚽ We'll confirm the kickoff date soon — get hyped!`;
  }
  // {round} is read fresh off this member's own next unplayed fixture every
  // time this message is generated (never stored), so as soon as a round's
  // results are in and the next round's fixtures exist, the very next time
  // this message goes out it names the new round on its own.
  const upcoming = t ? nextFixtureForTeam(league, t.id) : null;
  if (upcoming) {
    // The window this fixture can be played in — real kickoff moment
    // through the deadline. For most rounds these are genuinely different
    // times (see fixtureStartsAt); if they happen to land on the exact same
    // moment (e.g. an older fixture with no round period recorded), only
    // show it once rather than printing the same time twice.
    const start = fixtureStartsAt(upcoming, league);
    const windowLine = start && start !== upcoming.due_at
      ? `📅 Starts ${fmtDate(start)} · Due ${fmtDate(upcoming.due_at)}`
      : `📅 Due ${fmtDate(upcoming.due_at)}`;
    // Round 1 of a fresh stage means this club just survived a cut — the
    // knockout bracket starting for groups_knockout, or a new survivor
    // stage (current_stage > 1) — so lead with a congrats line instead of
    // the plain reminder. Round 1 of stage 1 (a league just starting, or
    // plain single/double round-robin with no earlier cut to survive)
    // isn't a promotion, so it's excluded here on purpose.
    //
    // A plain knockout league has no earlier stage to be promoted FROM —
    // round 1 is just the bracket starting, same as any other league's
    // opening round. But round 2 onward is different: reaching it always
    // means this club just won its previous tie (or, rarely, had a bye),
    // so that's worth congratulating the same way, every round.
    const justAdvanced = !t.eliminated && (
      (upcoming.round === 1 && (
        (league.format === "groups_knockout" && upcoming.stage === 2) ||
        (league.format === "survivor" && league.current_stage > 1 && upcoming.stage === league.current_stage)
      )) ||
      (league.format === "knockout" && upcoming.round > 1)
    );
    if (justAdvanced) {
      const throughTo = league.format === "knockout" ? "the next round"
        : league.format === "survivor" ? (league.final_stage_started ? "the final stage" : "the next stage")
        : "the knockout stage";
      return `Hey ${name}! 🎉\n🏆 Congrats — you're through to ${throughTo} of ${league.name}!\n🏟️ Round ${upcoming.round} is up next.\n${windowLine} — lock in a time with your opponent.\n🔥 Bring the heat!\n👉 ${SITE_URL}`;
    }
    return `Hey ${name}! ⚡\n🏟️ Round ${upcoming.round} in ${league.name} is up next.\n${windowLine} — lock in a time with your opponent.\n🔥 Bring the heat!${firstMatchdayNote(upcoming.round)}`;
  }
  return `Hey ${name}! 👋\n💬 This is weAfrica admin Saul, checking in on ${league.name}.`;
}

// Red "reminded" highlight for a member row. members.wa_reminder_due_at is
// set (by every admin, via markWaReminder) to the timestamp someone last
// sent that member the WhatsApp text, and stored in Supabase so the
// highlight is the same for every admin looking at the league, not just
// whoever sent it. Active for WA_REMINDER_WINDOW_MS after that timestamp,
// regardless of fixtures, due dates, or elimination status — purely "was
// this person messaged recently".
export function isWaReminderActive(m) {
  if (!m.wa_reminder_due_at) return false;
  return Date.now() - new Date(m.wa_reminder_due_at).getTime() < WA_REMINDER_WINDOW_MS;
}

// Re-render on a slow tick purely so a reminder's red highlight clears
// itself in an open tab once its due date quietly passes, without needing
// a page refresh or a league data reload to notice.
function useNow(intervalMs = 60000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

export function MemberPaymentRow({ m, t, league, isCash, canManage, allowRemove = false, isOwnRow = false, onRemoveTeam, onLeave, onDownloadProof, onReviewPayment, onMarkWaReminder, onClearWaReminder, c }) {
  useNow();
  const reminded = isWaReminderActive(m);
  return (
    <div className="rounded-lg px-4 py-2.5 border transition-colors"
      style={reminded ? { background: c.redSoft, borderColor: c.red } : { background: c.surface, borderColor: "transparent" }}>
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{m.display_name[0]?.toUpperCase()}</div>
        <span className="font-body text-sm flex-1">{m.display_name}</span>
        {canManage && t?.phone && (
          <WhatsAppLink phone={t.phone} iconOnly text={adminStatusMessage(m, t, league)}
            onClick={() => onMarkWaReminder(m)} c={c} />
        )}
        {canManage && reminded && (
          <button onClick={() => onClearWaReminder(m)} title="Clear reminder highlight"
            className="w-5 h-5 flex items-center justify-center rounded-full shrink-0" style={{ color: c.red }}>
            <X size={12} />
          </button>
        )}
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
export function PrizeBreakdownPanel({ league, c }) {
  const prizes = computeCashPrizes(league);
  const complete = league.fixtures.length > 0 && league.fixtures.every((f) => f.played);
  const rows = (league.members || [])
    .filter((m) => m.payment_status === "approved")
    .map((m) => ({ m, prize: prizes.get(m.id) }))
    .sort((a, b) => (a.prize?.rank || 99) - (b.prize?.rank || 99));
  const pool = rows.reduce((sum, r) => sum + (r.m.entry_fee || 0), 0);
  const knockoutFormat = isKnockoutFormat(league);
  const orgFee = organizerFee(league);
  const medal = (rank) => (rank === 1 ? "🥇 " : rank === 2 ? "🥈 " : rank === 3 ? "🥉 " : `#${rank} `);

  return (
    <div className="rounded-xl border mt-4" style={{ borderColor: c.border }}>
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: c.textFaint }}>Prize breakdown</div>
        <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: complete ? c.greenSoft : "rgba(217,164,6,0.18)", color: complete ? c.greenText : "#B8860B" }}>
          {complete ? "Final" : "Projected"}
        </span>
      </div>
      <div className="px-4 pb-3 font-mono text-[11px]" style={{ color: c.textFaint }}>
        {knockoutFormat
          ? `Pool ${formatRand(pool)} · 75% champion · 20% runner-up · 5% organizer fee`
          : `Pool ${formatRand(pool)} · 55% gold · 25% silver · 15% bronze · 5% organizer fee`}
        {!complete ? " · updates live as results come in" : ""}
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
                <td className="px-4 py-2">{prize ? medal(prize.rank) : ""}{m.display_name}</td>
                <td className="text-right px-2 py-2">{formatRand(m.entry_fee || 0)}</td>
                <td className="text-right px-2 py-2">{prize ? formatRand(Math.round(prize.directPrize)) : "—"}</td>
                <td className="text-right px-2 py-2">{prize ? formatRand(Math.round(prize.redistributed)) : "—"}</td>
                <td className="text-right px-4 py-2 font-semibold" style={{ color: prize ? c.greenText : c.text }}>{formatRand(Math.round(prize?.total || 0))}</td>
              </tr>
            ))}
            {orgFee > 0 && (
              <tr className="border-t" style={{ borderColor: c.border }}>
                <td className="px-4 py-2" style={{ color: c.textFaint }}>Organizer fee (5%)</td>
                <td className="text-right px-2 py-2" style={{ color: c.textFaint }}>—</td>
                <td className="text-right px-2 py-2" style={{ color: c.textFaint }}>—</td>
                <td className="text-right px-2 py-2" style={{ color: c.textFaint }}>—</td>
                <td className="text-right px-4 py-2 font-semibold" style={{ color: c.text }}>{formatRand(Math.round(orgFee))}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Kebab menu on the league page for admin/creator actions — keeps "Delete league"
// tucked away behind a deliberate open-then-tap, rather than a bare trash icon
// sitting next to the back button where it's easy to hit by accident.
export function LeagueMenu({ league, onShare, onDelete, c }) {
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
