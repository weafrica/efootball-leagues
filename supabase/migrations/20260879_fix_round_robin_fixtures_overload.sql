-- Fix: _generate_round_robin_fixtures_internal ambiguous overload
--
-- 20260856 created _generate_round_robin_fixtures_internal(uuid, integer, uuid[]).
-- 20260862 later added a 4th parameter (p_week_start_at timestamptz default now()),
-- but since that's a different signature, `create or replace function` created a
-- SECOND overload instead of replacing the first one. The original 3-arg version
-- was never dropped.
--
-- Because the 4-arg version's last parameter has a default, it can also be invoked
-- with just 3 arguments — so any 3-arg call (join flow, weekly cycle, etc.) becomes
-- ambiguous between the two overloads, raising:
--   function _generate_round_robin_fixtures_internal(uuid, integer, uuid[]) is not unique
--
-- Fix: drop the stale 3-arg overload. All existing call sites (3-arg or 4-arg) then
-- resolve unambiguously to the 4-arg version, with p_week_start_at defaulting to
-- now() for any 3-arg caller — identical behavior to what those callers got before
-- this bug existed.

drop function if exists _generate_round_robin_fixtures_internal(uuid, integer, uuid[]);
