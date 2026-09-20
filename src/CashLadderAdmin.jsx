// Cash Ladder — admin screen.
// Matches this repo's real conventions (c theme prop, payment-proofs /
// result-proofs buckets via signed URLs — both are private buckets, same as
// everywhere else in the app uses createSignedUrl rather than a public URL).
//
// Mount this only where isAdmin is true, e.g.:
//   {isAdmin && <CashLadderAdmin c={c} />}

import { useEffect, useState, useCallback } from "react";
import { supabase } from "./supabaseClient";

const goats = (n) => `${n}G`;
const rand = (n) => `R${Number(n).toLocaleString("en-ZA")}`;

function Section({ c, title, children }) {
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: c.bg, border: `1px solid ${c.border}` }}>
      <h2 className="font-mono text-[10px] uppercase tracking-wider mb-3" style={{ color: c.textFaint }}>{title}</h2>
      {children}
    </div>
  );
}

function Row({ c, children }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5" style={{ borderBottom: `1px solid ${c.border}` }}>
      {children}
    </div>
  );
}

function Btn({ c, children, onClick, tone = "neutral", disabled }) {
  const bg = tone === "good" ? c.accent : tone === "bad" ? "#ef4444" : c.surfaceHover;
  const fg = tone === "good" ? c.accentText : tone === "bad" ? "#fff" : c.text;
  return (
    <button onClick={onClick} disabled={disabled}
      className="font-body text-[11px] font-semibold px-2.5 py-1.5 rounded-full disabled:opacity-40"
      style={{ background: bg, color: fg }}>
      {children}
    </button>
  );
}

async function viewProof(bucket, path) {
  if (!path) return;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 120);
  if (error) { alert(`Couldn't open proof: ${error.message}`); return; }
  window.open(data.signedUrl, "_blank");
}

export default function CashLadderAdmin({ c }) {
  const [topups, setTopups] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [leagues, setLeagues] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [payoutRefs, setPayoutRefs] = useState({});

  const load = useCallback(async () => {
    setError(null);
    const [{ data: t }, { data: s }, { data: p }, { data: l }] = await Promise.all([
      supabase.from("cash_ladder_goats_topups")
        .select("id, user_id, amount_rand, total_goats, checkout_method, payment_proof_path, created_at")
        .eq("payment_status", "pending_review").order("created_at", { ascending: true }),
      supabase.from("cash_ladder_fixture_result_submissions")
        .select("id, fixture_id, submitted_by, home_score, away_score, proof_url, created_at")
        .eq("status", "pending").order("created_at", { ascending: true }),
      supabase.from("cash_ladder_reward_payout_queue")
        .select("id, user_id, amount, status, queued_at")
        .eq("status", "pending").order("queued_at", { ascending: true }),
      supabase.from("cash_ladder_leagues")
        .select("id, tier, status, current_season, pool_balance")
        .order("tier", { ascending: true }),
    ]);
    setTopups(t ?? []);
    setSubmissions(s ?? []);
    setPayouts(p ?? []);
    setLeagues(l ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (id, fn) => {
    setBusyId(id);
    setError(null);
    const { error: err } = await fn();
    if (err) setError(err.message);
    else await load();
    setBusyId(null);
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <h1 className="font-display text-xl font-extrabold uppercase tracking-tight mb-4" style={{ color: c.text }}>
        Cash Ladder \u2014 Admin
      </h1>

      {error && (
        <div className="rounded-lg p-3 mb-4 font-body text-xs" style={{ background: c.surface, color: "#ef4444" }}>{error}</div>
      )}

      <Section c={c} title={`Pending top-ups (${topups.length})`}>
        {topups.length === 0 && <p className="font-body text-xs" style={{ color: c.textFaint }}>Nothing waiting.</p>}
        {topups.map((t) => (
          <Row c={c} key={t.id}>
            <div className="font-body text-xs" style={{ color: c.textDim }}>
              <div>{rand(t.amount_rand)} \u2192 {goats(t.total_goats)}</div>
              <div style={{ color: c.textFaint }}>
                {t.checkout_method ?? "no method noted"}
                {t.payment_proof_path && (
                  <>
                    {" \u00b7 "}
                    <button onClick={() => viewProof("payment-proofs", t.payment_proof_path)} className="underline">view proof</button>
                  </>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Btn c={c} tone="good" disabled={busyId === t.id}
                onClick={() => run(t.id, () => supabase.rpc("admin_approve_cash_ladder_goats_topup", { p_topup_id: t.id }))}>
                Approve
              </Btn>
              <Btn c={c} tone="bad" disabled={busyId === t.id}
                onClick={() => run(t.id, () => supabase.rpc("admin_reject_cash_ladder_goats_topup", { p_topup_id: t.id, p_note: null }))}>
                Reject
              </Btn>
            </div>
          </Row>
        ))}
      </Section>

      <Section c={c} title={`Unconfirmed results (${submissions.length})`}>
        {submissions.length === 0 && <p className="font-body text-xs" style={{ color: c.textFaint }}>Nothing waiting.</p>}
        {submissions.map((s) => (
          <Row c={c} key={s.id}>
            <div className="font-body text-xs" style={{ color: c.textDim }}>
              <div className="font-semibold">{s.home_score} \u2013 {s.away_score}</div>
              {s.proof_url && (
                <button onClick={() => viewProof("result-proofs", s.proof_url)} className="underline" style={{ color: c.textFaint }}>view proof</button>
              )}
            </div>
            <Btn c={c} tone="good" disabled={busyId === s.id}
              onClick={() => run(s.id, () => supabase.rpc("admin_approve_cash_ladder_fixture_result", { p_submission_id: s.id }))}>
              Approve
            </Btn>
          </Row>
        ))}
      </Section>

      <Section c={c} title={`Withdrawal requests (${payouts.length})`}>
        {payouts.length === 0 && <p className="font-body text-xs" style={{ color: c.textFaint }}>Nothing waiting.</p>}
        {payouts.map((p) => (
          <Row c={c} key={p.id}>
            <div className="font-body text-xs" style={{ color: c.textDim }}>{goats(p.amount)}</div>
            <div className="flex items-center gap-2">
              <input placeholder="reference" value={payoutRefs[p.id] ?? ""}
                onChange={(e) => setPayoutRefs((r) => ({ ...r, [p.id]: e.target.value }))}
                className="rounded px-2 py-1 font-body text-[11px] w-28"
                style={{ background: c.surfaceHover, border: `1px solid ${c.border}`, color: c.text }} />
              <Btn c={c} tone="good" disabled={busyId === p.id}
                onClick={() => run(p.id, () => supabase.rpc("admin_mark_cash_ladder_payout_paid", {
                  p_payout_id: p.id, p_payout_method: "manual", p_payout_reference: payoutRefs[p.id] || null,
                }))}>
                Mark paid
              </Btn>
              <Btn c={c} tone="bad" disabled={busyId === p.id}
                onClick={() => run(p.id, () => supabase.rpc("admin_reject_cash_ladder_payout", { p_payout_id: p.id, p_note: null }))}>
                Reject
              </Btn>
            </div>
          </Row>
        ))}
      </Section>

      <Section c={c} title="Leagues">
        {leagues.map((l) => (
          <Row c={c} key={l.id}>
            <div className="font-body text-xs" style={{ color: c.textDim }}>
              Tier {l.tier} \u00b7 {l.status} \u00b7 season {l.current_season} \u00b7 pool {goats(l.pool_balance)}
            </div>
            {l.status === "active" && (
              <Btn c={c} disabled={busyId === l.id}
                onClick={() => run(l.id, () => supabase.rpc("admin_resolve_cash_ladder_season", { p_league_id: l.id }))}>
                Resolve season
              </Btn>
            )}
          </Row>
        ))}
      </Section>
    </div>
  );
}
