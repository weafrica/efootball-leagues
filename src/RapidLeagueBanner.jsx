import React, { useState, useEffect, useCallback, useRef } from "react";
import { Info, X } from "lucide-react";
import { supabase } from "./supabaseClient";
import { RapidCupJoinModal } from "./RapidCupFeeDisplay";

// RapidLeagueBanner — single-round-robin sibling to RapidCupBanner.
// Same 4-player lobby/join/fee/countdown/payout mechanics; adapted from
// the real, current RapidCupBanner.jsx rather than guessed from scratch.
//
// Deliberately different from RapidCupBanner, and why:
//
//   - No team-elimination check in useOpenRapidLeagueLobby. Rapid Cup
//     drops a stale "live" lobby the moment the viewer's own team is
//     eliminated (see its own comment on that block) because a bracket
//     keeps running for the other 3 players after you're knocked out. A
//     round robin has no elimination — every player plays all 3 of their
//     matches regardless of how the others go — so that entire check
//     doesn't apply and is left out rather than ported unnecessarily.
//
//   - No useCountdownDrumroll / useLeagueStartAlarm from
//     RapidCupEpicExtras.jsx. Checked that file directly: stopAlarm()
//     hardcodes an RPC call to stop_rapid_cup_alarm and a Realtime
//     subscription filtered on the rapid_cup_lobby_players table; the
//     phone notification hardcodes the tag rapid-cup-alarm-${lobbyId} and
//     the text "⚡ Rapid Cup". Reusing that hook here wouldn't error, but
//     the cross-device stop-sync would silently watch the wrong table and
//     the phone notification would say "Rapid Cup" on a Rapid League
//     match. Rather than fork a file three other things depend on
//     (rapidCupAlarmSync.js, sw.js) without visibility into those too,
//     this is intentionally out of scope for this pass. What's still
//     here: the in-app "your league has started" auto-redirect (below,
//     self-contained, always worked this way) and a plain stop_rapid_
//     league_alarm() call when the viewer taps in, so the DB-side
//     alarm_stopped_at bookkeeping is still correct even without an
//     audible alarm attached to it yet.
//
//   - No push notification subscribe/listen (subscribeToRapidCupPush /
//     listenForPushResubscribe). There's no send-rapid-league-push edge
//     function deployed — see the migration's own header comment.
//
// Countdown notifications at 15/5/1 min remaining still fire ONLY for a
// viewer who has actually joined this lobby (myEntry) — same fix as the
// one already shipped on RapidCupBanner.
const NOTIFY_THRESHOLDS_MS = [15 * 60 * 1000, 5 * 60 * 1000, 60 * 1000];

// sessionStorage-backed for the same reason as RapidCupBanner's identical
// pattern: has to survive both a Home remount AND a full page refresh.
// Separate storage key from Rapid Cup's so the two features don't collide.
const AUTO_OPENED_STORAGE_KEY = "rapidLeague:autoOpenedLeagueIds";

function loadAutoOpenedLeagueIds() {
  try {
    const raw = sessionStorage.getItem(AUTO_OPENED_STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function markLeagueAutoOpened(leagueId) {
  const ids = loadAutoOpenedLeagueIds();
  ids.add(leagueId);
  try {
    sessionStorage.setItem(AUTO_OPENED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage unavailable — nothing to do, worst case is an extra redirect.
  }
}

function useOpenRapidLeagueLobby() {
  const [lobby, setLobby] = useState(null);
  const [playerCount, setPlayerCount] = useState(0);
  const [myEntry, setMyEntry] = useState(null);

  const load = useCallback(async () => {
    const { data: { user } = {} } = await supabase.auth.getUser();

    // Same "prefer a lobby I'm actually in" preference as Rapid Cup, for
    // the same reason: once a lobby fills, join_rapid_league_lobby
    // immediately opens a fresh empty one to chain into, and that fresh
    // one has a later created_at — ordering by created_at desc alone
    // would show the 4 players who just filled it an empty lobby that
    // isn't theirs.
    let lobbyRow = null;
    if (user?.id) {
      const { data: myRows } = await supabase
        .from("rapid_league_lobby_players")
        .select("lobby_id")
        .eq("user_id", user.id);
      const myLobbyIds = (myRows || []).map((r) => r.lobby_id);
      if (myLobbyIds.length) {
        const { data: myActive } = await supabase
          .from("rapid_league_lobbies")
          .select("*")
          .in("id", myLobbyIds)
          .in("status", ["filling", "live"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        lobbyRow = myActive || null;
        // No elimination check here — see the file-level comment above
        // for why a round robin doesn't need one.
      }
    }

    if (!lobbyRow) {
      const { data: latest } = await supabase
        .from("rapid_league_lobbies")
        .select("*")
        .in("status", ["open", "filling", "live"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      lobbyRow = latest;
    }

    if (!lobbyRow) { setLobby(null); setPlayerCount(0); setMyEntry(null); return; }

    const { data: players } = await supabase
      .from("rapid_league_lobby_players")
      .select("user_id, entry_fee")
      .eq("lobby_id", lobbyRow.id);

    setLobby(lobbyRow);
    setPlayerCount(players?.length || 0);
    setMyEntry((players || []).find((p) => p.user_id === user?.id) || null);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [load]);

  return { lobby, playerCount, myEntry, reload: load };
}

function RapidLeagueHelpModal({ open, onClose, c }) {
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
          <div style={{ fontWeight: 700 }}>🔁 What's Rapid League?</div>
          <button onClick={onClose} aria-label="Close" style={{ color: c?.textFaint || "#888" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, opacity: 0.85 }}>
          A 4-player single round robin — join a lobby, pay your entry fee in Nets, and once it fills everyone plays everyone once (3 matches each). Top of the table when all 6 matches are done takes the pooled bonus.
        </div>
        <button onClick={onClose} style={{ width: "100%", marginTop: 16, padding: "8px 0", borderRadius: 8, fontWeight: 600 }}>
          Got it
        </button>
      </div>
    </div>
  );
}

export default function RapidLeagueBanner({ onOpenLobby, onOpenLeague, showToast, onSuggestNotifications, c }) {
  const { lobby, playerCount, myEntry, reload } = useOpenRapidLeagueLobby();
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

  useEffect(() => {
    if (lobby?.id !== lastLobbyId.current) {
      firedThresholds.current = new Set();
      lastLobbyId.current = lobby?.id ?? null;
    }
  }, [lobby?.id]);

  const resetAtMs = lobby?.reset_at ? new Date(lobby.reset_at).getTime() : null;
  const msLeft = resetAtMs ? Math.max(0, resetAtMs - now) : null;

  // Countdown notifications at 15/5/1 min remaining — same myEntry gate
  // as the fixed RapidCupBanner: only fires for a viewer who has actually
  // joined this lobby, never for someone just browsing.
  useEffect(() => {
    if (msLeft == null || !lobby || lobby.status !== "open" || !myEntry) return;
    for (const threshold of NOTIFY_THRESHOLDS_MS) {
      const key = `${lobby.id}:${threshold}`;
      if (msLeft <= threshold && !firedThresholds.current.has(key)) {
        firedThresholds.current.add(key);
        const mins = Math.round(threshold / 60000);
        showToast?.(`Rapid League lobby resets in ${mins} min — get your match in!`);
      }
    }
  }, [msLeft, lobby, myEntry, showToast]);

  // Auto-redirect once the round robin goes live and this viewer is one
  // of the 4 — same self-contained pattern as Rapid Cup (no dependency
  // on the Epic Extras alarm file).
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

  // Fixture generation — as soon as the lobby flips to "filling" (4th
  // player joined) but hasn't got a league_id yet. generate_rapid_league_
  // fixtures itself is the race guard (locks the lobby row, no-ops if
  // already live); triedGeneration just stops every one of the 4 open
  // tabs from firing the RPC on every 5s poll tick.
  const triedGeneration = useRef(new Set());
  useEffect(() => {
    if (lobby?.status !== "filling" || lobby?.league_id || !myEntry) return;
    if (triedGeneration.current.has(lobby.id)) return;
    triedGeneration.current.add(lobby.id);
    supabase.rpc("generate_rapid_league_fixtures", { p_lobby_id: lobby.id }).then(({ error }) => {
      if (error) {
        triedGeneration.current.delete(lobby.id);
      } else {
        reload();
      }
    });
  }, [lobby?.status, lobby?.league_id, lobby?.id, myEntry, reload]);

  const join = async (fee) => {
    setJoining(true);
    const { error } = await supabase.rpc("join_rapid_league_lobby", { p_entry_fee: fee });
    setJoining(false);
    if (error) { showToast?.(error.message || "Couldn't join Rapid League."); return; }
    setShowJoinModal(false);
    onSuggestNotifications?.();
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

  const handleBannerClick = () => {
    if (myEntry && lobby.league_id) {
      supabase.rpc("stop_rapid_league_alarm", { p_lobby_id: lobby.id }).then(() => {});
      onOpenLeague?.(lobby.league_id);
      return;
    }
    if (myEntry) {
      showToast?.("Starting… you'll be taken in automatically in a moment.");
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
        background: c?.cardBg || "#1a1a1a",
        border: `1px solid ${c?.border || "#333"}`,
        marginBottom: 12,
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700 }}>🔁 Rapid League</span>
          <button
            onClick={(e) => { e.stopPropagation(); setShowHelp(true); }}
            title="What's Rapid League?" aria-label="What's Rapid League?"
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
            ? isMine ? "Your league has started — tap to enter!" : "Round robin live"
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

      <RapidLeagueHelpModal open={showHelp} onClose={() => setShowHelp(false)} c={c} />
    </div>
  );
}
