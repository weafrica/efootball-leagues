import React, { useState, useMemo, Suspense, lazy } from "react";
import {
  ArrowLeft, Camera, Crown, Download, Medal, Pause, Play, Search, Swords,
} from "lucide-react";
import {
  ChallengeBoard, ChallengeChatModal, ChallengeRow, LADDER_THEME, Loader,
  MemberAvatar, PlayerProfileModal, RulesButton, ShareRangeModal, timeAgo,
} from "./App.jsx";
import { LADDER_JOIN_FEE_NETS } from "./economy.js";
import { formatNets } from "./nets.js";

const RulesModal = lazy(() => import("./Rules.jsx"));

// Split out of App.jsx: the full permanent Ladder screen is only opened by
// a signed-in user tapping into it from the header or the home screen's
// LadderStrip preview - never on first load. Lazy-loaded the same way
// Shop/Terms/Rules/LeagueDetail/ChallengesScreen/CreateLeague/Leaderboard
// already are.
//
// LADDER_THEME stayed behind in App.jsx (and is exported here) because
// LadderStrip - the home screen's compact preview of the ladder - also
// needs it and must stay in the main bundle. ShareRangeModal (and its
// canvas-drawing helpers) also stayed behind and is exported, since
// StandingsPanel uses it too. SHARE_LADDER_COLUMNS only feeds this
// Ladder screen's share-image export, so it moved here in full.

const SHARE_LADDER_COLUMNS = [
  { key: "rank", label: "#", width: 70, align: "center", isRank: true },
  { key: "username", label: "Player", width: 438, align: "left", isName: true, get: (r) => r.username },
  { key: "wins", label: "W", width: 110, align: "center", get: (r) => String(r.wins) },
  { key: "draws", label: "D", width: 110, align: "center", get: (r) => String(r.draws) },
  { key: "losses", label: "L", width: 110, align: "center", get: (r) => String(r.losses) },
  { key: "points", label: "Pts", width: 130, align: "center", bold: true, get: (r) => String(r.points) },
];

// The full permanent ladder — every member, ordered by rank_position, with
// search-to-find and inline "Challenge" buttons on whichever (up to 3) rows
// the viewer is actually allowed to challenge right now. LadderStrip and the
// Ladder menu tile both land here; the pick-a-target sheet stays reachable
// from the CTA below for people who'd rather jump straight to it.
export default function LadderPage({ ladder, myLadderRank, targets, session, onOpenChallenge, onBack, onTogglePause, onJoinLadder, comments, isAdmin, myUsername, onPostComment, onDeleteComment, onToggleCommentReaction, recentMatches,
  challenges, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onViewResultProof, showToast, memberAvatars, myAvatarUrl }) {
  const c = LADDER_THEME; // the Ladder always renders in its own black/gold/red look, not the app's normal theme
  const [rulesOpen, setRulesOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chatModal, setChatModal] = useState(null); // { challengeId, kind, counterpartUsername } — in-site chat with a matched opponent
  const [profileRow, setProfileRow] = useState(null); // the ladder row currently shown in PlayerProfileModal, or null
  // Same platform-wide roster (and same "layer my own photo in separately"
  // trick) the Leaderboard uses — reused here purely as a lookup so tapping
  // a ladder row can show a real photo without this screen fetching
  // anything of its own.
  const avatarByUserId = useMemo(() => {
    const map = new Map();
    (memberAvatars || []).forEach((m) => { if (m.user_id) map.set(m.user_id, m.avatar_url || null); });
    if (session && myAvatarUrl) map.set(session.user.id, myAvatarUrl);
    return map;
  }, [memberAvatars, session, myAvatarUrl]);
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

  const handleJoin = async () => {
    if (joining) return;
    setJoining(true);
    try {
      await onJoinLadder();
    } finally {
      setJoining(false);
    }
  };

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
      <div key={row.user_id} role="button" tabIndex={0} onClick={() => setProfileRow(row)} onKeyDown={(e) => { if (e.key === "Enter") setProfileRow(row); }}
        className="flex items-center gap-3 rounded-lg px-4 py-2.5 cursor-pointer"
        style={{ background: isMe ? c.surfaceHover : c.surface, border: isMe ? `1px solid ${c.accent}` : "1px solid transparent" }}>
        {rankIdx >= 0 && rankIdx < 3 ? (
          <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${rankColors[rankIdx]}22`, border: `1px solid ${rankColors[rankIdx]}66` }}>
            {rankIdx === 0 ? <Crown size={13} style={{ color: rankColors[0] }} /> : <Medal size={13} style={{ color: rankColors[rankIdx] }} />}
          </span>
        ) : (
          <span className="w-7 h-7 text-center font-mono text-xs shrink-0 flex items-center justify-center" style={{ color: c.textFaint }}>#{row.rank_position}</span>
        )}
        <MemberAvatar url={avatarByUserId.get(row.user_id)} username={row.username} size={28} c={c} />
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
          <button onClick={(e) => { e.stopPropagation(); onOpenChallenge(); }} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}>
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

      {session && !myLadderRank && (
        <div className="rounded-xl px-4 py-3 mb-4 text-center" style={{ background: c.surfaceHover, border: `1px solid ${c.accent}55` }}>
          <div className="font-body text-sm mb-2.5" style={{ color: c.textDim }}>
            Not on the ladder yet — join for a one-time {formatNets(LADDER_JOIN_FEE_NETS)} fee.
          </div>
          <button onClick={handleJoin} disabled={joining}
            className="w-full flex items-center justify-center gap-1.5 font-body text-sm font-semibold px-3 py-2.5 rounded-lg disabled:opacity-50"
            style={{ background: c.accent, color: c.accentText }}>
            <Swords size={14} /> {joining ? "Joining..." : `Join Ladder — ${formatNets(LADDER_JOIN_FEE_NETS)}`}
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
                <div key={r.user_id} role="button" tabIndex={0} onClick={() => setProfileRow(r)} onKeyDown={(e) => { if (e.key === "Enter") setProfileRow(r); }}
                  className="flex items-center gap-2 shrink-0 rounded-xl pl-2 pr-3.5 py-2 cursor-pointer"
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
                    <button onClick={(e) => { e.stopPropagation(); onOpenChallenge(); }} className="ml-1 font-body text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}>
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
                  {/* Screenshot itself is never eagerly loaded/shown here — only the two
                      players involved and admins get a "view proof" action, which pulls
                      a fresh short-lived signed link on click. Everyone else (and even
                      the two players, for every OTHER match) sees just the plain icon. */}
                  {(session?.user?.id === m.challenger_id || session?.user?.id === m.opponent_id || isAdmin) ? (
                    <button type="button" onClick={() => onViewResultProof(m)} title="View screenshot"
                      className="w-10 h-10 rounded-md flex items-center justify-center shrink-0" style={{ background: c.surfaceHover, border: `1px solid ${c.border}` }}>
                      <Camera size={14} style={{ color: c.accent }} />
                    </button>
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

      {profileRow && (
        <PlayerProfileModal
          username={profileRow.username}
          avatarUrl={avatarByUserId.get(profileRow.user_id)}
          isMe={session && profileRow.user_id === session.user.id}
          rank={profileRow.rank_position}
          stats={[
            { label: "Points", value: profileRow.points },
            { label: "W · D · L", value: `${profileRow.wins} · ${profileRow.draws} · ${profileRow.losses}` },
          ]}
          onClose={() => setProfileRow(null)}
          c={c}
        />
      )}
    </div>
  );
}
