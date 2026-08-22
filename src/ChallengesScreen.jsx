import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import {
  AlertTriangle, ArrowLeft, Camera, Check, Clock, CornerDownRight, History,
  MessageCircle, Pencil, Search, Send, Shuffle, Swords, Trash2, Trophy, Volume2, X,
} from "lucide-react";
import { supabase } from "./supabaseClient";
import {
  ChallengeBoard, ChallengeChatModal, ChallengeRow, CommunityResultRow,
  Loader, MemberAvatar, REACTIONS, REACTION_EMOJI, RulesButton, VoiceNotePlayer,
  VoiceRecorderButton, WhatsAppCallLink, WhatsAppLink, avatarColor, challengeResultConfirmExpired,
  challengeResultMinutesLeft, commentSpeech, isCommunityResultEscalated, ladderDaysLeft, timeAgo,
  useCommentSpeakingId, useVoiceRecorder,
} from "./App.jsx";

// Split out of App.jsx: the Challenges/Board screen (community board, open
// challenges, 1-on-1 challenge rows and chat) is only ever rendered once a
// signed-in user opens it from the header — never on the guest/login page —
// so it doesn't need to be in the bundle everyone downloads just to see the
// sign-in screen. Lazy-loaded from App.jsx the same way Shop/Terms/Rules/
// LeagueDetail already are.
const RulesModal = lazy(() => import("./Rules.jsx"));

export default function ChallengesScreen({ session, members, challenges, openChallenges, recentResults, boardComments, isAdmin, accounts, myUsername, onPostBoardComment, onDeleteBoardComment, onToggleBoardCommentReaction, onSendChallenge, onAccept, onDecline, onRemove, onOpenLogResult, onConfirmResult, onDisputeResult, onOpenLogResultOpen, onConfirmResultOpen, onDisputeResultOpen, onAdminApproveResult, onAdminRejectResult, onAdminApproveResultOpen, onAdminRejectResultOpen, onAdminEditResult, onAdminEditResultOpen, onAdminGrantLadderWalkover, onAdminCancelLadderChallenge, onViewResultProof, onSendRandom, onAcceptOpen, onCancelOpen, onRemoveOpen, onBack, showToast, c }) {
  const [query, setQuery] = useState("");
  const [sendingTo, setSendingTo] = useState(null);
  const [sendingRandom, setSendingRandom] = useState(false);
  const [resultsQuery, setResultsQuery] = useState("");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [chatModal, setChatModal] = useState(null); // { challengeId, kind, counterpartUsername } — in-site chat with a matched opponent

  // Admin-only: phone numbers for the WhatsApp icon on escalated results
  // below, keyed by user id — sourced from the accounts list (only ever
  // loaded/passed for an admin; see openChallengesScreen in App.jsx), never
  // from `members`, which deliberately excludes phone numbers since every
  // signed-in player can see that list to pick an opponent.
  //
  // Hoisted above the loading-state early return below: hooks must run in
  // the same order on every render, and this was previously declared after
  // that return, so the very first render (members/challenges still null)
  // called 6 hooks while a later render, once data arrived, called 7 —
  // React error #310 ("rendered fewer hooks than expected").
  const phoneByUserId = useMemo(() => {
    const map = {};
    (accounts || []).forEach((a) => { if (a.phone) map[a.user_id] = a.phone; });
    return map;
  }, [accounts]);

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

  // Admin-only: phone numbers for the WhatsApp icon on escalated results
  // below — see the hoisted useMemo near the top of the component for why
  // this moved up above the loading-state early return.

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

  // Admin-only: pull escalated (past the opponent's confirm window, still
  // unconfirmed) rows out of the Community results feed into their own
  // section up top, instead of leaving them scattered — in red — among a
  // hundred confirmed results an admin has to scroll past to spot them.
  // Non-admins keep seeing the flat feed exactly as before, escalated rows
  // still highlighted in place.
  const escalatedCommunityResults = isAdmin ? filteredResults.filter(isCommunityResultEscalated) : [];
  // Random (open) challenge results that haven't been approved yet — either
  // still inside the opponent's confirm window, or past it and sitting in
  // the escalated section above — don't belong in the general history feed
  // below; only an approved/confirmed random result counts as history.
  // Direct challenges are unaffected and keep showing their "Awaiting
  // confirmation" state inline, same as before.
  const nonEscalatedCommunityResults = filteredResults.filter((r) => {
    if (isAdmin && isCommunityResultEscalated(r)) return false;
    if (r.kind === "open" && !r.confirmed) return false;
    return true;
  });
  // Lookup so the escalated rows above can be rendered with real
  // approve/reject/edit-score/view-proof actions (via AdminEscalatedResultRow,
  // the same row the top-of-page review box uses) instead of the inert
  // read-only CommunityResultRow — matched back to the actual challenge/open
  // challenge record by id, since the community-results view only carries
  // display fields, not the row an action can be taken against.
  const challengesById = new Map(challenges.map((ch) => [ch.id, ch]));
  const openChallengesById = new Map((openChallenges || []).map((ch) => [ch.id, ch]));

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
                reporterPhone={phoneByUserId[ch.result_reported_by]}
                onApprove={() => onAdminApproveResult(ch)} onReject={() => onAdminRejectResult(ch)}
                onEditScore={(a, b) => onAdminEditResult(ch, a, b)} onViewProof={() => onViewResultProof(ch)} c={c} />
            ))}
            {escalatedOpenChallenges.map((ch) => (
              <AdminEscalatedResultRow key={`oc-${ch.id}`} nameA={ch.creator_username} nameB={ch.accepted_by_username}
                scoreA={ch.creator_score} scoreB={ch.accepted_by_score} reportedByUsername={ch.result_reported_by === ch.creator_id ? ch.creator_username : ch.accepted_by_username}
                reporterPhone={phoneByUserId[ch.result_reported_by]}
                onApprove={() => onAdminApproveResultOpen(ch)} onReject={() => onAdminRejectResultOpen(ch)}
                onEditScore={(a, b) => onAdminEditResultOpen(ch, a, b)} onViewProof={() => onViewResultProof(ch)} c={c} />
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
        <div className="flex flex-col gap-2 max-h-[23rem] overflow-y-auto pr-0.5">
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
            <>
              {escalatedCommunityResults.length > 0 && (
                <div className="rounded-xl p-3 border mb-2.5" style={{ background: "rgba(220,38,38,0.06)", borderColor: c.red }}>
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2 flex items-center gap-1.5" style={{ color: c.red }}>
                    <AlertTriangle size={12} /> Escalated — awaiting admin review ({escalatedCommunityResults.length})
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {escalatedCommunityResults.map((r) => {
                      const ch = r.kind === "open" ? openChallengesById.get(r.id) : challengesById.get(r.id);
                      if (!ch) return <CommunityResultRow key={`${r.kind}-${r.id}`} result={r} myId={myId} c={c} />;
                      if (r.kind === "open") {
                        return (
                          <AdminEscalatedResultRow key={`oc-${ch.id}`} nameA={ch.creator_username} nameB={ch.accepted_by_username}
                            scoreA={ch.creator_score} scoreB={ch.accepted_by_score}
                            reportedByUsername={ch.result_reported_by === ch.creator_id ? ch.creator_username : ch.accepted_by_username}
                            reporterPhone={phoneByUserId[ch.result_reported_by]}
                            onApprove={() => onAdminApproveResultOpen(ch)} onReject={() => onAdminRejectResultOpen(ch)}
                            onEditScore={(a, b) => onAdminEditResultOpen(ch, a, b)} onViewProof={() => onViewResultProof(ch)} c={c} />
                        );
                      }
                      return (
                        <AdminEscalatedResultRow key={`ch-${ch.id}`} nameA={ch.challenger_username} nameB={ch.opponent_username}
                          scoreA={ch.challenger_score} scoreB={ch.opponent_score}
                          reportedByUsername={ch.result_reported_by === ch.challenger_id ? ch.challenger_username : ch.opponent_username}
                          reporterPhone={phoneByUserId[ch.result_reported_by]}
                          onApprove={() => onAdminApproveResult(ch)} onReject={() => onAdminRejectResult(ch)}
                          onEditScore={(a, b) => onAdminEditResult(ch, a, b)} onViewProof={() => onViewResultProof(ch)} c={c} />
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-col gap-1.5 max-h-[28rem] overflow-y-auto pr-0.5">
                {nonEscalatedCommunityResults.map((r) => <CommunityResultRow key={`${r.kind}-${r.id}`} result={r} myId={myId} c={c} />)}
              </div>
            </>
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
function AdminEscalatedResultRow({ nameA, nameB, scoreA, scoreB, reportedByUsername, reporterPhone, onApprove, onReject, onEditScore, onViewProof, c }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); await fn(); setBusy(false); };
  const reporterWhatsAppText = `Hi ${reportedByUsername}, your reported result — ${nameA} ${scoreA} – ${scoreB} ${nameB} — is with me for approval now. I'll get to it shortly.`;

  // Lets an admin correct a mis-typed score before approving/rejecting —
  // same inline number-input pattern as the league Results tab's score
  // editor (CommentRow in LeagueDetail.jsx), just without the
  // fixture/standings recompute that one needs, since this result hasn't
  // been confirmed yet.
  const [editing, setEditing] = useState(false);
  const [editA, setEditA] = useState("");
  const [editB, setEditB] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const startEdit = () => { setEditA(String(scoreA ?? "")); setEditB(String(scoreB ?? "")); setEditing(true); };
  const saveEdit = async () => {
    const a = parseInt(editA, 10);
    const b = parseInt(editB, 10);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return;
    setSavingEdit(true);
    const ok = await onEditScore(a, b);
    setSavingEdit(false);
    if (ok) setEditing(false);
  };

  return (
    <div className="rounded-lg p-3 border flex items-center gap-3" style={{ background: c.surface, borderColor: c.border }}>
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-body text-xs truncate" style={{ color: c.textDim, maxWidth: 90 }}>{nameA}</span>
            <input type="number" min="0" inputMode="numeric" value={editA} autoFocus
              onChange={(e) => setEditA(e.target.value)}
              className="w-12 rounded-lg px-1.5 py-1 font-mono text-sm text-center outline-none"
              style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
            <span className="font-body text-xs" style={{ color: c.textFaint }}>–</span>
            <input type="number" min="0" inputMode="numeric" value={editB}
              onChange={(e) => setEditB(e.target.value)}
              className="w-12 rounded-lg px-1.5 py-1 font-mono text-sm text-center outline-none"
              style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
            <span className="font-body text-xs truncate" style={{ color: c.textDim, maxWidth: 90 }}>{nameB}</span>
            <div className="flex items-center gap-2 w-full mt-0.5">
              <button onClick={saveEdit} disabled={savingEdit || editA === "" || editB === ""}
                className="font-body text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{ background: c.accent, color: c.accentText, opacity: (savingEdit || editA === "" || editB === "") ? 0.5 : 1 }}>
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
          <>
            <div className="font-body text-sm font-semibold truncate">{nameA} {scoreA} – {scoreB} {nameB}</div>
            <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: c.textFaint }}>Reported by {reportedByUsername}</div>
          </>
        )}
      </div>
      {!editing && (
        <>
          {reporterPhone && (
            <WhatsAppLink phone={reporterPhone} text={reporterWhatsAppText} iconOnly
              title={`Message ${reportedByUsername} about this result`} c={c} />
          )}
          <button onClick={startEdit} title="Edit score" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}><Pencil size={14} /></button>
          <button onClick={onViewProof} title="View photo proof" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}><Camera size={14} /></button>
          <button onClick={() => run(onApprove)} disabled={busy} title="Approve" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.accent, color: c.accentText }}><Check size={14} /></button>
          <button onClick={() => run(onReject)} disabled={busy} title="Reject" className="w-8 h-8 flex items-center justify-center rounded-full shrink-0" style={{ background: c.surfaceHover, color: c.textFaint }}><X size={14} /></button>
        </>
      )}
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

