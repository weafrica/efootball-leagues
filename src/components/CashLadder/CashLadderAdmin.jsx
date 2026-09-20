import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient'; // adjust this import to match your project

const money = (rand) => `R${Number(rand).toFixed(2)}`;
const goats = (n) => `${n}G`;

function Section({ title, children }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h2 className="text-sm font-semibold tracking-wide text-neutral-300 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function Row({ children }) {
  return <div className="flex items-center justify-between gap-3 py-2 border-b border-neutral-800 last:border-0">{children}</div>;
}

function Button({ children, onClick, tone = 'neutral', disabled }) {
  const tones = {
    neutral: 'bg-neutral-100 text-neutral-900 hover:bg-white',
    good: 'bg-emerald-600 text-white hover:bg-emerald-500',
    bad: 'bg-rose-700 text-white hover:bg-rose-600',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export default function CashLadderAdmin() {
  const [topups, setTopups] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [leagues, setLeagues] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [payoutRefs, setPayoutRefs] = useState({});

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [{ data: topupRows }, { data: subRows }, { data: payoutRows }, { data: leagueRows }] = await Promise.all([
        supabase
          .from('cash_ladder_goats_topups')
          .select('id, user_id, amount_rand, total_goats, checkout_method, payment_proof_path, created_at')
          .eq('payment_status', 'pending_review')
          .order('created_at', { ascending: true }),
        supabase
          .from('cash_ladder_fixture_result_submissions')
          .select('id, fixture_id, submitted_by, home_score, away_score, proof_url, created_at')
          .eq('status', 'pending')
          .order('created_at', { ascending: true }),
        supabase
          .from('cash_ladder_reward_payout_queue')
          .select('id, user_id, amount, status, queued_at')
          .eq('status', 'pending')
          .order('queued_at', { ascending: true }),
        supabase
          .from('cash_ladder_leagues')
          .select('id, tier, status, current_season, pool_balance')
          .order('tier', { ascending: true }),
      ]);
      setTopups(topupRows ?? []);
      setSubmissions(subRows ?? []);
      setPayouts(payoutRows ?? []);
      setLeagues(leagueRows ?? []);
    } catch (e) {
      setError(e.message ?? 'Could not load the admin queues.');
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function run(id, fn) {
    setBusyId(id);
    setError(null);
    try {
      const { error: rpcErr } = await fn();
      if (rpcErr) throw rpcErr;
      await loadAll();
    } catch (e) {
      setError(e.message ?? 'That action failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6 text-neutral-100">
      <h1 className="text-2xl font-bold">Cash Ladder \u2014 Admin</h1>

      {error && (
        <div className="rounded-lg border border-rose-800 bg-rose-950/50 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <Section title={`Pending top-ups (${topups.length})`}>
        {topups.length === 0 && <p className="text-sm text-neutral-500">Nothing waiting.</p>}
        {topups.map((t) => (
          <Row key={t.id}>
            <div className="text-sm">
              <div>{money(t.amount_rand)} \u2192 {goats(t.total_goats)}</div>
              <div className="text-neutral-500 text-xs">
                {t.checkout_method ?? 'no method noted'}
                {t.payment_proof_path && (
                  <>
                    {' \u00b7 '}
                    <a
                      className="underline"
                      href={
                        supabase.storage.from('cash-ladder-proofs').getPublicUrl(t.payment_proof_path).data
                          .publicUrl
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      view proof
                    </a>
                  </>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                tone="good"
                disabled={busyId === t.id}
                onClick={() => run(t.id, () => supabase.rpc('admin_approve_cash_ladder_goats_topup', { p_topup_id: t.id }))}
              >
                Approve
              </Button>
              <Button
                tone="bad"
                disabled={busyId === t.id}
                onClick={() => run(t.id, () => supabase.rpc('admin_reject_cash_ladder_goats_topup', { p_topup_id: t.id, p_note: null }))}
              >
                Reject
              </Button>
            </div>
          </Row>
        ))}
      </Section>

      <Section title={`Disputed / unconfirmed results (${submissions.length})`}>
        {submissions.length === 0 && <p className="text-sm text-neutral-500">Nothing waiting.</p>}
        {submissions.map((s) => (
          <Row key={s.id}>
            <div className="text-sm">
              <div className="font-semibold">{s.home_score} \u2013 {s.away_score}</div>
              {s.proof_url && (
                <a className="text-xs underline text-neutral-400" href={s.proof_url} target="_blank" rel="noreferrer">
                  view proof
                </a>
              )}
            </div>
            <Button
              tone="good"
              disabled={busyId === s.id}
              onClick={() => run(s.id, () => supabase.rpc('admin_approve_cash_ladder_fixture_result', { p_submission_id: s.id }))}
            >
              Approve result
            </Button>
          </Row>
        ))}
      </Section>

      <Section title={`Withdrawal requests (${payouts.length})`}>
        {payouts.length === 0 && <p className="text-sm text-neutral-500">Nothing waiting.</p>}
        {payouts.map((p) => (
          <Row key={p.id}>
            <div className="text-sm">{goats(p.amount)}</div>
            <div className="flex items-center gap-2">
              <input
                placeholder="payout reference"
                value={payoutRefs[p.id] ?? ''}
                onChange={(e) => setPayoutRefs((r) => ({ ...r, [p.id]: e.target.value }))}
                className="rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-xs w-36"
              />
              <Button
                tone="good"
                disabled={busyId === p.id}
                onClick={() =>
                  run(p.id, () =>
                    supabase.rpc('admin_mark_cash_ladder_payout_paid', {
                      p_payout_id: p.id,
                      p_payout_method: 'manual',
                      p_payout_reference: payoutRefs[p.id] || null,
                    })
                  )
                }
              >
                Mark paid
              </Button>
              <Button
                tone="bad"
                disabled={busyId === p.id}
                onClick={() => run(p.id, () => supabase.rpc('admin_reject_cash_ladder_payout', { p_payout_id: p.id, p_note: null }))}
              >
                Reject
              </Button>
            </div>
          </Row>
        ))}
      </Section>

      <Section title="Leagues">
        {leagues.map((l) => (
          <Row key={l.id}>
            <div className="text-sm">
              Tier {l.tier} \u00b7 {l.status} \u00b7 season {l.current_season} \u00b7 pool {goats(l.pool_balance)}
            </div>
            {l.status === 'active' && (
              <Button
                disabled={busyId === l.id}
                onClick={() => run(l.id, () => supabase.rpc('admin_resolve_cash_ladder_season', { p_league_id: l.id }))}
              >
                Resolve season
              </Button>
            )}
          </Row>
        ))}
      </Section>
    </div>
  );
}
