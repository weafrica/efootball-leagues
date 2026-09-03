-- WEEKEND LEAGUE auto-cycle — stop carrying stage/progress over to the new
-- weekly instance.
--
-- _weekend_league_open_new_internal (see 20260901071500) clones the
-- previous week's league row in full (`v_new := v_prev;`) and only
-- overrides id/created_at/starts_at/entry_closes_at/prizes_paid_at. That's
-- correct for actual configuration (format, group_size, group_qualifiers,
-- knockout_legs, round_period_hours, league_type, description, etc.) —
-- but it was also carrying over the *previous* cycle's progress:
-- current_stage, final_stage_started, groups_count, and
-- group_stage_due_at. A freshly-opened league with zero teams and zero
-- fixtures was ending up already marked as being in the knockout stage
-- (final_stage_started=true, current_stage=2) with a group_stage_due_at
-- left over from weeks ago — which both mislabels the league in the UI
-- before an admin has even started it, and silently defeats
-- 20260925_weekend_league_group_stage_auto_advance's cron sweep (which
-- only ever acts on final_stage_started=false leagues), permanently.
--
-- Fix: reset those four columns to the same defaults a brand-new league
-- row gets (current_stage=1, final_stage_started=false, groups_count=null,
-- group_stage_due_at=null). groups_count/group_stage_due_at get set for
-- real when the admin (or the group-stage-auto-advance flow further down
-- the line) actually starts the league and generates fixtures — see
-- doGenerateFixtures in src/App.jsx.
--
-- Same cron job ('weekend-league-monday-open', unchanged) calls this
-- function by name, so replacing the function body alone is enough — no
-- need to re-schedule anything. Safe to run more than once.
create or replace function _weekend_league_open_new_internal()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev leagues%rowtype;
  v_new leagues%rowtype;
  v_new_id uuid;
  v_next_start timestamptz;
begin
  v_next_start := _weekend_league_next_sast_dow_hour(now(), 5, 18); -- next Friday 18:00 SAST

  if exists (
    select 1 from leagues
    where created_by_admin = true and format <> 'ladder_cup' and starts_at = v_next_start
  ) then
    return null; -- already opened this weekend's league
  end if;

  select * into v_prev
  from leagues
  where created_by_admin = true
    and format <> 'ladder_cup'
    and extract(dow from ((starts_at + interval '2 hours') at time zone 'UTC')) in (5, 6, 0)
  order by starts_at desc
  limit 1;

  if not found then
    return null; -- no prior Weekend League to clone settings from yet
  end if;

  v_new := v_prev;
  v_new.id := gen_random_uuid();
  v_new.created_at := now();
  v_new.starts_at := v_next_start;
  v_new.entry_closes_at := v_next_start; -- open continuously from creation through kickoff
  v_new.prizes_paid_at := null;

  -- Progress belongs to the cycle that produced it, not the next one —
  -- reset it to the same state a brand-new league row starts in.
  v_new.current_stage := 1;
  v_new.final_stage_started := false;
  v_new.groups_count := null;
  v_new.group_stage_due_at := null;

  insert into leagues select (v_new).*
  returning id into v_new_id;

  return v_new_id;
end;
$$;
