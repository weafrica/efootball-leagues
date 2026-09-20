import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient'; // adjust this import to match your project

// Storage bucket used for payment proof screenshots. Point this at whatever
// bucket you already use for proof uploads elsewhere, or create a new
// private bucket called "cash-ladder-proofs".
const PROOF_BUCKET = 'cash-ladder-proofs';

const money = (rand) => `R${Number(rand).toFixed(2)}`;
const goats = (n) => `${n}G`;

function Card({ title, children, right }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold tracking-wide text-neutral-300">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Pill({ children, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-neutral-800 text-neutral-300',
    good: 'bg-emerald-900/50 text-emerald-300',
    warn: 'bg-amber-900/50 text-amber-300',
    bad: 'bg-rose-900/50 text-rose-300',
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export default function CashLadderPlayer({ userId }) {
  const [wallet, setWallet] = useState(null);
  const [topups, setTopups] = useState([]);
  const [membership, setMembership] = useState(null);
  const [fixtures, setFixtures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // top-up form state
  const [amount, setAmount] = useState('');
  const [checkoutMethod, setCheckoutMethod] = useState('manual_proof');
  const [proofFile, setProofFile] = useState(null);
  const [submittingTopup, setSubmittingTopup] = useState(false);
  const [topupNotice, setTopupNotice] = useState(null);

  // result submission state, keyed by fixture id
  const [scoreDrafts, setScoreDrafts] = useState({});

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ data: walletRow }, { data: topupRows }, { data: memberRows }] = await Promise.all([
        supabase.from('cash_ladder_goats_wallet').select('balance').eq('user_id', userId).maybeSingle(),
        supabase
          .from('cash_ladder_goats_topups')
          .select('id, amount_rand, total_goats, payment_status, created_at')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('cash_ladder_memberships')
          .select('id, league_id, week_number, status, win_streak, cash_ladder_leagues(tier, current_season)')
          .eq('user_id', userId)
          .eq('status', 'active')
          .maybeSingle(),
      ]);

      setWallet(walletRow ?? { balance: 0 });
      setTopups(topupRows ?? []);
      setMembership(memberRows ?? null);

      if (memberRows?.league_id) {
        const { data: fixtureRows } = await supabase
          .from('cash_ladder_fixtures')
          .select('id, home_user_id, away_user_id, home_score, away_score, status, countdown_expires_at, leg')
          .eq('league_id', memberRows.league_id)
          .eq('week_number', memberRows.week_number)
          .or(`home_user_id.eq.${userId},away_user_id.eq.${userId}`)
          .order('countdown_expires_at', { ascending: true });
        setFixtures(fixtureRows ?? []);
      } else {
        setFixtures([]);
      }
    } catch (e) {
      setError(e.message ?? 'Something went wrong loading your Cash Ladder data.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handleTopup(e) {
    e.preventDefault();
    setTopupNotice(null);
    const rand = Number(amount);
    if (!rand || rand <= 0) {
      setTopupNotice({ tone: 'bad', text: 'Enter an amount greater than R0.' });
      return;
    }
    setSubmittingTopup(true);
    try {
      let proofPath = null;
      if (proofFile) {
        const path = `${userId}/${Date.now()}-${proofFile.name}`;
        const { error: uploadErr } = await supabase.storage.from(PROOF_BUCKET).upload(path, proofFile);
        if (uploadErr) throw uploadErr;
        proofPath = path;
      }

      const { error: rpcErr } = await supabase.rpc('submit_cash_ladder_goats_topup', {
        p_amount_rand: rand,
        p_checkout_method: checkoutMethod,
        p_payment_proof_path: proofPath,
        p_gateway_reference: null,
      });
      if (rpcErr) throw rpcErr;

      setTopupNotice({
        tone: 'good',
        text: 'Sent. Once it\u2019s reviewed, your Goats will land in your wallet.',
      });
      setAmount('');
      setProofFile(null);
      await loadAll();
    } catch (e) {
      setTopupNotice({ tone: 'bad', text: e.message ?? 'Could not submit your top-up.' });
    } finally {
      setSubmittingTopup(false);
    }
  }

  async function handleJoinFromBalance() {
    setError(null);
    try {
      const { error: rpcErr } = await supabase.rpc('join_cash_ladder_league_from_balance');
      if (rpcErr) throw rpcErr;
      await loadAll();
    } catch (e) {
      setError(e.message ?? 'Could not join using your balance.');
    }
  }

  async function handleSubmitResult(fixtureId) {
    const draft = scoreDrafts[fixtureId];
    if (!draft || draft.home === '' || draft.away === '') return;
    try {
      const { error: rpcErr } = await supabase.rpc('submit_cash_ladder_fixture_result', {
        p_fixture_id: fixtureId,
        p_home_score: Number(draft.home),
        p_away_score: Number(draft.away),
        p_proof_url: draft.proofUrl || null,
      });
      if (rpcErr) throw rpcErr;
      await loadAll();
    } catch (e) {
      setError(e.message ?? 'Could not submit that result.');
    }
  }

  if (loading) {
    return <div className="p-6 text-neutral-400">Loading your Cash Ladder\u2026</div>;
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6 text-neutral-100">
      <h1 className="text-2xl font-bold">Cash Ladder</h1>

      {error && (
        <div className="rounded-lg border border-rose-800 bg-rose-950/50 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <Card title="Your Goats wallet">
        <div className="flex items-baseline justify-between">
          <div className="text-3xl font-bold">{goats(wallet?.balance ?? 0)}</div>
          <div className="text-xs text-neutral-500">1 Rand \u2248 3.8G</div>
        </div>

        {!membership && (wallet?.balance ?? 0) > 0 && (
          <button
            onClick={handleJoinFromBalance}
            className="mt-4 w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 transition-colors py-2 text-sm font-semibold"
          >
            Join this season with your balance
          </button>
        )}

        <form onSubmit={handleTopup} className="mt-5 space-y-3 border-t border-neutral-800 pt-4">
          <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wide">Top up</div>
          <div className="flex gap-2">
            <span className="flex items-center px-3 rounded-lg bg-neutral-800 text-neutral-400 text-sm">R</span>
            <input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount paid"
              className="flex-1 rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
            />
          </div>
          <select
            value={checkoutMethod}
            onChange={(e) => setCheckoutMethod(e.target.value)}
            className="w-full rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
          >
            <option value="manual_proof">Bank transfer / EFT</option>
            <option value="whatsapp">Sent via WhatsApp</option>
            <option value="gateway">Card / online payment</option>
          </select>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Proof of payment (screenshot)</label>
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-neutral-400"
            />
          </div>
          {topupNotice && (
            <div className={`text-sm ${topupNotice.tone === 'bad' ? 'text-rose-400' : 'text-emerald-400'}`}>
              {topupNotice.text}
            </div>
          )}
          <button
            type="submit"
            disabled={submittingTopup}
            className="w-full rounded-lg bg-neutral-100 text-neutral-900 hover:bg-white transition-colors py-2 text-sm font-semibold disabled:opacity-50"
          >
            {submittingTopup ? 'Sending\u2026' : 'Submit top-up'}
          </button>
        </form>

        {topups.length > 0 && (
          <div className="mt-4 space-y-1.5">
            {topups.map((t) => (
              <div key={t.id} className="flex items-center justify-between text-sm text-neutral-400">
                <span>{money(t.amount_rand)} \u2192 {goats(t.total_goats)}</span>
                <Pill tone={t.payment_status === 'paid' ? 'good' : t.payment_status === 'rejected' ? 'bad' : 'warn'}>
                  {t.payment_status.replace('_', ' ')}
                </Pill>
              </div>
            ))}
          </div>
        )}
      </Card>

      {membership ? (
        <Card
          title={`League tier ${membership.cash_ladder_leagues?.tier} \u00b7 Season ${membership.week_number}`}
          right={<Pill tone="good">Active</Pill>}
        >
          {fixtures.length === 0 ? (
            <p className="text-sm text-neutral-500">Your fixtures haven\u2019t been generated yet.</p>
          ) : (
            <div className="space-y-2">
              {fixtures.map((f) => {
                const played = f.status === 'played' || f.status === 'forfeited';
                const draft = scoreDrafts[f.id] ?? { home: '', away: '', proofUrl: '' };
                return (
                  <div key={f.id} className="rounded-lg border border-neutral-800 p-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-neutral-400">Leg {f.leg}</span>
                      {played ? (
                        <span className="font-semibold">{f.home_score} \u2013 {f.away_score}</span>
                      ) : (
                        <Pill>pending</Pill>
                      )}
                    </div>
                    {!played && (
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          placeholder="You"
                          value={draft.home}
                          onChange={(e) =>
                            setScoreDrafts((s) => ({ ...s, [f.id]: { ...draft, home: e.target.value } }))
                          }
                          className="w-16 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm"
                        />
                        <span className="text-neutral-500">\u2013</span>
                        <input
                          type="number"
                          min="0"
                          placeholder="Opp"
                          value={draft.away}
                          onChange={(e) =>
                            setScoreDrafts((s) => ({ ...s, [f.id]: { ...draft, away: e.target.value } }))
                          }
                          className="w-16 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm"
                        />
                        <button
                          onClick={() => handleSubmitResult(f.id)}
                          className="ml-auto rounded-lg bg-neutral-100 text-neutral-900 px-3 py-1 text-xs font-semibold"
                        >
                          Submit result
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ) : (
        <Card title="You're not in a Cash League yet">
          <p className="text-sm text-neutral-500">
            Top up above to join. If you already have a Goats balance from a previous season, use the
            &ldquo;Join this season with your balance&rdquo; button instead of paying again.
          </p>
        </Card>
      )}
    </div>
  );
}
