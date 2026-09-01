-- Remove the inactivity-decay step from the weekly close. It was silently
-- stranding players: a stayer who didn't play (e.g. because their whole
-- league's fixtures were forfeited, as happened to Tier 13's week 1) got
-- flipped from 'active' to 'eliminated' *before* _ladder_open_week_internal's
-- carry-forward query ran, which only carries forward 'active' rows — so
-- they got no membership at all for the next week, with no fall-through and
-- no fixture to appeal. Same class of bug as the fall-through affordability
-- exception the redesign spec's Phase B (step 7) already flags — decay just
-- wasn't covered by that spec, and had no fallback at all (fall-through at
-- least re-seats the player in their own league on failure).
--
-- _ladder_apply_decay_penalty_internal itself is left in place (unused)
-- rather than dropped, in case it's wanted again later with a fix that
-- seats the player somewhere instead of leaving them with no week at all.

create or replace function _ladder_close_week_internal()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_week integer;
begin
  select current_week into v_week from ladder_cycle where id = true;

  perform _ladder_resolve_promotion_relegation_internal();

  if v_week is not null and v_week > 0 then
    perform _ladder_record_wall_of_fame_internal(v_week);
    perform _ladder_settle_week_fees_internal(v_week);
    perform _ladder_settle_bids_internal(v_week);
    perform _ladder_fall_through_internal(v_week);
  end if;

  update ladder_cycle
  set bidding_open = false, fixtures_locked = true, updated_at = now()
  where id = true;

  perform _ladder_open_week_internal();
end;
$$;
