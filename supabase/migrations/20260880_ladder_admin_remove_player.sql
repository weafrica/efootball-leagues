-- League Ladder — admin: remove a player from a league.
--
-- Same admins-table check pattern as 20260864's admin tools. Scoped
-- deliberately narrow: this removes a membership row BEFORE fixtures
-- exist for it — the "player joined, roster's stuck, admin needs to pull
-- them back off" case (e.g. clearing the join that's currently blocking
-- Week 1 from generating fixtures). It is NOT a mid-competition removal
-- tool: once ladder_fixtures rows exist for that player/week/league,
-- pulling the membership out from under them would leave those fixtures
-- dangling and corrupt standings/promotion math for everyone else in the
-- league that week. For that case, use the existing
-- admin_override_ladder_fixture_result (20260864) to forfeit/correct
-- their remaining games instead — the membership itself stays put.
--
-- Refund: join_ladder_league (20260867) is the only path that ever
-- charges an entry fee for a membership row (a 'ladder_league_join'
-- nets_transactions entry, tagged ref_type='ladder_leagues',
-- ref_id=<league_id>). Promotion/relegation/auction/carry-forward rows
-- never charged one at insert time, so this only refunds when that exact
-- transaction is found — never guesses an amount from the tier table,
-- and never double-refunds a membership that's already been refunded
-- once.
--
-- Safe to run more than once.

create or replace function admin_remove_ladder_player(
  p_user_id uuid,
  p_week_number integer default null
) returns ladder_memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid := auth.uid();
  v_membership ladder_memberships%rowtype;
  v_current_week integer;
  v_fixture_count integer;
  v_refund_tx nets_transactions%rowtype;
  v_already_refunded boolean;
begin
  if v_admin_id is null or not exists (select 1 from admins a where a.user_id = v_admin_id) then
    raise exception 'admin_remove_ladder_player: admin only';
  end if;

  select current_week into v_current_week from ladder_cycle where id = true;
  v_current_week := coalesce(v_current_week, 0);

  -- p_week_number lets an admin target a specific week's row explicitly;
  -- left null, this finds their current/upcoming active membership — the
  -- same "already on the ladder" row join_ladder_league itself checks
  -- against.
  if p_week_number is not null then
    select * into v_membership
    from ladder_memberships
    where user_id = p_user_id and week_number = p_week_number and status = 'active'
    for update;
  else
    select * into v_membership
    from ladder_memberships
    where user_id = p_user_id and status = 'active' and week_number >= v_current_week
    order by week_number desc
    limit 1
    for update;
  end if;

  if v_membership.id is null then
    raise exception 'admin_remove_ladder_player: player has no active ladder membership%',
      case when p_week_number is not null then ' for week ' || p_week_number else '' end;
  end if;

  select count(*) into v_fixture_count
  from ladder_fixtures
  where league_id = v_membership.league_id
    and week_number = v_membership.week_number
    and (home_user_id = p_user_id or away_user_id = p_user_id);

  if v_fixture_count > 0 then
    raise exception 'admin_remove_ladder_player: fixtures already exist for this player this week — forfeit/override those (admin_override_ladder_fixture_result) instead of removing the membership';
  end if;

  delete from ladder_memberships where id = v_membership.id;

  -- Refund the paid entry fee for this exact join, if there is one and it
  -- hasn't already been refunded.
  select * into v_refund_tx
  from nets_transactions
  where user_id = p_user_id
    and reason = 'ladder_league_join'
    and ref_type = 'ladder_leagues'
    and ref_id = v_membership.league_id::text
    and created_at <= v_membership.joined_at
  order by created_at desc
  limit 1;

  if v_refund_tx.id is not null and v_refund_tx.amount < 0 then
    select exists (
      select 1 from nets_transactions
      where user_id = p_user_id
        and reason = 'ladder_league_join_refund'
        and ref_type = 'ladder_leagues'
        and ref_id = v_membership.league_id::text
        and created_at >= v_refund_tx.created_at
    ) into v_already_refunded;

    if not v_already_refunded then
      perform nets_credit(
        p_user_id, -v_refund_tx.amount, 'ladder_league_join_refund',
        'Removed from League Ladder by admin', 'ladder_leagues', v_membership.league_id::text
      );
    end if;
  end if;

  return v_membership;
end;
$$;

grant execute on function admin_remove_ladder_player(uuid, integer) to authenticated;
