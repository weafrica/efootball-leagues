import React, { useState, useEffect, useCallback } from "react";
import { MessageCircle } from "lucide-react";
import { supabase } from "./supabaseClient";
import { RapidCupLiveFees } from "./RapidCupFeeDisplay.jsx";
import { RapidCupInvestorPanel } from "./RapidCupInvestment.jsx";
import { getRapidCupTheme } from "./rapidCupThemes.js";
import { CupboxPackReveal, RapidCupMvpCard } from "./RapidCupEpicExtras.jsx";
import { RapidCupHallOfFame } from "./RapidCupHallOfFame.jsx";
import { waLink, WHATSAPP_GREEN, SUPPORT_WHATSAPP_NUMBER } from "./App.jsx";

// Rapid Cup — Phase 6: Winbox / Cup box tap-to-collect (Section 8).
//
// Both boxes call a server RPC that determines the amount itself — this
// file never computes or displays a number it isn't already sure the
// server will pay, and never lets the client claim on someone else's
// behalf. See supabase/migrations/20260903210000_rapid_cup_prize_collection.sql
// for the server side (collect_rapid_cup_winbox / collect_rapid_cup_cupbox).
//
// The Cup box's pack-opening animation, and the Winbox's MVP shareable
// card, are Section 13 (Phase 9) polish — see RapidCupEpicExtras.jsx. Kept
// in that separate file rather than inlined here so this file's own job
// (talk to the server, show an honest number) stays easy to read on its
// own.

function useCollectionStatus(userId, boxType, refId) {
  const [collected, setCollected] = useState(null); // null = loading, else the row (or false if none)

  const load = useCallback(async () => {
    if (!userId || !refId) { setCollected(false); return; }
    const { data } = await supabase
      .from("rapid_cup_collections")
      .select("amount")
      .eq("user_id", userId)
      .eq("box_type", boxType)
      .eq("ref_id", refId)
      .maybeSingle();
    setCollected(data || false);
  }, [userId, boxType, refId]);

  useEffect(() => { load(); }, [load]);

  return { collected, reload: load };
}

// computeIWon — mirrors collect_rapid_cup_winbox's own winner rule exactly
// (score, or penalties on a level scoreline) so the button only renders
// for an actual winner without the caller having to re-derive that logic
// itself. Returns false for anything not decided yet (unplayed, or level
// with no pens submitted) — same as the server, which has no collectable
// winner in that case either.
function computeIWon(fixture, myTeamId) {
  if (!fixture || !fixture.played || !myTeamId) return false;
  const { home_team_id, away_team_id, home_score, away_score, pens_home, pens_away } = fixture;
  if (myTeamId !== home_team_id && myTeamId !== away_team_id) return false;
  let winnerTeamId = null;
  if (home_score > away_score) winnerTeamId = home_team_id;
  else if (away_score > home_score) winnerTeamId = away_team_id;
  else if (pens_home != null && pens_away != null && pens_home !== pens_away) {
    winnerTeamId = pens_home > pens_away ? home_team_id : away_team_id;
  }
  return winnerTeamId === myTeamId;
}

// RapidCupWinbox — shown on a fixture the viewer just won. Renders nothing
// if the viewer isn't the (known, already-played) winner of this fixture —
// the server enforces this too, this is just so losers don't see a dead
// button. amountHint is optional and purely cosmetic (e.g. "3 Nets") —
// the server-returned amount is always what's actually shown/credited.
//
// Pass EITHER `fixture` + `myTeamId` (preferred — the component works out
// whether you won using the same rule the server uses) OR an explicit
// `iWon` boolean if the caller already knows it. `iWon`, when passed,
// always wins over the computed value.
// teamNameById (optional) — { [team_id]: name } so the MVP card can show
// real names. Caller (RapidCupTournamentExtras) already has league.teams
// loaded, so building this map costs it nothing; omitting it just falls
// back to generic labels rather than breaking anything.
export function RapidCupWinbox({ fixtureId, myUserId, myTeamId, fixture, iWon, amountHint = 3, teamNameById, cupName, showToast, c }) {
  const { collected, reload } = useCollectionStatus(myUserId, "winbox", fixtureId);
  const [collecting, setCollecting] = useState(false);
  const [justWon, setJustWon] = useState(null); // amount from the RPC's own response, for the reveal
  const [showMvp, setShowMvp] = useState(false); // only auto-show right after collecting, not on every revisit

  const won = iWon !== undefined ? iWon : computeIWon(fixture, myTeamId);

  if (!won || collected === null) return null;

  const collect = async () => {
    setCollecting(true);
    const { data, error } = await supabase.rpc("collect_rapid_cup_winbox", { p_fixture_id: fixtureId });
    setCollecting(false);
    if (error) { showToast?.(error.message || "Couldn't open the Winbox."); return; }
    setJustWon(data);
    setShowMvp(true);
    await reload();
  };

  const already = collected && collected.amount != null;
  const revealAmount = justWon ?? (already ? collected.amount : null);

  const opponentTeamId = fixture && myTeamId
    ? (fixture.home_team_id === myTeamId ? fixture.away_team_id : fixture.home_team_id)
    : null;
  const myScore = fixture && myTeamId ? (fixture.home_team_id === myTeamId ? fixture.home_score : fixture.away_score) : null;
  const opponentScore = fixture && myTeamId ? (fixture.home_team_id === myTeamId ? fixture.away_score : fixture.home_score) : null;
  const roundLabel = fixture?.round === 2 ? "Final" : fixture?.round === 1 ? "Semi-Final" : "";

  return (
    <div style={{ borderRadius: 10, border: `1px solid ${c?.border || "#333"}`, padding: 12, marginTop: 8 }}>
      {revealAmount != null ? (
        <div style={{ textAlign: "center", fontWeight: 700 }}>
          🎁 Winbox collected — +{revealAmount} Nets
        </div>
      ) : (
        <button
          onClick={collect}
          disabled={collecting}
          style={{ width: "100%", padding: "10px 0", borderRadius: 8, fontWeight: 700 }}
        >
          {collecting ? "Opening…" : `🎁 Open Winbox (+${amountHint} Nets)`}
        </button>
      )}
      {showMvp && revealAmount != null && myScore != null && opponentScore != null && (
        <RapidCupMvpCard
          winnerName={teamNameById?.[myTeamId] || "You"}
          opponentName={teamNameById?.[opponentTeamId] || "opponent"}
          myScore={myScore}
          opponentScore={opponentScore}
          roundLabel={roundLabel}
          cupName={cupName}
          c={c}
        />
      )}
    </div>
  );
}

// RapidCupCupbox — shown once the lobby is 'completed' (a rapid_cup_payouts
// row exists). Every participant can tap this, even a loser in a 'split'/
// 'refund' outcome or a non-winner in a 'winner' outcome — the reveal is
// honest about a $0 result rather than hiding the button from them.
export function RapidCupCupbox({ lobbyId, myUserId, showToast, c }) {
  const { collected, reload } = useCollectionStatus(myUserId, "cupbox", lobbyId);
  const [collecting, setCollecting] = useState(false);
  const [justWon, setJustWon] = useState(null);

  if (!lobbyId || !myUserId || collected === null) return null;

  const collect = async () => {
    setCollecting(true);
    const { data, error } = await supabase.rpc("collect_rapid_cup_cupbox", { p_lobby_id: lobbyId });
    setCollecting(false);
    if (error) { showToast?.(error.message || "Couldn't open the Cup box."); return; }
    setJustWon(data);
    await reload();
  };

  const already = collected && collected.amount != null;
  const revealAmount = justWon ?? (already ? collected.amount : null);
  // Only play the pack-opening animation on the tap that just revealed it
  // (justWon set) — reopening the page to an already-collected box just
  // shows the plain result, no replay.
  const justRevealed = justWon != null;

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 16, marginTop: 12 }}>
      {revealAmount != null ? (
        <CupboxPackReveal active={justRevealed}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 22 }}>🏆</div>
            <div style={{ fontWeight: 700, marginTop: 4 }}>
              {revealAmount > 0 ? `Cup box collected — +${revealAmount} Nets` : "Cup box collected — nothing this time"}
            </div>
          </div>
        </CupboxPackReveal>
      ) : (
        <button
          onClick={collect}
          disabled={collecting}
          style={{ width: "100%", padding: "12px 0", borderRadius: 8, fontWeight: 700, fontSize: 16 }}
        >
          {collecting ? "Opening…" : "🏆 Open Cup Box"}
        </button>
      )}
    </div>
  );
}

// RapidCupTournamentExtras — drops the Winbox/Cup box into a league's own
// Fixtures tab (LeagueDetail). Self-gating: a Rapid Cup league is just a
// regular `leagues` row under the hood (see generate_rapid_cup_bracket),
// so rather than threading an "is this Rapid Cup" flag down from App.jsx
// through every caller, this queries rapid_cup_lobbies for the league id
// itself and renders nothing if no lobby points at it — a normal league
// gets nothing extra here, a Rapid Cup league gets its boxes automatically.
export function RapidCupTournamentExtras({ league, session, myTeam, myUsername, showToast, c }) {
  const [lobby, setLobby] = useState(null); // null = loading; false = not a Rapid Cup league

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!league?.id) { setLobby(false); return; }
      const { data } = await supabase
        .from("rapid_cup_lobbies")
        .select("id, status, cup_number")
        .eq("league_id", league.id)
        .maybeSingle();
      if (!cancelled) setLobby(data || false);
    }
    load();
    return () => { cancelled = true; };
  }, [league?.id]);

  if (!lobby) return null;

  // Every cup's own look (Section — theme cycling, see rapidCupThemes.js):
  // overrides the generic app `c` theme for everything Rapid-Cup-specific
  // on this page, so a Neon Blitz cup and a Golden Strike cup don't look
  // like the same screen. cardBg is an alias for surface — the fee/box
  // components below were written against the app's generic `c.cardBg`
  // key, so this fills that in rather than editing every call site.
  const cupTheme = { ...getRapidCupTheme(lobby.cup_number), cardBg: getRapidCupTheme(lobby.cup_number).surface };

  const myUserId = session?.user?.id || null;
  const myTeamId = myTeam?.id || null;

  // Every fixture the viewer's own team has already played, not just the
  // current round — a Rapid Cup player can have a collectable Winbox from
  // their semi-final sitting around while the final is still in progress.
  const myPlayedFixtures = myTeamId
    ? (league.fixtures || []).filter((f) => f.played && (f.home_team_id === myTeamId || f.away_team_id === myTeamId))
    : [];

  const showBoxes = myPlayedFixtures.length > 0 || lobby.status === "completed";

  // For the MVP card's names — cheap to build, league.teams is already
  // loaded for this page regardless of Rapid Cup.
  const teamNameById = Object.fromEntries((league.teams || []).map((t) => [t.id, t.name]));
  const cupName = getRapidCupTheme(lobby.cup_number).name;

  return (
    <div className="space-y-2">
      <RapidCupHelpButton league={league} myUsername={myUsername} c={cupTheme} />
      <RapidCupLiveFees lobbyId={lobby.id} myUserId={myUserId} showToast={showToast} c={cupTheme} />
      {(lobby.status === "live" || lobby.status === "completed") && (
        <RapidCupInvestorPanel lobbyId={lobby.id} myUserId={myUserId} isSpectator={!myTeamId} showToast={showToast} c={cupTheme} />
      )}
      {showBoxes && myPlayedFixtures.map((f) => (
        <RapidCupWinbox
          key={f.id} fixtureId={f.id} myUserId={myUserId} myTeamId={myTeamId} fixture={f}
          teamNameById={teamNameById} cupName={cupName} showToast={showToast} c={cupTheme}
        />
      ))}
      {lobby.status === "completed" && (
        <>
          <RapidCupCupbox lobbyId={lobby.id} myUserId={myUserId} showToast={showToast} c={cupTheme} />
          <RapidCupHallOfFame myUserId={myUserId} c={cupTheme} />
        </>
      )}
    </div>
  );
}

// Rapid Cup Help button (Section 11) — reuses the same wa.me link builder
// and support number every other WhatsApp entry point in the app uses
// (see WhatsAppLink/SupportWhatsAppButton in App.jsx), but with a richer
// prefilled message than the generic floating support button: which
// tournament this is, who's asking, and a direct link straight back into
// this league so the admin doesn't have to go hunting for it.
function RapidCupHelpButton({ league, myUsername, c }) {
  const leagueUrl = typeof window !== "undefined"
    ? `${window.location.origin}${window.location.pathname}?league=${league.id}`
    : "";
  const text = `Hi, I need help with my Rapid Cup${myUsername ? ` (${myUsername})` : ""}: ${league.name}. ${leagueUrl}`;
  const href = waLink(SUPPORT_WHATSAPP_NUMBER, text);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title="Get help with this Rapid Cup on WhatsApp"
      className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold px-3 py-1.5 rounded-full"
      style={{ background: "rgba(37,211,102,0.14)", color: WHATSAPP_GREEN }}>
      <MessageCircle size={12} /> Help — WhatsApp
    </a>
  );
}
