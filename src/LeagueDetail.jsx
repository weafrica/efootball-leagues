import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import {
  ArrowLeft, Calendar, Camera, Check, Clock, CornerDownRight, Crown, Download, Eye,
  Flame, Heart, LogOut, Medal, MessageCircle, Pencil, Phone, ReceiptText, Search, Send, Settings2,
  Shield, Skull, Sparkles, Swords, Target, ThumbsDown, ThumbsUp, Trash2, Trophy, Users, Volume2, X, XCircle, Zap,
} from "lucide-react";
import { toProxiedUrl } from "./utils/mediaUrl";
import { rankLadderCupStandings, getOpponentPool, ladderCupOpponentTimerState, poolSightingDeadline, isWalkoverClaimable, hasMissedJoinContactWindow, joinContactDeadline, LADDER_CUP_RULES } from "./formats/ladderCup.js";

// Live "Xh Ym left" text for a deadline, ticking against a shared `now`
// (passed down from a parent's own setInterval rather than each row
// running its own timer — see LadderCupOpponentBoard's `now` state).
// Below one hour switches to minutes only; deadline in the past reads
// "Overdue" rather than going negative, since the caller (poolSightingDeadline
// et al.) stops returning a value the instant the pairing is exempted, but
// there's a brief window each tick where a just-expired deadline is still
// the prop in hand.
function formatCountdown(deadline, now) {
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return "Overdue";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}
import {
  FORMATS, GroupFixturesList, GroupStageDueLine, GroupTables, KNOCKOUT_TIE_WINDOW_MS,
  KnockoutFixturesList, LADDER_THEME, LeagueDescriptionBlock, LeagueMenu, LeaguePhotoBanner, LeagueReactionBar,
  LeagueScheduleLine, LeagueStatusBanner, MemberAvatar, MemberMessageEditor, MemberPaymentRow, ONE_DAY_MS,
  PendingResultsPanel, PlayerProfileModal, PrizeBreakdownPanel, REACTIONS, REACTION_EMOJI,
  RESULT_CONFIRM_WINDOW_MINUTES, RulesButton, ShareRangeModal, StandingsPanel,
  VoiceNotePlayer, VoiceRecorderButton, WEEKEND_RESULT_CONFIRM_WINDOW_MINUTES, WhatsAppCallLink,
  WhatsAppLink, avatarColor, challengeResultConfirmExpired, challengeResultMinutesLeft, commentSpeech,
  computeHeadToHead, computeStandings, findSubmissionOpponentId, playerKeyForTeam,
  firstMatchdayNote, fmtDate, groupLabel, isExpired, isFinalFixture, isFinalRoundFixtures,
  isFixtureLocked, isResultComment, isWaReminderActive, isWeekendLeague, knockoutBracketWinners, knockoutRoundFixtures,
  ladderCupResultEscalationReason, nextFixtureForTeam, resultConfirmDeadline, resultEscalationReason, splitCommentsByRoot,
  timeAgo, useCommentSpeakingId, useVoiceRecorder, usesCustomMessage,
  ACHIEVEMENTS_DEF, computeMyProgress, teamForUserInLeague,
} from "./App.jsx";

const RulesModal = lazy(() => import("./Rules.jsx"));

// Split out of App.jsx (was the last ~1,555 lines of it): the full league
// detail screen (standings, fixtures, comments, payments, admin controls)
// is only ever rendered once a signed-in user taps into a specific league —
// never on the guest/login page — so it doesn't need to be in the bundle
// everyone downloads just to see the sign-in screen. Lazy-loaded from
// App.jsx the same way Shop/Terms/Rules already are.
// Ladder Cup's DB rows (ladder_cup_entries: team_id, pts, w, l, gd, streak,
// status, badge_* flat columns) don't share a shape with the pure engine's
// entry type (club_id, badge_counts.{...}) — rankLadderCupStandings only
// ever reads club_id/pts/gd/toughest_opponent_beaten_pts, so this adapter
// is deliberately minimal rather than a full round-trip mapping. Badge
// counts are read straight off the raw row in the table below instead.
// ladder_rating rides along too — it's what getOpponentPool actually bands
// on (see formats/ladderCup.js); the league table below never reads it,
// same way rankLadderCupStandings never reads pts's counterpart here.
function toLadderCupEngineEntries(league) {
  const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
  return (league.ladder_cup_entries || []).map((row) => ({
    club_id: row.team_id,
    club_name: teamsById[row.team_id]?.name || "Unknown club",
    pts: row.pts, gd: row.gd,
    ladder_rating: row.ladder_rating ?? LADDER_CUP_RULES.RATING_START,
    toughest_opponent_beaten_pts: row.toughest_opponent_beaten_pts,
    status: row.status,
    _row: row,
  }));
}

const LADDER_CUP_STATUS_LABEL = {
  active: "Active", pending_second_life: "Second life pending",
  eliminated: "Eliminated", champion: "Champion", survived: "Survived",
};

// Step 13: shown once App.jsx's lazy finalize-on-read effect has set
// ladder_cup_finalized_at (see hasLadderCupCutoffPassed/crownChampion in
// formats/ladderCup.js). finalized_at, not champion_team_id, is the flag
// checked at the call site below — a null champion is a legitimate
// outcome (every club eliminated before the cutoff), not "not finalized
// yet".
function LadderCupFinalizedBanner({ league, c }) {
  const champion = league.ladder_cup_champion_team_id
    ? (league.teams || []).find((t) => t.id === league.ladder_cup_champion_team_id)
    : null;
  // Champion reveal card — glowing gold ring around a trophy, a one-shot
  // diagonal sweep on mount (same technique as PlayerProfileModal's
  // gold/silver/bronze card-shine), reads as the arena's "match point" HUD
  // moment. No champion is a legitimate, plainer outcome, so it skips the
  // glow treatment entirely rather than dressing up a non-event.
  if (!champion) {
    return (
      <div className="rounded-lg p-3 mt-3 flex items-center gap-2.5 border" style={{ background: c.surfaceHover, borderColor: c.border }}>
        <Skull size={16} style={{ color: c.textFaint }} />
        <div className="font-body text-sm" style={{ color: c.textDim }}>
          Ladder Cup finalized at the cutoff — no eligible champion, every club was eliminated.
        </div>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-2xl p-4 mt-3 border text-center" style={{ background: "radial-gradient(circle at 50% 0%, rgba(232,185,35,0.18), transparent 70%)", borderColor: c.accent }}>
      <div className="absolute inset-0 pointer-events-none animate-ladder-sweep"
        style={{ backgroundImage: `linear-gradient(135deg, transparent 40%, ${c.accent}40 50%, transparent 60%)`, backgroundSize: "250% 250%" }} />
      <div className="relative">
        <div className="w-12 h-12 mx-auto rounded-full flex items-center justify-center mb-2" style={{ background: c.accent, boxShadow: `0 0 0 1px ${c.accent}, 0 0 22px 4px ${c.accent}66` }}>
          <Trophy size={22} style={{ color: c.accentText }} />
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] mb-1" style={{ color: c.accent }}>Champion</div>
        <div className="font-display font-extrabold text-xl uppercase tracking-wide" style={{ color: c.text }}>{champion.name}</div>
        <div className="font-body text-xs mt-1" style={{ color: c.textDim }}>Crowned at the cutoff — last club standing.</div>
      </div>
    </div>
  );
}

// Small icon + count for each nonzero badge counter on a raw
// ladder_cup_entries row. Column names come straight from the migration
// (badge_heater_tier/giant_slayer/bounty_hunter/walkover are running
// counts, badge_second_life is a one-time boolean) — displayed as-is, no
// invented tiering beyond what's actually tracked.
// Each badge type gets its own medal color instead of one flat accent tint
// — a quick-scan "what kind of player is this" read, same idea as rank
// medal colors in the standings table below. Colors pulled from the
// LADDER_THEME palette (plus one raw gold/orange for heater/walkover,
// matching the champion banner's gold and the app's existing "hot streak"
// orange convention) rather than inventing a whole new palette.
const LADDER_CUP_BADGE_STYLE = {
  heater: { icon: Flame, color: "#F0A020" },
  giantSlayer: { icon: Swords, color: "#8B5CF6" },
  bountyHunter: { icon: Target, color: "#E8B923" },
  walkover: { icon: Zap, color: "#4EA8DE" },
  secondLife: { icon: Heart, color: "#C81E3A" },
};
// Shared source of truth for a club's earned badges — used both by the
// compact icon-only row inline in the table and by the fuller labeled chip
// list in PlayerProfileModal, so the two views can never drift out of sync
// on what counts as "earned".
function ladderCupBadges(row) {
  return [
    row.badge_heater_tier > 0 && { ...LADDER_CUP_BADGE_STYLE.heater, label: `Heater ×${row.badge_heater_tier}`, flame: true },
    row.badge_giant_slayer > 0 && { ...LADDER_CUP_BADGE_STYLE.giantSlayer, label: `Giant Slayer ×${row.badge_giant_slayer}` },
    row.badge_bounty_hunter > 0 && { ...LADDER_CUP_BADGE_STYLE.bountyHunter, label: `Bounty Hunter ×${row.badge_bounty_hunter}` },
    row.badge_walkover > 0 && { ...LADDER_CUP_BADGE_STYLE.walkover, label: `Walkover ×${row.badge_walkover}` },
    row.badge_second_life && { ...LADDER_CUP_BADGE_STYLE.secondLife, label: `Used Second Life (−${LADDER_CUP_RULES.SECOND_LIFE_DEDUCTION} pts, floored at 0)` },
  ].filter(Boolean);
}
function LadderCupBadgeRow({ row, c }) {
  const badges = ladderCupBadges(row);
  if (badges.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 mt-0.5">
      {badges.map(({ icon: Icon, label, color, flame }, i) => (
        <span key={i} title={label} className={`flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${flame ? "animate-ladder-flame" : ""}`}
          style={{ background: `${color}26`, color, boxShadow: `0 0 0 1px ${color}40` }}>
          <Icon size={11} />
        </span>
      ))}
    </div>
  );
}

const LADDER_CUP_STANDINGS_ROW_HEIGHT = 42;
const LADDER_CUP_STANDINGS_VISIBLE_ROWS = 10;

// Cosmetic Elo-style tier read off ladder_rating (the separate matchmaking
// number — see formats/ladderCup.js) purely so the table has a sense of
// "climbing the ranks" beyond the raw points column. Thresholds are
// centered on RATING_START (1000): a club that hasn't played yet starts
// Silver, not Bronze, so a fresh entry doesn't read as already behind.
function ladderCupTier(rating) {
  if (rating >= 1200) return { label: "Diamond", color: "#8FD9F5" };
  if (rating >= 1100) return { label: "Platinum", color: "#8FE3C7" };
  if (rating >= 1000) return { label: "Gold", color: "#FFD700" };
  if (rating >= 900) return { label: "Silver", color: "#C0C0C0" };
  return { label: "Bronze", color: "#CD7F32" };
}

// Top-3 podium — center-tallest #1 with a crown, #2/#3 flanking on shorter
// pedestals — rendered above the table itself so the club actually leading
// the ladder gets a "trophy shelf" moment instead of just being row one of
// a list. Only shown against the full, unfiltered standings (not mid-
// search) and only once there are actually 3+ clubs to podium.
function LadderCupPodium({ standings, avatarByTeamId, c }) {
  const order = [standings[1], standings[0], standings[2]];
  return (
    <div className="flex items-end justify-center gap-4 sm:gap-6 mb-5 pt-3 pb-1">
      {order.map((r) => {
        const rank = r.rank_position;
        const isFirst = rank === 1;
        const medal = rank === 1 ? "#FFD700" : rank === 2 ? "#C0C0C0" : "#CD7F32";
        const eliminated = r._row.status === "eliminated";
        return (
          <div key={r.club_id} className="flex flex-col items-center" style={{ opacity: eliminated ? 0.45 : 1 }}>
            <div className="relative mb-2">
              {isFirst && (
                <Crown size={18} className="absolute -top-6 left-1/2 -translate-x-1/2 animate-ladder-heartbeat" style={{ color: medal }} />
              )}
              <div className="rounded-full" style={{ boxShadow: `0 0 0 3px ${medal}, 0 0 18px -2px ${medal}` }}>
                <MemberAvatar url={avatarByTeamId ? avatarByTeamId[r.club_id] : null} username={r.club_name} size={isFirst ? 56 : 44} c={c} />
              </div>
            </div>
            <span className="font-body text-xs font-semibold truncate max-w-[84px]" style={{ color: c.text }}>{r.club_name}</span>
            <span className="font-mono text-[10px] font-bold" style={{ color: medal }}>{r.pts} pts</span>
            <div className="mt-1.5 w-16 rounded-t-lg flex items-start justify-center pt-1 font-display font-extrabold text-sm"
              style={{ height: isFirst ? 44 : rank === 2 ? 34 : 26, background: `linear-gradient(180deg, ${medal}33, ${medal}0d)`, borderTop: `2px solid ${medal}`, color: medal }}>
              {rank}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Same shape as SHARE_STANDINGS_COLUMNS (App.jsx) but without the Draws
// column — Ladder Cup has no draws — and with Streak added since it's the
// one extra stat that actually matters for this format's share image.
const LADDER_CUP_SHARE_COLUMNS = [
  { key: "rank", label: "#", width: 64, align: "center", isRank: true },
  { key: "name", label: "Club", width: 456, align: "left", isName: true, get: (r) => r.name + (r.eliminated ? " · OUT" : r.statusLabel ? ` · ${r.statusLabel.toUpperCase()}` : "") },
  { key: "p", label: "P", width: 64, align: "center", get: (r) => String(r.p) },
  { key: "w", label: "W", width: 64, align: "center", get: (r) => String(r.w) },
  { key: "l", label: "L", width: 64, align: "center", get: (r) => String(r.l) },
  { key: "gd", label: "GD", width: 96, align: "center", get: (r) => (r.gd > 0 ? `+${r.gd}` : String(r.gd)) },
  { key: "streak", label: "Streak", width: 96, align: "center", get: (r) => String(r.streak) },
  { key: "pts", label: "Pts", width: 96, align: "center", bold: true, get: (r) => String(r.pts) },
];

// The standings table itself — points/GD/streak/status/badges, ranked with
// the engine's own tiebreaker chain (points, then GD, then toughest
// opponent beaten) rather than re-deriving an ordering here. Brings over
// the normal league table's club search, avatars, click-for-profile, and
// share/download image — the parts of StandingsPanel (App.jsx) that are
// genuinely useful here too — while keeping the Ladder Cup-only stuff
// (streak, badges, status label) that StandingsPanel has no concept of.
function LadderCupStandingsTable({ league, leagues, allAchievements, avatarByTeamId, myTeamId, c }) {
  const [query, setQuery] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [profileRow, setProfileRow] = useState(null); // the standings row currently shown in PlayerProfileModal, or null

  // The club's owner (whoever's user_id holds this team's membership row in
  // *this* league) — needed to look up their app-wide XP/level and earned
  // achievement badges below, neither of which live on the Ladder Cup entry
  // itself. Falls back to null (not found) rather than throwing, since a
  // club can in principle have no matching member row (e.g. mid-removal).
  const profileOwnerId = useMemo(() => {
    if (!profileRow) return null;
    return (league.members || []).find((m) => m.team_id === profileRow.club_id)?.user_id || null;
  }, [profileRow, league.members]);

  // Same XP/level system the homepage shows for "you" (see computeMyProgress
  // in App.jsx), just aggregated for whoever owns the clicked club instead —
  // every match they've played across every league they've fielded a team
  // in, not only this one. Recomputed from data already loaded client-side
  // (the full `leagues` list), so it needs no extra fetch.
  const profileOwnerProgress = useMemo(() => {
    if (!profileOwnerId || !leagues) return null;
    return computeMyProgress(leagues, (l) => teamForUserInLeague(l, profileOwnerId));
  }, [profileOwnerId, leagues]);

  // The owner's earned milestone badges (see ACHIEVEMENTS_DEF in App.jsx) —
  // read straight from the shared, already-synced achievements table
  // (allAchievements) rather than recomputed here, same source of truth the
  // Wall of Fame uses for other members' badges. Anything not yet synced
  // for that member just won't show up here either, same as there.
  const profileOwnerBadges = useMemo(() => {
    if (!profileOwnerId || !allAchievements) return [];
    return allAchievements
      .filter((a) => a.user_id === profileOwnerId)
      .map((a) => ACHIEVEMENTS_DEF.find((d) => d.id === a.achievement_id))
      .filter(Boolean)
      .map((d) => ({ icon: d.icon, label: d.label, color: d.color }));
  }, [profileOwnerId, allAchievements]);

  const mapped = useMemo(() => toLadderCupEngineEntries(league), [league]);
  const standings = useMemo(() => rankLadderCupStandings(mapped), [mapped]);
  // Once the cutoff's lazy finalize-on-read effect has run (see App.jsx),
  // a surviving club's row.status is still "active" in the DB — that flag
  // only ever meant "not eliminated yet", so it stays true forever once
  // the cup's over. The table should stop calling that "Active" once
  // there's nothing left to be active *in* — everyone still standing is
  // shown as having survived to the end instead.
  const isFinalized = !!league.ladder_cup_finalized_at;

  if (standings.length === 0) {
    return <div className="border border-dashed rounded-2xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's registered yet — share the league so players can join.</div>;
  }

  const q = query.trim().toLowerCase();
  const filtered = q ? standings.filter((r) => r.club_name.toLowerCase().includes(q)) : standings;
  const scrolls = filtered.length > LADDER_CUP_STANDINGS_VISIBLE_ROWS;
  // Same top/bottom zone tint the round-robin/knockout StandingsPanel uses
  // (App.jsx's zoneFor, mirrored here since this table doesn't share that
  // component) — purely a visual read of the pack at a glance, no ruleset
  // meaning of its own (Ladder Cup eliminates match-by-match, not by a
  // table cutoff). idx is 0-based off rank_position, n is the full,
  // unfiltered standings count so the bands don't shift while searching.
  const n = standings.length;
  const zoneFor = (idx) => {
    if (idx === 0 && n > 4) return c.accent;
    if (idx < Math.ceil(n / 3) && n > 6) return c.green;
    if (idx >= n - Math.max(1, Math.floor(n / 4)) && n > 6) return c.red;
    return "transparent";
  };
  const shareRows = standings.map((r) => ({
    rank: r.rank_position, name: r.club_name, p: r._row.w + r._row.l, w: r._row.w, l: r._row.l,
    gd: r.gd, streak: r._row.streak, pts: r.pts, eliminated: r._row.status === "eliminated",
    statusLabel: r._row.status !== "active" && r._row.status !== "eliminated" ? LADDER_CUP_STATUS_LABEL[r._row.status]
      : isFinalized && r._row.status === "active" ? LADDER_CUP_STATUS_LABEL.survived : null,
  }));

  return (
    <div className="-mx-4 px-4">
      <div className="flex items-center justify-between gap-3 mb-3 px-2">
        <div className="font-mono text-xs" style={{ color: c.textFaint }}>
          {standings.length} club{standings.length === 1 ? "" : "s"} on the ladder
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {standings.length > LADDER_CUP_STANDINGS_VISIBLE_ROWS && (
            <div className="font-mono text-[11px]" style={{ color: c.textFaint }}>{filtered.length} club{filtered.length === 1 ? "" : "s"}</div>
          )}
          <button onClick={() => setShareOpen(true)} title="Download image"
            className="w-7 h-7 flex items-center justify-center rounded-full transition-transform active:scale-90" style={{ background: c.surfaceHover, color: c.textDim }}>
            <Download size={13} />
          </button>
        </div>
      </div>
      {shareOpen && (
        <ShareRangeModal onClose={() => setShareOpen(false)} kicker="Survival Ladder Cup" title={league.name}
          subtitle={isFinalized
            ? `${standings.filter((r) => r._row.status !== "eliminated").length} of ${standings.length} clubs survived to the end`
            : `${standings.filter((r) => r._row.status !== "eliminated").length} of ${standings.length} clubs still active`}
          rows={shareRows} columns={LADDER_CUP_SHARE_COLUMNS} c={c} />
      )}

      <div className="relative mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a club..."
          className="w-full border rounded-xl pl-9 pr-3 py-2.5 font-body text-sm outline-none"
          style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={c.textFaint} strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
      </div>

      {!q && standings.length >= 3 && <LadderCupPodium standings={standings} avatarByTeamId={avatarByTeamId} c={c} />}

      <div className="overflow-x-auto rounded-2xl border" style={{ borderColor: c.border, boxShadow: "0 8px 22px -10px rgba(0,0,0,0.55)" }}>
        <div className="overflow-y-auto" style={{ maxHeight: scrolls ? LADDER_CUP_STANDINGS_ROW_HEIGHT * LADDER_CUP_STANDINGS_VISIBLE_ROWS + 34 : undefined }}>
        <table className="w-full font-mono text-sm min-w-[620px]">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider border-b sticky top-0 z-10" style={{ color: c.textFaint, borderColor: c.border, background: c.bg }}>
              <th className="text-left py-2 pl-2 font-medium">#</th>
              <th className="text-left py-2 font-medium">Club</th>
              <th className="text-center py-2 font-medium">P</th>
              <th className="text-center py-2 font-medium">W</th>
              <th className="text-center py-2 font-medium">L</th>
              <th className="text-center py-2 font-medium">GD</th>
              <th className="text-center py-2 font-medium">Streak</th>
              <th className="text-center py-2 pr-2 font-medium">Pts</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} className="py-8 text-center font-body text-sm" style={{ color: c.textFaint }}>No club matches "{query}".</td></tr>
            ) : filtered.map((r) => {
              const row = r._row;
              const eliminated = row.status === "eliminated";
              // Top-3 medal treatment (gold/silver/bronze), same colors
              // PlayerProfileModal's card-tier-glow uses for its own
              // gold/silver/bronze tiers — only while still active, since
              // an eliminated club sitting in the top 3 on points isn't
              // "medaling", it's out.
              const medalColor = eliminated ? null : r.rank_position === 1 ? "#FFD700" : r.rank_position === 2 ? "#C0C0C0" : r.rank_position === 3 ? "#CD7F32" : null;
                const danger = !eliminated && zoneFor(r.rank_position - 1) === c.red;
                const onFire = !eliminated && row.streak >= 3;
                const tier = ladderCupTier(row.ladder_rating ?? 1000);
                const statusChip = {
                  eliminated: { color: c.textFaint, bg: "transparent", icon: Skull },
                  pending_second_life: { color: "#B8860B", bg: "rgba(184,134,11,0.15)", icon: Heart },
                  champion: { color: c.accent, bg: `${c.accent}26`, icon: Crown },
                  active: { color: c.greenText, bg: c.greenSoft, icon: Shield },
                  survived: { color: c.textFaint, bg: c.surfaceHover, icon: Check },
              }[isFinalized && row.status === "active" ? "survived" : row.status] || { color: c.textFaint, bg: "transparent", icon: Shield };
              return (
                <tr key={r.club_id} role="button" tabIndex={0} onClick={() => setProfileRow(r)} onKeyDown={(e) => { if (e.key === "Enter") setProfileRow(r); }}
                  className="border-b align-top cursor-pointer transition-colors active:brightness-125" style={{ borderColor: c.border, opacity: eliminated ? 0.45 : 1, height: LADDER_CUP_STANDINGS_ROW_HEIGHT, background: danger ? "rgba(200,30,58,0.06)" : onFire ? "rgba(240,160,32,0.05)" : myTeamId && r.club_id === myTeamId ? c.surfaceHover : "transparent" }}>
                <td className="py-2.5 pl-2 relative">
                  <span className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: eliminated ? "transparent" : zoneFor(r.rank_position - 1) }} />
                  {/* Rank read as a small filled badge instead of bare text
                      — medal colors get a glow ring so top-3 pop out of the
                      list at a glance, same "achievement chip" language the
                      badge row below already uses. */}
                  <span className="w-6 h-6 rounded-full flex items-center justify-center font-mono text-[11px] font-bold"
                    style={{
                      background: medalColor ? `${medalColor}26` : "transparent",
                      color: medalColor || c.textFaint,
                      boxShadow: medalColor ? `0 0 0 1px ${medalColor}66, 0 0 8px -2px ${medalColor}` : "none",
                    }}>
                    {medalColor ? <Medal size={12} /> : r.rank_position}
                  </span>
                </td>
                <td className="py-2.5 font-body font-medium">
                  <div className="flex items-center gap-2">
                    {avatarByTeamId && <MemberAvatar url={avatarByTeamId[r.club_id]} username={r.club_name} size={20} c={c} />}
                    {row.status === "champion" && <Crown size={13} style={{ color: c.accent }} />}
                    <span className="truncate">{r.club_name}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 mt-0.5">
                    <div className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-[1px] rounded-full" style={{ color: statusChip.color, background: statusChip.bg }}>
                      <statusChip.icon size={9} /> {isFinalized && row.status === "active" ? LADDER_CUP_STATUS_LABEL.survived : (LADDER_CUP_STATUS_LABEL[row.status] || row.status)}
                    </div>
                    {/* Cosmetic matchmaking tier (see ladderCupTier) — a
                        "climbing the ranks" read that moves off
                        ladder_rating independently of the points column,
                        so a club can be mid-table on points but visibly
                        Gold/Platinum on form. */}
                    <div className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-[1px] rounded-full" style={{ color: tier.color, background: `${tier.color}22` }}>
                      {tier.label}
                    </div>
                    {/* Step 14 (rebirth): a club that's come back from full
                        elimination wears that as a badge, not a footnote —
                        it's the whole "everyone can see they were reborn"
                        point of the feature. Shows whenever rebirth_count
                        is > 0, active or eliminated again. */}
                    {row.rebirth_count > 0 && (
                      <div className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-[1px] rounded-full" title={`Reborn ${row.rebirth_count}×`} style={{ color: "#F0A020", background: "rgba(240,160,32,0.15)" }}>
                        <Flame size={9} /> {row.rebirth_count}× reborn
                      </div>
                    )}
                  </div>
                  {/* Fallen clubs stay on the table for the record — this
                      is that record: their finished life's numbers, kept
                      readable even once pts/w/l reset to zero on rebirth. */}
                  {eliminated && (
                    <div className="font-mono text-[10px] mt-0.5" style={{ color: c.textFaint }}>
                      Final: {row.pts} pts · {row.w}W-{row.l}L
                    </div>
                  )}
                  <LadderCupBadgeRow row={row} c={c} />
                </td>
                <td className="text-center py-2.5" style={{ color: c.textDim }}>{row.w + row.l}</td>
                <td className="text-center py-2.5" style={{ color: c.textDim }}>{row.w}</td>
                <td className="text-center py-2.5" style={{ color: c.textDim }}>{row.l}</td>
                <td className="text-center py-2.5" style={{ color: c.textDim }}>{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                <td className="text-center py-2.5" style={{ color: c.textDim }}>
                  {onFire ? <span className="inline-flex items-center gap-0.5 animate-ladder-flame" style={{ color: "#F0A020" }}><Flame size={11} />{row.streak}</span> : row.streak}
                </td>
                <td className="text-center py-2.5 pr-2 font-display font-extrabold text-base" style={{ color: medalColor || c.text }}>
                  <span className="inline-flex items-center gap-1">
                    {medalColor && <Trophy size={11} style={{ color: medalColor }} />}
                    {r.pts}
                  </span>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
      {scrolls && (
        <div className="font-mono text-[10px] text-center mt-2" style={{ color: c.textFaint }}>Scroll for more — showing {LADDER_CUP_STANDINGS_VISIBLE_ROWS} of {filtered.length}</div>
      )}

      {profileRow && (
        <PlayerProfileModal
          username={profileRow.club_name}
          avatarUrl={avatarByTeamId ? avatarByTeamId[profileRow.club_id] : null}
          isMe={!!myTeamId && profileRow.club_id === myTeamId}
          rank={profileRow.rank_position}
          stats={[
            { label: "Played", value: profileRow._row.w + profileRow._row.l },
            { label: "Points", value: profileRow.pts },
            { label: "W · L", value: `${profileRow._row.w} · ${profileRow._row.l}` },
            { label: "Goal diff", value: `${profileRow.gd >= 0 ? "+" : ""}${profileRow.gd}` },
            { label: "Streak", value: profileRow._row.streak },
            { label: "Status", value: LADDER_CUP_STATUS_LABEL[profileRow._row.status] || profileRow._row.status },
            // Cosmetic matchmaking tier (see ladderCupTier) plus the raw
            // rating it's derived from — shown to anyone who opens this
            // club's card (via photo, username, or table row), same as
            // every other stat here, not just the club's own owner.
            { label: "Level", value: `${ladderCupTier(profileRow._row.ladder_rating ?? 1000).label} · ${profileRow._row.ladder_rating ?? 1000}` },
            // The owner's real, app-wide XP level (see computeMyProgress) —
            // separate from the cosmetic Ladder Cup tier above: this one is
            // earned from every match they've played in every league, not
            // just their form in this one.
            ...(profileOwnerProgress ? [{ label: "XP Level", value: `Lvl ${profileOwnerProgress.level} · ${profileOwnerProgress.levelTitle}` }] : []),
          ]}
          badges={[...ladderCupBadges(profileRow._row), ...profileOwnerBadges]}
          onClose={() => setProfileRow(null)}
          c={c}
        />
      )}
    </div>
  );
}


// Step 12: the walkover track running alongside (not instead of) the
// Challenge/match flow above. "Message opponent" is a bookkeeping click —
// the actual message happens outside the app (WhatsApp) — that starts the
// 24h wait. Once it's passed, Claim opens the screenshot form inline;
// submitting sends it to the admin review queue below. A rejected claim
// can be re-messaged (the DB's unique index only blocks a second OPEN
// claim, not a rejected one), same "try again" path a declined second
// life doesn't get but a walkover claim does, since a reviewer might've
// rejected it over a bad screenshot rather than a bad claim.
function LadderCupWalkoverClaimSection({ opponentName, opponentPhone, myTeamName, canSeePhones, claim, onMessage, onMarkFirstContact, onSubmitClaim, c }) {
  const [busy, setBusy] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [file, setFile] = useState(null);

  const message = async () => {
    setBusy(true);
    await onMessage();
    setBusy(false);
  };
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    await onSubmitClaim(claim, file);
    setBusy(false);
    setClaiming(false);
    setFile(null);
  };
  // The actual walkover message happens outside the app on WhatsApp — this
  // is that entry point, prefilled with the exact "you haven't played yet"
  // nudge, same idea as WhatsAppCallLink elsewhere but a real chat message
  // rather than a call prompt since there's nothing to "lock in" yet.
  const walkoverWhatsAppLink = canSeePhones && opponentPhone && (
    <WhatsAppLink phone={opponentPhone} iconOnly onClick={() => onMarkFirstContact?.()}
      text={`Hi, it's ${myTeamName || "your Ladder Cup opponent"} — we haven't played our Ladder Cup match yet. Let's sort out a time, otherwise I'll have to claim a walkover.`} c={c} />
  );

  if (!claim || claim.status === "rejected") {
    return (
      <div className="mt-2 pt-2 border-t flex items-center gap-2" style={{ borderColor: c.border }}>
        <div className="flex-1 min-w-0">
          {claim?.status === "rejected" && (
            <div className="font-mono text-[10px] uppercase tracking-wide mb-1.5" style={{ color: c.red }}>Previous walkover claim rejected</div>
          )}
          <button onClick={message} disabled={busy} className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color: c.textFaint }}>
            <MessageCircle size={11} /> {claim ? "Message opponent again" : "No response? Message them for a walkover"}
          </button>
        </div>
        {walkoverWhatsAppLink}
      </div>
    );
  }

  if (claim.status === "pending_review") {
    return (
      <div className="mt-2 pt-2 border-t font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ borderColor: c.border, color: c.textFaint }}>
        <Clock size={10} /> Walkover claim submitted — awaiting admin review
      </div>
    );
  }

  // status === "messaged": either still inside the 24h wait, or claimable now.
  const claimable = isWalkoverClaimable(claim);
  if (!claimable) {
    return (
      <div className="mt-2 pt-2 border-t font-mono text-[10px] uppercase tracking-wide flex items-center justify-between gap-2" style={{ borderColor: c.border, color: c.textFaint }}>
        <span className="flex items-center gap-1 min-w-0"><Clock size={10} className="shrink-0" /> {opponentName} messaged — claimable {fmtDate(claim.claimable_at)} SAST if they still haven't played</span>
        {walkoverWhatsAppLink}
      </div>
    );
  }

  if (!claiming) {
    return (
      <div className="mt-2 pt-2 border-t flex items-center justify-between gap-2" style={{ borderColor: c.border }}>
        <button onClick={() => setClaiming(true)} className="flex items-center gap-1.5 font-mono text-[11px] font-semibold" style={{ color: "#B8860B" }}>
          <Zap size={11} /> 24h wait's up — claim walkover
        </button>
        {walkoverWhatsAppLink}
      </div>
    );
  }

  return (
    <div className="mt-2 pt-2 border-t" style={{ borderColor: c.border }}>
      <label className="flex items-center gap-2 border border-dashed rounded-lg px-3 py-2 mb-1.5 cursor-pointer font-body text-xs" style={{ borderColor: c.borderStrong, color: file ? c.text : c.textDim }}>
        <Camera size={13} style={{ color: c.textFaint }} />
        {file ? file.name : "Upload a screenshot showing they never played"}
        <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
      </label>
      <div className="flex gap-2">
        <button disabled={!file || busy} onClick={submit} className="flex-1 font-body text-xs font-semibold px-3 py-2 rounded-full"
          style={file && !busy ? { background: "#B8860B", color: "#fff" } : { background: c.surfaceHover, color: c.textFaint }}>
          {busy ? "Submitting…" : "Submit claim"}
        </button>
        <button disabled={busy} onClick={() => { setClaiming(false); setFile(null); }} className="font-body text-xs font-semibold px-3 py-2 rounded-full" style={{ background: c.surfaceHover, color: c.textDim }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// One row per opponent in the current ladder-points band. Three states per
// row: no match yet (Challenge button), a match exists and is ready to play
// (either side can cancel from here, and Log result opens the step 10
// scoreline form), or it's mid-submit. Either side can log the result —
// first one to submit wins, same self-report model as the rest of Ladder
// Cup's match flow. The walkover track (LadderCupWalkoverClaimSection) runs
// independently underneath — messaging for a walkover doesn't require a
// Challenge to exist first, since the whole point is an opponent who won't
// engage at all.
function LadderCupOpponentRow({ opponent, myTeamId, myTeamName, match, walkoverClaim, canSeePhones, opponentPhone, onMarkFirstContact, onMarkPoolContact, poolSightingDeadlineAt, now, onInitiate, onCancel, onOpenResult, onRespondResult, onMessageWalkover, onSubmitWalkoverClaim, c }) {
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);
  const iAmHome = match && match.home_team_id === myTeamId;
  // A result is "reported" the instant submitLadderCupMatchResult lands
  // (result_status: "pending") and stays that way — never applied to
  // standings, never dropping the match out of this board — until either
  // the opponent confirms/disputes it or an admin steps in once
  // ladderCupResultEscalationReason flags it. iReported gates which side
  // sees "waiting for them" vs the confirm/dispute buttons, same split
  // ChallengeRow makes for challenges.
  const resultPending = match && match.result_status === "pending";
  const iReported = resultPending && match.result_reported_by_team_id === myTeamId;
  const escalated = resultPending && !!ladderCupResultEscalationReason(match);
  // Scores are stored home/away on the match row regardless of who
  // reported them — flip to "mine"/"theirs" for display so this reads the
  // same way for either side, same convention ChallengeRow uses for
  // challenger/opponent scores.
  const myGoals = match ? (iAmHome ? match.home_goals : match.away_goals) : null;
  const theirGoals = match ? (iAmHome ? match.away_goals : match.home_goals) : null;

  const challenge = async () => {
    setBusy(true);
    await onInitiate(opponent.club_id);
    setBusy(false);
  };
  const cancel = async () => {
    setBusy(true);
    await onCancel(match);
    setBusy(false);
  };
  const respond = async (accept) => {
    setResolving(true);
    await onRespondResult(match, accept);
    setResolving(false);
  };

  return (
    <div className="relative overflow-hidden rounded-2xl p-3.5 border transition-transform active:scale-[0.99]" style={{ background: c.surface, borderColor: match && !resultPending && !match.finalized_at ? c.borderStrong : c.border, boxShadow: "0 6px 18px -8px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
      {/* Ambient glow only while there's an open, unclaimed challenge slot —
          a match already logging a result or done doesn't need the "come
          fight me" pull. */}
      {!match && <div className="animate-ladder-ember absolute -top-10 -right-6 w-24 h-24 rounded-full blur-2xl pointer-events-none" style={{ background: c.accent, opacity: 0.18 }} />}
      <div className="relative flex items-center gap-3">
        {/* Sword-flanked matchup header — a small crossed-swords glyph next
            to the badge reads as "this is a matchup", not just a list row. */}
        <div className="relative w-8 h-8 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.surfaceHover, color: c.text, boxShadow: `0 0 0 1px ${c.border}` }}>
          {opponent.club_name[0]?.toUpperCase()}
          {!match && <Swords size={10} className="absolute -bottom-1 -right-1 rounded-full p-[3px]" style={{ background: c.bg, color: c.accent, boxShadow: `0 0 0 1px ${c.border}` }} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-body text-sm font-semibold truncate flex items-center gap-1.5">
            {opponent.club_name}
            {/* Same call-to-arrange entry point the fixture-based formats offer —
                available any time a number's on file, not just once a match
                exists, since messaging an opponent (to set up a challenge, or
                to chase a walkover) is exactly what this icon is for. Silently
                renders nothing without a number on file, same guard every
                other WhatsAppCallLink use in this file relies on. Also fires
                two independent "made contact" signals at once: the
                club-wide join-contact one (onMarkFirstContact — see
                hasMissedJoinContactWindow) and this specific opponent's
                12h pool-visibility one (onMarkPoolContact — see
                ladderCupOpponentTimerState). First tap of each only counts. */}
            {canSeePhones && opponentPhone && (
              <WhatsAppCallLink phone={opponentPhone} iconOnly onClick={() => { onMarkFirstContact?.(); onMarkPoolContact?.(); }}
                text={match
                  ? `Hi, it's ${myTeamName || "your Ladder Cup opponent"} 🔥 Call me when you're ready to play our Ladder Cup match — let's lock in the time ⚽🕹️`
                  : `Hi, it's ${myTeamName || "your Ladder Cup opponent"} 🔥 Fancy a Ladder Cup match? Call me and let's set it up ⚽🕹️`} c={c} />
            )}
          </div>
          <span className="inline-block font-mono text-[10px] uppercase tracking-wide mt-0.5 px-1.5 py-[1px] rounded-full" style={{ background: c.surfaceHover, color: c.textFaint }}>{opponent.ladder_rating} rating</span>
          {/* The single "live" 12h pool-visibility countdown (see
              ladderCupOpponentTimerState / poolSightingDeadline) — only one
              opponent on the whole board has this running at once, so this
              only renders for whichever opponent LadderCupOpponentBoard
              handed a non-null poolSightingDeadlineAt (everyone else's
              clock hasn't started yet). Disappears the instant the
              WhatsApp icon above is tapped for this opponent, same as the
              deadline prop itself going null once contacted_at is set.
              Live-ticking against the board's shared `now` (formatCountdown)
              rather than a static date; red once under 3h to flag it's
              about to drop off. */}
          {!match && poolSightingDeadlineAt && (
            <div className="font-mono text-[9px] mt-0.5" style={{ color: new Date(poolSightingDeadlineAt).getTime() - now <= 3 * 60 * 60 * 1000 ? c.red : c.textFaint }}>
              {formatCountdown(poolSightingDeadlineAt, now)} to message them or they drop off your list
            </div>
          )}
        </div>
        {!match && (
          <button onClick={challenge} disabled={busy}
            className="shrink-0 flex items-center gap-1.5 font-body text-xs font-semibold px-3.5 py-2 rounded-full"
            style={{ background: c.accent, color: c.accentText, boxShadow: `0 0 0 1px ${c.accent}, 0 0 14px 1px ${c.accent}55` }}>
            <Swords size={13} /> Challenge
          </button>
        )}
        {/* match.result_status flips straight from "pending" to "confirmed"
            once applyLadderCupMatchResult lands — resultPending alone
            (only true while "pending") doesn't distinguish "no result
            logged yet" from "already confirmed", so a finalized match was
            falling through to the same Log result button as a fresh one.
            Gate on finalized_at instead so a settled match shows its
            score, not an invitation to log it again. */}
        {match && !resultPending && !match.finalized_at && (
          <button onClick={() => onOpenResult(match)}
            className="shrink-0 flex items-center gap-1.5 font-body text-xs font-semibold px-3 py-2 rounded-full transition-transform active:scale-95" style={{ background: c.greenSoft, color: c.greenText }}>
            <Trophy size={13} /> Log result
          </button>
        )}
        {match && match.finalized_at && (
          <div className="shrink-0 font-mono text-xs font-semibold px-3 py-2" style={{ color: c.textFaint }}>
            {myGoals} – {theirGoals}
          </div>
        )}
        {resultPending && !iReported && !escalated && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={() => respond(true)} disabled={resolving} title="Confirm result" className="w-8 h-8 flex items-center justify-center rounded-full transition-transform active:scale-90" style={{ background: c.accent, color: c.accentText }}><Check size={14} /></button>
            <button onClick={() => respond(false)} disabled={resolving} title="Dispute result" className="w-8 h-8 flex items-center justify-center rounded-full transition-transform active:scale-90" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
          </div>
        )}
        {match && !resultPending && !match.finalized_at && (
          <button onClick={cancel} disabled={busy} title="Cancel match" className="w-7 h-7 flex items-center justify-center rounded-full shrink-0 transition-transform active:scale-90" style={{ color: c.textFaint }}>
            <X size={13} />
          </button>
        )}
      </div>
      {/* Step 10 pipeline: reported-but-unconfirmed result. iReported sees a
          waiting/escalated status line (no buttons — the confirm/dispute
          buttons above are only ever offered to the other side); the other
          side sees the reported scoreline plus a link to the photo proof
          alongside the Confirm/Dispute buttons above, mirroring how
          ChallengeRow splits the same state. */}
      {resultPending && iReported && !escalated && (
        <div className="font-mono text-[10px] uppercase tracking-wide mt-2 flex items-center gap-1" style={{ color: (challengeResultMinutesLeft(match) ?? 99) <= 5 ? c.red : c.textFaint }}>
          <Clock size={10} /> You {myGoals} – {theirGoals} them · {challengeResultMinutesLeft(match)}m left for them to respond
        </div>
      )}
      {resultPending && !iReported && !escalated && (
        <div className="mt-2 space-y-1.5">
          <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.accent }}>
            They reported {theirGoals} – {myGoals} you · {challengeResultMinutesLeft(match)}m left to confirm or dispute
          </div>
          {match.proof_url && (
            <button onClick={() => window.open(match.proof_url, "_blank", "noopener,noreferrer")}
              className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border flex items-center gap-1.5" style={{ borderColor: c.borderStrong }}>
              <Eye size={12} /> View photo proof
            </button>
          )}
        </div>
      )}
      {resultPending && escalated && (
        <div className="font-mono text-[10px] uppercase tracking-wide mt-2 flex items-center gap-1" style={{ color: c.red }}>
          <Clock size={10} /> {iReported ? `You ${myGoals} – ${theirGoals} them` : `They reported ${theirGoals} – ${myGoals} you`} · escalated to admin for review
        </div>
      )}
      <LadderCupWalkoverClaimSection opponentName={opponent.club_name} opponentPhone={opponentPhone} myTeamName={myTeamName} canSeePhones={canSeePhones} claim={walkoverClaim}
        onMessage={() => onMessageWalkover(opponent.club_id)} onMarkFirstContact={onMarkFirstContact}
        onSubmitClaim={onSubmitWalkoverClaim} c={c} />
    </div>
  );
}

// Step 11: the 24h accept/decline prompt a club sees the moment its status
// flips to pending_second_life (right after its first loss, via applyLoss
// in the engine). Either button ends the window immediately — there's
// nothing else to decide once you've picked, so no confirmation step here
// beyond the buttons themselves. If nobody responds, the lazy expiry check
// in App.jsx converts it to eliminated on the next time this league loads,
// same outcome as tapping Decline.
function LadderCupSecondLifeOffer({ entryRow, onAccept, onDecline, c }) {
  const [busy, setBusy] = useState(null); // "accept" | "decline" | null — which button is in flight

  const act = async (accept) => {
    setBusy(accept ? "accept" : "decline");
    await (accept ? onAccept() : onDecline());
    setBusy(null);
  };

  // Signature "revive" moment of the format — the one screen worth being
  // genuinely dramatic about: a pulsing heart HUD element, a red "you're
  // down" glow, and headline-weight copy instead of a routine offer card.
  return (
    <div className="relative overflow-hidden rounded-2xl p-5 border mt-3 text-center" style={{ background: "radial-gradient(circle at 50% 0%, rgba(200,30,58,0.16), transparent 70%)", borderColor: c.red }}>
      <div className="animate-ladder-ember absolute -top-14 -right-8 w-32 h-32 rounded-full blur-3xl pointer-events-none" style={{ background: c.red, opacity: 0.3 }} />
      <div className="relative">
        <Heart size={30} className="mx-auto mb-2 animate-ladder-heartbeat" style={{ color: c.red, fill: c.red }} />
        <div className="font-display font-extrabold text-lg uppercase tracking-wide" style={{ color: c.text }}>Eliminated — unless you revive</div>
        <div className="font-body text-xs mt-2 mb-1" style={{ color: c.textDim }}>
          That loss would normally end your run — but you've still got your one re-entry. Accept to rejoin the ladder at
          &minus;{LADDER_CUP_RULES.SECOND_LIFE_DEDUCTION} points, or decline and you're out for good.
        </div>
        {entryRow.second_life_expires_at && (
          <div className="font-mono text-[10px] uppercase tracking-wide mb-3 flex items-center justify-center gap-1" style={{ color: c.textFaint }}>
            <Clock size={10} /> Decide by {fmtDate(entryRow.second_life_expires_at)} SAST — no response counts as decline
          </div>
        )}
        <div className="flex gap-2 mt-3">
          <button disabled={busy != null} onClick={() => act(true)}
            className="flex-1 font-body text-sm font-bold px-3 py-3 rounded-full flex items-center justify-center gap-1.5"
            style={{ background: c.red, color: "#fff", boxShadow: `0 0 0 1px ${c.red}, 0 0 18px 2px ${c.red}55` }}>
            <Heart size={14} style={{ fill: "#fff" }} /> {busy === "accept" ? "Saving…" : `Revive (−${LADDER_CUP_RULES.SECOND_LIFE_DEDUCTION} pts)`}
          </button>
          <button disabled={busy != null} onClick={() => act(false)}
            className="flex-1 font-body text-xs font-semibold px-3 py-3 rounded-full" style={{ background: c.surfaceHover, color: c.textDim }}>
            {busy === "decline" ? "Saving…" : "Decline"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Step 14: the card a fully eliminated club sees instead of an opponent
// board — "eliminated" no longer means the story's over, it means one
// tap away from a fresh run. The club's finished life stays visible right
// here (and stays on the standings table forever, greyed out — see the
// `eliminated` row styling above) while this offers the way back in.
// rebirth_count > 0 means this isn't the club's first time down, so the
// copy leans into that instead of pretending it's their first rodeo.
function LadderCupFallenCard({ entryRow, clubName, onRejoin, c }) {
  const [busy, setBusy] = useState(false);
  const pastLives = entryRow.past_lives || [];
  const careerPts = pastLives.reduce((s, l) => s + (l.pts || 0), 0) + entryRow.pts;
  const careerW = pastLives.reduce((s, l) => s + (l.w || 0), 0) + entryRow.w;
  const careerL = pastLives.reduce((s, l) => s + (l.l || 0), 0) + entryRow.l;
  const rebirthCount = entryRow.rebirth_count || 0;

  const act = async () => {
    setBusy(true);
    await onRejoin();
    setBusy(false);
  };

  return (
    <div className="relative overflow-hidden rounded-2xl p-5 border mt-3 text-center" style={{ background: "radial-gradient(circle at 50% 0%, rgba(240,160,32,0.16), transparent 70%)", borderColor: "#F0A020" }}>
      <div className="animate-ladder-ember absolute -top-14 -right-8 w-32 h-32 rounded-full blur-3xl pointer-events-none" style={{ background: "#F0A020", opacity: 0.3 }} />
      <div className="relative">
        <Skull size={26} className="mx-auto mb-2" style={{ color: c.textFaint }} />
        <div className="font-display font-extrabold text-lg uppercase tracking-wide" style={{ color: c.text }}>Fallen</div>
        <div className="font-body text-xs mt-2 mb-1" style={{ color: c.textDim }}>
          This run ended at {entryRow.pts} pts ({entryRow.w}W-{entryRow.l}L) — that record is locked in on the table for
          good, {rebirthCount > 0 ? "alongside every life before it." : "forever."}
        </div>
        {(pastLives.length > 0 || rebirthCount > 0) && (
          <div className="font-mono text-[10px] uppercase tracking-wide mb-3" style={{ color: c.textFaint }}>
            Career: {careerPts} pts · {careerW}W-{careerL}L across {rebirthCount + 1} {rebirthCount + 1 === 1 ? "life" : "lives"}
          </div>
        )}
        <div className="font-body text-xs mb-3" style={{ color: c.textDim }}>
          Rejoin now and {clubName} comes back at 0 pts — a clean slate, one more shot at the ladder.
        </div>
        <button disabled={busy} onClick={act}
          className="w-full font-body text-sm font-bold px-3 py-3 rounded-full flex items-center justify-center gap-1.5"
          style={{ background: "#F0A020", color: "#fff", boxShadow: "0 0 0 1px #F0A020, 0 0 18px 2px #F0A02055" }}>
          <Flame size={14} /> {busy ? "Rising from the ashes…" : "Rejoin — Be Reborn"}
        </button>
      </div>
    </div>
  );
}

// The "who can I play" screen (Step 9). No accept/decline step here — a
// tap on Challenge immediately assigns home/away and creates the match row;
// the ladder_rating band (widening in getOpponentPool) is what stands in
// for matchmaking consent. Refreshes automatically off the live `league` prop,
// same as the standings table, so logging any result elsewhere in the app
// widens/narrows this club's slate without a separate re-fetch.
function LadderCupOpponentBoard({ league, myTeam, canSeePhones, onMarkFirstContact, onEnsurePoolSighting, onMarkPoolContact, onInitiateMatch, onCancelMatch, onOpenResult, onRespondResult, onRespondSecondLife, onRejoin, onMessageWalkover, onSubmitWalkoverClaim, c }) {
  const teamsById = useMemo(() => Object.fromEntries((league.teams || []).map((t) => [t.id, t])), [league.teams]);
  // Hooks stay unconditional (called every render, same order) — the
  // eliminated/pending-second-life/no-entry short-circuits below happen
  // after both useMemo calls, not before, so React never sees a different
  // hook count between renders.
  const mapped = useMemo(() => toLadderCupEngineEntries(league), [league]);
  const myEntry = myTeam ? mapped.find((e) => e.club_id === myTeam.id) : null;
  const opponents = useMemo(() => (myEntry ? getOpponentPool(myEntry, mapped) : []), [myEntry, mapped]);

  // 12h pool visibility timer (see ladderCupOpponentTimerState /
  // ladder_cup_pool_sightings) — mySightings is just this club's own rows
  // out of the league's full sightings collection, keyed by opponent so
  // ladderCupOpponentTimerState can look each one up in O(1).
  const mySightings = useMemo(() => new Map(
    (league.ladder_cup_pool_sightings || []).filter((s) => s.team_id === myTeam?.id).map((s) => [s.opponent_team_id, s])
  ), [league.ladder_cup_pool_sightings, myTeam?.id]);

  // Shared tick for the board's one live "Xh Ym left" countdown
  // (formatCountdown) — also what ladderCupOpponentTimerState below walks
  // the pool against, so which opponent is "live" re-evaluates on the same
  // clock the displayed countdown ticks on. 30s is plenty for a
  // minutes-granularity display.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Only one opponent in the pool is ever "live" (has a running 12h
  // clock) at a time — everyone else is either exempted (contacted),
  // already dropped off, or hasn't been reached yet. See
  // ladderCupOpponentTimerState for the full walk.
  const { visible: visibleOpponents, live: liveOpponent } = useMemo(
    () => ladderCupOpponentTimerState(opponents, mySightings, new Date(now)),
    [opponents, mySightings, now]
  );

  // Starts the 12h clock for whichever opponent is currently "live" once
  // it doesn't have a sighting yet — the previous live opponent (now
  // exempted or dropped off) already has one, so this only ever fires for
  // the newly-live opponent, one at a time, never the whole pool at once.
  // onEnsurePoolSighting itself is a safe no-op on the server for a
  // pairing already tracked.
  useEffect(() => {
    if (!myTeam || !onEnsurePoolSighting || !liveOpponent) return;
    if (!mySightings.has(liveOpponent.club_id)) onEnsurePoolSighting(liveOpponent.club_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOpponent, mySightings, myTeam]);

  if (!myEntry) return null; // not a registered club in this league — nothing to challenge with

  const myStatus = myEntry._row.status;
  if (myStatus === "eliminated") {
    return <LadderCupFallenCard entryRow={myEntry._row} clubName={myTeam.name} onRejoin={onRejoin} c={c} />;
  }
  if (myStatus === "pending_second_life") {
    return <LadderCupSecondLifeOffer entryRow={myEntry._row}
      onAccept={() => onRespondSecondLife(true)} onDecline={() => onRespondSecondLife(false)} c={c} />;
  }

  const matches = league.ladder_cup_matches || [];
  const matchWith = (opponentClubId) => matches.find((m) =>
    !m.finalized_at &&
    ((m.home_team_id === myTeam.id && m.away_team_id === opponentClubId) ||
     (m.away_team_id === myTeam.id && m.home_team_id === opponentClubId)));

  // Most relevant open walkover claim against a given opponent: an
  // in-flight one (messaged/pending_review) always wins; otherwise the
  // latest rejected one, so LadderCupWalkoverClaimSection can offer
  // "message them again". Approved claims are skipped here — by the time
  // one's approved the target's status has moved on (eliminated or back
  // in via second life), so it's no longer "the" claim against them; a
  // fresh one is what a new message would create anyway.
  const claims = league.ladder_cup_walkover_claims || [];
  const walkoverClaimWith = (opponentClubId) => {
    const against = claims.filter((cl) => cl.claimant_team_id === myTeam.id && cl.target_team_id === opponentClubId);
    return against.find((cl) => cl.status === "messaged" || cl.status === "pending_review")
      || [...against].filter((cl) => cl.status === "rejected").sort((a, b) => new Date(b.messaged_at) - new Date(a.messaged_at))[0]
      || null;
  };

  // 24h join-contact window (see hasMissedJoinContactWindow /
  // formats/ladderCup.js): shown only while myEntry has never made
  // contact — deadline is null (and this stays hidden) the instant any
  // WhatsApp icon below gets tapped for the first time.
  const contactDeadline = joinContactDeadline(myEntry._row);

  return (
    <div className="mt-3 space-y-1.5">
      {contactDeadline && (
        <div className="rounded-lg px-3 py-2 mb-1.5 flex items-center gap-2" style={{ background: "rgba(200,30,58,0.1)", border: `1px solid ${c.red}` }}>
          <Clock size={13} style={{ color: c.red }} />
          <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.red }}>
            Message an opponent by {fmtDate(contactDeadline)} SAST or {myTeam.name} is auto-removed — no contact within 24h of joining
          </div>
        </div>
      )}
      {opponents.length === 0 ? (
        <div className="font-body text-xs mt-3" style={{ color: c.textFaint }}>No one's in range to challenge yet — check back as more clubs join or results come in.</div>
      ) : visibleOpponents.map((op) => (
        <LadderCupOpponentRow key={op.club_id} opponent={op} myTeamId={myTeam.id} myTeamName={myTeam.name} match={matchWith(op.club_id)}
          walkoverClaim={walkoverClaimWith(op.club_id)}
          canSeePhones={canSeePhones} opponentPhone={teamsById[op.club_id]?.phone}
          onMarkFirstContact={onMarkFirstContact} onMarkPoolContact={() => onMarkPoolContact?.(op.club_id)}
          poolSightingDeadlineAt={op.club_id === liveOpponent?.club_id ? poolSightingDeadline(mySightings.get(op.club_id)) : null} now={now}
          onInitiate={onInitiateMatch} onCancel={onCancelMatch} onOpenResult={onOpenResult} onRespondResult={onRespondResult}
          onMessageWalkover={onMessageWalkover} onSubmitWalkoverClaim={onSubmitWalkoverClaim} c={c} />
      ))}
    </div>
  );
}

// Step 12's admin queue: every league-wide claim sitting at pending_review,
// regardless of which club's slate it came from — a claim can outlive its
// original opponent-row (the claimant's band can move on before an admin
// gets to it), so this reads straight off league.ladder_cup_walkover_claims
// rather than anything derived from a particular viewer's opponent pool.
// Same approve/reject shape as PendingResultsPanel, but claims aren't tied
// to a fixture, so this builds its own rows instead of reusing that panel.
function LadderCupWalkoverReviewPanel({ league, claims, onApprove, onReject, c }) {
  const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
  if (claims.length === 0) return null;
  return (
    <div className="rounded-2xl p-4 border" style={{ background: "rgba(217,164,6,0.08)", borderColor: c.border, boxShadow: "0 6px 18px -8px rgba(0,0,0,0.5)" }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: "#B8860B" }}>
        <Zap size={13} /> {claims.length} walkover claim{claims.length === 1 ? "" : "s"} awaiting review
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {claims.map((cl) => {
          const claimant = teamsById[cl.claimant_team_id];
          const target = teamsById[cl.target_team_id];
          return (
            <div key={cl.id} className="rounded-xl px-4 py-2.5" style={{ background: c.surface, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}>
              <div className="font-body text-sm">{claimant?.name || "Unknown club"} claims a walkover over {target?.name || "Unknown club"}</div>
              <div className="font-mono text-[11px]" style={{ color: c.textFaint }}>Messaged {fmtDate(cl.messaged_at)} SAST · claimable since {fmtDate(cl.claimable_at)} SAST</div>
              <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t" style={{ borderColor: c.border }}>
                <button onClick={() => window.open(cl.proof_url, "_blank", "noopener,noreferrer")} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border flex items-center gap-1.5 transition-transform active:scale-95" style={{ borderColor: c.borderStrong }}>
                  <Eye size={12} /> View screenshot
                </button>
                <button onClick={() => onApprove(cl)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-transform active:scale-95" style={{ background: c.greenSoft, color: c.greenText }}>
                  <ThumbsUp size={12} /> Approve
                </button>
                <button onClick={() => onReject(cl)} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-transform active:scale-95" style={{ background: c.redSoft, color: c.red }}>
                  <ThumbsDown size={12} /> Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Step 10's admin queue: every live (unfinalized) Ladder Cup match whose
// reported result has hit its deadline or its dispute cap —
// ladderCupResultEscalationReason is the single source of truth both this
// panel and LadderCupOpponentRow's "escalated to admin" line key off, so
// they can't disagree about which matches belong here. Same approve/reject
// shape as PendingResultsPanel/LadderCupWalkoverReviewPanel above, but
// built from ladder_cup_matches directly rather than a fixture-linked
// submissions list.
function LadderCupResultReviewPanel({ league, matches, onResolve, onEditScore, c }) {
  const teamsById = Object.fromEntries((league.teams || []).map((t) => [t.id, t]));
  if (matches.length === 0) return null;
  return (
    <div className="rounded-2xl p-4 border" style={{ background: "rgba(217,164,6,0.08)", borderColor: c.border, boxShadow: "0 6px 18px -8px rgba(0,0,0,0.5)" }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: "#B8860B" }}>
        <Camera size={13} /> {matches.length} match result{matches.length === 1 ? "" : "s"} awaiting your review
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {matches.map((m) => (
          <LadderCupEscalatedResultRow key={m.id} match={m} home={teamsById[m.home_team_id]} away={teamsById[m.away_team_id]}
            reportingTeam={teamsById[m.result_reported_by_team_id]}
            onApprove={() => onResolve(m, true)} onReject={() => onResolve(m, false)}
            onEditScore={(homeGoals, awayGoals) => onEditScore(m, homeGoals, awayGoals)} c={c} />
        ))}
      </div>
    </div>
  );
}

// Split out of LadderCupResultReviewPanel above so each row can own its own
// edit-mode state — a hook can't live inside the .map() callback directly.
// Editing is regulation-score only, same restriction the CommentRow score
// box already applies for a CONFIRMED result's correction (see
// editLadderCupMatchResult in App.jsx): extra time/penalties aren't
// editable here since a still-pending match hasn't been played out that
// far yet to have anything on record to correct.
function LadderCupEscalatedResultRow({ match: m, home, away, reportingTeam, onApprove, onReject, onEditScore, c }) {
  const reason = ladderCupResultEscalationReason(m);
  let scoreLine = `${home?.name || "Home"} ${m.home_goals} – ${m.away_goals} ${away?.name || "Away"}`;
  if (m.decided_by === "extra_time") scoreLine += ` (aet ${m.extra_time_home_goals}-${m.extra_time_away_goals})`;
  if (m.decided_by === "penalties") scoreLine += ` (pens ${m.penalties_home}-${m.penalties_away})`;
  // Same "ask the reporting club about it" affordance PendingResultsPanel
  // gives admins for fixture-linked results — here resolved off
  // result_reported_by_team_id since Ladder Cup matches carry no
  // submitted_by user id, only the reporting team.
  const reporterWhatsAppText = reportingTeam
    ? `Hi ${reportingTeam.name}, your Ladder Cup result — ${home?.name || "Home"} ${m.home_goals} – ${m.away_goals} ${away?.name || "Away"} — is with me for approval now. I'll get to it shortly.`
    : null;

  const [editing, setEditing] = useState(false);
  const [editHome, setEditHome] = useState("");
  const [editAway, setEditAway] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const startEdit = () => { setEditHome(String(m.home_goals ?? "")); setEditAway(String(m.away_goals ?? "")); setEditing(true); };
  const saveEdit = async () => {
    const h = parseInt(editHome, 10);
    const a = parseInt(editAway, 10);
    if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return;
    setSavingEdit(true);
    const ok = await onEditScore(h, a);
    setSavingEdit(false);
    if (ok) setEditing(false);
  };

  return (
    <div className="rounded-xl px-4 py-2.5" style={{ background: c.surface, boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}>
      {editing ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-body text-sm truncate" style={{ maxWidth: 110 }}>{home?.name || "Home"}</span>
          <input type="number" min="0" inputMode="numeric" value={editHome} autoFocus
            onChange={(e) => setEditHome(e.target.value)}
            className="w-12 rounded-lg px-1.5 py-1 font-mono text-sm text-center outline-none"
            style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
          <span className="font-body text-xs" style={{ color: c.textFaint }}>–</span>
          <input type="number" min="0" inputMode="numeric" value={editAway}
            onChange={(e) => setEditAway(e.target.value)}
            className="w-12 rounded-lg px-1.5 py-1 font-mono text-sm text-center outline-none"
            style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
          <span className="font-body text-sm truncate" style={{ maxWidth: 110 }}>{away?.name || "Away"}</span>
          <div className="flex items-center gap-2 w-full mt-1">
            <button onClick={saveEdit} disabled={savingEdit || editHome === "" || editAway === ""}
              className="font-body text-xs font-semibold px-3 py-1.5 rounded-full transition-transform active:scale-95"
              style={{ background: c.greenSoft, color: c.greenText, opacity: (savingEdit || editHome === "" || editAway === "") ? 0.5 : 1 }}>
              {savingEdit ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} disabled={savingEdit}
              className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border transition-transform active:scale-95" style={{ borderColor: c.borderStrong }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-body text-sm truncate">{scoreLine}</div>
            {reportingTeam?.phone && (
              <WhatsAppLink phone={reportingTeam.phone} text={reporterWhatsAppText} iconOnly
                title={`Message ${reportingTeam.name} about this result`} c={c} />
            )}
          </div>
          <div className="font-mono text-[11px]" style={{ color: c.textFaint }}>
            Reported by {(m.result_reported_by_team_id === m.home_team_id ? home : away)?.name || "a club"} · {timeAgo(m.result_reported_at)}
          </div>
          <div className="font-mono text-[11px] mt-0.5" style={{ color: c.red }}>
            {reason === "dispute-cap" ? "Disputed too many times already — sent straight to the admin" : "Confirmation window passed — sent to the admin"}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t" style={{ borderColor: c.border }}>
            <button onClick={() => window.open(m.proof_url, "_blank", "noopener,noreferrer")} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border flex items-center gap-1.5 transition-transform active:scale-95" style={{ borderColor: c.borderStrong }}>
              <Eye size={12} /> View photo proof
            </button>
            <button onClick={startEdit} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full border flex items-center gap-1.5 transition-transform active:scale-95" style={{ borderColor: c.borderStrong }}>
              <Pencil size={12} /> Edit score
            </button>
            <button onClick={onApprove} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-transform active:scale-95" style={{ background: c.greenSoft, color: c.greenText }}>
              <ThumbsUp size={12} /> Approve
            </button>
            <button onClick={onReject} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-transform active:scale-95" style={{ background: c.redSoft, color: c.red }}>
              <ThumbsDown size={12} /> Reject
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// The read-only, search-by-name counterpart to LadderCupOpponentBoard —
// anyone viewing the league (not just the logged-in club) can look up a
// specific club and see its live ladder status plus who's currently in its
// challenge band. Mirrors OpponentFinder's "type a name, hit Find" pattern
// used on the fixtures-based formats, but there's no matchday concept here
// (Ladder Cup has no fixtures — see LadderCupPendingPanel below), so it
// searches straight off the live standings/entries instead. Never shows
// action buttons (Challenge/Log result/etc.) — those stay exclusive to
// LadderCupOpponentBoard, which only acts on the viewer's own club.
function LadderCupFindOpponent({ league, c }) {
  const [teamQuery, setTeamQuery] = useState("");
  const [result, setResult] = useState(null);
  const mapped = useMemo(() => toLadderCupEngineEntries(league), [league]);

  const search = () => {
    const team = league.teams.find((t) => t.name.trim().toLowerCase() === teamQuery.trim().toLowerCase());
    if (!team) { setResult({ notFound: true, reason: "No club with that exact name — pick one from the suggestions." }); return; }
    const entry = mapped.find((e) => e.club_id === team.id);
    if (!entry) { setResult({ notFound: true, reason: `${team.name} hasn't been placed on the ladder yet.` }); return; }
    const pool = entry.status === "active" ? getOpponentPool(entry, mapped) : [];
    setResult({ team, entry, pool });
  };

  return (
    <div className="rounded-2xl p-4 border" style={{ background: c.surface, borderColor: c.border, boxShadow: "0 6px 18px -8px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)" }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Find your opponent</div>
      {/* Always stacked (no sm:flex-row) — this now lives in a fixed-width
          compact widget card, not a full-width column, so a side-by-side
          input+button row would cramp or overflow it regardless of
          viewport size. */}
      <div className="flex flex-col gap-2">
        <input list="team-names-datalist" value={teamQuery} onChange={(e) => setTeamQuery(e.target.value)} placeholder="Club name"
          className="w-full border rounded-xl px-3 py-2.5 font-body text-sm outline-none" style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        <datalist id="team-names-datalist">{league.teams.map((t) => <option key={t.id} value={t.name} />)}</datalist>
        <button onClick={search} className="w-full font-body text-sm font-semibold px-4 py-2.5 rounded-xl shrink-0 transition-transform active:scale-95" style={{ background: c.accent, color: c.accentText }}>Find</button>
      </div>

      {result && (result.notFound ? (
        <div className="font-body text-xs mt-3" style={{ color: c.textFaint }}>{result.reason}</div>
      ) : (
        <div className="mt-3">
          <div className="font-body text-sm font-semibold flex items-center gap-2">
            {result.team.name}
            <span className="font-mono text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ background: c.surfaceHover, color: c.textFaint }}>
              {LADDER_CUP_STATUS_LABEL[result.entry.status] || result.entry.status}
            </span>
          </div>
          <div className="font-mono text-xs mt-0.5" style={{ color: c.textFaint }}>{result.entry.ladder_rating} rating</div>

          {result.entry.status !== "active" ? (
            <div className="font-body text-xs mt-2" style={{ color: c.textFaint }}>
              {result.entry.status === "eliminated" && "Eliminated — no longer challenging."}
              {result.entry.status === "pending_second_life" && "Decided their second life offer — status updates once they respond."}
              {result.entry.status === "champion" && "Crowned champion of this cup."}
            </div>
          ) : result.pool.length === 0 ? (
            <div className="font-body text-xs mt-2" style={{ color: c.textFaint }}>No one's in range to challenge yet.</div>
          ) : (
            <div className="mt-2 space-y-1 max-h-48 overflow-y-auto pr-1">
              {result.pool.map((op) => (
                <div key={op.club_id} className="flex items-center justify-between rounded-lg px-3 py-1.5" style={{ background: c.surfaceHover }}>
                  <span className="font-body text-xs">{op.club_name}</span>
                  <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{op.ladder_rating} rating</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// Ladder Cup has no "Start league & generate fixtures" step — a club is
// live on the ladder the instant it registers (see ensureLadderCupEntry in
// App.jsx) — so this intentionally doesn't try to reuse the fixtures-based
// registration screen; it just tracks who's registered and, for cash
// leagues, payment review, same as every other format already does.
const LADDER_CUP_WIDGET_TITLE = {
  opponent: "Find your opponent",
  walkover: "Walkover claims awaiting review",
  escalated: "Escalated results awaiting review",
  results: "Results",
  discussion: "Discussion",
};

// A single quick-action tile in the row above the standings table — an
// icon in a colored circle, a label, and a subtitle line (a count, a
// status, or a preview). `tone` gives each widget its own look (Find
// opponent reads gold/neutral, the two admin queues read urgent
// gold-brown/red, Results reads green, Discussion reads a cooler neutral)
// so the row scans as five distinct entry points rather than five copies
// of the same pill. The actual panel content only mounts once its tile is
// tapped (see openWidget in LadderCupPendingPanel), so this row stays
// cheap even with a big Discussion thread sitting behind one of them.
const LADDER_CUP_WIDGET_TONE = {
  accent: { bg: "rgba(232,185,35,0.08)", border: "rgba(232,185,35,0.35)", circle: "rgba(232,185,35,0.18)", fg: "#E8B923" },
  amber: { bg: "rgba(217,164,6,0.12)", border: "#B8860B55", circle: "rgba(217,164,6,0.22)", fg: "#B8860B" },
  red: { bg: "rgba(200,30,58,0.10)", border: "rgba(200,30,58,0.4)", circle: "rgba(200,30,58,0.2)", fg: "#E0546E" },
  green: { bg: "rgba(45,106,79,0.14)", border: "rgba(45,106,79,0.5)", circle: "rgba(45,106,79,0.28)", fg: "#7FC9A2" },
  neutral: { bg: "rgba(245,238,220,0.05)", border: "rgba(245,238,220,0.18)", circle: "rgba(245,238,220,0.1)", fg: "#F5EEDC" },
};

function LadderCupWidgetTrigger({ icon: Icon, label, subtitle, count, tone = "neutral", active, onClick, c }) {
  const t = LADDER_CUP_WIDGET_TONE[tone];
  return (
    <button onClick={onClick}
      className="relative shrink-0 w-36 h-[104px] flex flex-col justify-between text-left rounded-2xl border p-3 transition-transform active:scale-95"
      style={{
        background: t.bg,
        borderColor: active ? t.fg : t.border,
        borderWidth: active ? 2 : 1,
        boxShadow: active ? `0 0 0 3px ${t.circle}` : "0 6px 16px -10px rgba(0,0,0,0.6)",
      }}>
      <div className="flex items-start justify-between">
        <span className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: t.circle, color: t.fg }}>
          <Icon size={16} />
        </span>
        {count > 0 && (
          <span className="font-mono text-xs font-bold min-w-[22px] h-[22px] px-1 flex items-center justify-center rounded-full" style={{ background: t.fg, color: c.bg }}>
            {count}
          </span>
        )}
      </div>
      <div>
        <div className="font-body text-sm font-bold leading-tight" style={{ color: c.text }}>{label}</div>
        {subtitle && <div className="font-mono text-[10px] uppercase tracking-wide mt-0.5 truncate" style={{ color: t.fg }}>{subtitle}</div>}
      </div>
    </button>
  );
}

// The pop-out itself — a bottom-sheet on mobile / centered dialog on
// desktop, same chrome as ShareRangeModal and PlayerProfileModal
// (App.jsx) so this reads as the app's one modal pattern rather than a
// bespoke popover. Renders on top of the standings table via fixed +
// z-50, backdrop click or the X closes it.
function LadderCupWidgetOverlay({ title, onClose, c, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.7)" }} onClick={onClose}>
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[85vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center justify-between px-5 pt-5 pb-3" style={{ background: c.bg }}>
          <h3 className="font-body text-sm font-bold uppercase tracking-wide" style={{ color: c.text }}>{title}</h3>
          <button aria-label="Close" onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surface, color: c.textDim }}><X size={14} /></button>
        </div>
        <div className="px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

function LadderCupPendingPanel({ league, leagues, allAchievements, canManage, canSeePhones, session, myTeam, myUsername, avatarByTeamId, resultComments, regularComments, onLeave, onRemoveTeam, onDownloadProof, onReviewPayment, onMarkWaReminder, onClearWaReminder, onClearAllWaReminders, onUpdateMemberMessage, onNotifyAllMembers, onUpdateCreatorPhone, onUpdateTeamPhone, onPostComment, onDeleteComment, onEditComment, onEditResult, onEditLadderCupResult, onToggleReaction, onMarkFirstContact, onEnsurePoolSighting, onMarkPoolContact, onInitiateMatch, onCancelMatch, onOpenResult, onRespondResult, onAdminResolveResult, onAdminEditResult, onRespondSecondLife, onRejoin, onMessageWalkover, onSubmitWalkoverClaim, onApproveWalkoverClaim, onRejectWalkoverClaim, onStartLadderCup, c: _appTheme }) {
  const [tab, setTab] = useState("table");
  // Which of the five small quick-action widgets (if any) is currently
  // popped open over the standings table — see the trigger row + overlay
  // rendered inside the "table" tab below. Only one at a time, closed by
  // default so the table is the first thing you see.
  const [openWidget, setOpenWidget] = useState(null);
  // The Ladder Cup gets its own permanent black/gold arena look, same as
  // the standalone Ladder does (Ladder.jsx: `const c = LADDER_THEME`) —
  // ignore the app's normal light/dark theme prop and thread LADDER_THEME
  // through everything below instead, so the whole "game page" reads as
  // its own mode rather than a re-skinned settings screen.
  const c = LADDER_THEME;
  const myEntryRow = myTeam ? (league.ladder_cup_entries || []).find((r) => r.team_id === myTeam.id) : null;
  const myRank = myTeam ? rankLadderCupStandings(toLadderCupEngineEntries(league)).find((r) => r.club_id === myTeam.id)?.rank_position : null;
  const totalClubs = league.teams.length;
  // Lives: 1 to start, back to 1 on an accepted second life, 0 once
  // eliminated — a simple HUD read of "how many chances are left", not a
  // new rules concept (Ladder Cup is still one-elimination-with-one-
  // second-life underneath).
  const myLives = !myEntryRow ? null : myEntryRow.status === "eliminated" ? 0 : myEntryRow.badge_second_life ? 1 : 1;
  const pendingWalkoverClaims = (league.ladder_cup_walkover_claims || []).filter((cl) => cl.status === "pending_review");
  // Same idea as pendingWalkoverClaims just above, for Step 10's admin
  // queue: every live match whose reported result has hit its deadline or
  // dispute cap (see ladderCupResultEscalationReason). finalized_at is
  // already excluded implicitly — an escalated reason only ever fires on
  // result_status === "pending", and a finalized match's result_status is
  // "confirmed".
  const escalatedResultMatches = (league.ladder_cup_matches || []).filter((m) => ladderCupResultEscalationReason(m));
  // Clubs are already live on the ladder the moment they join (no fixtures
  // to generate here, unlike the other formats) — Start League is a status
  // marker only. It does NOT close registration: clubs keep joining right
  // up to the cutoff/finalize either way. See startLadderCupLeague in
  // App.jsx.
  const started = !!league.ladder_cup_started_at;
  return (
    <div>
      {/* Arena HUD header — same "always dark, gold-accented" surface as
          Ladder Battles on Home, dressed up with an ambient ember glow, a
          one-shot sweep on mount, and (once you've got a club in it) a
          rank chip + life-orb strip so this reads as a ranked-mode HUD
          rather than a plain info card. rounded-2xl + a real drop shadow
          (plus a faint inset top highlight) instead of a flat bordered box
          — gives it the lifted, "floating card" depth a native app screen
          has instead of a website panel. */}
      <div className="relative overflow-hidden rounded-2xl p-5 border mb-5" style={{ background: c.surface, borderColor: c.borderStrong, boxShadow: "0 12px 32px -12px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)" }}>
        <div className="animate-ladder-ember absolute -top-16 -right-10 w-40 h-40 rounded-full blur-3xl pointer-events-none" style={{ background: c.accent, opacity: 0.35 }} />
        <div className="absolute inset-0 pointer-events-none animate-ladder-sweep"
          style={{ backgroundImage: `linear-gradient(135deg, transparent 40%, ${c.accent}26 50%, transparent 60%)`, backgroundSize: "250% 250%" }} />
        <div className="relative">
          <div className="flex items-center justify-between gap-3 mb-1">
            <div className="flex items-center gap-2">
              <Shield size={16} style={{ color: c.accent }} />
              <div className="font-display font-bold text-lg uppercase tracking-wide" style={{ color: c.text }}>Survival Ladder Cup</div>
            </div>
            {myRank && (
              <div className="shrink-0 flex items-center gap-1 font-mono text-xs font-bold px-2.5 py-1 rounded-full border" style={{ borderColor: c.borderStrong, color: c.accent, background: c.bg, boxShadow: "0 2px 6px -2px rgba(0,0,0,0.5)" }}>
                RANK #{myRank}<span style={{ color: c.textFaint }}>/{totalClubs}</span>
              </div>
            )}
          </div>
          <div className="font-body text-sm mb-1" style={{ color: c.textDim }}>
            {league.teams.length} club{league.teams.length === 1 ? "" : "s"} registered · {started ? "league started — clubs can still join anytime before the cutoff." : "live on the ladder as soon as they join."}
          </div>
          {league.ladder_cup_cutoff_at && (
            <div className="font-mono text-xs" style={{ color: c.textFaint }}>Cutoff: {fmtDate(league.ladder_cup_cutoff_at)} SAST</div>
          )}
          {/* Life-orb strip — a single filled heart while you've still got
              your run (or your second life still in the bank), an empty
              outline once eliminated. Not a countdown of multiple lives
              (the format only ever grants the one second life), just a HUD-
              style "are you still in this" read at a glance. */}
          {myLives != null && (
            <div className="flex items-center gap-1.5 mt-2">
              <Heart size={15} className={myLives > 0 ? "animate-ladder-heartbeat" : ""}
                style={{ color: myLives > 0 ? c.red : c.textFaint, fill: myLives > 0 ? c.red : "transparent" }} />
              <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: myLives > 0 ? c.textDim : c.textFaint }}>
                {myLives > 0 ? "Still in the fight" : "Eliminated"}
              </span>
            </div>
          )}
          {canManage && !started && !league.ladder_cup_finalized_at && (
            <button disabled={league.teams.length < 2} onClick={() => onStartLadderCup(league)}
              className="mt-3 font-body text-sm font-semibold px-4 py-2.5 rounded-full transition-transform active:scale-95"
              style={league.teams.length >= 2 ? { background: c.accent, color: c.accentText, boxShadow: "0 4px 12px -4px rgba(232,185,35,0.5)" } : { background: c.surfaceHover, color: c.textFaint }}>
              Start League
            </button>
          )}
          {league.ladder_cup_finalized_at ? (
            <LadderCupFinalizedBanner league={league} c={c} />
          ) : myTeam ? (
            <LadderCupOpponentBoard league={league} myTeam={myTeam} canSeePhones={canSeePhones} onMarkFirstContact={onMarkFirstContact} onEnsurePoolSighting={onEnsurePoolSighting} onMarkPoolContact={onMarkPoolContact} onInitiateMatch={onInitiateMatch} onCancelMatch={onCancelMatch} onOpenResult={onOpenResult} onRespondResult={onRespondResult} onRespondSecondLife={onRespondSecondLife} onRejoin={onRejoin}
              onMessageWalkover={onMessageWalkover} onSubmitWalkoverClaim={onSubmitWalkoverClaim} c={c} />
          ) : (
            <div className="font-body text-xs mt-3" style={{ color: c.textFaint }}>Join with a club to see who you can challenge.</div>
          )}
        </div>
      </div>

      {/* Segmented tab control — sticky under the header (like a native
          app's top tab bar), with a sliding pill that transforms between
          positions instead of just recoloring the active label. grid-
          cols-2 gives both tabs equal width so the sliding math is a flat
          50% translate, no measuring needed. */}
      <div className="sticky top-0 z-20 py-2 mb-5" style={{ background: `${c.bg}f2`, backdropFilter: "blur(6px)" }}>
        <div className="relative grid grid-cols-2 rounded-full p-1" style={{ background: c.surface, boxShadow: "0 4px 14px -6px rgba(0,0,0,0.6)" }}>
          <div className="absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] rounded-full transition-transform duration-300 ease-out"
            style={{ background: c.text, transform: tab === "members" ? "translateX(100%)" : "translateX(0%)" }} />
          {[{ id: "table", label: "Table", icon: Trophy }, { id: "members", label: "Members", icon: Users }].map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className="relative z-10 flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-full font-body text-xs font-semibold uppercase tracking-wide transition-colors"
              style={{ color: tab === t.id ? c.bg : c.textDim }}>
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "table" ? (
        <div>
          {/* Everything else on this tab (find opponent, admin review
              queues, results feed, discussion) is a row of bigger tile-
              style quick-action widgets — icon-in-circle, label, and a
              subtitle line, each with its own color "tone" (see
              LADDER_CUP_WIDGET_TONE) so the row scans as five distinct
              entry points, not five copies of one pill. Tapping a tile
              doesn't push the table down; it pops the widget's full
              content open in an overlay on top of the table, same
              bottom-sheet-on-mobile/centered-on-desktop chrome
              ShareRangeModal/PlayerProfileModal already use elsewhere in
              this app, so it reads as "the same kind of popup" rather
              than a one-off. Closing (X, backdrop click, or re-tapping
              the same tile) just clears openWidget. */}
          <div className="no-scrollbar flex items-stretch gap-3 overflow-x-auto -mx-4 px-4 pb-2 mb-6">
            {!league.ladder_cup_finalized_at && (
              <LadderCupWidgetTrigger icon={Search} label="Find opponent" subtitle="Search clubs" tone="accent"
                active={openWidget === "opponent"} onClick={() => setOpenWidget((w) => (w === "opponent" ? null : "opponent"))} c={c} />
            )}

            {canManage && !league.ladder_cup_finalized_at && pendingWalkoverClaims.length > 0 && (
              <LadderCupWidgetTrigger icon={Zap} label="Walkovers" subtitle="Awaiting review" count={pendingWalkoverClaims.length} tone="amber"
                active={openWidget === "walkover"} onClick={() => setOpenWidget((w) => (w === "walkover" ? null : "walkover"))} c={c} />
            )}

            {canManage && !league.ladder_cup_finalized_at && escalatedResultMatches.length > 0 && (
              <LadderCupWidgetTrigger icon={Camera} label="Escalated" subtitle="Awaiting review" count={escalatedResultMatches.length} tone="red"
                active={openWidget === "escalated"} onClick={() => setOpenWidget((w) => (w === "escalated" ? null : "escalated"))} c={c} />
            )}

            <LadderCupWidgetTrigger icon={Trophy} label="Results" subtitle={resultComments.length > 0 ? `${resultComments.length} posted` : "None yet"} tone="green"
              active={openWidget === "results"} onClick={() => setOpenWidget((w) => (w === "results" ? null : "results"))} c={c} />

            <LadderCupWidgetTrigger icon={MessageCircle} label="Discussion" subtitle={regularComments.length > 0 ? `${regularComments.length} messages` : "Say something"} tone="neutral"
              active={openWidget === "discussion"} onClick={() => setOpenWidget((w) => (w === "discussion" ? null : "discussion"))} c={c} />
          </div>

          {openWidget && (
            <LadderCupWidgetOverlay title={LADDER_CUP_WIDGET_TITLE[openWidget]} onClose={() => setOpenWidget(null)} c={c}>
              {openWidget === "opponent" && <LadderCupFindOpponent league={league} c={c} />}
              {openWidget === "walkover" && (
                <LadderCupWalkoverReviewPanel league={league} claims={pendingWalkoverClaims} onApprove={onApproveWalkoverClaim} onReject={onRejectWalkoverClaim} c={c} />
              )}
              {openWidget === "escalated" && (
                <LadderCupResultReviewPanel league={league} matches={escalatedResultMatches} onResolve={onAdminResolveResult} onEditScore={onAdminEditResult} c={c} />
              )}
              {openWidget === "results" && (
                <CommentsSection league={league} session={session} canComment={!!myTeam || canManage}
                  comments={resultComments} heading="Results" icon={Trophy} allowCompose={false} showFindMyResults
                  emptyText="No results posted yet — they'll show up here as walkovers and matches are logged."
                  canEditResults={canManage}
                  onPost={onPostComment} onDelete={onDeleteComment} onEdit={onEditComment} onEditResult={onEditResult} onEditLadderCupResult={onEditLadderCupResult} onToggleReaction={onToggleReaction} myUsername={myUsername} c={c} />
              )}
              {openWidget === "discussion" && (
                <CommentsSection league={league} session={session} canComment={!!myTeam || canManage}
                  comments={regularComments} heading="Discussion" allowCompose
                  onPost={onPostComment} onDelete={onDeleteComment} onToggleReaction={onToggleReaction} myUsername={myUsername} c={c} />
              )}
            </LadderCupWidgetOverlay>
          )}

          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.accent }}>
            <Trophy size={13} /> The Ladder
          </div>
          <div className="mb-5">
            <LadderCupStandingsTable league={league} leagues={leagues} allAchievements={allAchievements} avatarByTeamId={avatarByTeamId} myTeamId={myTeam?.id} c={c} />
          </div>
        </div>
      ) : (
        <div>
          {canManage && <MemberMessageEditor league={league} onUpdateMemberMessage={onUpdateMemberMessage} onNotifyAllMembers={onNotifyAllMembers} c={c} />}
          {canManage && <OrganizerContactEditor league={league} onUpdateCreatorPhone={onUpdateCreatorPhone} c={c} />}
          {canManage && league.members.some((m) => isWaReminderActive(m)) && (
            <div className="flex justify-end mb-2">
              <button onClick={() => onClearAllWaReminders(league)} className="font-mono text-[11px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.red }}>
                <X size={11} /> Clear all highlights
              </button>
            </div>
          )}
          {league.league_type === "cash" && canManage && league.members.some((m) => m.payment_status === "pending") && (
            <div className="rounded-lg p-3 mb-3 font-body text-xs flex items-center gap-2" style={{ background: "rgba(217,164,6,0.12)", color: "#B8860B" }}>
              <ReceiptText size={14} /> Download each member's proof of payment, then approve or reject to confirm their registration.
            </div>
          )}
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Registered clubs</div>
          {league.teams.length === 0 ? (
            <div className="border border-dashed rounded-2xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's registered yet — share the league so players can join.</div>
          ) : (() => {
            const rows = [...league.teams]
              .map((t) => ({ t, m: league.members.find((mm) => mm.team_id === t.id) }))
              .sort((a, b) => (a.m?.payment_status === "pending" ? -1 : 0) - (b.m?.payment_status === "pending" ? -1 : 0));
            const row = ({ t, m }) => (
              m ? (
                <MemberPaymentRow key={t.id} m={m} t={t} league={league} isCash={league.league_type === "cash"} canManage={canManage} allowRemove
                  isOwnRow={session && m.user_id === session.user.id} onLeave={() => onLeave(league)}
                  onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment} onMarkWaReminder={onMarkWaReminder} onClearWaReminder={onClearWaReminder} c={c} />
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
            );
            // Same custom/automated WA message split the normal leagues'
            // Members tab uses — only worth splitting once a template
            // actually exists on the league (see usesCustomMessage).
            if (!league.wa_message_template) {
              return <div className="space-y-1.5 mb-5">{rows.map(row)}</div>;
            }
            const custom = rows.filter((r) => usesCustomMessage(r.t, league));
            const automated = rows.filter((r) => !usesCustomMessage(r.t, league));
            return (
              <div className="space-y-5 mb-5">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Custom message ({custom.length})</div>
                  {custom.length === 0 ? (
                    <div className="font-body text-xs px-1" style={{ color: c.textFaint }}>No members will get the custom message right now.</div>
                  ) : (
                    <div className="space-y-1.5">{custom.map(row)}</div>
                  )}
                </div>
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Automated message ({automated.length})</div>
                  {automated.length === 0 ? (
                    <div className="font-body text-xs px-1" style={{ color: c.textFaint }}>No members are on the automated message right now.</div>
                  ) : (
                    <div className="space-y-1.5">{automated.map(row)}</div>
                  )}
                </div>
              </div>
            );
          })()}

          {canSeePhones && <TeamContactsPanel teams={league.teams} canManage={canManage} onUpdateTeamPhone={onUpdateTeamPhone} c={c} />}
          {myTeam && !canSeePhones && (
            <div className="rounded-2xl p-4 border font-body text-xs" style={{ borderColor: c.borderStrong, color: c.textFaint }}>
              Player contacts are hidden because your club has been eliminated from this league.
            </div>
          )}

          {league.league_type === "cash" && league.members.some((m) => m.payment_status === "approved") && (
            <PrizeBreakdownPanel league={league} c={c} />
          )}
        </div>
      )}
    </div>
  );
}

export default function LeagueDetail({ league, leagues, allAchievements, session, isAdmin, joined, canSeePhones, myTeam, entryClosed, myPaymentStatus, blockedByLeague, qualified, myUsername, onBack, onJoin, onResubmitPayment, onDownloadProof, onReviewPayment, onMarkWaReminder, onClearWaReminder, onClearAllWaReminders, onUpdateMemberMessage, onNotifyAllMembers, onRecordResult, onUpdateTeamPhone, onRemoveTeam, onUpdatePhoto, onUpdateDescription, onUpdateCreatorPhone, onUpdateSchedule, onUpdateRoundPeriod, onUpdateGroupStageDueAt, onStartLadderCup, onAdvance, onGenerateFixtures, onDelete, onShare, onLeave, onOpenSubmitResult, onDownloadResultProof, onApproveResult, onRejectResult, onRespondToResultSubmission, onPostComment, onDeleteComment, onEditComment, onEditResult, onEditLadderCupResult, onToggleReaction, onToggleLeagueReaction, onMarkLadderCupFirstContact, onEnsureLadderCupPoolSighting, onMarkLadderCupPoolContact, onInitiateLadderCupMatch, onCancelLadderCupMatch, onOpenLadderCupResult, onRespondLadderCupMatchResult, onAdminResolveLadderCupMatchResult, onAdminEditLadderCupMatchResult, onRespondLadderCupSecondLife, onRejoinLadderCup, onMessageLadderCupWalkoverOpponent, onSubmitLadderCupWalkoverClaim, onApproveLadderCupWalkoverClaim, onRejectLadderCupWalkoverClaim, avatarByTeamId, c }) {
  const [tab, setTab] = useState("table");
  const [descOpen, setDescOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
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
  // The opponent has 30 minutes to confirm or dispute a submission themselves
  // (see resultConfirmDeadline) — unless this fixture has already burned
  // through its dispute allowance (see resultEscalationReason), in which case
  // it skips straight to the admin queue. Only once one of those two
  // conditions is true does a submission escalate into the admin's override
  // queue — before that, it's still the opponent's to act on, so admins see
  // it as a heads-up only.
  const escalatedResults = pendingResults.filter((s) => resultEscalationReason(league, s));
  const awaitingOpponentResults = pendingResults.filter((s) => !resultEscalationReason(league, s));
  const isKnockout = league.format === "knockout";
  const isSurvivor = league.format === "survivor";
  const isGroupsKnockout = league.format === "groups_knockout";
  // Ladder Cup never uses `fixtures` at all (challenge-based, not
  // fixture-generated — see LadderCupPendingPanel below), so it gets routed
  // out of the notStarted/started fixtures ternary entirely rather than
  // falling into either branch and rendering something meaningless.
  const isLadderCup = league.format === "ladder_cup";
  const inGroupStage = isGroupsKnockout && !league.final_stage_started;
  const inKnockoutBracket = isKnockout || (isGroupsKnockout && league.final_stage_started);

  const stageFixtures = (isSurvivor || isGroupsKnockout) ? league.fixtures.filter((f) => f.stage === league.current_stage) : league.fixtures;
  const displayTeams = isSurvivor ? league.teams.filter((t) => !t.eliminated) : league.teams;
  const standings = useMemo(() => computeStandings(displayTeams, stageFixtures, league), [displayTeams, stageFixtures, league]);
  const totalRounds = Math.max(...stageFixtures.map((f) => f.round), 0);
  const groupStageFixtures = isGroupsKnockout ? league.fixtures.filter((f) => f.stage === 1) : [];
  const groupStageDone = groupStageFixtures.length > 0 && groupStageFixtures.every((f) => f.played || isFixtureLocked(f, league));

  const n = standings.length;
  const zoneFor = (idx) => {
    if (idx === 0 && n > 4) return c.accent;
    if (idx < Math.ceil(n / 3) && n > 6) return c.green;
    if (idx >= n - Math.max(1, Math.floor(n / 4)) && n > 6) return c.red;
    return "transparent";
  };

  const currentRoundFixtures = league.fixtures.filter((f) => f.round === totalRounds && (!(isSurvivor || isGroupsKnockout) || f.stage === league.current_stage));
  const currentRoundDone = currentRoundFixtures.length > 0 && currentRoundFixtures.every((f) => f.played || isExpired(f));
  const stageDone = stageFixtures.length > 0 && stageFixtures.every((f) => f.played || isExpired(f));

  const activeTeamsCount = league.teams.filter((t) => !t.eliminated).length;
  // Recomputed straight from the fixtures (same helper isLeagueCompleted in
  // App.jsx uses) rather than off team.eliminated — that flag can go stale
  // on a finished bracket's runner-up whenever a tie resolves purely by one
  // leg expiring unplayed (see knockoutBracketWinners' comment), which used
  // to leave this page stuck showing "Advance round" — and the dead-end
  // "This league already has a champion" toast when clicked — even once the
  // bracket was actually decided.
  const knockoutBracketStage = isGroupsKnockout ? 2 : 1;
  const knockoutWinnerIds = inKnockoutBracket ? knockoutBracketWinners(league.fixtures, knockoutBracketStage) : null;
  const knockoutChampion = knockoutWinnerIds && knockoutWinnerIds.length === 1 ? league.teams.find((t) => t.id === knockoutWinnerIds[0]) : null;
  const survivorComplete = isSurvivor && league.final_stage_started && stageDone;
  const survivorChampion = survivorComplete ? standings[0] : null;

  const formatLabel = FORMATS.find((f) => f.id === league.format)?.label;
  const notStarted = league.fixtures.length === 0;
  const expiredCount = league.fixtures.filter((f) => isFixtureLocked(f, league)).length;

  return (
    <div className="pt-8">
      <div className="flex items-center justify-between mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm" style={{ color: c.textDim }}><ArrowLeft size={15} /> All leagues</button>
        <div className="flex items-center gap-2">
          <RulesButton label="League Rules" onClick={() => setRulesOpen(true)} c={c} />
          {canManage && (
            <LeagueMenu league={league} onShare={onShare} onDelete={onDelete} c={c} />
          )}
          {!canManage && joined && (
            <button onClick={() => onLeave(league)} title="Leave league" className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.red }}><LogOut size={14} /></button>
          )}
        </div>
      </div>

      {rulesOpen && <Suspense fallback={null}><RulesModal type="league" onClose={() => setRulesOpen(false)} c={c} /></Suspense>}

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
          <LeagueScheduleLine league={league} canManage={canManage} onUpdateSchedule={onUpdateSchedule} onUpdateRoundPeriod={onUpdateRoundPeriod} c={c} />
          {isGroupsKnockout && notStarted && (
            <GroupStageDueLine league={league} canManage={canManage} onUpdateGroupStageDueAt={onUpdateGroupStageDueAt} c={c} />
          )}
        </div>
        {!joined && !entryClosed && !blockedByLeague && qualified && <button onClick={onJoin} className="shrink-0 flex items-center gap-1.5 font-body font-semibold text-sm px-4 py-2 rounded-full" style={{ background: c.accent, color: c.accentText }}><Users size={14} /> Join</button>}
        {!joined && !entryClosed && blockedByLeague && (
          <span title={`Active in "${blockedByLeague.name}" — finish or get eliminated there first`}
            className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1.5 rounded" style={{ background: c.surfaceHover, color: c.textFaint }}>
            Locked · active in "{blockedByLeague.name}"
          </span>
        )}
        {!joined && !entryClosed && !blockedByLeague && !qualified && (
          <span title="Requires a top-20% finish in a completed Survival Ladder Cup"
            className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1.5 rounded" style={{ background: c.surfaceHover, color: c.textFaint }}>
            Locked · needs a top-20% Ladder Cup finish
          </span>
        )}
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

      {!isLadderCup && <LeagueStatusBanner league={league} notStarted={notStarted} myTeam={myTeam} c={c} />}

      {isLadderCup ? (
        <LadderCupPendingPanel league={league} leagues={leagues} allAchievements={allAchievements} canManage={canManage} canSeePhones={canSeePhones} session={session} myTeam={myTeam} myUsername={myUsername} avatarByTeamId={avatarByTeamId}
          resultComments={resultComments} regularComments={regularComments}
          onLeave={onLeave}
          onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment}
          onMarkWaReminder={onMarkWaReminder} onClearWaReminder={onClearWaReminder} onClearAllWaReminders={onClearAllWaReminders}
          onUpdateMemberMessage={onUpdateMemberMessage} onNotifyAllMembers={onNotifyAllMembers} onUpdateCreatorPhone={onUpdateCreatorPhone} onUpdateTeamPhone={onUpdateTeamPhone}
          onPostComment={onPostComment} onDeleteComment={onDeleteComment} onEditComment={onEditComment} onEditResult={onEditResult} onEditLadderCupResult={onEditLadderCupResult} onToggleReaction={onToggleReaction}
          onMarkFirstContact={onMarkLadderCupFirstContact} onEnsurePoolSighting={onEnsureLadderCupPoolSighting} onMarkPoolContact={onMarkLadderCupPoolContact}
          onInitiateMatch={onInitiateLadderCupMatch} onCancelMatch={onCancelLadderCupMatch} onOpenResult={onOpenLadderCupResult} onRespondResult={onRespondLadderCupMatchResult} onAdminResolveResult={onAdminResolveLadderCupMatchResult} onAdminEditResult={onAdminEditLadderCupMatchResult} onRespondSecondLife={onRespondLadderCupSecondLife} onRejoin={onRejoinLadderCup}
          onMessageWalkover={onMessageLadderCupWalkoverOpponent} onSubmitWalkoverClaim={onSubmitLadderCupWalkoverClaim}
          onApproveWalkoverClaim={onApproveLadderCupWalkoverClaim} onRejectWalkoverClaim={onRejectLadderCupWalkoverClaim} onStartLadderCup={onStartLadderCup} c={c} />
      ) : notStarted ? (
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
                    onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment} onMarkWaReminder={onMarkWaReminder} onClearWaReminder={onClearWaReminder} c={c} />
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
        <div className="rounded-xl p-3 mb-5 font-body text-xs flex items-center justify-between gap-3 flex-wrap" style={{ background: c.redSoft, color: c.red }}>
          <span>You have been eliminated — you can now join one of the available leagues.</span>
          <button onClick={onBack} className="shrink-0 font-body font-semibold px-3 py-1.5 rounded-full" style={{ background: c.red, color: "#fff" }}>
            Browse leagues
          </button>
        </div>
      )}

      {expiredCount > 0 && (
        <div className="rounded-xl p-3 mb-5 font-body text-xs flex items-center gap-2" style={{ background: c.redSoft, color: c.red }}>
          <Clock size={13} /> The 2-day deadline unplayed — both clubs recorded a loss and conceded 4 goals automatically.
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
          {awaitingOpponentResults.length} result{awaitingOpponentResults.length === 1 ? "" : "s"} still within the opponent's {isWeekendLeague(league) ? WEEKEND_RESULT_CONFIRM_WINDOW_MINUTES : RESULT_CONFIRM_WINDOW_MINUTES}-minute confirmation window
          {" — "}lands here for your review only if they don't respond in time.
        </div>
      )}

      {canManage && escalatedResults.length > 0 && (
        <PendingResultsPanel league={league} submissions={escalatedResults}
          title={`${escalatedResults.length} result${escalatedResults.length === 1 ? "" : "s"} needing review — opponent didn't confirm in time or disputed it repeatedly`}
          showEscalationReason showSubmitterWhatsApp
          onDownloadProof={onDownloadResultProof} onApprove={onApproveResult} onReject={onRejectResult} c={c} />
      )}

      {isSurvivor && !survivorComplete && (
        <div className="rounded-xl p-4 mb-5 border" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-body text-xs mb-2" style={{ color: c.textDim }}>
            {league.final_stage_started
              ? `Final stage (${league.survivor_final_format === "double_round_robin" ? "double" : "single"} round robin) · ${activeTeamsCount} clubs · ${stageFixtures.filter((f) => f.played || isExpired(f)).length}/${stageFixtures.length} played`
              : `Stage ${league.current_stage} · ${activeTeamsCount} clubs, ${league.survivor_matches_per_stage} matches each · ${stageFixtures.filter((f) => f.played || isExpired(f)).length}/${stageFixtures.length} played · bottom ${league.survivor_elimination_percent}% cut when complete`}
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
            Group stage · {league.groups_count} groups · {groupStageFixtures.filter((f) => f.played || isFixtureLocked(f, league)).length}/{groupStageFixtures.length} played · top {league.group_qualifiers} from each group advance
          </div>
          <GroupStageDueLine league={league} canManage={canManage} onUpdateGroupStageDueAt={onUpdateGroupStageDueAt} c={c} />
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
            {currentRoundDone ? `Round ${totalRounds} complete — ready for the next round.` : `Round ${totalRounds} in progress: ${currentRoundFixtures.filter((f) => f.played || isExpired(f)).length}/${currentRoundFixtures.length} played.`}
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
            ? <GroupTables league={league} groupStageFixtures={groupStageFixtures} avatarByTeamId={avatarByTeamId} session={session} myTeamId={myTeam?.id} c={c} />
            : <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={stageFixtures} isSurvivor={isSurvivor} league={league} avatarByTeamId={avatarByTeamId} session={session} myTeamId={myTeam?.id} c={c} />}
          <CommentsSection league={league} session={session} canComment={joined || canManage}
            comments={resultComments} heading="Results" icon={Trophy} allowCompose={false} showFindMyResults
            emptyText="No results posted yet — they'll show up here as matches are played."
            // canManage = this league's own creator, or a site admin (isCreator
            // checks league.created_by against the current session, so a
            // player or the creator of some other league never gets it here).
            // That's exactly who should be able to edit a posted result.
            canEditResults={canManage}
            onPost={onPostComment} onDelete={onDeleteComment} onEdit={onEditComment} onEditResult={onEditResult} onToggleReaction={onToggleReaction} myUsername={myUsername} c={c} />
        </div>
      )}

      {tab === "fixtures" && (
        <div className="space-y-6">
          {/* Weekend leagues skip the full "every fixture" admin view — even
              for the league's own manager — and just show their own
              opponent instead, same as a regular joined player gets in a
              normal league. See isWeekendLeague. */}
          {inGroupStage && canManage && !isWeekendLeague(league) && (
            <GroupFixturesList league={league} groupStageFixtures={groupStageFixtures} canManage={canManage} joined={joined}
              getSubmission={submissionForFixture} onOpenSubmitResult={onOpenSubmitResult}
              onRecordResult={(fixture, h, a, file) => onRecordResult(league, fixture, h, a, file)} c={c} />
          )}
          {(inGroupStage || inKnockoutBracket) && joined && myTeam && (!canManage || isWeekendLeague(league)) && (
            <NextOpponentCard league={league} leagues={leagues} myTeam={myTeam} canSeePhones={canSeePhones} c={c} />
          )}
          <FindYourself league={league} stageFixtures={stageFixtures} inGroupStage={inGroupStage} inKnockoutBracket={inKnockoutBracket}
            groupStageFixtures={groupStageFixtures} canSeePhones={canSeePhones} c={c} />
          {(joined || canManage) && (
            <OpponentFinder teams={league.teams} fixtures={stageFixtures} totalRounds={totalRounds} canManage={canManage} joined={joined}
              getSubmission={submissionForFixture} onOpenSubmitResult={onOpenSubmitResult}
              canSeePhones={canSeePhones} onRecordResult={(fixture, h, a, file) => onRecordResult(league, fixture, h, a, file)} league={league} leagues={leagues} c={c} />
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
          {canManage && <MemberMessageEditor league={league} onUpdateMemberMessage={onUpdateMemberMessage} onNotifyAllMembers={onNotifyAllMembers} c={c} />}
          {canManage && <OrganizerContactEditor league={league} onUpdateCreatorPhone={onUpdateCreatorPhone} c={c} />}
          {canManage && league.members.some((m) => isWaReminderActive(m)) && (
            <div className="flex justify-end mb-2">
              <button onClick={() => onClearAllWaReminders(league)} className="font-mono text-[11px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.red }}>
                <X size={11} /> Clear all highlights
              </button>
            </div>
          )}
          {league.league_type === "cash" && canManage && league.members.some((m) => m.payment_status === "pending") && (
            <div className="rounded-lg p-3 mb-3 font-body text-xs flex items-center gap-2" style={{ background: "rgba(217,164,6,0.12)", color: "#B8860B" }}>
              <ReceiptText size={14} /> Download each member's proof of payment, then approve or reject to confirm their registration.
            </div>
          )}
          {league.members.length === 0 ? (
            <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's joined yet.</div>
          ) : (() => {
            const sorted = [...league.members].sort((a, b) => (a.payment_status === "pending" ? -1 : 0) - (b.payment_status === "pending" ? -1 : 0));
            const row = (m) => (
              <MemberPaymentRow key={m.id} m={m} t={league.teams.find((t) => t.id === m.team_id)} league={league}
                isCash={league.league_type === "cash"} canManage={canManage}
                isOwnRow={session && m.user_id === session.user.id} onLeave={() => onLeave(league)}
                onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment} onMarkWaReminder={onMarkWaReminder} onClearWaReminder={onClearWaReminder} c={c} />
            );
            // Only worth splitting into two lists once a custom template
            // actually exists on the league — with none set, every member
            // gets the automated message and a "Custom" list would just sit
            // there empty. See usesCustomMessage: within one league some
            // members can still land on automated (eliminated, or nothing
            // left to play) even with a template active, which is exactly
            // the split this surfaces.
            if (!league.wa_message_template) {
              return <div className="space-y-1.5">{sorted.map(row)}</div>;
            }
            const custom = sorted.filter((m) => usesCustomMessage(league.teams.find((t) => t.id === m.team_id), league));
            const automated = sorted.filter((m) => !usesCustomMessage(league.teams.find((t) => t.id === m.team_id), league));
            return (
              <div className="space-y-5">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>
                    Custom message ({custom.length})
                  </div>
                  {custom.length === 0 ? (
                    <div className="font-body text-xs px-1" style={{ color: c.textFaint }}>No members will get the custom message right now.</div>
                  ) : (
                    <div className="space-y-1.5">{custom.map(row)}</div>
                  )}
                </div>
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>
                    Automated message ({automated.length})
                  </div>
                  {automated.length === 0 ? (
                    <div className="font-body text-xs px-1" style={{ color: c.textFaint }}>No members are on the automated message right now.</div>
                  ) : (
                    <div className="space-y-1.5">{automated.map(row)}</div>
                  )}
                </div>
              </div>
            );
          })()}
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

function CommentsSection({ league, session, canComment, onPost, onDelete, onEdit, onEditResult, onEditLadderCupResult, canEditResults = false, onToggleReaction, myUsername, c, comments, heading = "Comments", icon: HeadingIcon = MessageCircle, allowCompose = true, emptyText = "No comments yet — be the first to say something.", showFindMyResults = false }) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [sortBy, setSortBy] = useState("newest"); // "newest" | "top" — top sorts root comments by reaction count
  const [visibleCount, setVisibleCount] = useState(COMMENT_PAGE_SIZE);
  const [pending, setPending] = useState([]); // optimistic comments/replies, cleared once the real row lands
  const [photo, setPhoto] = useState(null); // optional photo attached to the comment being composed
  const voiceRecorder = useVoiceRecorder(); // optional voice note attached to the comment being composed
  const [myResultsQuery, setMyResultsQuery] = useState("");
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

  // A result post's body is the plain-text result line itself (e.g. "Matchday
  // 1 — asiyetha 1 – 0 culerGMC"), so matching a club name just means
  // checking whether that text mentions it — no separate team lookup needed.
  const filteredRoots = showFindMyResults && myResultsQuery.trim()
    ? roots.filter((r) => r.body?.toLowerCase().includes(myResultsQuery.trim().toLowerCase()))
    : roots;
  const visibleRoots = filteredRoots.slice(0, visibleCount);
  const hiddenCount = filteredRoots.length - visibleRoots.length;

  const submit = async () => {
    const trimmed = text.trim();
    const voiceClip = voiceRecorder.state === "recorded" ? voiceRecorder.clip : null;
    if ((!trimmed && !photo && !voiceClip) || posting) return;
    setPosting(true);
    const tempId = `temp-${Date.now()}`;
    const photoFile = photo;
    const optimistic = {
      id: tempId, league_id: league.id, user_id: session.user.id,
      username: myUsername || session.user.email,
      body: trimmed, created_at: new Date().toISOString(), parent_comment_id: null,
      photo_url: photoFile ? URL.createObjectURL(photoFile) : null,
      voice_url: voiceClip ? URL.createObjectURL(voiceClip.blob) : null, voice_duration: voiceClip?.duration || null,
      comment_likes: [], pending: true,
    };
    setPending((prev) => [...prev, optimistic]);
    setText("");
    setPhoto(null);
    voiceRecorder.discard();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const ok = await onPost(league, trimmed, null, photoFile, null, false, voiceClip);
    setPosting(false);
    if (!ok) {
      setPending((prev) => prev.filter((p) => p.id !== tempId));
      setText(trimmed);
      setPhoto(photoFile);
      voiceRecorder.restore(voiceClip);
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

      {showFindMyResults && (
        <div className="mb-3">
          <input value={myResultsQuery} onChange={(e) => { setMyResultsQuery(e.target.value); setVisibleCount(COMMENT_PAGE_SIZE); }}
            placeholder="Find my results — enter your club name…"
            className="w-full border rounded-lg px-3 py-2 font-body text-sm outline-none"
            style={{ background: c.surfaceHover, borderColor: c.border, color: c.text }} />
        </div>
      )}

      {filteredRoots.length === 0 ? (
        <div className="border border-dashed rounded-xl p-6 text-center mb-4" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          <HeadingIcon size={20} className="mx-auto mb-2" style={{ color: c.textFaint }} />
          <div className="font-body text-sm">{myResultsQuery.trim() ? `No results found for "${myResultsQuery.trim()}".` : emptyText}</div>
        </div>
      ) : (
        <div className="space-y-3 mb-3">
          {visibleRoots.map((cm) => (
            <CommentNode key={cm.id} comment={cm} league={league} session={session} canComment={canComment}
              onPost={onPost} onDelete={onDelete} onEdit={onEdit} onEditResult={onEditResult} onEditLadderCupResult={onEditLadderCupResult} canEditResults={canEditResults} onToggleReaction={onToggleReaction} c={c} depth={0} />
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
            {voiceRecorder.state !== "recorded" && <VoiceRecorderButton recorder={voiceRecorder} c={c} />}
            <div className="flex flex-col items-end gap-1 shrink-0">
              <button aria-label="Send" onClick={submit} disabled={(!text.trim() && !photo && voiceRecorder.state !== "recorded") || posting}
                className="w-10 h-10 flex items-center justify-center rounded-full transition-transform active:scale-90"
                style={(text.trim() || photo || voiceRecorder.state === "recorded") && !posting ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
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
function CommentNode({ comment, league, session, canComment, onPost, onDelete, onEdit, onEditResult, onEditLadderCupResult, canEditResults = false, onToggleReaction, c, depth }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [repliesShown, setRepliesShown] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyPhoto, setReplyPhoto] = useState(null);
  const replyVoiceRecorder = useVoiceRecorder();
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
    const voiceClip = replyVoiceRecorder.state === "recorded" ? replyVoiceRecorder.clip : null;
    if ((!trimmed && !replyPhoto && !voiceClip) || posting) return;
    setPosting(true);
    const photoFile = replyPhoto;
    setReplyText("");
    setReplyPhoto(null);
    replyVoiceRecorder.discard();
    setReplyOpen(false);
    const ok = await onPost(league, trimmed, comment, photoFile, null, false, voiceClip);
    setPosting(false);
    if (!ok) { setReplyText(trimmed); setReplyPhoto(photoFile); replyVoiceRecorder.restore(voiceClip); }
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
        onDelete={onDelete} onEdit={onEdit} onEditResult={onEditResult} onEditLadderCupResult={onEditLadderCupResult} canEditResults={canEditResults} onToggleReaction={onToggleReaction} c={c} isReply={depth > 0}
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
              onPost={onPost} onDelete={onDelete} onEdit={onEdit} onEditResult={onEditResult} onEditLadderCupResult={onEditLadderCupResult} canEditResults={canEditResults} onToggleReaction={onToggleReaction} c={c} depth={depth + 1} />
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
            {replyVoiceRecorder.state !== "recorded" && <VoiceRecorderButton recorder={replyVoiceRecorder} c={c} size={36} iconSize={13} />}
            <button aria-label="Send reply" onClick={submitReply} disabled={(!replyText.trim() && !replyPhoto && replyVoiceRecorder.state !== "recorded") || posting}
              className="shrink-0 w-9 h-9 flex items-center justify-center rounded-full transition-transform active:scale-90"
              style={(replyText.trim() || replyPhoto || replyVoiceRecorder.state === "recorded") && !posting ? { background: c.accent, color: c.accentText } : { background: c.surfaceHover, color: c.textFaint }}>
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
function CommentRow({ comment: cm, league, session, canComment, onDelete, onEdit, onEditResult, onEditLadderCupResult, canEditResults = false, onToggleReaction, onReplyClick, c, isReply = false }) {
  const isOwn = session && cm.user_id === session.user.id;
  const isManager = cm.user_id === league.created_by;
  const realReactions = cm.comment_likes || [];
  const speakingId = useCommentSpeakingId();
  const isSpeaking = speakingId === cm.id;

  const [pendingReaction, setPendingReaction] = useState(undefined); // undefined = no optimistic override
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popKey, setPopKey] = useState(0);
  const [photoRevealed, setPhotoRevealed] = useState(false);
  const pickerRef = useRef(null);

  // Admin-only correction for a posted result line — only offered on the
  // actual auto-posted scoreline row itself (not on chat replies underneath
  // it), and only from the Results tab (canEditResults).
  const isResultRow = !cm.pending && isResultComment(cm.body, cm.is_result);
  const canEditThis = canEditResults && isResultRow;
  // Quick "I have a question about this result" contact button to the league
  // admin — offered to anyone viewing a result row who ISN'T themselves the
  // admin (canEditResults doubles as "am I the admin" here, since it's only
  // ever true on the Results tab). Renders nothing if the league has no
  // creator_phone on file (older leagues created before that field existed).
  const queryWhatsAppText = `Hi, I have a question about this result in "${league.name}": ${cm.body} Could you take a look?`;
  // Only results posted after fixture_id was added carry a link back to the
  // actual match — those get real score inputs that update the fixture (and
  // so the table). Older posts fall back to editing just the displayed text.
  const linkedFixture = cm.fixture_id ? (league.fixtures || []).find((f) => f.id === cm.fixture_id) : null;
  // Ladder Cup results don't use the fixtures table at all (see
  // ladder_cup_matches) — they carry ladder_cup_match_id instead, set by
  // applyLadderCupMatchResult once a report is confirmed. Same purpose as
  // linkedFixture: resolving the two clubs so the admin contact icons
  // below have someone to message.
  const linkedLadderMatch = !linkedFixture && cm.ladder_cup_match_id
    ? (league.ladder_cup_matches || []).find((m) => m.id === cm.ladder_cup_match_id)
    : null;
  const homeTeam = linkedFixture
    ? league.teams.find((t) => t.id === linkedFixture.home_team_id)
    : linkedLadderMatch
    ? league.teams.find((t) => t.id === linkedLadderMatch.home_team_id)
    : null;
  const awayTeam = linkedFixture
    ? league.teams.find((t) => t.id === linkedFixture.away_team_id)
    : linkedLadderMatch
    ? league.teams.find((t) => t.id === linkedLadderMatch.away_team_id)
    : null;
  const homeTeamName = homeTeam?.name || (linkedFixture || linkedLadderMatch ? "Home" : null);
  const awayTeamName = awayTeam?.name || (linkedFixture || linkedLadderMatch ? "Away" : null);
  // Ready message an admin can fire off to either club straight from the
  // result row — one for each side. Ladder Cup results have no round
  // number, so the message drops that clause rather than showing "undefined".
  const adminQueryText = (teamName) => linkedFixture
    ? `Hi ${teamName}, quick check on your result — Matchday ${linkedFixture.round}: ${homeTeamName} ${linkedFixture.home_score} – ${linkedFixture.away_score} ${awayTeamName}. Everything look right on your end?`
    : `Hi ${teamName}, quick check on your Ladder Cup result — ${homeTeamName} ${linkedLadderMatch?.home_goals} – ${linkedLadderMatch?.away_goals} ${awayTeamName}. Everything look right on your end?`;

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(cm.body || "");
  const [editHomeScore, setEditHomeScore] = useState("");
  const [editAwayScore, setEditAwayScore] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const startEdit = () => {
    setEditText(cm.body || "");
    if (linkedFixture) {
      setEditHomeScore(linkedFixture.home_score ?? "");
      setEditAwayScore(linkedFixture.away_score ?? "");
    } else if (linkedLadderMatch) {
      setEditHomeScore(linkedLadderMatch.home_goals ?? "");
      setEditAwayScore(linkedLadderMatch.away_goals ?? "");
    }
    setEditing(true);
  };
  // Ladder Cup results get real score inputs too (linkedLadderMatch), same
  // as a linked fixture — see onEditLadderCupResult (App.jsx's
  // editLadderCupMatchResult) for why that's a full-league recompute under
  // the hood rather than a plain overwrite. Only a comment with neither
  // link (predates score-linked editing entirely) falls back to the
  // text-only onEdit path.
  const saveEdit = async () => {
    if (savingEdit) return;
    if (linkedFixture) {
      const homeNum = parseInt(editHomeScore, 10);
      const awayNum = parseInt(editAwayScore, 10);
      if (!Number.isInteger(homeNum) || !Number.isInteger(awayNum) || homeNum < 0 || awayNum < 0) return;
      setSavingEdit(true);
      const ok = await onEditResult(cm, league, linkedFixture, homeNum, awayNum);
      setSavingEdit(false);
      if (ok) setEditing(false);
    } else if (linkedLadderMatch) {
      const homeNum = parseInt(editHomeScore, 10);
      const awayNum = parseInt(editAwayScore, 10);
      if (!Number.isInteger(homeNum) || !Number.isInteger(awayNum) || homeNum < 0 || awayNum < 0) return;
      setSavingEdit(true);
      const ok = await onEditLadderCupResult(cm, league, linkedLadderMatch, homeNum, awayNum);
      setSavingEdit(false);
      if (ok) setEditing(false);
    } else {
      const trimmed = editText.trim();
      if (!trimmed) return;
      setSavingEdit(true);
      const ok = await onEdit(cm, league, trimmed);
      setSavingEdit(false);
      if (ok) setEditing(false);
    }
  };

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
      <div className="flex-1 min-w-0 rounded-xl px-3 py-2 transition-colors" style={{ background: isSpeaking ? c.surfaceHover : c.surface }}>
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
            {!cm.pending && cm.body && (
              <button onClick={() => commentSpeech.speak(cm.id, `${cm.username} said: ${cm.body}`)} title="Read comment aloud"
                className="transition-colors" style={{ color: isSpeaking ? c.accent : c.textFaint }}>
                <Volume2 size={11} />
              </button>
            )}
            {isResultRow && !canEditResults && league.creator_phone && (
              <WhatsAppLink phone={league.creator_phone} text={queryWhatsAppText} iconOnly c={c} />
            )}
            {isResultRow && canEditResults && (linkedFixture || linkedLadderMatch) && (
              <>
                <WhatsAppLink phone={homeTeam?.phone} text={adminQueryText(homeTeamName)} iconOnly
                  title={`Message ${homeTeamName}`} c={c} />
                <WhatsAppLink phone={awayTeam?.phone} text={adminQueryText(awayTeamName)} iconOnly
                  title={`Message ${awayTeamName}`} c={c} />
              </>
            )}
            {canEditThis && !editing && (
              <button onClick={startEdit} title="Edit result"
                className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: c.textFaint }}>
                <Pencil size={11} />
              </button>
            )}
            {!cm.pending && (isOwn || canComment) && (
              <button onClick={() => onDelete(cm, league)} title="Delete"
                className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: c.textFaint }}>
                <Trash2 size={11} />
              </button>
            )}
          </div>
        </div>
        {editing ? (
          <div className="mt-1.5">
            {(linkedFixture || linkedLadderMatch) ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-body text-xs truncate" style={{ color: c.textDim, maxWidth: 90 }}>{homeTeamName}</span>
                <input type="number" min="0" inputMode="numeric" value={editHomeScore} autoFocus
                  onChange={(e) => setEditHomeScore(e.target.value)}
                  className="w-14 rounded-lg px-2 py-1 font-mono text-sm text-center outline-none"
                  style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
                <span className="font-body text-xs" style={{ color: c.textFaint }}>–</span>
                <input type="number" min="0" inputMode="numeric" value={editAwayScore}
                  onChange={(e) => setEditAwayScore(e.target.value)}
                  className="w-14 rounded-lg px-2 py-1 font-mono text-sm text-center outline-none"
                  style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
                <span className="font-body text-xs truncate" style={{ color: c.textDim, maxWidth: 90 }}>{awayTeamName}</span>
                {linkedLadderMatch && (
                  <div className="font-mono text-[10px] w-full mt-0.5" style={{ color: c.textFaint }}>
                    Regulation-time score only — this recomputes the whole ladder (points, streaks, elimination status) from this match onward.
                  </div>
                )}
              </div>
            ) : (
              <>
                <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={2} autoFocus
                  className="w-full rounded-lg px-2.5 py-1.5 font-body text-sm outline-none resize-none"
                  style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
                <div className="font-mono text-[10px] mt-1" style={{ color: c.textFaint }}>
                  This result predates score-linked editing — this only changes the posted text, not the table.
                </div>
              </>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <button onClick={saveEdit}
                disabled={savingEdit || ((linkedFixture || linkedLadderMatch) ? (editHomeScore === "" || editAwayScore === "") : !editText.trim())}
                className="font-body text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{ background: c.accent, color: c.accentText, opacity: (savingEdit || ((linkedFixture || linkedLadderMatch) ? (editHomeScore === "" || editAwayScore === "") : !editText.trim())) ? 0.5 : 1 }}>
                {savingEdit ? "Saving…" : "Save"}
              </button>
              <button onClick={() => setEditing(false)} disabled={savingEdit}
                className="font-body text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{ background: c.surfaceHover, color: c.textDim }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          cm.body && <div className="font-body text-sm mt-0.5 whitespace-pre-wrap break-words">{cm.body}</div>
        )}
        {cm.photo_url && (
          isResultComment(cm.body, cm.is_result) && !photoRevealed ? (
            <button onClick={() => setPhotoRevealed(true)} title="Tap to view the scoreboard photo"
              aria-label="View proof photo"
              className="flex items-center gap-1.5 mt-2 font-mono text-[11px] font-semibold px-2.5 py-1.5 rounded-lg"
              style={{ background: c.surfaceHover, color: c.textDim, border: `1px solid ${c.border}` }}>
              <Camera size={12} /> View proof photo
            </button>
          ) : (
            <button onClick={() => window.open(toProxiedUrl(cm.photo_url), "_blank", "noopener,noreferrer")} className="block mt-2">
              <img src={toProxiedUrl(cm.photo_url)} alt="Scoreboard proof photo" loading="lazy" className="rounded-lg max-h-56 object-cover" style={{ border: `1px solid ${c.border}` }} />
            </button>
          )
        )}
        {cm.voice_url && <div className="mt-2"><VoiceNotePlayer url={cm.voice_url} duration={cm.voice_duration} c={c} /></div>}
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

// Admin-only fill-in for the organizer's own WhatsApp number, stored on
// league.creator_phone. Leagues created before this field existed (or before
// the creator had a phone on their profile) have it blank, which silently
// hides the "message the admin" WhatsApp icon on Results rows (see
// CommentRow) — this lets an admin set it retroactively so older leagues get
// that icon too, no different from any other team's contact row.
function OrganizerContactEditor({ league, onUpdateCreatorPhone, c }) {
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(league.creator_phone || "");
  useEffect(() => { setPhone(league.creator_phone || ""); }, [league.creator_phone]);
  return (
    <div className="rounded-xl p-4 border mb-3" style={{ background: c.surface, borderColor: c.border }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>Organizer contact</div>
      {editing ? (
        <div className="flex items-center gap-2 font-body text-sm">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" type="tel" autoFocus
            className="flex-1 rounded-lg font-mono text-xs px-2 py-1.5 outline-none" style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
          <button onClick={() => { onUpdateCreatorPhone(league, phone.trim()); setEditing(false); }} style={{ color: c.greenText }} className="p-1"><Check size={15} /></button>
          <button onClick={() => setEditing(false)} style={{ color: c.textFaint }} className="p-1"><X size={15} /></button>
        </div>
      ) : (
        <div onClick={() => setEditing(true)} className="flex items-center gap-2 font-body text-sm cursor-pointer">
          <span className="flex-1" style={{ color: c.textDim }}>
            Number opponents WhatsApp you on from a result they have a question about.
          </span>
          {league.creator_phone
            ? <span className="font-mono text-xs shrink-0" style={{ color: c.textDim }}>{league.creator_phone}</span>
            : <span className="font-mono text-xs shrink-0" style={{ color: c.textFaint }}>Add number</span>}
          <Settings2 size={12} className="shrink-0" style={{ color: c.textFaint }} />
        </div>
      )}
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
        <button onClick={() => { onUpdateTeamPhone(team.id, team.league_id, phone.trim()); setEditing(false); }} style={{ color: c.greenText }} className="p-1"><Check size={15} /></button>
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

// What a regular joined player sees on the Fixtures tab instead of the full
// all-teams list (that stays admin-only, since that's the view used to
// record scores). Just their own club's next unplayed match, plus a
// WhatsApp icon to line up the game with the opponent — mirrors the "Up
// next" card on Home but scoped to this one league.
// The personal rivalry between whoever's behind two clubs, followed across
// every league they've ever met in — not scoped to the league currently
// open (see computeHeadToHead/playerKeyForTeam in App.jsx). Shown as a
// compact strip that expands into the full match-by-match history, so
// there's always something extra worth a look right before you play someone
// again: a streak to defend, a rivalry to settle, or — the first time two
// people meet — a clean slate worth calling out.
function HeadToHeadStrip({ leagues, league, teamId, opponentId, myLabel, opponentLabel, c }) {
  const [open, setOpen] = useState(false);
  const record = useMemo(() => {
    const keyA = playerKeyForTeam(league, teamId);
    const keyB = playerKeyForTeam(league, opponentId);
    return computeHeadToHead(leagues, keyA, keyB);
  }, [leagues, league, teamId, opponentId]);

  if (!record) return null;

  if (record.played === 0) {
    return (
      <div className="mt-3 pt-3 border-t flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider" style={{ borderColor: c.border, color: c.textFaint }}>
        <Sparkles size={11} /> First ever clash with {opponentLabel} — no history yet
      </div>
    );
  }

  const gd = record.gf - record.ga;
  const streakColor = record.streakType === "W" ? c.green : record.streakType === "L" ? c.red : c.textDim;
  const streakLabel = record.streak >= 2
    ? `${record.streakType === "W" ? "Won" : record.streakType === "L" ? "Lost" : "Drawn"} last ${record.streak}`
    : null;

  return (
    <>
      <button onClick={() => setOpen(true)} className="mt-3 pt-3 border-t w-full flex items-center justify-between gap-2 text-left" style={{ borderColor: c.border }}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, color: c.accent }}><Swords size={13} /></span>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: c.textFaint }}>Head-to-head</div>
            <div className="font-body text-xs font-semibold truncate" style={{ color: c.text }}>
              {record.w}W {record.d}D {record.l}L · GD {gd > 0 ? "+" : ""}{gd}
              {streakLabel && <span style={{ color: streakColor }}> · {streakLabel}</span>}
            </div>
          </div>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wide shrink-0" style={{ color: c.accent }}>History →</span>
      </button>
      {open && (
        <HeadToHeadModal record={record} myLabel={myLabel} opponentLabel={opponentLabel} onClose={() => setOpen(false)} c={c} />
      )}
    </>
  );
}

function HeadToHeadStatBlock({ label, value, color, c }) {
  return (
    <div className="rounded-lg py-2.5 text-center" style={{ background: `${color}18` }}>
      <div className="font-mono text-lg font-bold" style={{ color }}>{value}</div>
      <div className="font-mono text-[9px] uppercase tracking-wider mt-0.5" style={{ color }}>{label}</div>
    </div>
  );
}

function HeadToHeadModal({ record, myLabel, opponentLabel, onClose, c }) {
  const gd = record.gf - record.ga;
  return (
    <LadderCupWidgetOverlay title={`${myLabel} vs ${opponentLabel}`} onClose={onClose} c={c}>
      <div className="grid grid-cols-3 gap-2 mb-3">
        <HeadToHeadStatBlock label="Won" value={record.w} color={c.green} c={c} />
        <HeadToHeadStatBlock label="Drawn" value={record.d} color={c.textDim} c={c} />
        <HeadToHeadStatBlock label="Lost" value={record.l} color={c.red} c={c} />
      </div>
      <div className="font-mono text-xs mb-4" style={{ color: c.textFaint }}>
        {record.gf}-{record.ga} goals · GD {gd > 0 ? "+" : ""}{gd} across {record.played} meeting{record.played === 1 ? "" : "s"}
      </div>
      <div className="space-y-1.5">
        {record.matches.map((m, i) => {
          const result = m.gfA > m.gfB ? "W" : m.gfA < m.gfB ? "L" : "D";
          const resultColor = result === "W" ? c.green : result === "L" ? c.red : c.textDim;
          return (
            <div key={i} className="flex items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: c.surface }}>
              <div className="min-w-0">
                <div className="font-body text-xs font-semibold truncate" style={{ color: c.text }}>{m.leagueName}</div>
                <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{fmtDate(m.date)} · Matchday {m.round}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-sm font-bold" style={{ color: c.text }}>{m.gfA}-{m.gfB}</span>
                <span className="font-mono text-[9px] font-bold uppercase w-5 h-5 rounded flex items-center justify-center" style={{ background: `${resultColor}22`, color: resultColor }}>
                  {result}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </LadderCupWidgetOverlay>
  );
}

function NextOpponentCard({ league, leagues, myTeam, canSeePhones, c }) {
  if (myTeam.eliminated) {
    return (
      <div className="rounded-xl p-4 border font-body text-sm" style={{ background: c.surface, borderColor: c.border, color: c.textFaint }}>
        {myTeam.name} has been eliminated from this league.
      </div>
    );
  }

  const fixture = nextFixtureForTeam(league, myTeam.id);
  if (!fixture) {
    return (
      <div className="rounded-xl p-4 border font-body text-sm" style={{ background: c.surface, borderColor: c.border, color: c.textFaint }}>
        No upcoming match scheduled for {myTeam.name} right now.
      </div>
    );
  }

  const isHome = fixture.home_team_id === myTeam.id;
  const opponentId = isHome ? fixture.away_team_id : fixture.home_team_id;
  const opponent = league.teams.find((t) => t.id === opponentId);

  // A knockout tie's second leg shares the same round/stage and the same
  // two clubs (home/away flipped) — if one exists, both legs already carry
  // the same shared due_at (see knockoutRoundFixtures). fixture.starts_at
  // is the real recorded start moment; only reconstruct it from due_at for
  // older fixtures created before that column existed.
  const siblingLeg = fixture.leg ? league.fixtures.find((f) => f.id !== fixture.id && f.round === fixture.round && f.stage === fixture.stage
    && ((f.home_team_id === fixture.home_team_id && f.away_team_id === fixture.away_team_id)
      || (f.home_team_id === fixture.away_team_id && f.away_team_id === fixture.home_team_id))) : null;
  const twoLegged = !!siblingLeg;
  const tieWindowMs = twoLegged ? KNOCKOUT_TIE_WINDOW_MS : 0;
  const tieStartAt = !twoLegged ? null : fixture.starts_at ? new Date(fixture.starts_at) : new Date(new Date(fixture.due_at).getTime() - tieWindowMs);
  const tieWindowDays = tieWindowMs / ONE_DAY_MS;

  return (
    <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
      {/* Club's group shown first, above the match itself, whenever this
          league is in its group stage — myTeam.group_number is only ever
          set once groups are assigned (see GroupFixturesList/GroupTables). */}
      {myTeam.group_number != null && (
        <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.accent }}>{groupLabel(myTeam.group_number)}</div>
      )}
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Your next match</div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate" style={{ color: c.text }}>vs {opponent?.name || "TBD"}</div>
          <div className="font-mono text-xs mt-1" style={{ color: isFixtureLocked(fixture, league) ? c.red : c.textDim }}>
            {isHome ? "Home" : "Away"} · Matchday {fixture.round}
            {isFixtureLocked(fixture, league)
              ? " · Expired"
              : twoLegged
              ? ` · ${fmtDate(tieStartAt)} → ${fmtDate(fixture.due_at)} (${tieWindowDays} day${tieWindowDays === 1 ? "" : "s"})`
              : fixture.due_at ? ` · Due ${fmtDate(fixture.due_at)}` : ""}
          </div>
        </div>
        {canSeePhones && opponent?.phone && (
          <WhatsAppCallLink phone={opponent.phone}
            text={`Hi, it's ${myTeam.name} 🔥 Call me when you're ready to play — matchday ${fixture.round} is due ${fmtDate(fixture.due_at)}, let's lock in the time ⚽🕹️${firstMatchdayNote(fixture.round)}`} c={c} />
        )}
      </div>
      {opponent && (
        <HeadToHeadStrip leagues={leagues} league={league} teamId={myTeam.id} opponentId={opponent.id}
          myLabel={myTeam.name} opponentLabel={opponent.name} c={c} />
      )}
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
      const standings = computeStandings(groupTeams, groupFx, league).map((r, i) => ({ ...r, rank: i + 1 }));
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

    // Survivor-format table lookup. Rank must be computed against the same
    // pool advanceSurvivor actually cuts from — active teams only — or an
    // already-eliminated club (which has zero fixtures in the current stage)
    // can tie its way to a deceptively "safe" looking rank near the top.
    if (team.eliminated) {
      setResult({ kind: "table", team, eliminated: true, standings: [], myRow: null, nextFixture: null, allTeams: league.teams });
      return;
    }
    const activeTeams = league.teams.filter((t) => !t.eliminated);
    const standings = computeStandings(activeTeams, stageFixtures, league).map((r, i) => ({ ...r, rank: i + 1 }));
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
                      <WhatsAppCallLink phone={opp.opponent.phone} iconOnly
                        text={`Hi, it's ${result.team.name} 🔥 Call me when you're ready to play — matchday ${result.nextFixture.round} is due ${fmtDate(result.nextFixture.due_at)}, let's lock in the time ⚽🕹️${firstMatchdayNote(result.nextFixture.round)}`} c={c} />
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
            // Two-legged (home & away) ties share one due_at across both legs
            // (see knockoutRoundFixtures) — reconstruct the tie's start moment
            // by subtracting the double-length window back off that shared
            // deadline, so this shows one "start → expiry (N days)" range
            // instead of a due date repeated on every leg. Matches the same
            // pattern used in KnockoutFixturesList and OpponentFinder.
            const allPlayed = result.myFixtures.every((f) => f.played);
            const f0 = result.myFixtures[0];
            const tieWindowMs = twoLegged ? KNOCKOUT_TIE_WINDOW_MS : 0;
            const tieStartAt = !twoLegged ? null : f0.starts_at ? new Date(f0.starts_at) : new Date(new Date(f0.due_at).getTime() - tieWindowMs);
            const tieWindowDays = tieWindowMs / ONE_DAY_MS;
            const tieExpired = twoLegged && !allPlayed && isFixtureLocked(f0, league);
            return (
              <div>
                <div className="font-mono text-xs" style={{ color: c.textDim }}>
                  Round {result.myFixtures[0].round} vs <span style={{ color: c.text }}>{opp.opponent?.name}</span>
                  {twoLegged ? " (home & away)" : ` (${opp.isHome ? "Home" : "Away"})`}
                </div>
                {twoLegged && !allPlayed && (
                  <div className="font-mono text-xs mt-1" style={{ color: tieExpired ? c.red : c.textDim }}>
                    {tieExpired
                      ? "Expired"
                      : `${fmtDate(tieStartAt)} → ${fmtDate(f0.due_at)} (${tieWindowDays} day${tieWindowDays === 1 ? "" : "s"})`}
                  </div>
                )}
                {twoLegged && (
                  <div className="font-mono text-xs mt-1" style={{ color: c.textDim }}>
                    Aggregate: {result.team.name} {agg(result.team.id)} – {agg(opp.opponent.id)} {opp.opponent.name}
                  </div>
                )}
                {result.myFixtures.map((f) => (
                  <div key={f.id} className="font-mono text-xs mt-1" style={{ color: c.textDim }}>
                    {twoLegged ? `Leg ${f.leg} (${f.home_team_id === result.team.id ? "Home" : "Away"}): ` : ""}
                    {f.played
                      ? `${f.home_score} – ${f.away_score}`
                      : isFixtureLocked(f, league) ? <span style={{ color: c.red }}>Expired — loss, conceded 4</span>
                      : twoLegged ? "" // shared start–expiry window already shown once, above
                      : `Due by ${fmtDate(f.due_at)}`}
                  </div>
                ))}
                {canSeePhones && (
                  opp.opponent?.phone ? (
                    <div className="mt-1.5">
                      <WhatsAppCallLink phone={opp.opponent.phone} iconOnly
                        text={`Hi, it's ${result.team.name} 🔥 Call me when you're ready to play — matchday ${result.myFixtures[0].round} is due ${fmtDate((result.myFixtures.find((f) => !f.played) || result.myFixtures[0]).due_at)}, let's lock in the time ⚽🕹️${firstMatchdayNote(result.myFixtures[0].round)}`} c={c} />
                    </div>
                  ) : <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>No number on file for this club yet.</div>
                )}
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="font-body text-sm mt-3 rounded-lg px-3 py-2.5" style={{ background: c.surfaceHover }}>
          <div className="font-semibold mb-1">
            {result.team.name}
            {result.eliminated ? <span className="font-mono text-[10px] ml-1.5" style={{ color: c.red }}>OUT</span> : ""}
          </div>
          {result.eliminated ? (
            <div className="font-mono text-xs" style={{ color: c.textFaint }}>{result.team.name} has been eliminated from this league.</div>
          ) : (<>
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
                      <WhatsAppCallLink phone={opp.opponent.phone} iconOnly
                        text={`Hi, it's ${result.team.name} 🔥 Call me when you're ready to play — matchday ${result.nextFixture.round} is due ${fmtDate(result.nextFixture.due_at)}, let's lock in the time ⚽🕹️${firstMatchdayNote(result.nextFixture.round)}`} c={c} />
                    </div>
                  ) : <div className="font-mono text-xs mt-1" style={{ color: c.textFaint }}>No number on file for this club yet.</div>
                )}
              </div>
            );
          })()}
          </>)}
        </div>
      ))}
    </div>
  );
}

function OpponentFinder({ teams, fixtures, totalRounds, canManage, joined, getSubmission, onOpenSubmitResult, canSeePhones, onRecordResult, league, leagues, c }) {
  const [matchday, setMatchday] = useState("");
  const [teamQuery, setTeamQuery] = useState("");
  const [result, setResult] = useState(null);
  const [scores, setScores] = useState({}); // fixture id -> { h, a }
  const [pensScores, setPensScores] = useState({}); // fixture id -> { ph, pa } — only used for a level final
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

    const anyExpired = legs.some((f) => isFixtureLocked(f, league));
    if (anyExpired && !canManage) {
      setResult({ notFound: true, reason: `This match passed its deadline without a result — both clubs received a loss. It's no longer viewable.` });
      return;
    }

    const opponentId = legs[0].home_team_id === team.id ? legs[0].away_team_id : legs[0].home_team_id;
    const opponent = opponentId ? teams.find((t) => t.id === opponentId) : null;
    setScores(Object.fromEntries(legs.map((f) => [f.id, { h: f.home_score, a: f.away_score }])));
    setPensScores(Object.fromEntries(legs.map((f) => [f.id, { ph: f.pens_home ?? "", pa: f.pens_away ?? "" }])));
    setSaveState({});
    setResult({ legs, team, opponent, bye: opponentId === null, expired: anyExpired, twoLegged: legs.length > 1 });
  };

  const save = async (fixture) => {
    if (!photos[fixture.id]) return;
    const { h, a } = scores[fixture.id] || { h: 0, a: 0 };
    const needsPens = isFinalFixture(fixture, league) && Number(h) === Number(a);
    const { ph, pa } = pensScores[fixture.id] || { ph: "", pa: "" };
    if (needsPens && (ph === "" || pa === "" || Number(ph) === Number(pa))) return;
    setSaveState((s) => ({ ...s, [fixture.id]: "saving" }));
    await onRecordResult(fixture, h, a, photos[fixture.id] || null, needsPens ? Number(ph) : null, needsPens ? Number(pa) : null);
    setPhotos((p) => ({ ...p, [fixture.id]: null }));
    setSaveState((s) => ({ ...s, [fixture.id]: "saved" }));
    setResult((r) => r && ({ ...r, legs: r.legs.map((f) => (f.id === fixture.id ? { ...f, played: true, home_score: h, away_score: a, pens_home: needsPens ? Number(ph) : null, pens_away: needsPens ? Number(pa) : null } : f)) }));
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

          <HeadToHeadStrip leagues={leagues} league={league} teamId={result.team.id} opponentId={result.opponent.id}
            myLabel={result.team.name} opponentLabel={result.opponent.name} c={c} />

          {(() => {
            const allPlayed = result.legs.every((f) => f.played);
            const level = allPlayed && aggregate(result.legs, result.team.id) === aggregate(result.legs, result.opponent.id);
            const isFinalTie = level && isFinalRoundFixtures(fixtures.filter((f) => f.round === result.legs[0].round));
            // Two-legged ties share one due_at across both legs (see
            // knockoutRoundFixtures), so both the player and the admin see
            // the full "start → expiry" window here, not just the cutoff.
            // legs[0].starts_at is the real recorded start moment; only
            // reconstruct it from due_at for older fixtures created before
            // that column existed.
            const tieWindowMs = result.twoLegged ? KNOCKOUT_TIE_WINDOW_MS : 0;
            const tieStartAt = !result.twoLegged ? null : result.legs[0].starts_at ? new Date(result.legs[0].starts_at) : new Date(new Date(result.legs[0].due_at).getTime() - tieWindowMs);
            const tieWindowDays = tieWindowMs / ONE_DAY_MS;
            if (!result.twoLegged && !level) return null;
            return (
              <div className="font-mono text-xs mt-1" style={{ color: c.textDim }}>
                {result.twoLegged && !allPlayed && (
                  <div>
                    {isFixtureLocked(result.legs[0], league)
                      ? <span style={{ color: c.red }}>Expired</span>
                      : `${fmtDate(tieStartAt)} → ${fmtDate(result.legs[0].due_at)} (${tieWindowDays} day${tieWindowDays === 1 ? "" : "s"})`}
                  </div>
                )}
                {result.twoLegged && <>Aggregate: {result.team.name} {aggregate(result.legs, result.team.id)} – {aggregate(result.legs, result.opponent.id)} {result.opponent.name}</>}
                {level && (isFinalTie
                  ? <span style={{ color: c.red }}> · level — needs a penalty shootout score to decide the winner</span>
                  : <span style={{ color: c.greenText }}> · level on aggregate — both clubs advance</span>)}
              </div>
            );
          })()}

          {canSeePhones ? (
            result.opponent.phone ? (
              <div className="mt-1.5">
                <WhatsAppCallLink phone={result.opponent.phone} iconOnly
                  text={`Hi, it's ${result.team.name} 🔥 Call me when you're ready to play — matchday ${matchday} is due ${fmtDate((result.legs.find((f) => !f.played) || result.legs[0]).due_at)}, let's lock in the time ⚽🕹️${firstMatchdayNote(Number(matchday))}`} c={c} />
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
            const pensSc = pensScores[fixture.id] || { ph: "", pa: "" };
            const needsPens = isFinalFixture(fixture, league) && Number(sc.h) === Number(sc.a);
            const pensReady = !needsPens || (pensSc.ph !== "" && pensSc.pa !== "" && Number(pensSc.ph) !== Number(pensSc.pa));
            return (
              <div key={fixture.id} className="mt-3 pt-3 border-t" style={{ borderColor: c.border }}>
                <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>
                  {result.twoLegged ? `Leg ${fixture.leg}` : "Result"}
                  {fixture.played
                    ? ` — ${fixture.home_score} – ${fixture.away_score}${fixture.pens_home != null ? ` (pens ${fixture.pens_home}-${fixture.pens_away})` : ""}`
                    : isFixtureLocked(fixture, league) ? " — expired, loss, conceded 4"
                    : result.twoLegged ? "" // shared start–expiry window already shown once, above
                    : ` — due ${fmtDate(fixture.due_at)}`}
                </div>
                {canManage && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{homeTeam.name} <span style={{ color: c.textFaint }}>(Home)</span></div>
                      <input type="number" min={0} value={sc.h} onChange={(e) => setScores((s) => ({ ...s, [fixture.id]: { ...sc, h: Number(e.target.value) } }))} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                    </div>
                    <span className="self-end pb-1.5" style={{ color: c.textFaint }}>–</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-body text-xs truncate mb-1" style={{ color: c.textDim }}>{awayTeam.name} <span style={{ color: c.textFaint }}>(Away)</span></div>
                      <input type="number" min={0} value={sc.a} onChange={(e) => setScores((s) => ({ ...s, [fixture.id]: { ...sc, a: Number(e.target.value) } }))} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                    </div>
                    {needsPens && (
                      <>
                        <div className="w-16 min-w-0">
                          <div className="font-body text-[10px] truncate mb-1" style={{ color: c.red }}>Pens (H)</div>
                          <input type="number" min={0} value={pensSc.ph} onChange={(e) => setPensScores((s) => ({ ...s, [fixture.id]: { ...pensSc, ph: e.target.value === "" ? "" : Number(e.target.value) } }))} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                        </div>
                        <span className="self-end pb-1.5" style={{ color: c.textFaint }}>–</span>
                        <div className="w-16 min-w-0">
                          <div className="font-body text-[10px] truncate mb-1" style={{ color: c.red }}>Pens (A)</div>
                          <input type="number" min={0} value={pensSc.pa} onChange={(e) => setPensScores((s) => ({ ...s, [fixture.id]: { ...pensSc, pa: e.target.value === "" ? "" : Number(e.target.value) } }))} className="w-full text-center rounded font-mono px-1 py-1.5 outline-none" style={{ background: c.surface, color: c.text }} />
                        </div>
                      </>
                    )}
                    <button onClick={() => { setPhotoTargetId(fixture.id); photoInputRef.current?.click(); }}
                      title={photos[fixture.id] ? photos[fixture.id].name : "Attach photo proof (required)"}
                      className="self-end shrink-0 w-9 h-9 flex items-center justify-center rounded-full"
                      style={photos[fixture.id] ? { background: c.accent, color: c.accentText } : { background: c.surface, color: c.textFaint }}>
                      <Camera size={14} />
                    </button>
                    <button onClick={() => save(fixture)} disabled={st === "saving" || !photos[fixture.id] || !pensReady}
                      title={!photos[fixture.id] ? "Attach a photo proof to save" : !pensReady ? "Enter a decisive penalty score" : undefined}
                      className="self-end font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 flex items-center gap-1"
                      style={{ background: st === "saved" ? c.greenSoft : c.accent, color: st === "saved" ? c.greenText : c.accentText, opacity: (st === "saving" || !photos[fixture.id] || !pensReady) ? 0.5 : 1 }}>
                      {st === "saved" ? (<><Check size={13} /> Saved</>) : st === "saving" ? "Saving…" : "Save"}
                    </button>
                  </div>
                )}
                {!canManage && joined && !fixture.played && !isFixtureLocked(fixture, league) && (() => {
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
