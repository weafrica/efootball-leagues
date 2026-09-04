-- Rapid Cup Push Alarm — Step 6 (see RAPID-CUP-PUSH-ALARM-BUILD-PLAN.md,
-- Section 8). Moves "stopped" out of sessionStorage (per-browser-profile,
-- invisible to any other device) and into the database, so tapping Stop
-- on ONE of a player's devices (e.g. the phone notification) silences the
-- alarm on ALL of that same player's open tabs/devices (e.g. a laptop tab
-- still ringing), not just the device the tap happened on.
--
-- Scoped to (lobby_id, user_id) — this is about one player's own alarm
-- following them across their own devices, not about one player silencing
-- another player's alarm.
alter table rapid_cup_lobby_players
  add column if not exists alarm_stopped_at timestamptz;

-- stop_rapid_cup_alarm — the only way this column is ever written. A
-- regular authenticated user has no direct update policy on
-- rapid_cup_lobby_players (matches this table's existing "writes only
-- happen through RPCs" convention, see Phase 1's migration) — this RPC is
-- the one exception, and it can only ever touch the caller's own row
-- (auth.uid()), never anyone else's.
--
-- Idempotent by design (`and alarm_stopped_at is null`) — whichever
-- device's Stop action reaches the database first "wins" and every other
-- device just sees the same already-set timestamp when it reads/subscribes,
-- rather than repeatedly overwriting it.
create or replace function stop_rapid_cup_alarm(p_lobby_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update rapid_cup_lobby_players
  set alarm_stopped_at = now()
  where lobby_id = p_lobby_id
    and user_id = auth.uid()
    and alarm_stopped_at is null;
end;
$$;

grant execute on function stop_rapid_cup_alarm(uuid) to authenticated;

-- rapid_cup_lobby_players is already in the supabase_realtime publication
-- (20260903130000_rapid_cup_enable_realtime.sql) — no further change
-- needed for the frontend to subscribe to this column's UPDATEs.
