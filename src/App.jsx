--- a/src/App.jsx
+++ b/src/App.jsx
@@ -2219,10 +2219,11 @@
 
 // Entry-fee + proof-of-payment modal for cash leagues. Used both for the initial
 // join and for resubmitting after a rejected payment (when `member` is set).
-function PaymentModal({ league, member, onCancel, onSubmit, c }) {
+function PaymentModal({ league, member, onCancel, onSubmit, onPayByCard, c }) {
   const [fee, setFee] = useState(clampFee(member?.entry_fee || 50));
   const [file, setFile] = useState(null);
   const [saving, setSaving] = useState(false);
+  const [cardSaving, setCardSaving] = useState(false);
   const inputStyle = { background: c.surfaceHover, borderColor: c.border, color: c.text };
   const isResubmit = !!member;
 
@@ -2233,6 +2234,13 @@
     setSaving(false);
   };
 
+  const submitCard = async () => {
+    if (cardSaving || isResubmit) return;
+    setCardSaving(true);
+    await onPayByCard(fee);
+    setCardSaving(false);
+  };
+
   return (
     <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-0 sm:px-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onCancel}>
       <div onClick={(e) => e.stopPropagation()} className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 max-h-[92vh] overflow-y-auto" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
@@ -2246,22 +2254,22 @@
         <div className="font-body text-sm mb-4" style={{ color: c.textDim }}>{league.name}</div>
 
         <div className="rounded-lg p-3 mb-3 font-body text-xs" style={{ background: c.surface, color: c.textDim }}>
-          {IKHOKHA_DETAILS.payLink && (
+          {IKHOKHA_DETAILS.payLink && !isResubmit && (
             <>
               <div className="flex items-center gap-2 mb-2">
                 <CreditCard size={14} style={{ color: c.accent }} />
                 <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Pay by card</span>
               </div>
-              <a href={IKHOKHA_DETAILS.payLink} target="_blank" rel="noopener noreferrer"
-                className="inline-flex items-center gap-1.5 font-body text-xs font-semibold px-3.5 py-2 rounded-full"
+              <button type="button" onClick={submitCard} disabled={cardSaving}
+                className="inline-flex items-center gap-1.5 font-body text-xs font-semibold px-3.5 py-2 rounded-full disabled:opacity-60"
                 style={{ background: c.accent, color: c.accentText }}>
-                <CreditCard size={13} /> Pay by card
-              </a>
+                <CreditCard size={13} /> {cardSaving ? "Starting checkout…" : "Pay by card"}
+              </button>
               <div className="mt-2">
                 <CardBrandsBadge c={c} />
               </div>
               <div className="font-body text-[10px] mt-1.5 mb-3" style={{ color: c.textFaint }}>
-                Opens a secure card checkout page. Still upload your receipt or confirmation screenshot below as proof.
+                Opens a secure card checkout page. You'll be joined automatically the moment payment is confirmed — no proof needed.
               </div>
             </>
           )}
@@ -5506,6 +5514,58 @@
     if (ok) setPaymentModal(null);
   };
 
+  // Card payments skip the proof-upload + admin-review flow entirely: a
+  // pending member row is created immediately, iKhokha's webhook flips it
+  // straight to "approved" the instant the card payment succeeds.
+  const handlePayByCard = async (fee) => {
+    if (!paymentModal) return;
+    const { league } = paymentModal;
+    if (league.format === "ladder_cup" && hasLadderCupCutoffPassed(league.ladder_cup_cutoff_at)) {
+      showToast("This Ladder Cup has already reached its cutoff — no new clubs can join.");
+      return;
+    }
+    if (entryClosed(league)) { showToast("Entry to this league has closed."); return; }
+    if (isMemberOf(league)) { showToast("You've already joined this league."); return; }
+
+    const result = await claimOrRegisterTeam(league);
+    if (result.error) return;
+
+    const feeNum = clampFee(fee);
+    const { data: memberRow, error } = await supabase.from("members").insert({
+      league_id: league.id, user_id: session.user.id,
+      display_name: profile.efootball_username, phone: profile.phone,
+      team_id: result.team ? result.team.id : null,
+      entry_fee: feeNum, payment_status: "pending",
+    }).select().single();
+
+    if (error) {
+      showToast("Couldn't start registration — you may already be a member.");
+      return;
+    }
+
+    const { data: { session: currentSession } } = await supabase.auth.getSession();
+    const response = await fetch(
+      "https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/create-entry-payment",
+      {
+        method: "POST",
+        headers: {
+          "Content-Type": "application/json",
+          Authorization: `Bearer ${currentSession.access_token}`,
+        },
+        body: JSON.stringify({ member_id: memberRow.id }),
+      }
+    );
+
+    const data = await response.json();
+    if (!response.ok) {
+      showToast(data.error || "Couldn't start card payment. Please try again.");
+      return;
+    }
+
+    showToast("Redirecting to secure card checkout — you'll be joined automatically once payment confirms.");
+    window.location.href = data.paylinkUrl;
+  };
+
   // Admin/creator only — downloads via a short-lived signed URL since the bucket is private.
   const downloadPaymentProof = async (member) => {
     if (!member.payment_proof_path) { showToast("No proof of payment on file for this member."); return; }
@@ -6879,7 +6939,7 @@
       </main>
       {paymentModal && (
         <PaymentModal league={paymentModal.league} member={paymentModal.member}
-          onCancel={() => setPaymentModal(null)} onSubmit={handlePaymentModalSubmit} c={c} />
+          onCancel={() => setPaymentModal(null)} onSubmit={handlePaymentModalSubmit} onPayByCard={handlePayByCard} c={c} />
       )}
       {resultModal && (
         <SubmitResultModal league={resultModal.league} fixture={resultModal.fixture} homeTeam={resultModal.homeTeam} awayTeam={resultModal.awayTeam} existing={resultModal.existing}
