import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import {
  ArrowLeft, Calendar, Camera, Check, Clock, CornerDownRight, Crown, Download,
  LogOut, MessageCircle, Pencil, Phone, ReceiptText, Search, Send, Settings2, Trash2,
  Trophy, Users, Volume2, X, XCircle,
} from "lucide-react";
import { toProxiedUrl } from "./utils/mediaUrl";
import {
  FORMATS, GroupFixturesList, GroupStageDueLine, GroupTables, KNOCKOUT_TIE_WINDOW_MS,
  KnockoutFixturesList, LeagueDescriptionBlock, LeagueMenu, LeaguePhotoBanner, LeagueReactionBar,
  LeagueScheduleLine, LeagueStatusBanner, MemberMessageEditor, MemberPaymentRow, ONE_DAY_MS,
  PendingResultsPanel, PrizeBreakdownPanel, REACTIONS, REACTION_EMOJI,
  RESULT_CONFIRM_WINDOW_MINUTES, RulesButton, StandingsPanel,
  VoiceNotePlayer, VoiceRecorderButton, WEEKEND_RESULT_CONFIRM_WINDOW_MINUTES, WhatsAppCallLink,
  WhatsAppLink, avatarColor, commentSpeech, computeStandings, findSubmissionOpponentId,
  firstMatchdayNote, fmtDate, groupLabel, isExpired, isFinalFixture, isFinalRoundFixtures,
  isFixtureLocked, isResultComment, isWaReminderActive, isWeekendLeague, knockoutRoundFixtures,
  nextFixtureForTeam, resultConfirmDeadline, resultEscalationReason, splitCommentsByRoot,
  timeAgo, useCommentSpeakingId, useVoiceRecorder, usesCustomMessage,
} from "./App.jsx";

// Split out of App.jsx (was the last ~1,555 lines of it): the full league
// detail screen (standings, fixtures, comments, payments, admin controls)
// is only ever rendered once a signed-in user taps into a specific league —
// never on the guest/login page — so it doesn't need to be in the bundle
// everyone downloads just to see the sign-in screen. Lazy-loaded from
// App.jsx the same way Shop/Terms/Rules already are.
const RulesModal = lazy(() => import("./Rules.jsx"));

export default function LeagueDetail({ league, session, isAdmin, joined, canSeePhones, myTeam, entryClosed, myPaymentStatus, blockedByLeague, myUsername, onBack, onJoin, onResubmitPayment, onDownloadProof, onReviewPayment, onMarkWaReminder, onClearWaReminder, onClearAllWaReminders, onUpdateMemberMessage, onNotifyAllMembers, onRecordResult, onUpdateTeamPhone, onRemoveTeam, onUpdatePhoto, onUpdateDescription, onUpdateSchedule, onUpdateRoundPeriod, onUpdateGroupStageDueAt, onAdvance, onGenerateFixtures, onDelete, onShare, onLeave, onOpenSubmitResult, onDownloadResultProof, onApproveResult, onRejectResult, onRespondToResultSubmission, onPostComment, onDeleteComment, onEditComment, onEditResult, onToggleReaction, onToggleLeagueReaction, avatarByTeamId, c }) {
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
  const knockoutChampion = inKnockoutBracket && stageDone && activeTeamsCount === 1 ? league.teams.find((t) => !t.eliminated) : null;
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
            canEditResults={canManage}
            onPost={onPostComment} onDelete={onDeleteComment} onEdit={onEditComment} onEditResult={onEditResult} onToggleReaction={onToggleReaction} myUsername={myUsername} c={c} />
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
              canSeePhones={canSeePhones} onRecordResult={(fixture, h, a, file) => onRecordResult(league, fixture, h, a, file)} league={league} c={c} />
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

function CommentsSection({ league, session, canComment, onPost, onDelete, onEdit, onEditResult, canEditResults = false, onToggleReaction, myUsername, c, comments, heading = "Comments", icon: HeadingIcon = MessageCircle, allowCompose = true, emptyText = "No comments yet — be the first to say something.", showFindMyResults = false }) {
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
              onPost={onPost} onDelete={onDelete} onEdit={onEdit} onEditResult={onEditResult} canEditResults={canEditResults} onToggleReaction={onToggleReaction} c={c} depth={0} />
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
function CommentNode({ comment, league, session, canComment, onPost, onDelete, onEdit, onEditResult, canEditResults = false, onToggleReaction, c, depth }) {
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
        onDelete={onDelete} onEdit={onEdit} onEditResult={onEditResult} canEditResults={canEditResults} onToggleReaction={onToggleReaction} c={c} isReply={depth > 0}
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
              onPost={onPost} onDelete={onDelete} onEdit={onEdit} onEditResult={onEditResult} canEditResults={canEditResults} onToggleReaction={onToggleReaction} c={c} depth={depth + 1} />
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
function CommentRow({ comment: cm, league, session, canComment, onDelete, onEdit, onEditResult, canEditResults = false, onToggleReaction, onReplyClick, c, isReply = false }) {
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
  const homeTeamName = linkedFixture ? (league.teams.find((t) => t.id === linkedFixture.home_team_id)?.name || "Home") : null;
  const awayTeamName = linkedFixture ? (league.teams.find((t) => t.id === linkedFixture.away_team_id)?.name || "Away") : null;

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
    }
    setEditing(true);
  };
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
            {linkedFixture ? (
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
                disabled={savingEdit || (linkedFixture ? (editHomeScore === "" || editAwayScore === "") : !editText.trim())}
                className="font-body text-[11px] font-semibold px-2.5 py-1 rounded-full"
                style={{ background: c.accent, color: c.accentText, opacity: (savingEdit || (linkedFixture ? (editHomeScore === "" || editAwayScore === "") : !editText.trim())) ? 0.5 : 1 }}>
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

function OpponentFinder({ teams, fixtures, totalRounds, canManage, joined, getSubmission, onOpenSubmitResult, canSeePhones, onRecordResult, league, c }) {
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
