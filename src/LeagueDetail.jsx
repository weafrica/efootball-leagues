--- a/src/LeagueDetail.jsx
+++ b/src/LeagueDetail.jsx
@@ -54,7 +54,7 @@
 
 const LADDER_CUP_STATUS_LABEL = {
   active: "Active", pending_second_life: "Second life pending",
-  eliminated: "Eliminated", champion: "Champion",
+  eliminated: "Eliminated", champion: "Champion", survived: "Survived",
 };
 
 // Step 13: shown once App.jsx's lazy finalize-on-read effect has set
@@ -259,6 +259,13 @@
 
   const mapped = useMemo(() => toLadderCupEngineEntries(league), [league]);
   const standings = useMemo(() => rankLadderCupStandings(mapped), [mapped]);
+  // Once the cutoff's lazy finalize-on-read effect has run (see App.jsx),
+  // a surviving club's row.status is still "active" in the DB — that flag
+  // only ever meant "not eliminated yet", so it stays true forever once
+  // the cup's over. The table should stop calling that "Active" once
+  // there's nothing left to be active *in* — everyone still standing is
+  // shown as having survived to the end instead.
+  const isFinalized = !!league.ladder_cup_finalized_at;
 
   if (standings.length === 0) {
     return <div className="border border-dashed rounded-2xl p-8 text-center font-body" style={{ borderColor: c.borderStrong, color: c.textDim }}>No one's registered yet — share the league so players can join.</div>;
@@ -283,7 +290,8 @@
   const shareRows = standings.map((r) => ({
     rank: r.rank_position, name: r.club_name, p: r._row.w + r._row.l, w: r._row.w, l: r._row.l,
     gd: r.gd, streak: r._row.streak, pts: r.pts, eliminated: r._row.status === "eliminated",
-    statusLabel: r._row.status !== "active" && r._row.status !== "eliminated" ? LADDER_CUP_STATUS_LABEL[r._row.status] : null,
+    statusLabel: r._row.status !== "active" && r._row.status !== "eliminated" ? LADDER_CUP_STATUS_LABEL[r._row.status]
+      : isFinalized && r._row.status === "active" ? LADDER_CUP_STATUS_LABEL.survived : null,
   }));
 
   return (
@@ -304,7 +312,9 @@
       </div>
       {shareOpen && (
         <ShareRangeModal onClose={() => setShareOpen(false)} kicker="Survival Ladder Cup" title={league.name}
-          subtitle={`${standings.filter((r) => r._row.status !== "eliminated").length} of ${standings.length} clubs still active`}
+          subtitle={isFinalized
+            ? `${standings.filter((r) => r._row.status !== "eliminated").length} of ${standings.length} clubs survived to the end`
+            : `${standings.filter((r) => r._row.status !== "eliminated").length} of ${standings.length} clubs still active`}
           rows={shareRows} columns={LADDER_CUP_SHARE_COLUMNS} c={c} />
       )}
 
@@ -352,7 +362,8 @@
                   pending_second_life: { color: "#B8860B", bg: "rgba(184,134,11,0.15)", icon: Heart },
                   champion: { color: c.accent, bg: `${c.accent}26`, icon: Crown },
                   active: { color: c.greenText, bg: c.greenSoft, icon: Shield },
-              }[row.status] || { color: c.textFaint, bg: "transparent", icon: Shield };
+                  survived: { color: c.textFaint, bg: c.surfaceHover, icon: Check },
+              }[isFinalized && row.status === "active" ? "survived" : row.status] || { color: c.textFaint, bg: "transparent", icon: Shield };
               return (
                 <tr key={r.club_id} role="button" tabIndex={0} onClick={() => setProfileRow(r)} onKeyDown={(e) => { if (e.key === "Enter") setProfileRow(r); }}
                   className="border-b align-top cursor-pointer transition-colors active:brightness-125" style={{ borderColor: c.border, opacity: eliminated ? 0.45 : 1, height: LADDER_CUP_STANDINGS_ROW_HEIGHT, background: danger ? "rgba(200,30,58,0.06)" : onFire ? "rgba(240,160,32,0.05)" : myTeamId && r.club_id === myTeamId ? c.surfaceHover : "transparent" }}>
@@ -379,7 +390,7 @@
                   </div>
                   <div className="flex flex-wrap items-center gap-1 mt-0.5">
                     <div className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-[1px] rounded-full" style={{ color: statusChip.color, background: statusChip.bg }}>
-                      <statusChip.icon size={9} /> {LADDER_CUP_STATUS_LABEL[row.status] || row.status}
+                      <statusChip.icon size={9} /> {isFinalized && row.status === "active" ? LADDER_CUP_STATUS_LABEL.survived : (LADDER_CUP_STATUS_LABEL[row.status] || row.status)}
                     </div>
                     {/* Cosmetic matchmaking tier (see ladderCupTier) — a
                         "climbing the ranks" read that moves off
