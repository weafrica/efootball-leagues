import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import {
  AlertTriangle, ArrowLeft, Camera, Check, Clock, CornerDownRight, History,
  MessageCircle, Search, Send, Shuffle, Swords, Trash2, Trophy, Volume2, X,
} from "lucide-react";
import { supabase } from "./supabaseClient";
import {
  Loader, MemberAvatar, RulesButton, VoiceNotePlayer, VoiceRecorderButton,
  WhatsAppCallLink, avatarColor, challengeResultConfirmExpired,
  challengeResultMinutesLeft, commentSpeech, ladderDaysLeft, timeAgo,
  useCommentSpeakingId, useVoiceRecorder,
} from "./App.jsx";

// Split out of App.jsx: the Challenges/Board screen (community board, open
// challenges, 1-on-1 challenge rows and chat) is only ever rendered once a
// signed-in user opens it from the header — never on the guest/login page —
// so it doesn't need to be in the bundle everyone downloads just to see the
// sign-in screen. Lazy-loaded from App.jsx the same way Shop/Terms/Rules/
// LeagueDetail already are.
const RulesModal = lazy(() => import("./Rules.jsx"));

export default function ChallengesScreen({ session, members, challenges, openChallenges, recentResults, boardComments, isAdmin, myUsername, onPostBoardComment, onDeleteBoardComment, onToggleBoardCommentReaction, onSendChallenge, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onOpenLogResultOpen, onConfirmResultOpen, onDisputeResultOpen, onAdminApproveResult, onAdminRejectResult, onAdminApproveResultOpen, onAdminRejectResultOpen, onAdminGrantLadderWalkover, onAdminCancelLadderChallenge, onViewResultProof, onSendRandom, onAcceptOpen, onCancelOpen, onRemoveOpen, onBack, showToast, c }) {
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

  // Admin-only: results whose 30-minute opponent-confirm window has passed without
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
            <AlertTriangle size={13} /> Needs admin review — opponent didn't respond within the window
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
          {ch.status === "accepted" && ch.result_status === "pending" && !challengeResultConfirmExpired(ch) && (() => { const m = challengeResultMinutesLeft(ch); return m !== null && (
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: m <= 5 ? c.red : c.textFaint }}>
              {iReported ? `Goes to admin in ${m}m if they don't respond` : `Confirm within ${m}m or it goes to admin`}
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

// A pending challenge/open-challenge result that's blown past its 30-minute
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
