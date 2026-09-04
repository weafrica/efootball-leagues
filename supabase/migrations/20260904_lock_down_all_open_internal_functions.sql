-- Site-wide sweep, prompted by finding the same gap twice in one day
-- (Rapid Cup spectator investment, League Ladder pool). Turns out the
-- gap is everywhere: every SECURITY DEFINER function named with a
-- leading underscore or an "_internal" suffix is, by Postgres default,
-- executable by PUBLIC (which includes anon and authenticated) unless
-- something explicitly revokes it. Almost none of these ever had that
-- revoke run. Worst case among them: _nets_debit_internal takes an
-- arbitrary p_user_id and could debit ANY user's wallet directly, no
-- ownership check, if called straight from the client.
--
-- These are meant to be called only from inside other SECURITY DEFINER
-- functions (cron sweeps, RPCs, triggers) — never directly by a client.
-- Locking every one of them down; nothing here is meant to be callable
-- by anon or authenticated directly.
revoke all on function _admin_approve_ladder_fixture_result_internal(p_submission_id uuid, p_admin_user_id uuid) from public, anon, authenticated;
revoke all on function _credit_ladder_battle_draw_reward(p_league_id uuid, p_match_id uuid, p_team_a_id uuid, p_team_b_id uuid) from public, anon, authenticated;
revoke all on function _credit_ladder_match_reward_internal(p_fixture_id uuid) from public, anon, authenticated;
revoke all on function _ensure_ladder_league_internal(p_tier integer) from public, anon, authenticated;
revoke all on function _generate_round_robin_fixtures_internal(p_league_id uuid, p_week_number integer, p_player_ids uuid[], p_week_start_at timestamp with time zone) from public, anon, authenticated;
revoke all on function _ladder_apply_decay_penalty_internal(p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_bid_eligible_pool_internal(p_target_league_id uuid, p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_close_week_internal() from public, anon, authenticated;
revoke all on function _ladder_cup_auto_finalize_due_sweep_internal() from public, anon, authenticated;
revoke all on function _ladder_cup_crown_champion_internal(p_league_id uuid) from public, anon, authenticated;
revoke all on function _ladder_cup_expire_stale_second_life_internal(p_league_id uuid) from public, anon, authenticated;
revoke all on function _ladder_cup_finalize_internal(p_league_id uuid) from public, anon, authenticated;
revoke all on function _ladder_cup_monthly_cycle_tick() from public, anon, authenticated;
revoke all on function _ladder_cup_open_new_internal() from public, anon, authenticated;
revoke all on function _ladder_cup_weekly_cycle_internal() from public, anon, authenticated;
revoke all on function _ladder_fall_through_internal(p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_fixture_result_auto_approve_expired_internal() from public, anon, authenticated;
revoke all on function _ladder_fixture_result_recheck_bid_leader_trigger() from public, anon, authenticated;
revoke all on function _ladder_forfeit_expired_fixtures_internal() from public, anon, authenticated;
revoke all on function _ladder_open_week_internal() from public, anon, authenticated;
revoke all on function _ladder_pool_reward_debit(p_amount bigint, p_reason text, p_user_id uuid, p_ref_type text, p_ref_id text) from public, anon, authenticated;
revoke all on function _ladder_recheck_bid_eligibility_on_result_internal(p_affected_league_id uuid, p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_recheck_bid_leader_eligibility_internal(p_league_id uuid, p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_record_wall_of_fame_internal(p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_resolve_promotion_relegation_internal() from public, anon, authenticated;
revoke all on function _ladder_retroactive_topup_internal(p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_settle_bids_internal(p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_settle_queued_reward_payouts_internal() from public, anon, authenticated;
revoke all on function _ladder_settle_week_fees_internal(p_week_number integer) from public, anon, authenticated;
revoke all on function _ladder_sync_fixtures_internal(p_league_id uuid, p_week_number integer) from public, anon, authenticated;
revoke all on function _nets_debit_internal(p_user_id uuid, p_amount bigint, p_reason text, p_note text, p_ref_type text, p_ref_id text, p_team_id uuid) from public, anon, authenticated;
revoke all on function _open_challenges_auto_approve_expired_internal() from public, anon, authenticated;
revoke all on function _purge_inactive_ladder_members_internal(p_grace interval) from public, anon, authenticated;
revoke all on function _rebalance_ladder_overflow_internal(p_week_number integer) from public, anon, authenticated;
revoke all on function _weekend_league_advance_knockout_internal(p_league_id uuid) from public, anon, authenticated;
revoke all on function _weekend_league_advance_one_group_stage(p_league_id uuid) from public, anon, authenticated;
revoke all on function _weekend_league_group_stage_sweep_internal() from public, anon, authenticated;
revoke all on function _weekend_league_open_new_internal() from public, anon, authenticated;
revoke all on function _weekend_league_sweep_internal() from public, anon, authenticated;
