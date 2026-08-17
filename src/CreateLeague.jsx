import React, { useState } from "react";
import { ArrowLeft, Calendar, Layers, Trophy, Zap } from "lucide-react";
import {
  DEFAULT_ROUND_PERIOD_HOURS, ENTRY_FEE_MAX, ENTRY_FEE_MIN,
  FORMATS, ONE_DAY_MS, formatRand, nextSundayCutoffSAST, toDatetimeLocalValue, weekendWindow,
} from "./App.jsx";

// Split out of App.jsx: the "create a new league" form is only ever opened
// when a signed-in admin/organizer starts a new league - never on first
// load, and never by most visitors at all. Lazy-loaded the same way
// Shop/Terms/Rules/LeagueDetail/ChallengesScreen already are.

export default function CreateLeague({ onCancel, onCreate, isAdmin, c }) {
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
  const [ladderCupCutoffAt, setLadderCupCutoffAt] = useState("");
  const [roundPeriodHours, setRoundPeriodHours] = useState(DEFAULT_ROUND_PERIOD_HOURS);
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
  // Survival Ladder Cup has no entry-close date of its own — clubs join
  // until the ladder's own weekly cutoff, set below — so the generic
  // entry-closes field is hidden and unrequired for this format.
  const isLadderCup = format === "ladder_cup";
  const datesOutOfOrder = !isLadderCup && entryClosesAt && startsAt && new Date(startsAt) < new Date(entryClosesAt);
  const roundPeriodValid = isLadderCup || (Number(roundPeriodHours) >= 1 && Number(roundPeriodHours) <= 720);
  const ladderCupValid = format !== "ladder_cup" || !!ladderCupCutoffAt;
  const canCreate = name.trim().length > 0 && (teamNames.length === 0 || teamNames.length >= 2) && teamNameDupes.length === 0 && teamNameMultiWord.length === 0 && survivorValid && groupsValid && ladderCupValid && (isLadderCup || entryClosesAt) && startsAt && !datesOutOfOrder && roundPeriodValid;
  const inputStyle = { background: c.surface, borderColor: c.border, color: c.text };

  // Weekend League is a shortcut, not a separate field: whether a league
  // shows up in the homepage's Weekend League spotlight is (and stays)
  // fully derived from its starts_at falling on the coming Fri–Sun, plus
  // created_by_admin. This just fills the date pickers with a sensible
  // Saturday-noon kickoff so admins don't have to work the date out by
  // hand, and confirms the result live under the fields — so the state
  // driving eligibility and the state telling the admin about it can never
  // drift apart.
  const [wkStart, wkEnd] = weekendWindow();
  const setWeekendLeagueDates = () => {
    const saturdayNoon = new Date(wkStart.getTime() + ONE_DAY_MS);
    saturdayNoon.setHours(12, 0, 0, 0);
    setStartsAt(toDatetimeLocalValue(saturdayNoon));
    if (!entryClosesAt) {
      const fridayEvening = new Date(wkStart);
      fridayEvening.setHours(18, 0, 0, 0);
      setEntryClosesAt(toDatetimeLocalValue(fridayEvening));
    }
  };
  const willBeWeekendLeague = isAdmin && startsAt && new Date(startsAt) >= wkStart && new Date(startsAt) <= wkEnd;

  // Fills the Ladder Cup cutoff picker with the ruleset's default — the
  // upcoming Sunday 10PM SAST — the same "quick-set, still overridable"
  // pattern as Set as Weekend League above. Doesn't touch entryClosesAt/
  // startsAt; those are the generic registration-window fields every format
  // uses, separate from ladder_cup's own weekly cutoff.
  const setDefaultLadderCupCutoff = () => setLadderCupCutoffAt(toDatetimeLocalValue(nextSundayCutoffSAST()));

  const submit = () => {
    onCreate({
      name: name.trim(), teamNames, format,
      survivor: format === "survivor" ? { matchesPerStage: Number(matchesPerStage), eliminationPercent: Number(eliminationPercent), targetCount: Number(targetCount), finalFormat } : null,
      groups: format === "groups_knockout" ? { groupSize: Number(groupSize), qualifiersPerGroup: Number(qualifiersPerGroup) } : null,
      knockoutLegs: (format === "knockout" || format === "groups_knockout") ? Number(knockoutLegs) : 1,
      ladderCupCutoffAt: format === "ladder_cup" ? new Date(ladderCupCutoffAt).toISOString() : null,
      entryClosesAt: format === "ladder_cup" ? null : new Date(entryClosesAt).toISOString(),
      startsAt: new Date(startsAt).toISOString(),
      roundPeriodHours: Number(roundPeriodHours),
      description: description.trim(),
      leagueType: isAdmin ? leagueType : "fun",
    });
  };

  return (
    <div className="pt-10">
      <button onClick={onCancel} className="flex items-center gap-1.5 font-body text-sm mb-6" style={{ color: c.textDim }}><ArrowLeft size={15} /> Back</button>
      <h1 className="text-3xl font-extrabold uppercase tracking-tight mb-1">New league</h1>
      <p className="font-body mb-6 text-sm" style={{ color: c.textDim }}>Fixtures are generated automatically based on the format you pick. Each match gets a set number of hours to be played once it opens — configurable below.</p>

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

      <div className={`grid grid-cols-1 ${isLadderCup ? "" : "sm:grid-cols-2"} gap-3 mb-1.5`}>
        {!isLadderCup && (
          <div>
            <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Entry closes</label>
            <input type="datetime-local" value={entryClosesAt} onChange={(e) => setEntryClosesAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
          </div>
        )}
        <div>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>League starts</label>
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-full border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
        </div>
      </div>
      {isLadderCup && (
        <div className="font-mono text-xs mb-1.5" style={{ color: c.textFaint }}>Survival Ladder Cup has no entry-close date — clubs can join anytime until the ladder's own weekly cutoff, set below.</div>
      )}
      {isAdmin && (
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <button onClick={setWeekendLeagueDates} className="flex items-center gap-1.5 font-mono text-[11px] font-semibold px-3 py-1.5 rounded-full transition-transform active:scale-95"
            style={{ background: `${c.accent}1A`, color: c.accent, border: `1px dashed ${c.accent}66` }}>
            <Calendar size={11} /> Set as Weekend League
          </button>
          {willBeWeekendLeague && (
            <span className="flex items-center gap-1 font-mono text-[11px] font-semibold" style={{ color: c.accent }}>
              <Zap size={11} /> Will be featured in Weekend Leagues
            </span>
          )}
        </div>
      )}
      {datesOutOfOrder && (
        <div className="font-mono text-xs mb-5" style={{ color: c.red }}>Start date must be on or after entry closes — otherwise the league would kick off before anyone's finished joining.</div>
      )}
      {!datesOutOfOrder && <div className="mb-1.5" />}

      {!isLadderCup && (
        <>
          <label className="block font-mono text-xs uppercase tracking-wider mb-2" style={{ color: c.textDim }}>Hours per round (match due-date period)</label>
          <input type="number" min={1} max={720} value={roundPeriodHours} onChange={(e) => setRoundPeriodHours(e.target.value)} className="w-full sm:w-40 border rounded-lg px-3 py-2.5 font-mono text-sm outline-none mb-1.5" style={inputStyle} />
          {!roundPeriodValid && (
            <div className="font-mono text-xs mb-5" style={{ color: c.red }}>Enter a number of days between 1 and 30.</div>
          )}
          {roundPeriodValid && <div className="mb-5" />}
        </>
      )}

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
              ? "Each tie is played twice — once at each club's home. Aggregate score decides the winner; a level aggregate sends both clubs through to the next round. The final is always a single decisive match, with penalties if it's level."
              : "Each tie is a single, decisive match. A draw goes to penalties — but only in the final; earlier rounds send both clubs through instead."}
          </div>
        </div>
      )}

      {format === "ladder_cup" && (
        <div className="rounded-lg p-4 border mb-5" style={{ background: c.surface, borderColor: c.border }}>
          <div className="font-mono text-xs uppercase tracking-[0.2em] mb-3 flex items-center gap-1.5" style={{ color: c.textFaint }}><Layers size={12} /> Ladder Cup cutoff</div>
          <div className="font-body text-xs mb-3" style={{ color: c.textFaint }}>
            Standings freeze and the champion is crowned at this deadline each week — the ruleset default is Sunday 10PM SAST, but you can set any date/time.
          </div>
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <button type="button" onClick={setDefaultLadderCupCutoff} className="flex items-center gap-1.5 font-mono text-[11px] font-semibold px-3 py-1.5 rounded-full transition-transform active:scale-95"
              style={{ background: `${c.accent}1A`, color: c.accent, border: `1px dashed ${c.accent}66` }}>
              <Calendar size={11} /> Set to this week's Sun 10PM
            </button>
          </div>
          <input type="datetime-local" value={ladderCupCutoffAt} onChange={(e) => setLadderCupCutoffAt(e.target.value)} className="w-full sm:w-64 border rounded-lg px-3 py-2.5 font-mono text-sm outline-none" style={inputStyle} />
          {!ladderCupCutoffAt && (
            <div className="font-mono text-xs mt-1.5" style={{ color: c.red }}>Set a cutoff date/time before creating the league.</div>
          )}
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
