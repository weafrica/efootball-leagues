import React, { useEffect, useRef, useState } from "react";

// Rapid Cup — Phase 9: Epic Extras (Section 13).
//
// Polish pass, built last per the plan's own Suggested Build Order — every
// piece here is cosmetic on top of already-working functionality, nothing
// in this file computes money or changes what anyone is owed. That's still
// decided server-side by Phase 3/4/8's payout functions; this file only
// decorates the result.
//
// Not built here (see plan Section 13 vs. Build Status for why):
//   - "Sudden-death Final — no draws allowed": already true for every round,
//     not just the final. The shared knockout result pipeline Rapid Cup
//     reuses (Phase 5's own note: "no porting needed") already rejects a
//     level scoreline without penalties on ANY fixture — see
//     record_fixture_result / apply_knockout_elimination's
//     "home_score = away_score and pens are null" guard. Nothing Rapid-Cup-
//     specific needed adding.
//   - Hall of Fame leaderboard: see RapidCupHallOfFame.jsx + the new
//     get_rapid_cup_hall_of_fame() RPC (20260905_rapid_cup_hall_of_fame.sql).

const ALL_IN_FEE = 400; // Section 3's fee slider cap.

// ─────────────────────────────────────────────────────────────────────────
// Underdog / All-In tags — pure function of the same `stakes` array
// RapidCupInvestorPanel already computes (entry_fee + investments per
// player), so this never re-fetches anything. Underdog is the single
// lowest total stake among the 4 (only awarded if the 4 aren't all tied,
// same "only means something if it's actually lower" reasoning as the
// existing "highest stake" tag already in that file). All-In is judged on
// the player's OWN fee, not total_stake — Section 13 says "sets their fee
// to the 400 max," which is about what they personally staked, not what
// spectators topped it up to.
// ─────────────────────────────────────────────────────────────────────────
export function isUnderdog(stakes, myStake) {
  if (!stakes.length) return false;
  const min = Math.min(...stakes);
  const max = Math.max(...stakes);
  if (min === max) return false; // everyone tied — no underdog to call out
  return myStake === min;
}

export function isAllIn(ownFee) {
  return ownFee >= ALL_IN_FEE;
}

export function UnderdogTag() {
  return <span style={{ opacity: 0.7 }}> · 🐎 underdog</span>;
}

export function AllInTag() {
  return <span style={{ opacity: 0.85, fontWeight: 700 }}> · 🔥 all-in</span>;
}

// ─────────────────────────────────────────────────────────────────────────
// Countdown drumroll — last 10 seconds of the LOBBY timer (Section 13:
// "Countdown drumroll sound in the last 10 seconds of the lobby timer"),
// i.e. RapidCupBanner's `msLeft` before the open lobby resets, same timer
// the 15/5/1 min toasts already watch. Synthesized with the Web Audio API
// rather than shipping an mp3 — this app has no audio-asset pipeline yet,
// and a synthesized snare-roll (short noise bursts, accelerating) needs no
// new file, no loading state, and no CORS/hosting concerns.
//
// Fires once per lobby (tracked by lobby id, mirroring the existing
// firedThresholds ref pattern in RapidCupBanner) — a re-render or a poll
// tick inside the same 10-second window must not restart the roll.
// ─────────────────────────────────────────────────────────────────────────
export function useCountdownDrumroll(msLeft, lobbyId, enabled) {
  const firedForLobby = useRef(null);

  useEffect(() => {
    if (!enabled || msLeft == null || lobbyId == null) return;
    if (msLeft > 10000) return; // only the final 10s
    if (firedForLobby.current === lobbyId) return;
    firedForLobby.current = lobbyId;

    let ctx;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ctx = new AudioCtx();
    } catch {
      return; // no Web Audio support — silently skip, this is pure polish
    }

    // Accelerating snare-roll: short white-noise bursts, gaps shrinking
    // from 220ms down to ~40ms over the 10s window, finishing on one
    // longer "hit" right as the lobby resets/starts.
    const start = ctx.currentTime + 0.05;
    let t = start;
    let gap = 0.22;
    while (t - start < 9.5) {
      const dur = 0.05;
      const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      const gainNode = ctx.createGain();
      gainNode.gain.setValueAtTime(0.35, t);
      gainNode.gain.exponentialRampToValueAtTime(0.001, t + dur);
      noise.connect(gainNode).connect(ctx.destination);
      noise.start(t);
      noise.stop(t + dur);

      t += gap;
      gap = Math.max(0.04, gap * 0.9);
    }

    // Closing hit — louder, longer decay.
    const hitBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
    const hitData = hitBuffer.getChannelData(0);
    for (let i = 0; i < hitData.length; i++) hitData[i] = (Math.random() * 2 - 1) * 0.8;
    const hit = ctx.createBufferSource();
    hit.buffer = hitBuffer;
    const hitGain = ctx.createGain();
    hitGain.gain.setValueAtTime(0.6, t);
    hitGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    hit.connect(hitGain).connect(ctx.destination);
    hit.start(t);
    hit.stop(t + 0.3);

    // Tear the context down well after the last scheduled sound finishes —
    // but if this component unmounts first (viewer navigates away mid-
    // countdown), the cleanup below closes it immediately instead. Web
    // Audio scheduling runs independently of React: without this, leaving
    // the page didn't stop the already-scheduled noise bursts, so the
    // drumroll kept playing in the background and the context was never
    // released.
    const cleanupMs = (t + 0.4 - ctx.currentTime) * 1000;
    const cleanupTimer = setTimeout(() => { ctx.close?.(); }, Math.max(0, cleanupMs));
    return () => { clearTimeout(cleanupTimer); ctx.close?.(); };
  }, [msLeft, lobbyId, enabled]);
}

// ─────────────────────────────────────────────────────────────────────────
// Pack-opening reveal — wraps the Cup box's revealed state (Section 13:
// "Pack-opening reveal animation on the Cup box"). Purely presentational:
// takes whatever children the caller already renders for "collected" and
// plays a shake -> flip -> reveal sequence around them the first time
// `active` flips true, then just renders children normally afterwards (a
// page revisit / re-render of an already-collected box shouldn't replay
// the animation every time).
// ─────────────────────────────────────────────────────────────────────────
export function CupboxPackReveal({ active, children }) {
  const [phase, setPhase] = useState(active ? "shake" : "idle");
  const played = useRef(false);

  useEffect(() => {
    if (!active || played.current) return;
    played.current = true;
    setPhase("shake");
    const t1 = setTimeout(() => setPhase("flip"), 550);
    const t2 = setTimeout(() => setPhase("done"), 950);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [active]);

  if (!active) return children;

  return (
    <div
      style={{
        display: "inline-block",
        width: "100%",
        animation:
          phase === "shake" ? "rapidCupPackShake 0.55s ease-in-out" :
          phase === "flip" ? "rapidCupPackFlip 0.4s ease-out" : "none",
        transformStyle: "preserve-3d",
      }}
    >
      <style>{`
        @keyframes rapidCupPackShake {
          0%, 100% { transform: rotate(0deg) scale(1); }
          20% { transform: rotate(-4deg) scale(1.02); }
          40% { transform: rotate(4deg) scale(1.02); }
          60% { transform: rotate(-3deg) scale(1.04); }
          80% { transform: rotate(3deg) scale(1.04); }
        }
        @keyframes rapidCupPackFlip {
          0% { transform: rotateY(0deg) scale(1.04); filter: brightness(1); }
          50% { transform: rotateY(90deg) scale(1.08); filter: brightness(1.6); }
          100% { transform: rotateY(0deg) scale(1); filter: brightness(1); }
        }
      `}</style>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MVP shareable card — auto-generated after a Winbox-eligible match win
// (Section 13: "Post-match MVP shareable card (auto-generated)"). Renders
// a themed card (uses the same per-cup theme as everything else on this
// page) and draws an identical version to an offscreen <canvas> so the
// viewer can save/share an actual image rather than a screenshot of a div.
// No new table/RPC — everything drawn here (names, score, round, theme) is
// already available to the caller from the fixture + cup theme it already
// has for the Winbox itself.
// ─────────────────────────────────────────────────────────────────────────
export function RapidCupMvpCard({ winnerName, opponentName, myScore, opponentScore, roundLabel, cupName, c }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;

    ctx.fillStyle = c?.bg || "#0C0A05";
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = c?.borderStrong || c?.accent || "#FFC72C";
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);

    ctx.textAlign = "center";
    ctx.fillStyle = c?.accent || "#FFC72C";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText("⚡ RAPID CUP MVP", W / 2, 70);

    ctx.fillStyle = c?.textDim || "#ccc";
    ctx.font = "16px sans-serif";
    ctx.fillText(cupName || "Rapid Cup", W / 2, 100);
    ctx.fillText(roundLabel || "", W / 2, 124);

    ctx.fillStyle = c?.text || "#fff";
    ctx.font = "bold 40px sans-serif";
    ctx.fillText(winnerName || "Player", W / 2, 210);

    ctx.font = "bold 56px sans-serif";
    ctx.fillText(`${myScore} – ${opponentScore}`, W / 2, 280);

    ctx.font = "18px sans-serif";
    ctx.fillStyle = c?.textFaint || "#999";
    ctx.fillText(`beat ${opponentName || "opponent"}`, W / 2, 320);
  }, [winnerName, opponentName, myScore, opponentScore, roundLabel, cupName, c]);

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `rapid-cup-mvp-${(winnerName || "player").replace(/\s+/g, "-").toLowerCase()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c?.border || "#333"}`, padding: 12, marginTop: 8, textAlign: "center" }}>
      <canvas
        ref={canvasRef}
        width={480}
        height={360}
        style={{ width: "100%", maxWidth: 360, borderRadius: 8, display: "block", margin: "0 auto" }}
      />
      <button
        onClick={download}
        style={{ marginTop: 10, padding: "8px 16px", borderRadius: 8, fontWeight: 600 }}
      >
        📸 Save MVP card
      </button>
    </div>
  );
}
