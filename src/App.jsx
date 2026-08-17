--- a/src/App.jsx
+++ b/src/App.jsx
@@ -11470,14 +11470,14 @@
   }, [league.entry_closes_at, league.starts_at, league.round_period_hours]);
 
   const datesOutOfOrder = !isLadderCup && entryClosesAt && startsAt && new Date(startsAt) < new Date(entryClosesAt);
-  const roundPeriodValid = Number(roundPeriodHours) >= 1 && Number(roundPeriodHours) <= 720;
+  const roundPeriodValid = isLadderCup || (Number(roundPeriodHours) >= 1 && Number(roundPeriodHours) <= 720);
 
   const save = async () => {
     if ((!isLadderCup && !entryClosesAt) || !startsAt || datesOutOfOrder || (notStartedYet && !roundPeriodValid)) return;
     setSaving(true);
     await onUpdateSchedule(league, { entryClosesAt, startsAt });
     const newPeriod = Number(roundPeriodHours);
-    if (notStartedYet && newPeriod !== (league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS)) {
+    if (!isLadderCup && notStartedYet && newPeriod !== (league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS)) {
       await onUpdateRoundPeriod(league, newPeriod);
     }
     setSaving(false);
@@ -11505,7 +11505,7 @@
         {datesOutOfOrder && (
           <div className="font-mono text-[11px] mb-2" style={{ color: c.red }}>Start date must be on or after entry closes.</div>
         )}
-        {notStartedYet ? (
+        {!isLadderCup && (notStartedYet ? (
           <div className="mb-1.5">
             <label className="block font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: c.textDim }}>Hours per round (match due-date period)</label>
             <input type="number" min={1} max={720} value={roundPeriodHours} onChange={(e) => setRoundPeriodHours(e.target.value)} className="w-full sm:w-32 border rounded-lg px-3 py-2 font-mono text-sm outline-none" style={inputStyle} />
@@ -11517,7 +11517,7 @@
           <div className="font-mono text-[11px] mb-1.5" style={{ color: c.textFaint }}>
             Match due-date period ({league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS} hour{(league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS) === 1 ? "" : "s"}) is locked in — the league has already started.
           </div>
-        )}
+        ))}
         <div className="flex items-center gap-2 justify-end">
           <button onClick={() => { setEntryClosesAt(toDatetimeLocalValue(league.entry_closes_at)); setStartsAt(toDatetimeLocalValue(league.starts_at)); setRoundPeriodHours(league.round_period_hours || DEFAULT_ROUND_PERIOD_HOURS); setEditing(false); }}
             className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ color: c.textFaint }}>Cancel</button>
