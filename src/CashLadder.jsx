// Cash Ladder — player screen.
// Matches this repo's real conventions: takes `c` (theme) and `session` as
// props like PaymentModal/ChallengesScreen do, reuses the existing
// "payment-proofs" and "result-proofs" storage buckets, compressImage, and
// logActivity rather than inventing new ones.
//
// Mount this from App.jsx the same way other screens are mounted, e.g.:
//   <CashLadder session={session} profile={profile} c={c} onBack={() => setView("home")} />

import { useEffect, useState, useCallback } from "react";
import { Wallet, CreditCard, X, ArrowLeft } from "lucide-react";
import { supabase } from "./supabaseClient";
import { compressImage } from "./utils/imageCompress";
import { logActivity } from "./activityLog";
import { BANK_DETAILS, MUKURU_DETAILS, CardBrandsBadge } from "./paymentConfig";

const goats = (n) => `${n}G`;
const rand = (n) => `R${Number(n).toLocaleString("en-ZA")}`;

function Panel({ c, title, children }) {
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
      <h2 className="font-mono text-[10px] uppercase tracking-wider mb-3" style={{ color: c.textFaint }}>
        {title}
      </h2>
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
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [scoreDrafts, setScoreDrafts] = useState({});

  const userId = session?.user?.id;

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

      setToast(`Submitted — ${rand(amount)} pending admin approval.`);
      setFile(null);
      await load();
    } catch (e) {
      setToast(e.message ?? "Couldn't submit that top-up.");
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
    return <div className="p-6 font-body text-sm" style={{ color: c.textDim }}>Loading Cash Ladder…</div>;
  }

  return (
    <div className="max-w-lg mx-auto p-4">
      <div className="flex items-center gap-2 mb-4">
        {onBack && (
          <button onClick={onBack} className="w-8 h-8 flex items-center justify-center rounded-full" style={{ background: c.surface, color: c.textDim }}>
            <ArrowLeft size={14} />
          </button>
        )}
        <h1 className="font-display text-xl font-extrabold uppercase tracking-tight" style={{ color: c.text }}>Cash Ladder</h1>
      </div>

      {toast && (
        <div className="rounded-lg p-3 mb-4 font-body text-xs" style={{ background: c.surface, color: c.text }}>
          {toast}
        </div>
      )}

      <Panel c={c} title="Your Goats balance">
        <div className="flex items-center justify-between">
          <div className="font-display text-2xl font-extrabold" style={{ color: c.accent }}>{goats(wallet.balance)}</div>
          {!membership && wallet.balance > 0 && (
            <button onClick={joinFromBalance} className="font-body text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: c.accent, color: c.accentText }}>
              Join with balance
            </button>
          )}
        </div>
      </Panel>

      {!membership && (
        <Panel c={c} title="Top up">
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

          <label className="block font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: c.textFaint }}>Amount you paid (Rand)</label>
          <input
            type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-lg px-3 py-2 font-body text-sm mb-3"
            style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }}
          />
          <div className="font-body text-[11px] mb-3" style={{ color: c.textFaint }}>
            \u2248 {goats(Math.round(Number(amount || 0) * 3.8))} — half enters you this season, half is banked for next season.
          </div>

          <label className="block font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: c.textFaint }}>Proof of payment</label>
          <input
            type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="w-full font-body text-xs mb-4" style={{ color: c.textDim }}
          />

          <button
            onClick={submitTopup} disabled={saving}
            className="w-full font-body text-sm font-semibold py-2 rounded-full disabled:opacity-50"
            style={{ background: c.accent, color: c.accentText }}
          >
            {saving ? "Submitting…" : "Submit top-up"}
          </button>
          <div className="mt-2">
            <CardBrandsBadge />
          </div>
        </Panel>
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
                          className="font-body text-[11px] font-semibold px-2.5 py-1 rounded-full"
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
