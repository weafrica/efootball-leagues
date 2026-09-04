import React, { useState, useEffect, useCallback, useRef } from "react";
import { Info, X } from "lucide-react";
import { supabase } from "./supabaseClient";
import { RapidCupJoinModal } from "./RapidCupFeeDisplay";
import { useCountdownDrumroll, useLeagueStartAlarm } from "./RapidCupEpicExtras.jsx";

// RapidCupBanner — horizontal banner for the home screen, sits under
// Quick Actions (see App.jsx home layout). Shows the current open
// lobby's fill count and countdown, lets the viewer join, and once
// their lobby goes live, hands off to the tournament page.
//
// Notification thresholds fire once each per lobby — trackedThresholds
// resets whenever the lobby id changes so a new lobby gets its own
// 15/5/1 min warnings.
const NOTIFY_THRESHOLDS_MS = [15 * 60 * 1000, 5 * 60 * 1000, 60 * 1000];

// sessionStorage-backed, not component state or a module-level Set — this
// has to survive two different resets:
//   1. RapidCupBanner unmounting/remounting, which happens every time Home
//      itself unmounts (App.jsx only renders <Home> while view === "home").
//      A ref or useState resets on that remount alone.
//   2. A full page reload/refresh, which wipes any plain in-memory JS
//      value (module-level Set included) back to empty.
// Case 2 was the actual cause of "can't get back to the homepage during
// Rapid Cup": a player leaves their live lobby to browse Home, refreshes
// the page, the in-memory guard forgets it already auto-opened that
// league_id, and the effect below fires again and yanks them straight back
// into the tournament. sessionStorage survives the reload (it's scoped to
// the tab, not the JS heap) so "already auto-opened" sticks for the rest
// of that browser session, while still resetting for a genuinely new
// session (new tab) — matching the "once per session" intent the old
// comment described but the old Set didn't actually deliver.
const AUTO_OPENED_STORAGE_KEY = "rapidCup:autoOpenedLeagueIds";

function loadAutoOpenedLeagueIds() {
  try {
    const raw = sessionStorage.getItem(AUTO_OPENED_STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    // Storage unavailable (private mode, etc.) — fail open to "never
    // remembered," which just costs an extra redirect worst case.
    return new Set();
  }
}

function markLeagueAutoOpened(leagueId) {
  const ids = loadAutoOpenedLeagueIds();
  ids.add(leagueId);
  try {
    sessionStorage.setItem(AUTO_OPENED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Nothing we can do if storage is unavailable/full — swallow it.
  }
}

function useOpenRapidCupLobby() {
  const [lobby, setLobby] = useState(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [myEntry, setMyEntry] = useState(null); // this viewer's row in the current lobby, if joined

  const load = useCallback(async () => {
    const { data: { user } = {} } = await supabase.auth.getUser();

    // Prefer a lobby the viewer is actually IN and still filling/live over
    // "whatever lobby is newest." Once a lobby fills, join_rapid_cup_lobby
    // immediately creates a fresh empty "open" lobby to chain into — that
    // new lobby has a LATER created_at than the one that just filled, so
    // ordering by created_at desc alone would show the 4 players who just
    // filled it an empty lobby that isn't theirs (myEntry would come back
    // null there, which silently breaks both bracket generation and the
    // live-tournament redirect below).
    let lobbyRow = null;
    if (user?.id) {
      const { data: myRows } = await supabase
        .from("rapid_cup_lobby_players")
        .select("lobby_id")
        .eq("user_id", user.id);
      const myLobbyIds = (myRows || []).map((r) => r.lobby_id);
      if (myLobbyIds.length) {
        const { data: myActive } = await supabase
          .from("rapid_cup_lobbies")
          .select("*")
          .in("id", myLobbyIds)
          .in("status", ["filling", "live"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        lobbyRow = myActive || null;

        // A lobby stays "live" for all 4 players until the WHOLE bracket
        // finishes — rapid_cup_lobbies has no per-player elimination
        // state, only teams.eliminated on the underlying league. Without
        // this check, a player who's already lost their match stays
        // pinned to this dead-for-them lobby (no Join button ever
        // renders once status !== "open") until every other player's
        // matches finish too — this was the actual cause of "can't join
        // back into Rapid Cup even before the cup is over." Once we know
        // our own team is eliminated, drop lobbyRow so the fallback
        // query below can pick up the fresh lobby chained via
        // next_lobby_id instead.
        if (lobbyRow?.status === "live" && lobbyRow.league_id) {
          const { data: myMember } = await supabase
            .from("members")
            .select("team_id")
            .eq("league_id", lobbyRow.league_id)
            .eq("user_id", user.id)
            .maybeSingle();
          if (myMember?.team_id) {
            const { data: myTeamRow } = await supabase
              .from("teams")
              .select("eliminated")
              .eq("id", myMember.team_id)
              .maybeSingle();
            if (myTeamRow?.eliminated) lobbyRow = null;
          }
        }
      }
    }

    // Not in an active (filling/live) lobby of our own — fall back to
    // showing whatever the current open lobby is, for the "Join" flow.
    if (!lobbyRow) {
      const { data: latest } = await supabase
        .from("rapid_cup_lobbies")
        .select("*")
        .in("status", ["open", "filling", "live"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      lobbyRow = latest;
    }

    if (!lobbyRow) { setLobby(null); setPlayerCount(0); setMyEntry(null); return; }

    const { data: players } = await supabase
      .from("rapid_cup_lobby_players")
      .select("user_id, entry_fee")
      .eq("lobby_id", lobbyRow.id);

    setLobby(lobbyRow);
    setPlayerCount(players?.length || 0);
    setMyEntry((players || []).find((p) => p.user_id === user?.id) || null);
  }, []);

  useEffect(() => {
    load();
    // Poll every 5s — swap for a Supabase realtime channel subscription
    // on rapid_cup_lobbies/rapid_cup_lobby_players once this is stable;
    // polling is the safe first cut.
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  return { lobby, playerCount, myEntry, reload: load };
}

// Short "what is this" explainer, opened from the (?) button on the banner.
// Same fixed-overlay pattern as RapidCupJoinModal in RapidCupFeeDisplay.jsx,
// kept local here since it has nothing to share with that one beyond the
// look — just a title, one explaining sentence, and a close button.
function RapidCupHelpModal({ open, onClose, c }) {
  if (!open) return null;
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
      }}
    >
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: c?.cardBg || "#1a1a1a", border: `1px solid ${c?.border || "#333"}`, borderRadius: 12, padding: 20, width: 320 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontWeight: 700 }}>⚡ What's Rapid Cup?</div>
          <button onClick={onClose} aria-label="Close" style={{ color: c?.textFaint || "#888" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, opacity: 0.85 }}>
          An instant 4-player knockout — join a lobby, pay your entry fee in Nets, get matched the moment it fills, and the winner takes the pooled bonus.
        </div>
        <button onClick={onClose} style={{ width: "100%", marginTop: 16, padding: "8px 0", borderRadius: 8, fontWeight: 600 }}>
          Got it
        </button>
      </div>
    </div>
  );
}

export default function RapidCupBanner({ onOpenLobby, onOpenLeague, showToast, c }) {
  const { lobby, playerCount, myEntry, reload } = useOpenRapidCupLobby();
  const [now, setNow] = useState(() => Date.now());
  const [joining, setJoining] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const firedThresholds = useRef(new Set());
  const lastLobbyId = useRef(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Reset fired-notification tracking whenever we land on a new lobby.
  useEffect(() => {
    if (lobby?.id !== lastLobbyId.current) {
      firedThresholds.current = new Set();
      lastLobbyId.current = lobby?.id ?? null;
    }
  }, [lobby?.id]);

  const resetAtMs = lobby?.reset_at ? new Date(lobby.reset_at).getTime() : null;
  const msLeft = resetAtMs ? Math.max(0, resetAtMs - now) : null;

  // Countdown drumroll (Section 13, Phase 9) — last 10s of this same
  // lobby-reset timer, once per lobby. Only while the lobby is still
  // "open" (filling), same gating as the 15/5/1 min toasts below.
  useCountdownDrumroll(msLeft, lobby?.id ?? null, lobby?.status === "open");

  // League-start alarm — rings once this lobby hits 4 players and starts,
  // for this viewer only if they're actually one of the 4 (myEntry), not
  // for someone just browsing the open lobby before joining.
  useLeagueStartAlarm(lobby?.status, lobby?.id ?? null, !!myEntry);

  // Countdown notifications at 15/5/1 min remaining — fires once per
  // threshold per lobby.
  useEffect(() => {
    if (msLeft == null || !lobby || lobby.status !== "open") return;
    for (const threshold of NOTIFY_THRESHOLDS_MS) {
      const key = `${lobby.id}:${threshold}`;
      if (msLeft <= threshold && !firedThresholds.current.has(key)) {
        firedThresholds.current.add(key);
        const mins = Math.round(threshold / 60000);
        showToast?.(`Rapid Cup lobby resets in ${mins} min — join now!`);
      }
    }
  }, [msLeft, lobby, showToast]);

  // Once the lobby goes live and this viewer is one of the 4, hand off
  // to the tournament page as soon as league_id is set — but only the
  // first time ever, not on every 5s poll tick and not on every remount
  // of this banner (see autoOpenedLeagueIds above).
  useEffect(() => {
    if (
      lobby?.status === "live" &&
      lobby?.league_id &&
      myEntry &&
      !loadAutoOpenedLeagueIds().has(lobby.league_id)
    ) {
      markLeagueAutoOpened(lobby.league_id);
      onOpenLeague?.(lobby.league_id);
    }
  }, [lobby?.status, lobby?.league_id, myEntry, onOpenLeague]);

  // Bracket generation — as soon as the lobby flips to "filling" (4th
  // player joined) but hasn't got a league_id yet, one of the 4 players'
  // clients calls generate_rapid_cup_bracket to create the leagues/teams/
  // fixtures rows. The RPC itself is the real race guard (locks the lobby
  // row, no-ops if already live) — triedGeneration just stops every one
  // of the 4 open tabs from firing the RPC on every 5s poll tick.
  const triedGeneration = useRef(new Set());
  useEffect(() => {
    if (lobby?.status !== "filling" || lobby?.league_id || !myEntry) return;
    if (triedGeneration.current.has(lobby.id)) return;
    triedGeneration.current.add(lobby.id);
    supabase.rpc("generate_rapid_cup_bracket", { p_lobby_id: lobby.id }).then(({ error }) => {
      if (error) {
        // Another of the 4 clients likely already generated it — clear the
        // guard so the next poll tick can pick up the resulting league_id
        // via the normal reload, instead of getting stuck on a failed try.
        triedGeneration.current.delete(lobby.id);
      } else {
        reload();
      }
    });
  }, [lobby?.status, lobby?.league_id, lobby?.id, myEntry, reload]);

  // Fee is chosen in RapidCupJoinModal (Section 3's 0–400 Nets slider) —
  // join() itself no longer guesses at 0, it just carries whatever the
  // modal confirms.
  const join = async (fee) => {
    setJoining(true);
    const { error } = await supabase.rpc("join_rapid_cup_lobby", { p_entry_fee: fee });
    setJoining(false);
    if (error) { showToast?.(error.message || "Couldn't join Rapid Cup."); return; }
    setShowJoinModal(false);
    await reload();
  };

  if (!lobby) return null;

  const fmtCountdown = (ms) => {
    if (ms == null) return "";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
    const s = (totalSec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const isMine = !!myEntry;
  const isFull = playerCount >= 4;

  // Tapping the banner used to be hard-wired to the "tap Join" nudge no
  // matter what — fine for a viewer who hasn't joined, but wrong once
  // they have: they'd tap their own "You're in" / "Open" banner and just
  // get told to join again instead of being let back in. Route by what's
  // actually true for this viewer instead:
  //   - already seated AND the lobby has a league (bracket generated,
  //     filling or live) -> take them straight there, same handler the
  //     auto-redirect effect above uses, so it's a no-op if they're
  //     already on it.
  //   - already seated but still waiting on the 4th player -> nothing to
  //     enter yet; say so instead of nudging them to "Join" again.
  //   - not seated -> original light nudge toward the Join button.
  const handleBannerClick = () => {
    if (myEntry && lobby.league_id) {
      onOpenLeague?.(lobby.league_id);
      return;
    }
    if (myEntry) {
      showToast?.("You're in — hang tight, the tournament opens once the lobby fills.");
      return;
    }
    onOpenLobby?.(lobby.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleBannerClick}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderRadius: 12, cursor: "pointer",
        background: c?.cardBg || "#1a1a1a", border: `1px solid ${c?.border || "#333"}`,
        marginBottom: 12,
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700 }}>⚡ Rapid Cup</span>
          <button
            onClick={(e) => { e.stopPropagation(); setShowHelp(true); }}
            title="What's Rapid Cup?" aria-label="What's Rapid Cup?"
            style={{
              width: 18, height: 18, borderRadius: "50%", display: "flex",
              alignItems: "center", justifyContent: "center", flexShrink: 0,
              background: "rgba(255,255,255,0.12)", color: c?.textDim || "#aaa",
            }}
          >
            <Info size={12} />
          </button>
        </div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          {lobby.status === "live"
            ? "Tournament live"
            : isFull
              ? "Full — next lobby opening"
              : `${playerCount}/4 joined${msLeft != null ? ` — resets in ${fmtCountdown(msLeft)}` : ""}`}
        </div>
      </div>

      {lobby.status === "open" && !isFull && (
        isMine ? (
          <span style={{ fontSize: 13, opacity: 0.8 }}>You're in</span>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setShowJoinModal(true); }}
            disabled={joining}
            style={{ padding: "8px 16px", borderRadius: 8, fontWeight: 600 }}
          >
            {joining ? "Joining…" : "Join"}
          </button>
        )
      )}

      {lobby.status !== "open" && (
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {isMine ? "Open" : "Join next"}
        </span>
      )}

      <RapidCupJoinModal
        open={showJoinModal}
        onClose={() => setShowJoinModal(false)}
        onConfirm={join}
        joining={joining}
        c={c}
      />

      <RapidCupHelpModal open={showHelp} onClose={() => setShowHelp(false)} c={c} />
    </div>
  );
}
