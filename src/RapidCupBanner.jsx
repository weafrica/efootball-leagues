import React, { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import { RapidCupJoinModal } from "./RapidCupFeeDisplay";

// RapidCupBanner — horizontal banner for the home screen, sits under
// Quick Actions (see App.jsx home layout). Shows the current open
// lobby's fill count and countdown, lets the viewer join, and once
// their lobby goes live, hands off to the tournament page.
//
// Notification thresholds fire once each per lobby — trackedThresholds
// resets whenever the lobby id changes so a new lobby gets its own
// 15/5/1 min warnings.
// Rapid Cup — Phase 1: Lobby & Auto-Start.
//
// "Every Rapid Cup gets its own theme" — RapidCupBanner shows the current
// cup's theme name/colors on the Home banner (see rapidCupThemes.js, same
// cycling-by-number pattern as League Ladder's per-tier themes in
// ladderTierThemes.js). The league itself is also named after its theme
// server-side, in generate_rapid_cup_bracket.
import { getRapidCupTheme } from "./rapidCupThemes.js";

const NOTIFY_THRESHOLDS_MS = [15 * 60 * 1000, 5 * 60 * 1000, 60 * 1000];

// Whether this browser tab has already auto-opened this particular Rapid
// Cup league once. sessionStorage (not a module-level variable, and not a
// React ref/state) is deliberate: a ref/module variable only survives
// RapidCupBanner being unmounted/remounted (e.g. leaving and returning to
// Home within the same page load) — it's wiped out by an actual page
// reload, which is common on mobile (backgrounding an installed PWA,
// pull-to-refresh, the OS discarding and reloading a background tab).
// Without this, a reload while still inside the live-tournament window
// looked identical to the original bug: land on Home, wait for the
// lobby fetch (a couple seconds), then get pulled straight back in.
// sessionStorage survives a reload but still clears itself once the tab
// actually closes, so it never traps someone in a tournament that's long
// finished.
function hasAutoOpenedRapidCupLeague(leagueId) {
  try { return sessionStorage.getItem(`rapid_cup_auto_opened:${leagueId}`) === "1"; }
  catch { return false; }
}
function markRapidCupLeagueAutoOpened(leagueId) {
  try { sessionStorage.setItem(`rapid_cup_auto_opened:${leagueId}`, "1"); }
  catch { /* private browsing / storage disabled — worst case, re-prompts once */ }
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

export default function RapidCupBanner({ onOpenLobby, onOpenLeague, showToast, c }) {
  const { lobby, playerCount, myEntry, reload } = useOpenRapidCupLobby();
  const [now, setNow] = useState(() => Date.now());
  const [joining, setJoining] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
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
  // to the tournament page as soon as league_id is set — but only ever
  // once for this league, on this device (see hasAutoOpenedRapidCupLeague
  // above), not on every 5s poll tick, not on every remount of this
  // banner, and not on every reload while the cup's still live.
  useEffect(() => {
    if (lobby?.status === "live" && lobby?.league_id && myEntry && !hasAutoOpenedRapidCupLeague(lobby.league_id)) {
      markRapidCupLeagueAutoOpened(lobby.league_id);
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

  const theme = getRapidCupTheme(lobby.cup_number);

  const fmtCountdown = (ms) => {
    if (ms == null) return "";
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
    const s = (totalSec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const isMine = !!myEntry;
  const isFull = playerCount >= 4;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenLobby?.(lobby.id)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "12px 16px", borderRadius: 12, cursor: "pointer",
        background: theme.surface, border: `1px solid ${theme.border}`,
        marginBottom: 12, fontFamily: theme.font,
      }}
    >
      <div>
        <div style={{ fontWeight: 700, color: theme.accent }}>⚡ {theme.name}</div>
        <div style={{ fontSize: 13, color: theme.textDim }}>
          {lobby.status === "live"
            ? "Tournament live"
            : isFull
              ? "Full — next lobby opening"
              : `${playerCount}/4 joined${msLeft != null ? ` — resets in ${fmtCountdown(msLeft)}` : ""}`}
        </div>
      </div>

      {lobby.status === "open" && !isFull && (
        isMine ? (
          <span style={{ fontSize: 13, color: theme.textDim }}>You're in</span>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setShowJoinModal(true); }}
            disabled={joining}
            style={{ padding: "8px 16px", borderRadius: 8, fontWeight: 600, background: theme.accent, color: theme.accentText }}
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
    </div>
  );
}
