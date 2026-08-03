// Everything a signed-in member sees once they're past the homepage and
// profile gate — Header, Home, leagues, challenges, the ladder, accounts,
// leaderboard, and all their nested panels/modals/comment threads. Split
// out of App.jsx (see the lazy() imports there) so a guest browsing the
// public homepage never has to download or parse any of this — it's fetched
// on demand the moment someone actually signs in. Purely a physical move for
// code-splitting purposes; nothing here should behave differently than it
// did living in App.jsx. Shared helpers/constants/components still used by
// both the guest homepage and this file stay defined in App.jsx and are
// imported back in below — see the export list at the top of App.jsx.
import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense, lazy } from "react";
import { supabase } from "./supabaseClient";
import {
  Trophy, Plus, Users, Calendar, ChevronRight, X, Check,
  ArrowLeft, Settings2, Moon, Sun, LogOut, Lock, Crown, Layers, Share2, Trash2, Clock, Info,
  Wallet, Upload, Download, CheckCircle2, XCircle, ReceiptText, Shield, Copy, MessageCircle, Search, AlertTriangle,
  MoreVertical, Send, CornerDownRight, Camera, Eye, ThumbsUp, ThumbsDown, Target, ChevronDown, History, Shuffle,
  TrendingUp, Swords, Volume2, Pause, Play, Square, Mic, Phone, Gamepad2, Medal,
  ShoppingBag, ExternalLink, Shirt, Package, Menu, Star, Flame, Award, Sparkles,
  Zap, Repeat, Rocket,
} from "lucide-react";
import {
  RulesModal, ENTRY_FEE_MIN, ENTRY_FEE_MAX, formatRand, isKnockoutFormat, organizerFee, LADDER_THEME, FORMATS,
  isActiveMember, activeFunLeaguesByKind, blockingLeagueFor, groupLabel, isExpired, nextFixtureForTeam, nextFixtureForLeague,
  resultConfirmDeadline, resultConfirmHoursLeft, challengeResultConfirmExpired, challengeResultHoursLeft, resultEscalationReason,
  computeMyUpcomingFixtures, computeMyProgress, tierColorFor, ProgressBreakdownModal, computeWallOfFame, computeAchievements,
  AchievementsStrip, AchievementsModal, WallOfFameStrip, WallOfFameModal, computeStandings, seasonAnchor, seasonBounds,
  seasonKey, seasonLabel, currentSeason, daysUntilSeasonReset, listSeasons, computeRecentMatches, computeGlobalLeaderboard,
  goalExtremes, computeCashPrizes, memberBalance, splitCommentsByRoot, findSubmissionOpponentId, fmtDate, toDatetimeLocalValue,
  timeAgo, ladderDaysLeft, avatarColor, WHATSAPP_GREEN, waLink, firstMatchdayNote, WhatsAppLink, WhatsAppCallLink, Loader,
  commentSpeech, useCommentSpeakingId, useVoiceRecorder, VoiceRecorderButton, VoiceNotePlayer, RulesButton,
} from "./App.jsx";

// Lets an already-onboarded member update their phone/username later — mainly the
// self-service fix for "this phone number is already linked to another account"
// (phone numbers are unique platform-wide), but also covers the ordinary case of
// a changed number or in-game name.
export function EditProfileModal({ profile, onCancel, onSubmit, onUpdatePhoto, c }) {
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
export function AccountsPanel({ accounts, leagues, session, onDelete, onApprove, onBack, c }) {
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
export function Leaderboard({ leagues, session, memberAvatars, myAvatarUrl, onBack, embedded, c }) {
  const [metric, setMetric] = useState("wins");
  const [query, setQuery] = useState("");
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
  const medal = (rank) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null);

  const row = (r) => (
    <div key={r.userId} className="flex items-center gap-3 rounded-lg px-4 py-2.5"
      style={{ background: session && r.userId === session.user.id ? c.surfaceHover : c.surface, border: session && r.userId === session.user.id ? `1px solid ${c.accent}` : "1px solid transparent" }}>
      <span className="w-6 text-center font-mono text-xs shrink-0" style={{ color: c.textFaint }}>{medal(r.rank) || `#${r.rank}`}</span>
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
    return <img src={url} alt="" loading="lazy" style={{ width: size, height: size }} className="rounded-full object-cover shrink-0" />;
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
export function ChallengesScreen({ session, members, challenges, openChallenges, recentResults, boardComments, isAdmin, myUsername, onPostBoardComment, onDeleteBoardComment, onToggleBoardCommentReaction, onSendChallenge, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onOpenLogResultOpen, onConfirmResultOpen, onDisputeResultOpen, onAdminApproveResult, onAdminRejectResult, onAdminApproveResultOpen, onAdminRejectResultOpen, onAdminGrantLadderWalkover, onAdminCancelLadderChallenge, onViewResultProof, onSendRandom, onAcceptOpen, onCancelOpen, onRemoveOpen, onBack, showToast, c }) {
  const [query, setQuery] = useState("");
  const [sendingTo, setSendingTo] = useState(null);
  const [sendingRandom, setSendingRandom] = useState(false);
  const [resultsQuery, setResultsQuery] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [chatModal, setChatModal] = useState(null); // { challengeId, kind, counterpartUsername } — in-site chat with a matched opponent

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

  // Admin-only: results whose 24h opponent-confirm window has passed without
  // a response — these move here instead of staying stuck waiting forever.
  const escalatedChallenges = isAdmin
    ? challenges.filter((ch) => ch.result_status === "pending" && challengeResultConfirmExpired(ch))
    : [];
  const escalatedOpenChallenges = isAdmin
    ? (openChallenges || []).filter((ch) => ch.result_status === "pending" && challengeResultConfirmExpired(ch))
    : [];
  // Admin-only: ladder challenges still pending after their 5-day accept
  // window — these no longer auto-resolve as a walkover, so an admin picks
  // between granting the walkover or cancelling the challenge.
  const escalatedLadderAccepts = isAdmin
    ? challenges.filter((ch) => ch.is_ladder && ch.status === "pending" && ladderDaysLeft(ch.created_at, 5) === 0)
    : [];

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
        <button aria-label="Back" onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}><ArrowLeft size={16} /></button>
        <h1 className="text-2xl font-extrabold uppercase tracking-tight flex-1">Challenges</h1>
        <RulesButton label="Challenge Rules" onClick={() => setRulesOpen(true)} c={c} />
      </div>
      {rulesOpen && <Suspense fallback={null}><RulesModal type="challenge" onClose={() => setRulesOpen(false)} c={c} /></Suspense>}

      {isAdmin && (escalatedChallenges.length > 0 || escalatedOpenChallenges.length > 0) && (
        <div className="rounded-xl p-4 border mb-6" style={{ background: "rgba(220,38,38,0.06)", borderColor: c.red }}>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.red }}>
            <AlertTriangle size={13} /> Needs admin review — opponent didn't respond within 24h
          </div>
          <div className="flex flex-col gap-2">
            {escalatedChallenges.map((ch) => (
              <AdminEscalatedResultRow key={`ch-${ch.id}`} nameA={ch.challenger_username} nameB={ch.opponent_username}
                scoreA={ch.challenger_score} scoreB={ch.opponent_score} reportedByUsername={ch.result_reported_by === ch.challenger_id ? ch.challenger_username : ch.opponent_username}
                onApprove={() => onAdminApproveResult(ch)} onReject={() => onAdminRejectResult(ch)} onViewProof={() => onViewResultProof(ch)} c={c} />
            ))}
            {escalatedOpenChallenges.map((ch) => (
              <AdminEscalatedResultRow key={`oc-${ch.id}`} nameA={ch.creator_username} nameB={ch.accepted_by_username}
                scoreA={ch.creator_score} scoreB={ch.accepted_by_score} reportedByUsername={ch.result_reported_by === ch.creator_id ? ch.creator_username : ch.accepted_by_username}
                onApprove={() => onAdminApproveResultOpen(ch)} onReject={() => onAdminRejectResultOpen(ch)} onViewProof={() => onViewResultProof(ch)} c={c} />
            ))}
          </div>
        </div>
      )}

      {isAdmin && escalatedLadderAccepts.length > 0 && (
        <div className="rounded-xl p-4 border mb-6" style={{ background: "rgba(220,38,38,0.06)", borderColor: c.red }}>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.red }}>
            <AlertTriangle size={13} /> Needs admin review — not accepted within 5 days
          </div>
          <div className="flex flex-col gap-2">
            {escalatedLadderAccepts.map((ch) => (
              <AdminEscalatedLadderAcceptRow key={`la-${ch.id}`} challengerUsername={ch.challenger_username} opponentUsername={ch.opponent_username}
                onGrantWalkover={() => onAdminGrantLadderWalkover(ch)} onCancel={() => onAdminCancelLadderChallenge(ch)} c={c} />
            ))}
          </div>
        </div>
      )}

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
            {myResolvedOpen.map((ch) => <ResolvedOpenChallengeRow key={ch.id} challenge={ch} myId={myId} myUsername={myUsername} onRemove={onRemoveOpen}
              onOpenLogResult={onOpenLogResultOpen} onConfirmResult={onConfirmResultOpen} onDisputeResult={onDisputeResultOpen} onViewResultProof={onViewResultProof}
              onOpenChat={setChatModal} c={c} />)}
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
          {sorted.map((ch) => <ChallengeRow key={ch.id} challenge={ch} myId={myId} myUsername={myUsername} onAccept={onAccept} onDecline={onDecline} onRemove={onRemove}
            onOpenLogResult={onOpenLogResult} onConfirmResult={onConfirmResult} onDisputeResult={onDisputeResult} onViewResultProof={onViewResultProof}
            onOpenChat={setChatModal} c={c} />)}
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

      {chatModal && (
        <ChallengeChatModal challengeId={chatModal.challengeId} kind={chatModal.kind} myId={myId}
          counterpartUsername={chatModal.counterpartUsername} onClose={() => setChatModal(null)} showToast={showToast} c={c} />
      )}
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
function ChallengeBoard({ session, comments, isAdmin, myUsername, onPost, onDelete, onToggleReaction, c, heading = "Challenge board", emptyText = "No comments yet — say something to get things going." }) {
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
function ResolvedOpenChallengeRow({ challenge: ch, myId, myUsername, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onViewResultProof, onOpenChat, c }) {
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
          {ch.status === "accepted" && ch.result_status === "pending" && !challengeResultConfirmExpired(ch) && (() => { const h = challengeResultHoursLeft(ch); return h !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: h <= 3 ? c.red : c.textFaint }}>
              {iReported ? `Goes to admin in ${h}h if they don't respond` : `Confirm within ${h}h or it goes to admin`}
            </div>
          ); })()}
          {ch.status === "accepted" && ch.result_status === "pending" && challengeResultConfirmExpired(ch) && (
            <div className="font-mono text-[10px] uppercase tracking-wide flex items-center gap-1" style={{ color: c.red }}><Clock size={10} /> You {myScore} – {theirScore} them · escalated to admin for review</div>
          )}
          {ch.status === "accepted" && !ch.result_status && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.greenText }}>Accepted — say hi and set a time</div>}
          {ch.status === "cancelled" && <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>Cancelled</div>}
        </div>
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

// A pending challenge/open-challenge result that's blown past its 24h
// opponent-confirm window, shown to admins for a manual call — same
// approve/reject choice the opponent would have had, just made by an admin
// instead since the opponent didn't act in time.
function AdminEscalatedResultRow({ nameA, nameB, scoreA, scoreB, reportedByUsername, onApprove, onReject, onViewProof, c }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); await fn(); setBusy(false); };
  return (
    <div className="rounded-lg p-3 border flex items-center gap-3" style={{ background: c.surface, borderColor: c.border }}>
      <div className="flex-1 min-w-0">
        <div className="font-body text-sm font-semibold truncate">{nameA} {scoreA} – {scoreB} {nameB}</div>
        <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>Reported by {reportedByUsername}</div>
      </div>
      <button onClick={onViewProof} title="View photo proof" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}><Camera size={14} /></button>
      <button onClick={() => run(onApprove)} disabled={busy} title="Approve" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}><Check size={14} /></button>
      <button onClick={() => run(onReject)} disabled={busy} title="Reject" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
    </div>
  );
}

// A ladder challenge whose 5-day accept window has passed with no response,
// shown to admins for a manual call — either grant the challenger the
// walkover (a nominal 3-0 win, same points/rank effect as any other
// confirmed ladder win) or cancel the challenge outright with no ladder
// effect on either side.
function AdminEscalatedLadderAcceptRow({ challengerUsername, opponentUsername, onGrantWalkover, onCancel, c }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); await fn(); setBusy(false); };
  return (
    <div className="rounded-lg p-3 border flex items-center gap-3" style={{ background: c.surface, borderColor: c.border }}>
      <div className="flex-1 min-w-0">
        <div className="font-body text-sm font-semibold truncate">{challengerUsername} challenged {opponentUsername}</div>
        <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>Never accepted or declined</div>
      </div>
      <button onClick={() => run(onGrantWalkover)} disabled={busy} title={`Grant walkover to ${challengerUsername}`}
        className="font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}>
        Grant walkover
      </button>
      <button onClick={() => run(onCancel)} disabled={busy} title="Cancel challenge" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
    </div>
  );
}

function ChallengeRow({ challenge: ch, myId, myUsername, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onViewResultProof, onOpenChat, c }) {
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
          {ch.status === "accepted" && ch.result_status === "pending" && !challengeResultConfirmExpired(ch) && (() => { const h = challengeResultHoursLeft(ch); return h !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: h <= 3 ? c.red : c.textFaint }}>
              {iReported ? `Goes to admin in ${h}h if they don't respond` : `Confirm within ${h}h or it goes to admin`}
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
function ChallengeChatModal({ challengeId, kind, myId, counterpartUsername, onClose, showToast, c }) {
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

export function Header({ view, setView, activeLeague, theme, toggleTheme, c, onSignOut, userEmail, avatarUrl, onEditProfile, isAdmin, onOpenAccounts, onOpenChallenges, challengeBadge, onOpenSuggestion, onOpenLeaderboard, onOpenLadder, onOpenCreate, grabbableCount }) {
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
export function SuggestionModal({ onCancel, onSubmit, c }) {
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

export function Home({ leagues, isAdmin, isMemberOf, entryClosed, myPaymentStatus, canManageLeague, myTeam, onOpen, onCreate, onJoin, session, onToggleLeagueReaction, challenges, openChallenges, onOpenChallenges, onOpenLogResult, onOpenLogResultOpen, ladder, myLadderRank, onOpenLadder, onOpenLeaderboard, onOpenShop, memberAvatars, allAchievements, onAchievementsSynced, myAvatarUrl, showToast, c }) {
  const cashLeagues = leagues.filter((l) => l.league_type === "cash");
  const funLeagues = leagues.filter((l) => l.league_type !== "cash");
  const myId = session?.user?.id;

  // Open random challenges anyone but the signed-in member can still grab —
  // same "unaccepted and up for grabs" definition ChallengesScreen uses.
  const grabbableChallenges = (openChallenges || []).filter((ch) => ch.status === "open" && ch.creator_id !== session?.user?.id);

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

  // Leagues that need the viewer's attention (something to review, or their
  // own payment needs sorting out) float to the top of each section; the
  // rest stay newest-first.
  const attentionScore = (l) => {
    const pendingCount = l.league_type === "cash" ? (l.members || []).filter((m) => m.payment_status === "pending").length : 0;
    const pendingResultsCount = (l.result_submissions || []).filter((s) => s.status === "pending" && resultEscalationReason(l, s)).length;
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
    if (isMemberOf(l) || entryClosed(l)) return false;
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

  const totalClubs = leagues.reduce((sum, l) => sum + l.teams.length, 0);
  const totalMatches = leagues.reduce((sum, l) => sum + l.fixtures.filter((f) => f.played).length, 0);

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
  const achievements = useMemo(
    () => computeAchievements({ p: myProgress, joinedCount: joinedLeagueCount, myLadderRank }),
    [myProgress.played, myProgress.w, myProgress.d, myProgress.bestStreak, myProgress.bestNoLossStreak, myProgress.cleanSheets, myProgress.biggestWinMargin, myProgress.level, joinedLeagueCount, myLadderRank?.rank_position]
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
  const wallOfFame = useMemo(() => computeWallOfFame(allAchievements, profileByUserId), [allAchievements, profileByUserId]);
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

      {/* Continue playing — the two "something's waiting on you" strips,
          grouped right after the featured banner so the page reads
          top-to-bottom as: who you are, what's live, what needs you now. */}
      <PendingResultsStrip items={pendingResultItems} onOpenLogResult={onOpenLogResult} onOpenLogResultOpen={onOpenLogResultOpen} c={c} />
      <UpNextStrip fixtures={myUpcomingFixtures} onOpen={onOpen} c={c} />

      {/* Quick actions — one equal-weight action dock. Shop lives here as a
          tile like everything else instead of a standing promo banner. */}
      <section className="mt-4">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Quick actions</div>
        <div className="grid grid-cols-4 gap-2">
          <MenuTile icon={Plus} label="New league" onClick={onCreate} c={c} />
          <MenuTile icon={Shuffle} label="Random" badge={grabbableChallenges.length || null} onClick={onOpenChallenges} c={c} />
          <MenuTile icon={TrendingUp} label="Ladder" onClick={onOpenLadder} c={c} />
          <MenuTile icon={ShoppingBag} label="Shop" external onClick={onOpenShop} c={c} />
        </div>
      </section>

      {/* Achievements — the badge collection layer, right after quick
          actions and before the competitive "where you stand" strips, so a
          player sees what they've earned before what they're chasing next. */}
      <AchievementsStrip achievements={achievements} earnedCount={earnedAchievementCount} onOpen={() => setAchievementsOpen(true)} c={c} />
      {achievementsOpen && <AchievementsModal achievements={achievements} earnedCount={earnedAchievementCount} onClose={() => setAchievementsOpen(false)} c={c} />}

      {/* Wall of Fame — the shared, cross-player view of the same badges,
          right under the personal Achievements strip so "what I've earned"
          and "how I stack up against everyone else" sit side by side. */}
      <WallOfFameStrip standings={wallOfFame} onOpen={() => setWallOfFameOpen(true)} c={c} />
      {wallOfFameOpen && <WallOfFameModal standings={wallOfFame} myUserId={myId} onClose={() => setWallOfFameOpen(false)} c={c} />}

      {/* Where you stand — Leaderboard preview then the Ladder banner,
          grouped together right after quick actions so this competitive
          "how am I doing" content is easy to reach before the league lists
          (which are the bulk of the page) take over. */}
      <div className="mt-8">
        <LeaderboardStrip leagues={leagues} session={session} memberAvatars={memberAvatars} myAvatarUrl={myAvatarUrl} onOpenLeaderboard={onOpenLeaderboard} c={c} />
      </div>
      <LadderStrip ladder={ladder} myLadderRank={myLadderRank} onOpenLadder={onOpenLadder} c={c} />

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

      <LeagueSection title="Leagues" icon={Gamepad2} leagues={sortLeagues(funLeagues)} isAdmin={isAdmin} isMemberOf={isMemberOf}
        entryClosed={entryClosed} myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
        session={session} onToggleLeagueReaction={onToggleLeagueReaction} onCreate={onCreate} c={c} />

      {cashLeagues.length > 0 && (
        <LeagueSection title="Cash leagues" icon={Wallet} leagues={sortLeagues(cashLeagues)} isAdmin={isAdmin} isMemberOf={isMemberOf}
          entryClosed={entryClosed} myPaymentStatus={myPaymentStatus} canManageLeague={canManageLeague} onOpen={onOpen} onJoin={onJoin}
          session={session} onToggleLeagueReaction={onToggleLeagueReaction} c={c} />
      )}

    </div>
  );
}

// The very top of Home for a signed-in player with clubs in flight: a
// horizontally-scrolling strip of their next 5 opponents across every
// league, soonest due date first. Renders nothing for a visitor with no
// upcoming fixtures (new signups, or someone only spectating), so it never
// leaves an empty band above the Shop banner.
function UpNextStrip({ fixtures, onOpen, c }) {
  if (!fixtures || fixtures.length === 0) return null;
  return (
    <section className="mt-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Up next</div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 no-scrollbar">
        {fixtures.map((f) => (
          <div key={f.fixtureId} role="button" tabIndex={0} onClick={() => onOpen(f.leagueId, f.fixtureId)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpen(f.leagueId); }}
            className="shrink-0 w-40 text-left rounded-xl p-3 font-body cursor-pointer transition-transform active:scale-[0.97]"
            style={{ background: c.surface, border: `1px solid ${c.border}` }}>
            <div className="font-mono text-[9px] uppercase tracking-wider truncate" style={{ color: c.accent }}>{f.leagueName}</div>
            <div className="font-semibold text-sm mt-1 truncate" style={{ color: c.text }}>{f.opponent.name}</div>
            <div className="flex items-center justify-between gap-1.5 mt-1.5">
              <div className="font-mono text-[10px] min-w-0 truncate" style={{ color: c.textDim }}>
                {f.isHome ? "Home" : "Away"}
                {f.expired ? <span style={{ color: c.red }}> · Expired</span> : f.due_at ? ` · Due ${fmtDate(f.due_at)}` : ""}
              </div>
              {f.opponent.phone && (
                // Stop the click from also bubbling up and opening the league —
                // tapping WhatsApp here should only open WhatsApp.
                <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                  <WhatsAppCallLink phone={f.opponent.phone} iconOnly
                    text={`Hi, it's ${f.team.name} 🔥 Call me when you're ready to play so we can lock in the time${f.due_at ? ` (due ${fmtDate(f.due_at)})` : ""} ⚽🕹️${firstMatchdayNote(f.round)}`} c={c} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Sits at the very top of Home, above even "Up next" — accepted challenges
// (direct or random, ladder or not) waiting on the signed-in member to log a
// score. Lets an opponent upload their result the moment they land on the
// homepage instead of having to find their way into Challenges or the
// Ladder screen first. Renders nothing when nothing's waiting.
function PendingResultsStrip({ items, onOpenLogResult, onOpenLogResultOpen, c }) {
  if (!items || items.length === 0) return null;
  return (
    <section className="mt-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2 flex items-center gap-1.5" style={{ color: c.red }}>
        <Trophy size={11} /> {items.length > 1 ? "Results to log" : "Result to log"}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4 no-scrollbar">
        {items.map((item) => (
          <button key={item.id} onClick={() => (item.kind === "open" ? onOpenLogResultOpen(item.challenge) : onOpenLogResult(item.challenge))}
            className="shrink-0 w-44 text-left rounded-xl p-3 font-body transition-transform active:scale-[0.97]"
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
    </section>
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
function MenuTile({ icon: Icon, label, badge, external, onClick, c }) {
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
export function LadderChallengeSheet({ myRank, targets, onChallenge, onCancel, c }) {
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
const SHARE_LADDER_COLUMNS = [
  { key: "rank", label: "#", width: 70, align: "center", isRank: true },
  { key: "username", label: "Player", width: 438, align: "left", isName: true, get: (r) => r.username },
  { key: "wins", label: "W", width: 110, align: "center", get: (r) => String(r.wins) },
  { key: "draws", label: "D", width: 110, align: "center", get: (r) => String(r.draws) },
  { key: "losses", label: "L", width: 110, align: "center", get: (r) => String(r.losses) },
  { key: "points", label: "Pts", width: 130, align: "center", bold: true, get: (r) => String(r.points) },
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
function ShareRangeModal({ onClose, kicker, title, subtitle, rows, columns, c, defaultRank }) {
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

// The full permanent ladder — every member, ordered by rank_position, with
// search-to-find and inline "Challenge" buttons on whichever (up to 3) rows
// the viewer is actually allowed to challenge right now. LadderStrip and the
// Ladder menu tile both land here; the pick-a-target sheet stays reachable
// from the CTA below for people who'd rather jump straight to it.
export function LadderPage({ ladder, myLadderRank, targets, session, onOpenChallenge, onBack, onTogglePause, comments, isAdmin, myUsername, onPostComment, onDeleteComment, onToggleCommentReaction, recentMatches,
  challenges, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onViewResultProof, showToast }) {
  const c = LADDER_THEME; // the Ladder always renders in its own black/gold/red look, not the app's normal theme
  const [rulesOpen, setRulesOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chatModal, setChatModal] = useState(null); // { challengeId, kind, counterpartUsername } — in-site chat with a matched opponent
  // How many rows of "#11 and below" are actually rendered — the ladder has
  // no cap on membership (it's the permanent, ever-growing one), so with
  // hundreds of players this was putting every single row (and every
  // avatar image) into the DOM on every visit regardless of whether anyone
  // scrolled that far. Render a first page and let "Show more" reveal the
  // rest on demand instead.
  const [restShown, setRestShown] = useState(30);
  const targetIds = useMemo(() => new Set((targets || []).map((t) => t.user_id)), [targets]);
  const myId = session?.user?.id;

  // Every ladder challenge (sent or received, any status) that involves me —
  // shown right here on the ladder instead of only in the Challenges tab.
  const myLadderChallenges = useMemo(() => {
    if (!challenges || !myId) return [];
    return challenges
      .filter((ch) => ch.is_ladder && (ch.challenger_id === myId || ch.opponent_id === myId))
      .sort((a, b) => {
        const rank = (ch) => (ch.status === "pending" && ch.opponent_id === myId ? 0 : ch.status === "accepted" ? 1 : ch.status === "pending" ? 2 : 3);
        return rank(a) - rank(b) || new Date(b.created_at) - new Date(a.created_at);
      });
  }, [challenges, myId]);

  if (!ladder) return <Loader c={c} />;

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const searchResults = searching ? ladder.filter((r) => (r.username || "").toLowerCase().includes(q)) : [];
  const shareRows = ladder.map((r) => ({ ...r, rank: r.rank_position }));
  const top10 = ladder.slice(0, 10);
  const rest = ladder.slice(10);
  const rankColors = ["#FFD700", "#C0C0C0", "#CD7F32"];

  const row = (row) => {
    const isMe = session && row.user_id === session.user.id;
    const canChallenge = targetIds.has(row.user_id);
    const rankIdx = row.rank_position - 1;
    return (
      <div key={row.user_id} className="flex items-center gap-3 rounded-lg px-4 py-2.5"
        style={{ background: isMe ? c.surfaceHover : c.surface, border: isMe ? `1px solid ${c.accent}` : "1px solid transparent" }}>
        {rankIdx >= 0 && rankIdx < 3 ? (
          <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${rankColors[rankIdx]}22`, border: `1px solid ${rankColors[rankIdx]}66` }}>
            {rankIdx === 0 ? <Crown size={13} style={{ color: rankColors[0] }} /> : <Medal size={13} style={{ color: rankColors[rankIdx] }} />}
          </span>
        ) : (
          <span className="w-7 h-7 text-center font-mono text-xs shrink-0 flex items-center justify-center" style={{ color: c.textFaint }}>#{row.rank_position}</span>
        )}
        <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>
          {row.username?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-body text-sm truncate flex items-center gap-1.5">
            {row.username}{isMe ? " (you)" : ""}
            {row.challenges_paused && (
              <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}>Paused</span>
            )}
          </div>
          <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>{row.points}pts · {row.wins}W–{row.losses}L</div>
        </div>
        {canChallenge && (
          <button onClick={onOpenChallenge} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}>
            Challenge
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="-mx-4 px-4 pt-8 pb-10" style={{ background: c.bg, color: c.text }}>
      <button onClick={onBack} className="flex items-center gap-1.5 font-body text-sm mb-5" style={{ color: c.textDim }}><ArrowLeft size={15} /> Home</button>

      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-3 min-w-0">
          <img src="/ladder-battles-badge.jpg" alt="" className="w-14 h-14 rounded-full object-cover shrink-0" style={{ boxShadow: `0 0 0 1px ${c.borderStrong}` }} />
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold uppercase tracking-tight leading-none" style={{ color: c.accent }}>Ladder Battles</h1>
            <div className="font-mono text-[11px] tracking-[0.35em] uppercase mt-1" style={{ color: c.red }}>No Mercy</div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setShareOpen(true)} title="Download image" disabled={ladder.length === 0}
            className="w-8 h-8 flex items-center justify-center rounded-full disabled:opacity-40" style={{ background: c.surface, color: c.textDim }}>
            <Download size={14} />
          </button>
          <RulesButton label="Ladder Rules" onClick={() => setRulesOpen(true)} c={c} />
        </div>
      </div>
      {rulesOpen && <Suspense fallback={null}><RulesModal type="ladder" onClose={() => setRulesOpen(false)} c={c} /></Suspense>}
      {shareOpen && (
        <ShareRangeModal onClose={() => setShareOpen(false)} kicker="Permanent Ladder" title="The Ladder"
          subtitle={`${ladder.length} player${ladder.length === 1 ? "" : "s"} · never resets`}
          rows={shareRows} columns={SHARE_LADDER_COLUMNS} c={c} defaultRank={myLadderRank?.rank_position} />
      )}
      <div className="font-mono text-xs mb-4 mt-3" style={{ color: c.textFaint }}>
        One permanent ranking, shared by everyone — it never resets. {ladder.length} player{ladder.length === 1 ? "" : "s"}.
      </div>

      {myLadderRank && (
        <div className="rounded-xl px-4 py-3 mb-4" style={{ background: c.surfaceHover, border: `1px solid ${c.accent}55` }}>
          <div className="flex items-center justify-between gap-3">
            <div className="font-body text-sm">
              You're <span className="font-bold" style={{ color: c.accent }}>#{myLadderRank.rank_position}</span> · {myLadderRank.points}pts · {myLadderRank.wins}W–{myLadderRank.losses}L
              {myLadderRank.challenges_paused && (
                <div className="font-mono text-[10px] uppercase tracking-wide mt-0.5" style={{ color: c.red }}>Challenges paused — no one can challenge you</div>
              )}
            </div>
            <button onClick={onOpenChallenge} className="flex items-center gap-1.5 font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}>
              <Swords size={13} /> Climb it
            </button>
          </div>
          <button onClick={onTogglePause}
            className="w-full mt-2.5 flex items-center justify-center gap-1.5 font-body text-xs font-semibold px-3 py-2 rounded-lg border"
            style={myLadderRank.challenges_paused
              ? { background: c.accent, color: c.accentText, borderColor: c.accent }
              : { background: "transparent", borderColor: c.borderStrong, color: c.textDim }}>
            {myLadderRank.challenges_paused ? <><Play size={13} /> Resume ladder challenges</> : <><Pause size={13} /> Pause ladder challenges</>}
          </button>
        </div>
      )}

      {myLadderChallenges.length > 0 && (
        <div className="mb-6">
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Your ladder challenges</div>
          <div className="flex flex-col gap-2">
            {myLadderChallenges.map((ch) => (
              <ChallengeRow key={ch.id} challenge={ch} myId={myId} myUsername={myUsername} onAccept={onAccept} onDecline={onDecline} onRemove={onRemove}
                onOpenLogResult={onOpenLogResult} onConfirmResult={onConfirmResult} onDisputeResult={onDisputeResult} onViewResultProof={onViewResultProof}
                onOpenChat={setChatModal} c={c} />
            ))}
          </div>
        </div>
      )}
      {chatModal && (
        <ChallengeChatModal challengeId={chatModal.challengeId} kind={chatModal.kind} myId={myId}
          counterpartUsername={chatModal.counterpartUsername} onClose={() => setChatModal(null)} showToast={showToast} c={c} />
      )}

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: c.textFaint }} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a username to find them..."
          className="w-full border rounded-lg pl-9 pr-4 py-2.5 font-body text-sm outline-none" style={{ background: c.surface, borderColor: c.border, color: c.text }} />
      </div>

      {ladder.length === 0 ? (
        <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
          No one's on the ladder yet.
        </div>
      ) : searching ? (
        searchResults.length === 0 ? (
          <div className="border border-dashed rounded-xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>
            No one matching "{query}".
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
            {searchResults.map(row)}
          </div>
        )
      ) : (
        <>
          <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>Top 10</div>
          <div className="no-scrollbar flex items-stretch gap-2.5 overflow-x-auto -mx-4 px-4 pb-1">
            {top10.map((r) => {
              const isMe = session && r.user_id === session.user.id;
              const canChallenge = targetIds.has(r.user_id);
              const rankIdx = r.rank_position - 1;
              return (
                <div key={r.user_id} className="flex items-center gap-2 shrink-0 rounded-xl pl-2 pr-3.5 py-2"
                  style={{
                    background: rankIdx === 0 ? `linear-gradient(135deg, ${c.accent}26, ${c.surface})` : c.surface,
                    border: `1px solid ${isMe ? c.accent : rankIdx === 0 ? c.accent + "55" : c.border}`,
                  }}>
                  {rankIdx < 3 ? (
                    <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${rankColors[rankIdx]}22`, border: `1px solid ${rankColors[rankIdx]}66` }}>
                      {rankIdx === 0 ? <Crown size={13} style={{ color: rankColors[0] }} /> : <Medal size={13} style={{ color: rankColors[rankIdx] }} />}
                    </span>
                  ) : (
                    <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 font-mono text-xs font-bold" style={{ background: c.surfaceHover, color: c.textFaint }}>
                      {r.rank_position}
                    </span>
                  )}
                  <div className="flex flex-col leading-tight">
                    <span className="font-body font-semibold text-sm truncate max-w-[110px]">{r.username}{isMe ? " (you)" : ""}</span>
                    <span className="font-mono text-[10px]" style={{ color: c.textFaint }}>{r.points}pts · {r.wins}W–{r.losses}L</span>
                  </div>
                  {canChallenge && (
                    <button onClick={onOpenChallenge} className="ml-1 font-body text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}>
                      Challenge
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {rest.length > 0 && (
            <div className="mt-4">
              <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>
                #11 and below ({rest.length})
              </div>
              <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {rest.slice(0, restShown).map(row)}
                {restShown < rest.length && (
                  <button onClick={() => setRestShown((n) => n + 30)}
                    className="w-full font-mono text-[11px] font-semibold py-2 rounded-lg" style={{ background: c.surfaceHover, color: c.textDim }}>
                    Show 30 more ({rest.length - restShown} left)
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-8">
        <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3" style={{ color: c.textFaint }}>
          Recent matches <span style={{ color: c.textFaint }}>({(recentMatches || []).length})</span>
        </div>
        {recentMatches === null ? (
          <Loader c={c} />
        ) : (recentMatches || []).length === 0 ? (
          <div className="border border-dashed rounded-xl p-6 text-center font-body text-sm" style={{ borderColor: c.borderStrong, color: c.textDim }}>
            No ladder matches played yet.
          </div>
        ) : (
          <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
            {recentMatches.map((m) => {
              const challengerWins = m.challenger_score > m.opponent_score;
              const opponentWins = m.opponent_score > m.challenger_score;
              return (
                <div key={m.id} className="flex items-center justify-between gap-3 rounded-lg px-4 py-2.5" style={{ background: c.surface }}>
                  {m.photo_url ? (
                    <a href={m.photo_url} target="_blank" rel="noopener noreferrer" className="shrink-0" title="View full screenshot">
                      <img src={m.photo_url} alt="Match result proof" loading="lazy" className="w-10 h-10 rounded-md object-cover"
                        style={{ border: `1px solid ${c.border}` }} />
                    </a>
                  ) : (
                    <div className="w-10 h-10 rounded-md flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, border: `1px solid ${c.border}` }}>
                      <Camera size={14} style={{ color: c.textFaint }} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-body text-sm truncate flex items-center gap-1.5">
                      <span style={{ fontWeight: challengerWins ? 700 : 500, color: challengerWins ? c.text : c.textFaint }}>{m.challenger_username}</span>
                      <span className="font-mono text-xs shrink-0" style={{ color: c.textFaint }}>vs</span>
                      <span style={{ fontWeight: opponentWins ? 700 : 500, color: opponentWins ? c.text : c.textFaint }}>{m.opponent_username}</span>
                    </div>
                    <div className="font-mono text-[10px] truncate" style={{ color: c.textFaint }}>{timeAgo(m.result_confirmed_at)}</div>
                  </div>
                  <div className="font-mono text-sm font-semibold shrink-0">{m.challenger_score} – {m.opponent_score}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ChallengeBoard session={session} comments={comments} isAdmin={isAdmin} myUsername={myUsername}
        onPost={onPostComment} onDelete={onDeleteComment} onToggleReaction={onToggleCommentReaction}
        heading="Ladder talk" emptyText="No comments yet — call someone out." c={c} />
    </div>
  );
}

function LeagueSection({ title, icon: Icon, leagues, isAdmin, isMemberOf, entryClosed, myPaymentStatus, canManageLeague, onOpen, onJoin, session, onToggleLeagueReaction, onCreate, c }) {
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

function LeagueCard({ league: l, isAdmin, joined, closed, blockedByLeague, myPaymentStatus, canManageLeague, onOpen, onJoin, session, onToggleLeagueReaction, c }) {
  const played = l.fixtures.filter((f) => f.played).length;
  const paymentStatus = l.league_type === "cash" ? myPaymentStatus(l) : null;
  const isCash = l.league_type === "cash";
  const canSeePool = canManageLeague(l) || paymentStatus === "approved";
  const approvedMembers = isCash ? (l.members || []).filter((m) => m.payment_status === "approved") : [];
  const pool = approvedMembers.reduce((sum, m) => sum + (m.entry_fee || 0), 0);
  const pendingCount = isCash ? (l.members || []).filter((m) => m.payment_status === "pending").length : 0;
  const pendingResultsCount = (l.result_submissions || []).filter((s) => s.status === "pending" && resultEscalationReason(l, s)).length;
  const isStaged = l.format === "survivor" || l.format === "groups_knockout";
  const activeTeams = l.format === "survivor" ? l.teams.filter((t) => !t.eliminated) : l.teams;
  const leader = computeStandings(activeTeams, l.fixtures.filter((f) => !isStaged || f.stage === l.current_stage))[0];
  const formatLabel = FORMATS.find((f) => f.id === l.format)?.label || l.format;
  const stageLabel = l.format === "survivor" ? (l.final_stage_started ? "Final stage" : `Stage ${l.current_stage}`)
    : l.format === "groups_knockout" ? (l.final_stage_started ? "Knockout stage" : "Group stage") : null;
  const progressPct = l.fixtures.length > 0 ? Math.round((played / l.fixtures.length) * 100) : 0;
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
          <img src={l.photo_url} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
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
        {l.fixtures.length === 0 ? (
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
          <Shield size={9} /> {l.teams.length}
          {l.fixtures.length > 0 && <span className="ml-1">· {played}/{l.fixtures.length}</span>}
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
          ) : (
            <button onClick={(e) => { e.stopPropagation(); onJoin(l.id); }} className="w-full font-body text-[11px] font-bold px-2 py-1.5 rounded-full"
              style={{ background: c.accent, color: c.accentText }}>Join</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function CreateLeague({ onCancel, onCreate, isAdmin, c }) {
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
  const datesOutOfOrder = entryClosesAt && startsAt && new Date(startsAt) < new Date(entryClosesAt);
  const canCreate = name.trim().length > 0 && (teamNames.length === 0 || teamNames.length >= 2) && teamNameDupes.length === 0 && teamNameMultiWord.length === 0 && survivorValid && groupsValid && entryClosesAt && startsAt && !datesOutOfOrder;
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-1.5">
        <div>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Entry closes</label>
          <input type="datetime-local" value={entryClosesAt} onChange={(e) => setEntryClosesAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
        </div>
        <div>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League starts</label>
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
        </div>
      </div>
      {datesOutOfOrder && (
        <div className="font-mono text-xs mb-5" style={{ color: c.red }}>Start date must be on or after entry closes — otherwise the league would kick off before anyone's finished joining.</div>
      )}
      {!datesOutOfOrder && <div className="mb-5" />}

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

function StandingsPanel({ standings, zoneFor, stageFixtures, isSurvivor, league, avatarByTeamId, c }) {
  const [query, setQuery] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
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
function FixtureScoreRow({ fixture, homeTeam, awayTeam, canManage, onSave, legLabel, joined, submission, onOpenSubmitResult, showContact, c }) {
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
        </>
      ) : (
        <span className="font-mono text-sm w-14 text-center shrink-0" style={{ color: c.text }}>
          {fixture.played ? `${fixture.home_score} – ${fixture.away_score}` : "– : –"}
        </span>
      )}
      {offerContact && homeTeam.phone && (
        <WhatsAppCallLink phone={homeTeam.phone} iconOnly text={callText(awayTeam)} c={c} />
      )}
      <span className="flex-1 min-w-0 truncate font-body text-sm">{awayTeam.name}</span>
      <span className="shrink-0 font-mono text-[10px] w-20 text-right" style={{ color: isExpired(fixture) ? c.red : c.textFaint }}>
        {fixture.played ? "" : isExpired(fixture) ? "Expired" : fmtDate(fixture.due_at)}
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
          <button onClick={save} disabled={saveState === "saving" || !photo} title={!photo ? "Attach a photo proof to save" : undefined}
            className="shrink-0 font-body text-xs font-semibold px-2.5 py-1 rounded-full"
            style={{ background: saveState === "saved" ? c.greenSoft : c.accent, color: saveState === "saved" ? c.greenText : c.accentText, opacity: (saveState === "saving" || !photo) ? 0.5 : 1 }}>
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
function KnockoutFixturesList({ league, bracketFixtures, canManage, joined, getSubmission, onOpenSubmitResult, onRecordResult, canSeePhones, c }) {
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
                        onSave={onRecordResult} legLabel={twoLegged ? `Leg ${f.leg || 1}` : null} showContact={canSeePhones}
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

function GroupTables({ league, groupStageFixtures, avatarByTeamId, c }) {
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
            <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={groupFx} isSurvivor={false} league={league} avatarByTeamId={avatarByTeamId} c={c} />
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

// The entry-close and kickoff dates, shown as plain text to everyone; for
// whoever can manage the league, a pencil next to it expands into two
// datetime-local inputs (same control CreateLeague uses) so plans can
// change after the league already exists, without needing to delete and
// recreate it. Mirrors LeagueDescriptionBlock's edit-in-place pattern.
function LeagueScheduleLine({ league, canManage, onUpdateSchedule, c }) {
  const [editing, setEditing] = useState(false);
  const [entryClosesAt, setEntryClosesAt] = useState(toDatetimeLocalValue(league.entry_closes_at));
  const [startsAt, setStartsAt] = useState(toDatetimeLocalValue(league.starts_at));
  const [saving, setSaving] = useState(false);
  const inputStyle = { background: c.surfaceHover, borderColor: c.border, color: c.text };

  useEffect(() => {
    setEntryClosesAt(toDatetimeLocalValue(league.entry_closes_at));
    setStartsAt(toDatetimeLocalValue(league.starts_at));
  }, [league.entry_closes_at, league.starts_at]);

  const datesOutOfOrder = entryClosesAt && startsAt && new Date(startsAt) < new Date(entryClosesAt);

  const save = async () => {
    if (!entryClosesAt || !startsAt || datesOutOfOrder) return;
    setSaving(true);
    await onUpdateSchedule(league, { entryClosesAt, startsAt });
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="mt-2 rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-1.5">
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textDim }}>Entry closes</label>
            <input type="datetime-local" value={entryClosesAt} onChange={(e) => setEntryClosesAt(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
          </div>
          <div>
            <label className="block font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textDim }}>League starts</label>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-full border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
          </div>
        </div>
        {datesOutOfOrder && (
          <div className="font-mono text-[11px] mb-2" style={{ color: c.red }}>Start date must be on or after entry closes.</div>
        )}
        <div className="flex items-center gap-2 justify-end">
          <button onClick={() => { setEntryClosesAt(toDatetimeLocalValue(league.entry_closes_at)); setStartsAt(toDatetimeLocalValue(league.starts_at)); setEditing(false); }}
            className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ color: c.textFaint }}>Cancel</button>
          <button onClick={save} disabled={saving || !entryClosesAt || !startsAt || datesOutOfOrder} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.accent, color: c.accentText, opacity: saving || !entryClosesAt || !startsAt || datesOutOfOrder ? 0.6 : 1 }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center flex-wrap gap-x-1.5 gap-y-1 mt-1">
      <div className="font-mono text-[11px] flex items-center gap-1.5" style={{ color: c.textFaint }}>
        <Clock size={11} /> Entry closes {fmtDate(league.entry_closes_at)} · Starts {fmtDate(league.starts_at)}
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
  approveLabel = "Approve", rejectLabel = "Reject", showDeadline = false, showEscalationReason = false }) {
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
                  {showDeadline && (() => {
                    const reason = resultEscalationReason(league, s);
                    return (
                      <div className="font-mono text-[11px] mt-0.5" style={{ color: reason ? c.red : (resultConfirmHoursLeft(s) <= 3 ? c.red : "#B8860B") }}>
                        {reason === "dispute-cap"
                          ? "This fixture's been disputed too many times already — sent straight to the admin"
                          : reason === "timeout"
                          ? "Confirmation window passed — this has been sent to the admin"
                          : `${resultConfirmHoursLeft(s)}h left to respond — after that it goes to the admin`}
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
function LeagueStatusBanner({ league, notStarted, myTeam, c }) {
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
function adminStatusMessage(m, t, league) {
  const name = m.display_name || "there";
  if (t?.eliminated) {
    return `Hey ${name}! 🔴 Tough one — you've been eliminated from ${league.name}. But the fun doesn't stop here, jump into one of our other available leagues and get straight back in the fight! 🔥`;
  }
  const notStarted = league.fixtures.length === 0;
  if (notStarted) {
    return league.starts_at
      ? `Hey ${name}! 🎉 ${league.name} kicks off ${fmtDate(league.starts_at)} — get ready, it's going to be a good one! 🏆⚽`
      : `Hey ${name}! 🎉 ${league.name} is filling up fast — we'll confirm the kickoff date soon, get hyped! 🏆⚽`;
  }
  const upcoming = t ? nextFixtureForTeam(league, t.id) : null;
  if (upcoming) {
    return `Hey ${name}! ⚡ Your next fixture in ${league.name} is due ${fmtDate(upcoming.due_at)} — lock in a time with your opponent and bring the heat! 🔥⚽${firstMatchdayNote(upcoming.round)}`;
  }
  return `Hey ${name}! 👋 This is weAfrica admin Saul, checking in on ${league.name}.`;
}

// The date an "upcoming league / upcoming fixture" WhatsApp text is really
// about — league kickoff before fixtures exist, otherwise the club's next
// fixture due date. Returns null for the eliminated/no-date messages, since
// those aren't "upcoming" reminders and have no due date to reset against.
function adminStatusReminderDate(m, t, league) {
  if (t?.eliminated) return null;
  const notStarted = league.fixtures.length === 0;
  if (notStarted) return league.starts_at || null;
  const upcoming = t ? nextFixtureForTeam(league, t.id) : null;
  return upcoming ? upcoming.due_at : null;
}

// Red "reminded" highlight for a member row. members.wa_reminder_due_at is
// set (by every admin, via markWaReminder below) the moment someone sends
// that member the WhatsApp text, and stored in Supabase so the highlight is
// the same for every admin looking at the league, not just whoever sent it.
// It's active only while it matches the CURRENT due date and that date
// hasn't passed yet — so it clears the instant the deadline passes, and
// also clears early if a newer fixture becomes the upcoming one before the
// old date even arrives.
function isWaReminderActive(m, dueAt) {
  return !!dueAt && m.wa_reminder_due_at === dueAt && new Date(dueAt) > new Date();
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

function MemberPaymentRow({ m, t, league, isCash, canManage, allowRemove = false, isOwnRow = false, onRemoveTeam, onLeave, onDownloadProof, onReviewPayment, onMarkWaReminder, c }) {
  useNow();
  const reminderDueAt = adminStatusReminderDate(m, t, league);
  const reminded = isWaReminderActive(m, reminderDueAt);
  return (
    <div className="rounded-lg px-4 py-2.5 border transition-colors"
      style={reminded ? { background: c.redSoft, borderColor: c.red } : { background: c.surface, borderColor: "transparent" }}>
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full flex items-center justify-center font-body text-xs font-bold shrink-0" style={{ background: c.green, color: c.text }}>{m.display_name[0]?.toUpperCase()}</div>
        <span className="font-body text-sm flex-1">{m.display_name}</span>
        {canManage && t?.phone && (
          <WhatsAppLink phone={t.phone} iconOnly text={adminStatusMessage(m, t, league)}
            onClick={() => onMarkWaReminder(m, reminderDueAt)} c={c} />
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
function PrizeBreakdownPanel({ league, c }) {
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

export function LeagueDetail({ league, session, isAdmin, joined, canSeePhones, myTeam, entryClosed, myPaymentStatus, blockedByLeague, myUsername, onBack, onJoin, onResubmitPayment, onDownloadProof, onReviewPayment, onMarkWaReminder, onRecordResult, onUpdateTeamPhone, onRemoveTeam, onUpdatePhoto, onUpdateDescription, onUpdateSchedule, onAdvance, onGenerateFixtures, onDelete, onShare, onLeave, onOpenSubmitResult, onDownloadResultProof, onApproveResult, onRejectResult, onRespondToResultSubmission, onPostComment, onDeleteComment, onToggleReaction, onToggleLeagueReaction, avatarByTeamId, c }) {
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
  // The opponent has 24 hours to confirm or dispute a submission themselves
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
  const inGroupStage = isGroupsKnockout && !league.final_stage_started;
  const inKnockoutBracket = isKnockout || (isGroupsKnockout && league.final_stage_started);

  const stageFixtures = (isSurvivor || isGroupsKnockout) ? league.fixtures.filter((f) => f.stage === league.current_stage) : league.fixtures;
  const displayTeams = isSurvivor ? league.teams.filter((t) => !t.eliminated) : league.teams;
  const standings = useMemo(() => computeStandings(displayTeams, stageFixtures), [displayTeams, stageFixtures]);
  const totalRounds = Math.max(...stageFixtures.map((f) => f.round), 0);
  const groupStageFixtures = isGroupsKnockout ? league.fixtures.filter((f) => f.stage === 1) : [];
  const groupStageDone = groupStageFixtures.length > 0 && groupStageFixtures.every((f) => f.played || isExpired(f));

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
          <LeagueScheduleLine league={league} canManage={canManage} onUpdateSchedule={onUpdateSchedule} c={c} />
        </div>
        {!joined && !entryClosed && !blockedByLeague && <button onClick={onJoin} className="shrink-0 flex items-center gap-1.5 font-body font-semibold text-sm px-4 py-2 rounded-full" style={{ background: c.accent, color: c.accentText }}><Users size={14} /> Join</button>}
        {!joined && !entryClosed && blockedByLeague && (
          <span title={`Active in "${blockedByLeague.name}" — finish or get eliminated there first`}
            className="shrink-0 font-mono text-[10px] uppercase tracking-wider px-2 py-1.5 rounded" style={{ background: c.surfaceHover, color: c.textFaint }}>
            Locked · active in "{blockedByLeague.name}"
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

      <LeagueStatusBanner league={league} notStarted={notStarted} myTeam={myTeam} c={c} />

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
                    onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment} onMarkWaReminder={onMarkWaReminder} c={c} />
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
          {awaitingOpponentResults.length} result{awaitingOpponentResults.length === 1 ? "" : "s"} still within the opponent's 24h confirmation window
          {" — "}lands here for your review only if they don't respond in time.
        </div>
      )}

      {canManage && escalatedResults.length > 0 && (
        <PendingResultsPanel league={league} submissions={escalatedResults}
          title={`${escalatedResults.length} result${escalatedResults.length === 1 ? "" : "s"} needing review — opponent didn't confirm in time or disputed it repeatedly`}
          showEscalationReason
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
            Group stage · {league.groups_count} groups · {groupStageFixtures.filter((f) => f.played || isExpired(f)).length}/{groupStageFixtures.length} played · top {league.group_qualifiers} from each group advance
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
            ? <GroupTables league={league} groupStageFixtures={groupStageFixtures} avatarByTeamId={avatarByTeamId} c={c} />
            : <StandingsPanel standings={standings} zoneFor={zoneFor} stageFixtures={stageFixtures} isSurvivor={isSurvivor} league={league} avatarByTeamId={avatarByTeamId} c={c} />}
          <CommentsSection league={league} session={session} canComment={joined || canManage}
            comments={resultComments} heading="Results" icon={Trophy} allowCompose={false} showFindMyResults
            emptyText="No results posted yet — they'll show up here as matches are played."
            onPost={onPostComment} onDelete={onDeleteComment} onToggleReaction={onToggleReaction} myUsername={myUsername} c={c} />
        </div>
      )}

      {tab === "fixtures" && (
        <div className="space-y-6">
          {inGroupStage && canManage && (
            <GroupFixturesList league={league} groupStageFixtures={groupStageFixtures} canManage={canManage} joined={joined}
              getSubmission={submissionForFixture} onOpenSubmitResult={onOpenSubmitResult}
              onRecordResult={(fixture, h, a, file) => onRecordResult(league, fixture, h, a, file)} c={c} />
          )}
          {(inGroupStage || inKnockoutBracket) && joined && !canManage && myTeam && (
            <NextOpponentCard league={league} myTeam={myTeam} canSeePhones={canSeePhones} c={c} />
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
                    onRemoveTeam={onRemoveTeam} onDownloadProof={onDownloadProof} onReviewPayment={onReviewPayment} onMarkWaReminder={onMarkWaReminder} c={c} />
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

function CommentsSection({ league, session, canComment, onPost, onDelete, onToggleReaction, myUsername, c, comments, heading = "Comments", icon: HeadingIcon = MessageCircle, allowCompose = true, emptyText = "No comments yet — be the first to say something.", showFindMyResults = false }) {
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
function CommentNode({ comment, league, session, canComment, onPost, onDelete, onToggleReaction, c, depth }) {
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
function CommentRow({ comment: cm, league, session, canComment, onDelete, onToggleReaction, onReplyClick, c, isReply = false }) {
  const isOwn = session && cm.user_id === session.user.id;
  const isManager = cm.user_id === league.created_by;
  const realReactions = cm.comment_likes || [];
  const speakingId = useCommentSpeakingId();
  const isSpeaking = speakingId === cm.id;

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
            {!cm.pending && (isOwn || canComment) && (
              <button onClick={() => onDelete(cm, league)} title="Delete"
                className="opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: c.textFaint }}>
                <Trash2 size={11} />
              </button>
            )}
          </div>
        </div>
        {cm.body && <div className="font-body text-sm mt-0.5 whitespace-pre-wrap break-words">{cm.body}</div>}
        {cm.photo_url && (
          <button onClick={() => window.open(cm.photo_url, "_blank", "noopener,noreferrer")} className="block mt-2">
            <img src={cm.photo_url} alt="" loading="lazy" className="rounded-lg max-h-56 object-cover" style={{ border: `1px solid ${c.border}` }} />
          </button>
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

// What a regular joined player sees on the Fixtures tab instead of the full
// all-teams list (that stays admin-only, since that's the view used to
// record scores). Just their own club's next unplayed match, plus a
// WhatsApp icon to line up the game with the opponent — mirrors the "Up
// next" card on Home but scoped to this one league.
function NextOpponentCard({ league, myTeam, canSeePhones, c }) {
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

  return (
    <div className="rounded-xl p-4 border" style={{ background: c.surface, borderColor: c.border }}>
      <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2" style={{ color: c.textFaint }}>Your next match</div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate" style={{ color: c.text }}>vs {opponent?.name || "TBD"}</div>
          <div className="font-mono text-xs mt-1" style={{ color: isExpired(fixture) ? c.red : c.textDim }}>
            {isHome ? "Home" : "Away"} · Matchday {fixture.round}
            {isExpired(fixture) ? " · Expired" : fixture.due_at ? ` · Due ${fmtDate(fixture.due_at)}` : ""}
          </div>
        </div>
        {canSeePhones && opponent?.phone && (
          <WhatsAppCallLink phone={opponent.phone}
            text={`Hi, it's ${myTeam.name} 🔥 Call me when you're ready to play — matchday ${fixture.round} is due ${fmtDate(fixture.due_at)}, let's lock in the time ⚽🕹️${firstMatchdayNote(fixture.round)}`} c={c} />
        )}
      </div>
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

    // Survivor-format table lookup. Rank must be computed against the same
    // pool advanceSurvivor actually cuts from — active teams only — or an
    // already-eliminated club (which has zero fixtures in the current stage)
    // can tie its way to a deceptively "safe" looking rank near the top.
    if (team.eliminated) {
      setResult({ kind: "table", team, eliminated: true, standings: [], myRow: null, nextFixture: null, allTeams: league.teams });
      return;
    }
    const activeTeams = league.teams.filter((t) => !t.eliminated);
    const standings = computeStandings(activeTeams, stageFixtures).map((r, i) => ({ ...r, rank: i + 1 }));
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
                    {f.played ? `${f.home_score} – ${f.away_score}` : isExpired(f) ? <span style={{ color: c.red }}>Expired — loss, conceded 4</span> : `Due by ${fmtDate(f.due_at)}`}
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
            return (
              <div key={fixture.id} className="mt-3 pt-3 border-t" style={{ borderColor: c.border }}>
                <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textFaint }}>
                  {result.twoLegged ? `Leg ${fixture.leg}` : "Result"}
                  {fixture.played ? ` — ${fixture.home_score} – ${fixture.away_score}` : isExpired(fixture) ? " — expired, loss, conceded 4" : ` — due ${fmtDate(fixture.due_at)}`}
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
