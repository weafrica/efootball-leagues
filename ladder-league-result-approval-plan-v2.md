# League Ladder — Result Approval System: Build Plan (v2 — finalized shape)

Decisions locked in: **Option A** (report → confirm/dispute → admin
escalation) as the overall shape, built on **Option B**'s table design
(one row per submission attempt, not evolving columns on `ladder_fixtures`),
with **Option D modified** — an admin who doesn't act within **1 hour** of a
result reaching the queue gets auto-approved rather than left indefinitely
pending. **C, E, F, G are rejected** — no dual-independent-report model, no
skip-the-opponent-entirely model, no proof-gated walkover-claim system, no
separate confirm-window tuning pass.

One thing this combination buys you for free: **Option B's table shape is
already exactly `result_submissions`**, the table regular (non-ladder)
league fixtures already use. So this isn't inventing a third pattern
alongside Ladder Cup's evolving-row model and the regular-fixtures
submissions-table model — it's League Ladder adopting the **same** table
shape and the **same** RPCs (`approve_result_submission`,
`reject_result_submission`, `respond_to_result_submission`) already proven
in `20260828_result_submission_rpcs.sql`, just scoped to `ladder_fixtures`
instead of `fixtures`. Less new code than a straight Ladder Cup port would
have needed.

---

## 1. Schema

```sql
create table if not exists ladder_fixture_result_submissions (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references ladder_fixtures(id) on delete cascade,
  submitted_by uuid not null references auth.users(id),
  home_score integer not null,
  away_score integer not null,
  proof_url text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ladder_fixture_result_submissions_fixture
  on ladder_fixture_result_submissions(fixture_id);

-- The admin queue's exact query shape — pending submissions only.
create index if not exists idx_ladder_fixture_result_submissions_pending
  on ladder_fixture_result_submissions(fixture_id)
  where status = 'pending';
```

`ladder_fixtures` itself needs no new columns beyond what it already has —
`status`/`home_score`/`away_score`/`played_at` only get written once a
submission is actually approved (by the opponent, by an admin, or by the
1-hour auto-approve sweep), exactly like `respond_to_result_submission`
already does for regular fixtures. This keeps every existing
`status = 'played'` filter (standings, countdown sweep, decay penalty, fee
settlement) working unchanged.

Correction audit table (Option A's piece — kept, since a confirmed result
still needs to be correctable):

```sql
create table if not exists ladder_fixture_corrections (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references ladder_fixtures(id) on delete cascade,
  corrected_by uuid references auth.users(id),
  previous_home_score integer,
  previous_away_score integer,
  new_home_score integer not null,
  new_away_score integer not null,
  created_at timestamptz not null default now()
);
```

---

## 2. RPCs

### `submit_ladder_fixture_result(p_fixture_id, p_home_score, p_away_score, p_proof_url default null)`
Replaces the current all-in-one `submit_ladder_fixture_result`. Re-checks
(same guards as today): caller is a participant or admin, fixture is still
`'pending'`, scores non-negative, `fixtures_locked` respected for
non-admins. Additionally: **rejects if a `pending` submission already
exists for this fixture** (mirrors the one-open-claim-per-target uniqueness
Ladder Cup enforces, applied here as one-open-submission-per-fixture)
— the second participant to try to log a result for the same fixture at
the same time gets a clear "a result is already awaiting confirmation"
error rather than creating a second pending row. Inserts into
`ladder_fixture_result_submissions` with `status='pending'`. Does **not**
touch `ladder_fixtures.status` and does **not** credit the reward.

### `respond_to_ladder_fixture_result_submission(p_submission_id, p_accept)`
The opponent's confirm/dispute action — same shape as the existing
`respond_to_result_submission`. Caller must be the *other* participant in
the fixture (not the submitter). On accept: writes
`home_score/away_score/status='played'/played_at` onto `ladder_fixtures`,
marks the submission `'approved'`, and **credits the match reward here**
(`_credit_ladder_match_reward_internal`) — this is the fix that closes the
"reward pays out on an unconfirmed report" hole the current one-shot RPC
has. Re-checks the fixture hasn't already been played another way (same
race guard `approve_result_submission` uses) before writing. On reject:
marks the submission `'rejected'` and leaves the fixture `'pending'` —
free to submit again.

### `admin_approve_ladder_fixture_result(p_submission_id)` / `admin_reject_ladder_fixture_result(p_submission_id, p_note default null)`
Admin-only twins of the two RPCs above (auth via the global `admins` table
only — no per-league creator concept here, unlike the `leagues.created_by`
branch `approve_result_submission` carries for regular fixtures). Same
already-played race guard, same reward-crediting-on-approve behavior. These
are what the admin queue's Approve/Reject buttons call, and are also what
the 1-hour auto-approve sweep calls under the hood (see below) — one code
path for "an admin clicked approve" and "an admin ran out the clock,"
same as Ladder Cup's admin path reusing the participant-facing RPC.

### Escalation reason (client-side, unchanged approach from the original plan)
```js
const LADDER_FIXTURE_DISPUTE_ESCALATION_THRESHOLD = 2;
function priorRejectedLadderFixtureCount(fixture, submissions) {
  return submissions.filter(s => s.fixture_id === fixture.id && s.status === "rejected").length;
}
// null = still the opponent's turn; "timeout" = 30 min passed with no
// response; "dispute-cap" = this fixture's been disputed twice already.
export function ladderFixtureResultEscalationReason(fixture, pendingSubmission, allSubmissionsForFixture) {
  if (!pendingSubmission) return null;
  if (priorRejectedLadderFixtureCount(fixture, allSubmissionsForFixture) >= LADDER_FIXTURE_DISPUTE_ESCALATION_THRESHOLD) return "dispute-cap";
  if (resultConfirmExpired(pendingSubmission, null)) return "timeout"; // reuses existing helper, reads submission.created_at
  return null;
}
```

### `_ladder_fixture_result_escalated_at(submission, prior_rejected_count)` — the piece Option D needs
The 1-hour auto-approve clock has to start from **when the submission
entered the admin queue**, not from when it was originally reported —
otherwise a dispute-cap escalation (which can happen immediately, on the
*third* report for a fixture) would already be halfway through its window
before an admin ever sees it. Two cases, mirroring the escalation reason
logic above exactly:

- **Dispute-cap escalation**: entered the queue the instant it was
  created (the prior two rejections already happened) → escalated_at =
  `submission.created_at`.
- **Timeout escalation**: entered the queue when the 30-minute confirm
  window lapsed → escalated_at = `submission.created_at + 30 minutes`.

`auto_approve_deadline = escalated_at + 1 hour`.

### `_ladder_auto_approve_escalated_results_internal()` — the sweep job
```sql
create or replace function _ladder_auto_approve_escalated_results_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub record;
begin
  for v_sub in
    select s.*
    from ladder_fixture_result_submissions s
    join ladder_fixtures f on f.id = s.fixture_id
    where s.status = 'pending'
      and f.status = 'pending'
      and (
        -- dispute-cap case: already 2+ prior rejections on this fixture
        (
          select count(*) from ladder_fixture_result_submissions prior
          where prior.fixture_id = s.fixture_id and prior.status = 'rejected'
        ) >= 2
        and s.created_at + interval '1 hour' <= now()
      )
      or (
        -- timeout case: no prior rejections yet, 30-min confirm window + 1hr admin window elapsed
        (
          select count(*) from ladder_fixture_result_submissions prior
          where prior.fixture_id = s.fixture_id and prior.status = 'rejected'
        ) < 2
        and s.created_at + interval '30 minutes' + interval '1 hour' <= now()
      )
  loop
    perform _admin_approve_ladder_fixture_result_internal(v_sub.id, null);
  end loop;
end;
$$;
```
`_admin_approve_ladder_fixture_result_internal` is the shared body behind
`admin_approve_ladder_fixture_result` (approve + credit reward), factored
out so both the real admin RPC and this sweep call the identical write path
— no duplicated logic between "a human clicked approve" and "the clock ran
out." Hook this into the same hourly cron/sweep infrastructure that already
drives the countdown/forfeit sweep (Phase 6) — no new scheduling mechanism
needed, just one more function call in the existing hourly job.

### `correct_ladder_fixture_result(p_fixture_id, p_home_score, p_away_score)`
Unchanged from the original plan (§6 of v1): admin-only, only callable once
`ladder_fixtures.status = 'played'`, logs before/after to
`ladder_fixture_corrections`, rewrites the score, and calls the
already-existing `admin_retrigger_ladder_resolve()` if that fixture's week
has already closed. No replay/recompute engine needed to be invented —
League Ladder's weekly resolve already recomputes fresh from
`ladder_fixtures` each time it runs.

---

## 3. Why this combination holds together

- **A** gives the overall shape (report → confirm/dispute → escalate →
  admin), which is the part every other result path in this app already
  uses, so nothing new for players to learn.
- **B** means the implementation is a straight copy of code that's already
  shipped and working (`result_submissions` + its three RPCs), retargeted
  at `ladder_fixtures` — lower risk than inventing Ladder Cup's
  evolving-single-row shape for a second table.
- **D-modified** puts a hard ceiling on how long a fixture can sit
  unresolved: an admin still gets first crack at every escalated case
  (unlike E, which was rejected), but nothing rots in the queue forever if
  nobody looks at it for a day — the escalated submission's own reported
  score becomes official after 1 hour of admin silence, same "trust the
  report absent a real objection" logic the rejected Option D used for the
  opponent-timeout step, just moved one level up to the admin-timeout step
  instead.
- **C** (both sides report, auto-compare) is rejected — kept the
  single-report-then-confirm shape instead, since it's what the app already
  does everywhere else.
- **E** (skip the opponent step, always to admin) is rejected — the
  opponent still gets first right of confirm/dispute; admins only see
  fixtures that time out or get genuinely disputed.
- **F** (proof-gated walkover claims) is rejected — out of scope for this
  pass; the existing countdown-expiry-based forfeit (`20260862`) stays the
  only no-show path.
- **G** (window-length tuning as its own workstream) is rejected — the
  30-minute opponent window and 1-hour admin window are fixed constants
  in this plan, not a separate tunable pass.

---

## 4. Build order

1. `ladder_fixture_result_submissions` + `ladder_fixture_corrections`
   tables + indexes (§1).
2. Rewrite `submit_ladder_fixture_result` to insert-only, with the
   one-pending-submission-per-fixture guard (§2).
3. Add `respond_to_ladder_fixture_result_submission`, with reward-crediting
   moved here (§2).
4. Add `_admin_approve_ladder_fixture_result_internal` (shared body),
   `admin_approve_ladder_fixture_result`, `admin_reject_ladder_fixture_result`
   as thin wrappers around it (§2).
5. Add `_ladder_auto_approve_escalated_results_internal` and wire it into
   the existing hourly sweep alongside the countdown/forfeit job (§2).
6. Add `correct_ladder_fixture_result`, wired to
   `admin_retrigger_ladder_resolve()` (§2).
7. Client: `ladderFixtureResultEscalationReason` + escalated-at/auto-approve
   countdown helpers (§2); three-state fixture card (report → opponent
   confirm/dispute → escalated, showing "auto-approves in Xm" once in the
   admin queue); admin queue tab wired to the two admin RPCs; correction UI
   repoint.
8. Backfill: existing `'played'` fixtures need one synthetic `'approved'`
   `ladder_fixture_result_submissions` row each (or are simply left with no
   submission row at all, since nothing in the new flow requires one to
   exist for an already-played fixture) — either is fine as long as the
   admin queue query (`status = 'pending'`) never picks up historical data.

Every migration written "safe to run more than once," per this repo's
existing convention.
