-- Rapid Cup — Phase 6: Winbox / Cup box tap-to-collect (Section 8).
--
-- Nothing before this phase actually credits Nets to anyone. Phase 3's
-- finalize_rapid_cup_payout() and Phase 4's _rapid_cup_finish_lobby_internal()
-- only ever RECORD payout amounts (rapid_cup_payouts / rapid_cup_payout_recipients)
-- — no _nets_credit_internal call exists anywhere in the Rapid Cup migration
-- history. This phase is what actually pays people, gated behind a tap.
--
-- Winbox reward amount: the build plan (Section 8) says "flat/small reward"
-- but never gives a number. Matched to this app's existing 'random_match_reward'
-- win payout (20260836_ladder_challenge_reward_crediting.sql:
-- economy.js's computeMatchNets 'random_match' branch, win=2 base + 1
-- participation = 3 Nets in practice) — same shape as every other format's
-- reward table. This is a DESIGN CALL, not a spec'd number — easy to change,
-- just edit v_winbox_reward below.
--
-- rapid_cup_collections is a new append-only claim ledger, one row per
-- (user, box, thing-collected). Its unique constraint IS the double-collect
-- guard: both RPCs attempt the insert FIRST (on conflict do nothing) and
-- only credit Nets if that insert actually landed a new row — so a double
-- tap, a retried request, or two overlapping calls all settle on exactly
-- one credit, same "insert-as-claim" idempotency shape as this migration
-- history already uses elsewhere (e.g. result_submissions' first-submit-wins
-- pattern). box_type distinguishes the two boxes; ref_id is the fixture_id
-- for a winbox, the lobby_id for a cup box.
--
-- Security posture matches Phase 3/4 exactly (see 20260903190000's fix):
-- Postgres grants EXECUTE to PUBLIC on every new function by default, and
-- this project has already shipped that exact hole twice (nets wallet
-- functions, then Rapid Cup's Phase 3/4 internals). Both explicitly
-- revoke from public/anon here and grant only to authenticated — these
-- two ARE meant to be client-callable (that's the whole point of a tap-to-
-- collect button), but only ever pay the calling user (auth.uid()) a
-- server-computed amount for a result the sweep cron already verified.
-- Nothing here lets a caller name another user or supply their own amount.
--
-- Tested live against a throwaway league/lobby/fixture/payout (all ids
-- prefixed ffffffff-, cleaned up after): winbox happy-path collect,
-- double-collect returns 0 with no second credit, the losing player is
-- rejected, a non-Rapid-Cup fixture is rejected, cupbox 'winner' outcome,
-- cupbox 'split' outcome (recipients table path), and a non-winner
-- collecting a legitimate $0 box. That pass caught a real bug: the first
-- version of collect_rapid_cup_cupbox passed a numeric payout straight
-- into _nets_credit_internal's bigint parameter and errored on the very
-- first live call — see the fix note inside collect_rapid_cup_cupbox
-- below for the rounding rule that replaced it.
--
-- Safe to run more than once.

create table if not exists rapid_cup_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  box_type text not null check (box_type in ('winbox', 'cupbox')),
  ref_id uuid not null, -- fixture_id (winbox) or lobby_id (cupbox)
  amount numeric not null default 0, -- what was actually credited (0 is valid: a loser "opening" a split/refund cup box with nothing owed)
  created_at timestamptz not null default now(),
  unique (user_id, box_type, ref_id)
);

create index if not exists idx_rapid_cup_collections_user on rapid_cup_collections (user_id, box_type);

alter table rapid_cup_collections enable row level security;

create policy "rapid_cup_collections readable by owner or admin"
  on rapid_cup_collections for select
  using (
    user_id = auth.uid()
    or exists (select 1 from admins a where a.user_id = auth.uid())
  );

-- Writes only happen through the two RPCs below (security definer) — no
-- insert/update policies granted to regular users.

-- ─────────────────────────────────────────────────────────────────────────
-- collect_rapid_cup_winbox — tap-to-collect after an individual match win.
-- Pays the flat per-match-win reward to the calling user if (and only if)
-- their team actually won that specific fixture. Winner determination
-- mirrors the exact same rule _rapid_cup_finish_lobby_internal already
-- uses (score, or penalties on a level scoreline) — same single-leg logic
-- as the rest of Rapid Cup, so a fixture that's level with no pens
-- submitted yet correctly has no collectable winner.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function collect_rapid_cup_winbox(p_fixture_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture fixtures%rowtype;
  v_team_id uuid;
  v_winner_team_id uuid;
  v_winbox_reward bigint := 3; -- design call, see header comment — easy to change. bigint, not numeric: must match _nets_credit_internal's p_amount type exactly or Postgres can't resolve the overload (caught live, see fix note below)
  v_claim rapid_cup_collections;
begin
  if auth.uid() is null then
    raise exception 'collect_rapid_cup_winbox: must be signed in';
  end if;

  select * into v_fixture from fixtures where id = p_fixture_id;
  if v_fixture.id is null then
    raise exception 'Fixture not found';
  end if;

  if not exists (select 1 from rapid_cup_lobbies where league_id = v_fixture.league_id) then
    raise exception 'Not a Rapid Cup fixture';
  end if;

  if not v_fixture.played then
    raise exception 'This match hasn''t finished yet';
  end if;

  select team_id into v_team_id
  from members
  where league_id = v_fixture.league_id and user_id = auth.uid();

  if v_team_id is null or (v_team_id <> v_fixture.home_team_id and v_team_id <> v_fixture.away_team_id) then
    raise exception 'You weren''t in this match';
  end if;

  v_winner_team_id := case
    when v_fixture.home_score > v_fixture.away_score then v_fixture.home_team_id
    when v_fixture.away_score > v_fixture.home_score then v_fixture.away_team_id
    when v_fixture.pens_home is not null and v_fixture.pens_away is not null and v_fixture.pens_home <> v_fixture.pens_away
      then case when v_fixture.pens_home > v_fixture.pens_away then v_fixture.home_team_id else v_fixture.away_team_id end
    else null
  end;

  if v_winner_team_id is null or v_winner_team_id <> v_team_id then
    raise exception 'You didn''t win this match';
  end if;

  -- Claim first — the unique constraint is the double-collect guard.
  insert into rapid_cup_collections (user_id, box_type, ref_id, amount)
  values (auth.uid(), 'winbox', p_fixture_id, v_winbox_reward)
  on conflict (user_id, box_type, ref_id) do nothing
  returning * into v_claim;

  if v_claim.id is null then
    return 0; -- already collected — idempotent, no double credit
  end if;

  perform _nets_credit_internal(auth.uid(), v_winbox_reward, 'rapid_cup_winbox', null, 'fixture', p_fixture_id::text, v_team_id);

  return v_winbox_reward;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- collect_rapid_cup_cupbox — tap-to-collect after the whole cup finishes.
-- Pays whatever Phase 3/4 already calculated and recorded for the calling
-- user — never recomputes the payout itself, just reads the verified
-- result and pays it out once. Covers all three payable outcomes:
--   'winner' — single row on rapid_cup_payouts, winner_net_total
--   'split' / 'refund' — per-player row on rapid_cup_payout_recipients
-- A non-winner in the 'winner' case has a legitimate $0 box (they still
-- get a "you collected, nothing this time" state rather than an error —
-- matches the pack-opening flavor in Section 8/13 better than a hard
-- failure for every loser).
-- ─────────────────────────────────────────────────────────────────────────
create or replace function collect_rapid_cup_cupbox(p_lobby_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payout rapid_cup_payouts%rowtype;
  v_amount numeric;
  v_amount_int bigint;
  v_is_participant boolean;
  v_claim rapid_cup_collections;
begin
  if auth.uid() is null then
    raise exception 'collect_rapid_cup_cupbox: must be signed in';
  end if;

  select * into v_payout from rapid_cup_payouts where lobby_id = p_lobby_id;
  if v_payout.id is null then
    raise exception 'This cup hasn''t finished yet';
  end if;

  if v_payout.outcome = 'winner' then
    select exists(select 1 from rapid_cup_lobby_players where lobby_id = p_lobby_id and user_id = auth.uid())
    into v_is_participant;

    if not v_is_participant then
      raise exception 'You weren''t in this cup';
    end if;

    v_amount := case when v_payout.winner_user_id = auth.uid() then v_payout.winner_net_total else 0 end;
  else
    -- 'split' or 'refund' — per-player amount lives on the recipients table.
    select amount into v_amount
    from rapid_cup_payout_recipients
    where payout_id = v_payout.id and user_id = auth.uid();

    if v_amount is null then
      raise exception 'You weren''t in this cup';
    end if;
  end if;

  -- FIX (caught by live testing, not just reasoned about): Nets are
  -- integer-only — nets_wallets.balance and nets_transactions.amount are
  -- both bigint, and _nets_credit_internal's p_amount parameter is bigint
  -- too. But Phase 3's payout math (compute_rapid_cup_payout) computes to
  -- 2 decimal places (round(..., 2)) — e.g. the build plan's own P1-wins
  -- worked example nets ≈1.9. Passing that numeric straight into a bigint
  -- parameter doesn't just truncate silently, it fails outright: Postgres
  -- can't resolve the function overload and the call errors before any
  -- write happens (confirmed live — first version of this migration hit
  -- exactly this on the very first test call). Round to the nearest whole
  -- Net at the point of payment, and record that SAME rounded figure in
  -- rapid_cup_collections so the claim ledger always matches what was
  -- actually credited, never the pre-rounding theoretical figure.
  v_amount_int := round(coalesce(v_amount, 0))::bigint;

  -- Claim first — the unique constraint is the double-collect guard. Claims
  -- even a $0 box, so a loser can't be re-charged the exception path above
  -- (and never gets re-credited) on a repeat tap.
  insert into rapid_cup_collections (user_id, box_type, ref_id, amount)
  values (auth.uid(), 'cupbox', p_lobby_id, v_amount_int)
  on conflict (user_id, box_type, ref_id) do nothing
  returning * into v_claim;

  if v_claim.id is null then
    return 0; -- already collected — idempotent, no double credit
  end if;

  if v_amount_int > 0 then
    perform _nets_credit_internal(auth.uid(), v_amount_int, 'rapid_cup_cupbox', null, 'lobby', p_lobby_id::text, null);
  end if;

  return v_amount_int;
end;
$$;

-- Explicit revoke-then-grant — see header comment. Both are meant to be
-- client-callable, but only via this exact grant, not the Postgres/Supabase
-- default-privilege hole.
revoke all on function collect_rapid_cup_winbox(uuid) from public, anon;
revoke all on function collect_rapid_cup_cupbox(uuid) from public, anon;
grant execute on function collect_rapid_cup_winbox(uuid) to authenticated;
grant execute on function collect_rapid_cup_cupbox(uuid) to authenticated;
