// Cash Ladder — player screen.
// Matches this repo's real conventions: takes `c` (theme) and `session` as
// props like PaymentModal/ChallengesScreen do, reuses the existing
// "payment-proofs" and "result-proofs" storage buckets, compressImage, and
// logActivity rather than inventing new ones.
//
// Mount this from App.jsx the same way other screens are mounted, e.g.:
//   <CashLadder session={session} profile={profile} c={c} onBack={() => setView("home")} />

import { useEffect, useState, useCallback } from "react";
import { Wallet, CreditCard, ChevronDown, Sparkles, ArrowLeft } from "lucide-react";
import { supabase } from "./supabaseClient";
import { compressImage } from "./utils/imageCompress";
import { logActivity } from "./activityLog";
import { BANK_DETAILS, MUKURU_DETAILS, CardBrandsBadge } from "./paymentConfig";

const goats = (n) => `${n}G`;
const rand = (n) => `R${Number(n).toLocaleString("en-ZA")}`;
const AMOUNT_PRESETS = [20, 50, 100, 200];

// Small, self-contained animation styles — kept local to this component so
// it doesn't depend on Tailwind config elsewhere having these defined.
function CashLadderStyles() {
  return (
    <style>{`
      @keyframes cl-pop { 0% { transform: scale(0.9); opacity: 0; } 60% { transform: scale(1.04); } 100% { transform: scale(1); opacity: 1; } }
      @keyframes cl-pulse-glow { 0%, 100% { box-shadow: 0 0 0 0 var(--cl-glow); } 50% { box-shadow: 0 0 22px 4px var(--cl-glow); } }
      @keyframes cl-shimmer { 0% { background-position: 0% 50%; } 100% { background-position: 200% 50%; } }
      @keyframes cl-fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      .cl-pop { animation: cl-pop 0.28s cubic-bezier(.2,1.4,.4,1); }
      .cl-fade-up { animation: cl-fade-up 0.25s ease-out; }
      .cl-glow-btn { animation: cl-pulse-glow 2.4s ease-in-out infinite; }
      .cl-shimmer-bg { background-size: 200% 200%; animation: cl-shimmer 6s ease-in-out infinite; }
      .cl-chip { transition: transform 0.15s ease, box-shadow 0.15s ease; }
      .cl-chip:active { transform: scale(0.94); }
      .cl-btn { transition: transform 0.15s ease, filter 0.15s ease; }
      .cl-btn:hover { filter: brightness(1.08); }
      .cl-btn:active { transform: scale(0.97); }
    `}</style>
  );
}

function Panel({ c, title, children, className = "" }) {
  return (
    <div className={`rounded-2xl p-4 mb-4 ${className}`} style={{ background: c.bg, border: `1px solid ${c.border}` }}>
      {title && (
        <h2 className="font-mono text-[10px] uppercase tracking-wider mb-3" style={{ color: c.textFaint }}>
          {title}
        </h2>
      )}
      {children}
    </div>
  );
}

function StatusPill({ c, status }) {
  const label = status.replace("_", " ");
  const tone =
    status === "paid" || status === "approved"
      ? c.accent
      : status === "rejected"
      ? "#ef4444"
      : c.textDim;
  return (
    <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ color: tone, background: c.surface }}>
      {label}
    </span>
  );
}

export default function CashLadder({ session, profile, c, onBack }) {
  const [wallet, setWallet] = useState({ balance: 0 });
  const [topups, setTopups] = useState([]);
  const [membership, setMembership] = useState(null);
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);

  const [amount, setAmount] = useState(50);
  const [customOpen, setCustomOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [scoreDrafts, setScoreDrafts] = useState({});

  const userId = session?.user?.id;
  const goatsPreview = Math.round(Number(amount || 0) * 3.8);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    const [{ data: walletRow }, { data: topupRows }, { data: memberRow }] = await Promise.all([
      supabase.from("cash_ladder_goats_wallet").select("balance").eq("user_id", userId).maybeSingle(),
      supabase
        .from("cash_ladder_goats_topups")
        .select("id, amount_rand, total_goats, payment_status, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("cash_ladder_memberships")
        .select("id, league_id, week_number, status, win_streak, cash_ladder_leagues(tier, current_season)")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle(),
    ]);

    setWallet(walletRow ?? { balance: 0 });
    setTopups(topupRows ?? []);
    setMembership(memberRow ?? null);

    if (memberRow?.league_id) {
      const { data: fixtureRows } = await supabase
        .from("cash_ladder_fixtures")
        .select("id, home_user_id, away_user_id, home_score, away_score, status, countdown_expires_at, leg")
        .eq("league_id", memberRow.league_id)
        .eq("week_number", memberRow.week_number)
        .or(`home_user_id.eq.${userId},away_user_id.eq.${userId}`)
        .order("countdown_expires_at", { ascending: true });
      setFixtures(fixtureRows ?? []);
    } else {
      setFixtures([]);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const submitTopup = async () => {
    if (!file || saving) { if (!file) setToast("Attach your proof of payment first."); return; }
    setSaving(true);
    try {
      const compressed = await compressImage(file, { maxDimension: 1600, quality: 0.85 });
      const ext = (file.name.split(".").pop() || "dat").toLowerCase();
      const path = `${userId}/cash-ladder-topup-${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("payment-proofs").upload(path, compressed, { cacheControl: "31536000" });
      if (uploadErr) throw uploadErr;
      logActivity("storage_upload", { bucket: "payment-proofs", context: "cash_ladder_topup", bytes: compressed.size ?? null });

      const { error: rpcErr } = await supabase.rpc("submit_cash_ladder_goats_topup", {
        p_amount_rand: Number(amount),
        p_checkout_method: "manual_proof",
        p_payment_proof_path: path,
        p_gateway_reference: null,
      });
      if (rpcErr) throw rpcErr;

      setToast(`Submitted \u2014 ${rand(amount)} pending admin approval.`);
      setFile(null);
      await load();
    } catch (e) {
      setToast(e.message ?? "Couldn't submit that top-up.");
    } finally {
      setSaving(false);
    }
  };

  const payByCard = async () => {
    if (saving) return;
    const randAmount = Number(amount);
    if (!randAmount || randAmount <= 0) { setToast("Enter an amount greater than R0."); return; }
    setSaving(true);
    try {
      const { data: topup, error: rpcErr } = await supabase.rpc("submit_cash_ladder_goats_topup", {
        p_amount_rand: randAmount,
        p_checkout_method: null,
        p_payment_proof_path: null,
        p_gateway_reference: null,
      });
      if (rpcErr) throw rpcErr;

      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const response = await fetch(
        "https://jobgzxljuczzqljwavyq.supabase.co/functions/v1/create-cash-ladder-payment",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentSession.access_token}` },
          body: JSON.stringify({ topup_id: topup.id }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        setToast(data.error || "Couldn't start card payment. Please try again.");
        return;
      }
      setToast("Redirecting to secure card checkout \u2014 you'll be topped up automatically once payment confirms.");
      window.location.href = data.paylinkUrl;
    } catch (e) {
      setToast(e.message ?? "Couldn't start card payment.");
    } finally {
      setSaving(false);
    }
  };

  const joinFromBalance = async () => {
    const { error } = await supabase.rpc("join_cash_ladder_league_from_balance");
    if (error) setToast(error.message);
    else await load();
  };

  const submitResult = async (fixtureId) => {
    const draft = scoreDrafts[fixtureId];
    if (!draft || draft.home === "" || draft.away === "") return;
    let proofUrl = null;
    if (draft.file) {
      const compressed = await compressImage(draft.file, { maxDimension: 1600, quality: 0.85 });
      const ext = (draft.file.name.split(".").pop() || "dat").toLowerCase();
      const path = `${userId}/cash-ladder-result-${fixtureId}-${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("result-proofs").upload(path, compressed, { cacheControl: "31536000" });
      if (uploadErr) { setToast(uploadErr.message); return; }
      proofUrl = path;
    }
    const { error } = await supabase.rpc("submit_cash_ladder_fixture_result", {
      p_fixture_id: fixtureId,
      p_home_score: Number(draft.home),
      p_away_score: Number(draft.away),
      p_proof_url: proofUrl,
    });
    if (error) setToast(error.message);
    else await load();
  };

  if (loading) {
    return <div className="p-6 font-body text-sm" style={{ color: c.textDim }}>Loading Cash Ladder\u2026</div>;
  }

  return (
    <div className="max-w-lg mx-auto p-4" style={{ "--cl-glow": `${c.accent}66` }}>
      <CashLadderStyles />

      {/* Vibrant header banner */}
      <div
        className="rounded-2xl p-4 mb-4 cl-shimmer-bg relative overflow-hidden"
        style={{
          backgroundImage: `linear-gradient(115deg, ${c.accent}, #ff9f43, ${c.accent})`,
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          {onBack && (
            <button onClick={onBack} className="w-7 h-7 flex items-center justify-center rounded-full bg-black/20 text-white shrink-0">
              <ArrowLeft size={13} />
            </button>
          )}
          <Sparkles size={16} className="text-white" />
          <h1 className="font-display text-xl font-extrabold uppercase tracking-tight text-white drop-shadow-sm">Cash Ladder</h1>
        </div>
        <p className="font-body text-[11px] text-white/90 ml-9">Real prizes, paid out every season \u2014 top 3 get the pool.</p>
      </div>

      {toast && (
        <div className="rounded-lg p-3 mb-4 font-body text-xs cl-fade-up" style={{ background: c.surface, color: c.text }}>
          {toast}
        </div>
      )}

      {/* Wallet balance, glowing */}
      <div
        className="rounded-2xl p-4 mb-4 flex items-center justify-between"
        style={{ background: c.bg, border: `1px solid ${c.accent}55` }}
      >
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: `${c.accent}22` }}>
            <Wallet size={16} style={{ color: c.accent }} />
          </span>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-wider" style={{ color: c.textFaint }}>Your balance</div>
            <div key={wallet.balance} className="font-display text-2xl font-extrabold cl-pop" style={{ color: c.accent }}>{goats(wallet.balance)}</div>
          </div>
        </div>
        {!membership && wallet.balance > 0 && (
          <button onClick={joinFromBalance} className="cl-btn font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.accent, color: c.accentText }}>
            Join now
          </button>
        )}
      </div>

      {!membership && (
        <>
          {/* Amount picker */}
          <Panel c={c} title="Choose an amount">
            <div className="grid grid-cols-4 gap-2 mb-3">
              {AMOUNT_PRESETS.map((preset) => {
                const active = Number(amount) === preset && !customOpen;
                return (
                  <button
                    key={preset}
                    onClick={() => { setAmount(preset); setCustomOpen(false); }}
                    className="cl-chip rounded-xl py-2.5 font-body text-sm font-bold"
                    style={{
                      background: active ? c.accent : c.surfaceHover,
                      color: active ? c.accentText : c.text,
                      border: `1px solid ${active ? c.accent : c.border}`,
                      boxShadow: active ? `0 4px 14px -4px ${c.accent}99` : "none",
                    }}
                  >
                    R{preset}
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setCustomOpen((v) => !v)}
              className="w-full flex items-center justify-between font-body text-xs mb-2"
              style={{ color: c.textFaint }}
            >
              <span>Enter a different amount</span>
              <ChevronDown size={13} style={{ transform: customOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
            </button>
            {customOpen && (
              <div className="cl-fade-up flex items-center gap-2 mb-3">
                <span className="font-body text-sm font-semibold" style={{ color: c.textDim }}>R</span>
                <input
                  type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)}
                  className="flex-1 rounded-lg px-3 py-2 font-body text-sm"
                  style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }}
                  autoFocus
                />
              </div>
            )}

            <div
              key={goatsPreview}
              className="cl-pop rounded-xl p-3 text-center font-body text-sm"
              style={{ background: `${c.accent}18`, color: c.text }}
            >
              You'll get <span className="font-extrabold" style={{ color: c.accent }}>{goats(goatsPreview)}</span>
              <div className="font-mono text-[10px] mt-0.5" style={{ color: c.textFaint }}>
                half enters you this season \u00b7 half banked for next season
              </div>
            </div>
          </Panel>

          {/* Pay by card \u2014 primary action */}
          <button
            onClick={payByCard} disabled={saving}
            className="cl-btn cl-glow-btn w-full flex items-center justify-center gap-2 font-body text-base font-extrabold py-3.5 rounded-2xl mb-2 disabled:opacity-50"
            style={{ background: c.accent, color: c.accentText }}
          >
            <CreditCard size={17} />
            {saving ? "Redirecting\u2026" : `Pay ${rand(amount || 0)} by card`}
          </button>
          <div className="flex justify-center mb-4">
            <CardBrandsBadge />
          </div>

          {/* Manual payment \u2014 secondary, collapsed by default */}
          <button
            onClick={() => setManualOpen((v) => !v)}
            className="w-full flex items-center justify-between font-body text-xs mb-2 px-1"
            style={{ color: c.textFaint }}
          >
            <span>Prefer to pay by EFT or Mukuru instead?</span>
            <ChevronDown size={13} style={{ transform: manualOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
          </button>

          {manualOpen && (
            <Panel c={c} className="cl-fade-up">
              <div className="flex items-center gap-2 mb-2">
                <img src="/capitec-logo.png" alt="Capitec Bank" className="h-4 w-auto object-contain" />
                <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Via bank transfer</span>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-body text-xs mb-3" style={{ color: c.textDim }}>
                <span style={{ color: c.textFaint }}>Bank</span><span>{BANK_DETAILS.bank}</span>
                <span style={{ color: c.textFaint }}>Account name</span><span>{BANK_DETAILS.accountName}</span>
                <span style={{ color: c.textFaint }}>Account number</span><span className="font-mono">{BANK_DETAILS.accountNumber}</span>
                <span style={{ color: c.textFaint }}>Account type</span><span>{BANK_DETAILS.accountType}</span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <img src="/mukuru-logo.png" alt="Mukuru" className="h-4 w-auto object-contain" />
                <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: c.textFaint }}>Or via Mukuru</span>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-body text-xs mb-4" style={{ color: c.textDim }}>
                <span style={{ color: c.textFaint }}>Receiver name</span><span>{MUKURU_DETAILS.receiverName}</span>
                <span style={{ color: c.textFaint }}>Receiver phone</span><span className="font-mono">{MUKURU_DETAILS.receiverPhone}</span>
              </div>

              <label className="block font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: c.textFaint }}>Proof of payment</label>
              <input
                type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full font-body text-xs mb-4" style={{ color: c.textDim }}
              />

              <button
                onClick={submitTopup} disabled={saving}
                className="cl-btn w-full font-body text-sm font-semibold py-2 rounded-full disabled:opacity-50"
                style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }}
              >
                {saving ? "Submitting\u2026" : `Submit ${rand(amount || 0)} top-up`}
              </button>
            </Panel>
          )}
        </>
      )}

      {topups.length > 0 && (
        <Panel c={c} title="Your top-ups">
          <div className="space-y-2">
            {topups.map((t) => (
              <div key={t.id} className="flex items-center justify-between font-body text-xs" style={{ color: c.textDim }}>
                <span>{rand(t.amount_rand)} \u2192 {goats(t.total_goats)}</span>
                <StatusPill c={c} status={t.payment_status} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {membership && (
        <Panel c={c} title={`Tier ${membership.cash_ladder_leagues?.tier} \u00b7 Season ${membership.week_number}`}>
          {fixtures.length === 0 ? (
            <p className="font-body text-xs" style={{ color: c.textFaint }}>Fixtures for this season haven't been generated yet.</p>
          ) : (
            <div className="space-y-2">
              {fixtures.map((f) => {
                const played = f.status === "played" || f.status === "forfeited";
                const draft = scoreDrafts[f.id] ?? { home: "", away: "", file: null };
                return (
                  <div key={f.id} className="rounded-lg p-2.5" style={{ background: c.surface }}>
                    <div className="flex items-center justify-between font-body text-xs mb-1" style={{ color: c.textDim }}>
                      <span style={{ color: c.textFaint }}>Leg {f.leg}</span>
                      {played ? <span className="font-semibold">{f.home_score} \u2013 {f.away_score}</span> : <StatusPill c={c} status="pending" />}
                    </div>
                    {!played && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <input type="number" min="0" placeholder="You" value={draft.home}
                          onChange={(e) => setScoreDrafts((s) => ({ ...s, [f.id]: { ...draft, home: e.target.value } }))}
                          className="w-14 rounded px-2 py-1 font-body text-xs" style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
                        <span style={{ color: c.textFaint }}>\u2013</span>
                        <input type="number" min="0" placeholder="Opp" value={draft.away}
                          onChange={(e) => setScoreDrafts((s) => ({ ...s, [f.id]: { ...draft, away: e.target.value } }))}
                          className="w-14 rounded px-2 py-1 font-body text-xs" style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
                        <input type="file" accept="image/*"
                          onChange={(e) => setScoreDrafts((s) => ({ ...s, [f.id]: { ...draft, file: e.target.files?.[0] ?? null } }))}
                          className="flex-1 font-body text-[10px]" style={{ color: c.textFaint }} />
                        <button onClick={() => submitResult(f.id)}
                          className="cl-btn font-body text-[11px] font-semibold px-2.5 py-1 rounded-full"
                          style={{ background: c.accent, color: c.accentText }}>
                          Submit
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
