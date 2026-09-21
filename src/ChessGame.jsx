// Chess — 1v1 real-time chess, optional Nets stake per table. New,
// self-contained top-level screen (same shape as TransferMarket.jsx /
// Shop.jsx — lazy-loaded from App.jsx, takes { c, session, showToast,
// onBack }), backed by chess_games (see
// supabase/migrations/20260940_chess.sql) and the chess.js npm package
// for move legality/check/checkmate/stalemate detection — reinventing a
// rules engine in this file (or in SQL) isn't worth it; chess.js is a
// dependency-free, MIT-licensed library, same "no paid libraries" bar
// the rest of this app holds itself to.
//
// Trust boundary, spelled out once here rather than at every call site:
// the server (chess_submit_move RPC) only enforces whose turn it is and
// settles the stake — it does not re-validate that the move itself was
// legal. Same trust model this app already applies to every other
// client-reported result (see FINALS-PENALTIES-MIGRATION.md). An
// admin-override RPC is a natural follow-up if that ever needs closing.
//
// Board orientation flips for the black player (row/col rendering
// order), so each player always sees their own pieces at the bottom.

import React, { useState, useEffect, useCallback, useRef, Suspense, lazy } from "react";
import { Chess } from "chess.js";
import { ArrowLeft, Swords, Plus, Users, Flag, Loader2, Trophy, Clock, Bot, BookOpen, GraduationCap, RotateCcw, Volume2, VolumeX, Sparkles } from "lucide-react";
import { supabase } from "./supabaseClient";
import { formatNets } from "./nets.js";
import { pickAiMove, AI_DIFFICULTIES, AI_REWARD_NETS, commentOnHumanMove, explainAiMove, describeCaptureNarrative } from "./chessAi.js";
import { chessSpeech, dramatizeSquare } from "./chessVoice.js";
import { getVoiceTier, setVoiceTierOverride, isHdVoiceEnabled, setHdVoiceEnabled, loadNeuralVoice, neuralVoiceReady } from "./chessVoiceHD.js";

const RulesModal = lazy(() => import("./Rules.jsx"));

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const STAKE_PRESETS = [0, 5, 10, 25, 50];

// Unicode glyphs — no image assets, matches the rest of this app's
// "CSS/SVG/icon-only, no image or video assets" constraint.
const PIECE_GLYPH = {
  wK: "♔", wQ: "♕", wR: "♖", wB: "♗", wN: "♘", wP: "♙",
  bK: "♚", bQ: "♛", bR: "♜", bB: "♝", bN: "♞", bP: "♟",
};

function squareId(file, rank) { return `${FILES[file]}${rank}`; }

export default function ChessGame({ c, session, showToast, onBack }) {
  const [activeGameId, setActiveGameId] = useState(null);
  const [practiceOpen, setPracticeOpen] = useState(false);

  if (activeGameId) {
    return (
      <ChessBoardScreen
        gameId={activeGameId}
        session={session}
        showToast={showToast}
        onBack={() => setActiveGameId(null)}
        c={c}
      />
    );
  }
  if (practiceOpen) {
    return <ChessPracticeBoard onBack={() => setPracticeOpen(false)} c={c} />;
  }
  return (
    <ChessLobby session={session} showToast={showToast} onBack={onBack} onOpenGame={setActiveGameId}
      onOpenPractice={() => setPracticeOpen(true)} c={c} />
  );
}

// ---------------------------------------------------------------------
// Lobby — open tables to join, your own in-progress games, create a
// table with an optional Nets stake.

function ChessLobby({ session, showToast, onBack, onOpenGame, onOpenPractice, c }) {
  const [rulesOpen, setRulesOpen] = useState(false);
  const [openGames, setOpenGames] = useState(null); // null = loading
  const [myGames, setMyGames] = useState([]);
  const [myOpenTable, setMyOpenTable] = useState(null); // my own waiting-for-opponent table, if any
  const [opponentNames, setOpponentNames] = useState({});
  const [stake, setStake] = useState(0);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    const myId = session?.user?.id;
    const [{ data: open, error: openError }, { data: mine, error: mineError }] = await Promise.all([
      supabase.from("chess_games").select("*").eq("status", "open").order("created_at", { ascending: false }).limit(30),
      myId
        ? supabase.from("chess_games")
            .select("*")
            .or(`white_user_id.eq.${myId},black_user_id.eq.${myId}`)
            .neq("status", "open")
            .order("last_move_at", { ascending: false, nullsFirst: false })
            .limit(20)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (openError) console.error("Couldn't load open chess tables:", openError.message);
    if (mineError) console.error("Couldn't load your chess games:", mineError.message);
    setOpenGames((open || []).filter((g) => g.created_by !== myId));
    setMyOpenTable((open || []).find((g) => g.created_by === myId) || null);
    setMyGames(mine || []);

    const ids = new Set();
    (open || []).forEach((g) => ids.add(g.white_user_id));
    (mine || []).forEach((g) => { ids.add(g.white_user_id); if (g.black_user_id) ids.add(g.black_user_id); });
    ids.delete(myId);
    if (ids.size > 0) {
      const { data: rows } = await supabase.from("profiles").select("user_id, efootball_username").in("user_id", Array.from(ids));
      const map = {};
      (rows || []).forEach((r) => { map[r.user_id] = r.efootball_username; });
      setOpponentNames(map);
    }
  }, [session?.user?.id]);

  useEffect(() => { load(); }, [load]);

  // Lightweight live refresh — new tables opening/closing, someone
  // joining one of your own. Not scoped to a single row (the lobby is a
  // list), so this just re-runs the two queries above on any change.
  useEffect(() => {
    const channel = supabase.channel("chess-lobby").on(
      "postgres_changes", { event: "*", schema: "public", table: "chess_games" }, load
    ).subscribe();
    return () => supabase.removeChannel(channel);
  }, [load]);

  const nameFor = (id) => opponentNames[id] || "Opponent";

  const createGame = async () => {
    setCreating(true);
    try {
      const { data, error } = await supabase.rpc("create_chess_game", { p_stake_nets: stake });
      if (error) throw error;
      showToast?.(stake > 0 ? `Table opened — ${formatNets(stake)} staked.` : "Table opened.");
      onOpenGame(data.id);
    } catch (err) {
      showToast?.(`Couldn't open a table: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const joinGame = async (gameId) => {
    setBusyId(gameId);
    try {
      const { error } = await supabase.rpc("join_chess_game", { p_game_id: gameId });
      if (error) throw error;
      onOpenGame(gameId);
    } catch (err) {
      showToast?.(`Couldn't join: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const cancelGame = async (gameId) => {
    setBusyId(gameId);
    try {
      const { error } = await supabase.rpc("cancel_chess_game", { p_game_id: gameId });
      if (error) throw error;
      showToast?.("Table cancelled — stake refunded.");
      await load();
    } catch (err) {
      showToast?.(`Couldn't cancel: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const [startingAi, setStartingAi] = useState(null); // difficulty currently starting, or null
  const startAiGame = async (difficulty) => {
    setStartingAi(difficulty);
    try {
      const { data, error } = await supabase.rpc("create_ai_chess_game", { p_difficulty: difficulty });
      if (error) throw error;
      onOpenGame(data.id);
    } catch (err) {
      showToast?.(`Couldn't start a game: ${err.message}`);
    } finally {
      setStartingAi(null);
    }
  };

  return (
    <div className="p-4 flex flex-col gap-6 max-w-2xl mx-auto">
      <button onClick={onBack} className="flex items-center gap-1 font-mono text-xs" style={{ color: c.textFaint }}>
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Swords size={20} style={{ color: c.accent }} />
          <h1 className="font-extrabold uppercase tracking-tight text-xl" style={{ color: c.text }}>Chess</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={onOpenPractice}
            className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-full border"
            style={{ borderColor: c.border, color: c.text }}>
            <GraduationCap size={12} /> Learn
          </button>
          <button onClick={() => setRulesOpen(true)}
            className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-full border"
            style={{ borderColor: c.border, color: c.text }}>
            <BookOpen size={12} /> Rules
          </button>
        </div>
      </div>
      {rulesOpen && (
        <Suspense fallback={null}>
          <RulesModal type="chess" onClose={() => setRulesOpen(false)} c={c} />
        </Suspense>
      )}

      {/* Play vs AI — instant, solo, Nets reward for winning */}
      <div className="rounded-xl border p-4 flex flex-col gap-3" style={{ borderColor: c.border, background: c.surface }}>
        <div className="font-mono text-xs uppercase tracking-wide flex items-center gap-1.5" style={{ color: c.textFaint }}>
          <Bot size={14} /> Play vs bot
        </div>
        <div className="flex flex-wrap gap-2">
          {AI_DIFFICULTIES.map((d) => (
            <button key={d} onClick={() => startAiGame(d)} disabled={startingAi !== null}
              className="flex items-center gap-1.5 font-mono text-xs font-bold uppercase px-3 py-2 rounded-full border disabled:opacity-50"
              style={{ borderColor: c.border, background: "transparent", color: c.text }}>
              {startingAi === d ? <Loader2 size={13} className="animate-spin" /> : null}
              {d} · win +{formatNets(AI_REWARD_NETS[d])}
            </button>
          ))}
        </div>
        <div className="font-mono text-[10px]" style={{ color: c.textFaint }}>
          Instant start, no waiting for an opponent. Reward only pays out on a genuine win (capped per day).
        </div>
      </div>

      {/* Create a table */}
      <div className="rounded-xl border p-4 flex flex-col gap-3" style={{ borderColor: c.border, background: c.surface }}>
        <div className="font-mono text-xs uppercase tracking-wide" style={{ color: c.textFaint }}>Open a table</div>
        <div className="flex flex-wrap gap-2">
          {STAKE_PRESETS.map((amt) => (
            <button key={amt} onClick={() => setStake(amt)}
              className="font-mono text-xs px-3 py-1.5 rounded-full border"
              style={{
                borderColor: stake === amt ? c.accent : c.border,
                background: stake === amt ? c.accent : "transparent",
                color: stake === amt ? c.accentText : c.text,
              }}>
              {amt === 0 ? "No stake" : formatNets(amt)}
            </button>
          ))}
        </div>
        <button onClick={createGame} disabled={creating}
          className="self-start flex items-center gap-1.5 font-mono text-xs font-bold uppercase px-4 py-2 rounded-full disabled:opacity-50"
          style={{ background: c.accent, color: c.accentText }}>
          {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Open table
        </button>
      </div>

      {/* Your own table, still waiting for an opponent */}
      {myOpenTable && (
        <div className="rounded-lg border p-3 flex items-center justify-between gap-3" style={{ borderColor: c.accent, background: c.surface }}>
          <div className="min-w-0">
            <div className="font-body text-sm font-semibold" style={{ color: c.text }}>Your table — waiting for an opponent</div>
            <div className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
              {myOpenTable.stake_nets > 0 ? `${formatNets(myOpenTable.stake_nets)} staked` : "No stake"}
            </div>
          </div>
          <button onClick={() => cancelGame(myOpenTable.id)} disabled={busyId === myOpenTable.id}
            className="font-mono text-[10px] font-bold uppercase px-3 py-1.5 rounded-full disabled:opacity-50"
            style={{ color: c.red || "#EF4444", border: `1px solid ${c.red || "#EF4444"}55` }}>
            {busyId === myOpenTable.id ? "…" : "Cancel"}
          </button>
        </div>
      )}

      {/* Your games */}
      {myGames.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="font-mono text-xs uppercase tracking-wide" style={{ color: c.textFaint }}>Your games</div>
          {myGames.map((g) => {
            const iAmWhite = g.white_user_id === session.user.id;
            const opponentId = iAmWhite ? g.black_user_id : g.white_user_id;
            const myTurn = g.status === "active" && ((g.turn === "w") === iAmWhite);
            return (
              <button key={g.id} onClick={() => onOpenGame(g.id)}
                className="rounded-lg border p-3 flex items-center justify-between gap-3 text-left"
                style={{ borderColor: c.border, background: c.surface }}>
                <div className="min-w-0">
                  <div className="font-body text-sm font-semibold truncate flex items-center gap-1.5" style={{ color: c.text }}>
                    {g.is_vs_ai ? (<><Bot size={13} /> vs {g.ai_difficulty} bot</>) : `vs ${nameFor(opponentId)}`}
                  </div>
                  <div className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
                    {g.status === "active" ? (myTurn ? "Your move" : "Waiting on opponent") : g.status}
                    {!g.is_vs_ai && g.stake_nets > 0 ? ` · ${formatNets(g.stake_nets)} staked` : ""}
                    {g.is_vs_ai && g.status === "finished" && g.ai_reward_paid ? ` · +${formatNets(g.ai_reward_nets)}` : ""}
                  </div>
                </div>
                {g.status === "active" && myTurn && (
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: c.red || "#EF4444" }} />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Open tables */}
      <div className="flex flex-col gap-2">
        <div className="font-mono text-xs uppercase tracking-wide" style={{ color: c.textFaint }}>Open tables</div>
        {openGames === null ? (
          <div className="text-center font-mono text-xs p-4" style={{ color: c.textFaint }}>Loading…</div>
        ) : openGames.length === 0 ? (
          <div className="text-center font-mono text-xs p-4" style={{ color: c.textFaint }}>
            No open tables right now — open one above.
          </div>
        ) : (
          openGames.map((g) => (
            <div key={g.id} className="rounded-lg border p-3 flex items-center justify-between gap-3"
              style={{ borderColor: c.border, background: c.surface }}>
              <div className="min-w-0">
                <div className="font-body text-sm font-semibold truncate" style={{ color: c.text }}>{nameFor(g.white_user_id)}</div>
                <div className="font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
                  {g.stake_nets > 0 ? `${formatNets(g.stake_nets)} stake` : "No stake"}
                </div>
              </div>
              <button onClick={() => joinGame(g.id)} disabled={busyId === g.id}
                className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-3 py-1.5 rounded-full disabled:opacity-50"
                style={{ background: c.accent, color: c.accentText }}>
                {busyId === g.id ? <Loader2 size={12} className="animate-spin" /> : <Users size={12} />} Join
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Board screen — one game, live.

function ChessBoardScreen({ gameId, session, showToast, onBack, c }) {
  const [game, setGame] = useState(null); // the chess_games row
  const chessRef = useRef(new Chess());
  const [selected, setSelected] = useState(null); // square id ("e2") or null
  const [legalTargets, setLegalTargets] = useState([]); // square ids
  const [submitting, setSubmitting] = useState(false);
  const [promotionChoice, setPromotionChoice] = useState(null); // { from, to } awaiting a piece pick
  const [aiThinking, setAiThinking] = useState(false);
  const [commentary, setCommentary] = useState([]); // vs-AI only: [{ from: "you"|"bot", text }] — most recent last
  const [autoSpeak, setAutoSpeak] = useState(true); // read the bot's analysis aloud, vs-AI games only
  const autoSpeakRef = useRef(autoSpeak);
  useEffect(() => { autoSpeakRef.current = autoSpeak; }, [autoSpeak]);
  useEffect(() => () => chessSpeech.stop(), []); // stop talking if the player leaves this screen

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("chess_games").select("*").eq("id", gameId).maybeSingle();
    if (error) { showToast?.(`Couldn't load game: ${error.message}`); return; }
    if (!data) { showToast?.("That game no longer exists."); onBack(); return; }
    setGame(data);
    chessRef.current = new Chess(data.fen);
    setSelected(null);
    setLegalTargets([]);
  }, [gameId, onBack, showToast]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const channel = supabase.channel(`chess-game-${gameId}`).on(
      "postgres_changes", { event: "UPDATE", schema: "public", table: "chess_games", filter: `id=eq.${gameId}` },
      (payload) => {
        setGame(payload.new);
        chessRef.current = new Chess(payload.new.fen);
        setSelected(null);
        setLegalTargets([]);
      }
    ).subscribe();
    return () => supabase.removeChannel(channel);
  }, [gameId]);

  // submitAiTurn — used both for the bot's own reply and (indirectly, via
  // attemptMove below) for the human's move in a vs-AI game. Separate
  // from finishOrContinue/chess_submit_move: outcomes here are
  // human_win/ai_win/draw rather than a winner_user_id, and payout is a
  // flat reward rather than a stake split (see chess_submit_ai_move).
  //
  // moveContext (optional) — { fenBeforeMove, moveResult, mover: "human"
  // | "ai" } — when given, commentary is generated and shown ONLY after
  // the RPC below has already succeeded, i.e. only once the move is
  // durably committed and can no longer be changed. This is a courtesy
  // caption, never a hint: it can't affect the game it's describing.
  const submitAiTurn = async (chess, moveContext) => {
    const isOver = chess.isGameOver();
    let status = null, outcome = null, reason = null;
    if (isOver) {
      status = "finished";
      if (chess.isCheckmate()) {
        reason = "checkmate";
        // Whoever just moved delivered mate; turn has already flipped to
        // the loser's color by this point.
        outcome = chess.turn() === "b" ? "human_win" : "ai_win";
      } else if (chess.isStalemate()) { reason = "stalemate"; outcome = "draw"; }
      else if (chess.isThreefoldRepetition()) { reason = "threefold"; outcome = "draw"; }
      else if (chess.isInsufficientMaterial()) { reason = "insufficient_material"; outcome = "draw"; }
      else { reason = "fifty_move"; outcome = "draw"; }
    }
    const { error } = await supabase.rpc("chess_submit_ai_move", {
      p_game_id: gameId,
      p_new_fen: chess.fen(),
      p_new_pgn: chess.pgn(),
      p_status: status,
      p_outcome: outcome,
      p_result_reason: reason,
    });
    if (error) {
      showToast?.(`Move didn't save: ${error.message}`);
      await load();
      return;
    }
    // Only past this point is the move locked in — safe to comment on it.
    if (moveContext) {
      const { fenBeforeMove, moveResult, mover } = moveContext;
      const qualityOrExplain = mover === "human"
        ? commentOnHumanMove(fenBeforeMove, { from: moveResult.from, to: moveResult.to, promotion: moveResult.promotion }, moveResult.san)
        : explainAiMove(chess, moveResult);
      const narrative = describeCaptureNarrative(chess, moveResult);
      const text = [qualityOrExplain, narrative].filter(Boolean).join(" ");
      if (text) {
        setCommentary((prev) => [...prev.slice(-4), { from: mover === "human" ? "you" : "bot", text }]);
        // Read the analysis aloud automatically — this is the whole
        // point of vs-AI commentary (see the "so a player can learn
        // patterns" reasoning above): hearing why a move was strong or
        // weak sinks in without having to stop and read a caption.
        if (autoSpeakRef.current) chessSpeech.speak(`analysis-${gameId}-${Date.now()}`, text, moveResult.piece);
      }
    }
  };

  // Drives the bot's own moves. Fires whenever the loaded/synced game
  // state says it's black's turn in an active AI game; the human's move
  // already flipped `turn` to "b" server-side by the time this runs, so
  // there's no local-vs-server race to reconcile — this only ever acts
  // on a confirmed position. Guards internally on `game` since this hook
  // must run unconditionally (before the `!game` early return below).
  useEffect(() => {
    if (!game || !game.is_vs_ai || game.status !== "active" || game.turn !== "b") return;
    let cancelled = false;
    setAiThinking(true);
    const timer = setTimeout(async () => {
      if (cancelled) return;
      const chess = chessRef.current;
      const fenBeforeMove = chess.fen();
      const move = pickAiMove(chess, game.ai_difficulty);
      if (!move) { setAiThinking(false); return; }
      let result;
      try { result = chess.move(move); } catch { result = null; }
      if (result) await submitAiTurn(chess, { fenBeforeMove, moveResult: result, mover: "ai" });
      if (!cancelled) setAiThinking(false);
    }, 500 + Math.random() * 500); // small delay reads as "thinking" rather than instant/robotic
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.fen, game?.is_vs_ai, game?.status, game?.turn]);

  if (!game) {
    return (
      <div className="p-8 flex justify-center"><Loader2 className="animate-spin" style={{ color: c.textFaint }} /></div>
    );
  }

  const myColor = game.white_user_id === session.user.id ? "w" : game.black_user_id === session.user.id ? "b" : null;
  const isPlayer = myColor !== null;
  const myTurn = isPlayer && game.status === "active" && game.turn === myColor;
  const board = chessRef.current.board(); // 8x8, rank 8 first, chess.js convention

  // finishOrContinue — PvP path only (stake settlement via
  // chess_submit_move). p_winner_user_id null means a draw.
  const finishOrContinue = async (moveResult) => {
    const chess = chessRef.current;
    const isOver = chess.isGameOver();
    let status = null, winnerUserId = null, reason = null;
    if (isOver) {
      status = "finished";
      if (chess.isCheckmate()) {
        reason = "checkmate";
        winnerUserId = myColor === "w" ? game.white_user_id : game.black_user_id; // mover just delivered mate
      } else if (chess.isStalemate()) { reason = "stalemate"; winnerUserId = null; }
      else if (chess.isThreefoldRepetition()) { reason = "threefold"; winnerUserId = null; }
      else if (chess.isInsufficientMaterial()) { reason = "insufficient_material"; winnerUserId = null; }
      else { reason = "fifty_move"; winnerUserId = null; }
    }
    const { error } = await supabase.rpc("chess_submit_move", {
      p_game_id: gameId,
      p_new_fen: chess.fen(),
      p_new_pgn: chess.pgn(),
      p_status: status,
      p_winner_user_id: winnerUserId,
      p_result_reason: reason,
    });
    if (error) {
      showToast?.(`Move didn't save: ${error.message}`);
      await load(); // resync — our local board may now disagree with the server
      return;
    }
    // Flavor-only, no evaluation — safe to show in PvP (unlike commentOnHumanMove's
    // numeric analysis, which stays vs-AI-only so it's never a one-sided edge
    // over a real opponent). Only ever runs after the move is already committed.
    const narrative = describeCaptureNarrative(chess, moveResult);
    if (narrative) setCommentary((prev) => [...prev.slice(-4), { from: "narrator", text: narrative }]);
  };

  const attemptMove = async (from, to, promotion) => {
    const chess = chessRef.current;
    const fenBeforeMove = chess.fen();
    let result;
    try {
      result = chess.move({ from, to, promotion: promotion || undefined });
    } catch {
      result = null;
    }
    if (!result) {
      setSelected(null);
      setLegalTargets([]);
      return;
    }
    setSelected(null);
    setLegalTargets([]);
    setSubmitting(true);
    try {
      if (game.is_vs_ai) await submitAiTurn(chess, { fenBeforeMove, moveResult: result, mover: "human" });
      else await finishOrContinue(result);
    } finally {
      setSubmitting(false);
    }
  };

  const onSquareClick = (sq) => {
    if (!myTurn || submitting || aiThinking) return;
    const chess = chessRef.current;
    if (selected) {
      if (legalTargets.includes(sq)) {
        // Promotion: a pawn reaching the back rank needs a piece choice —
        // default to queen unless the destination is a promotion square,
        // in which case ask first.
        const piece = chess.get(selected);
        const isPromotion = piece?.type === "p" && (sq[1] === "8" || sq[1] === "1");
        if (isPromotion) { setPromotionChoice({ from: selected, to: sq }); return; }
        attemptMove(selected, sq, null);
        return;
      }
      // Clicking another one of your own pieces re-selects instead of
      // treating it as an (illegal) move attempt.
      const piece = chess.get(sq);
      if (piece && piece.color === myColor) {
        setSelected(sq);
        setLegalTargets(chess.moves({ square: sq, verbose: true }).map((m) => m.to));
        return;
      }
      setSelected(null);
      setLegalTargets([]);
      return;
    }
    const piece = chess.get(sq);
    if (piece && piece.color === myColor) {
      setSelected(sq);
      setLegalTargets(chess.moves({ square: sq, verbose: true }).map((m) => m.to));
    }
  };

  const resign = async () => {
    if (!window.confirm("Resign this game?")) return;
    const { error } = await supabase.rpc(game.is_vs_ai ? "resign_ai_chess_game" : "resign_chess_game", { p_game_id: gameId });
    if (error) showToast?.(`Couldn't resign: ${error.message}`);
  };

  // Board is always rendered rank-8-to-rank-1, file-a-to-file-h internally
  // (chess.js's own .board() order); flip that render order for the
  // black player so each side sees their own pieces at the bottom.
  const displayRanks = myColor === "b" ? [...Array(8).keys()] : [...Array(8).keys()].reverse();
  const displayFiles = myColor === "b" ? [...Array(8).keys()].reverse() : [...Array(8).keys()];

  const statusText = game.status === "finished"
    ? (game.is_vs_ai
        ? (game.ai_won
            ? `You lost — ${game.result_reason?.replace("_", " ")}`
            : game.winner_user_id
              ? `You won — ${game.result_reason?.replace("_", " ")}${game.ai_reward_paid ? ` (+${formatNets(game.ai_reward_nets)})` : " (daily reward cap reached)"}`
              : `Draw — ${game.result_reason?.replace("_", " ")}`)
        : (game.winner_user_id
            ? (game.winner_user_id === session.user.id ? "You won" : "You lost") + ` — ${game.result_reason?.replace("_", " ")}`
            : `Draw — ${game.result_reason?.replace("_", " ")}`))
    : game.status === "aborted" ? "Table cancelled"
    : aiThinking ? "Bot is thinking…"
    : isPlayer ? (myTurn ? "Your move" : "Waiting on opponent") : "Spectating";

  return (
    <div className="p-4 flex flex-col gap-4 max-w-lg mx-auto">
      <button onClick={onBack} className="flex items-center gap-1 font-mono text-xs" style={{ color: c.textFaint }}>
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-center justify-between">
        <div className="font-mono text-xs uppercase tracking-wide flex items-center gap-1.5" style={{ color: c.textFaint }}>
          {game.status === "active" && (aiThinking ? <Loader2 size={12} className="animate-spin" /> : <Clock size={12} />)}
          {statusText}
        </div>
        {game.is_vs_ai ? (
          <div className="flex items-center gap-2">
            <div className="font-mono text-[10px] uppercase flex items-center gap-1" style={{ color: c.accent }}>
              <Bot size={11} /> {game.ai_difficulty} bot{game.status === "active" ? ` · win +${formatNets(game.ai_reward_nets)}` : ""}
            </div>
            <button onClick={() => { if (autoSpeak) chessSpeech.stop(); setAutoSpeak((v) => !v); }}
              aria-label={autoSpeak ? "Mute spoken analysis" : "Unmute spoken analysis"}
              className="p-1 rounded-full" style={{ color: autoSpeak ? c.accent : c.textFaint }}>
              {autoSpeak ? <Volume2 size={13} /> : <VolumeX size={13} />}
            </button>
          </div>
        ) : game.stake_nets > 0 && (
          <div className="font-mono text-[10px] uppercase flex items-center gap-1" style={{ color: c.accent }}>
            <Trophy size={11} /> {formatNets(game.stake_nets * 2)} on the table
          </div>
        )}
      </div>

      {/* 8x8 board */}
      <div className="grid grid-cols-8 rounded-lg overflow-hidden border" style={{ borderColor: c.border }}>
        {displayRanks.map((rankIdx) =>
          displayFiles.map((fileIdx) => {
            const rank = 8 - rankIdx; // chess.js board()[0] is rank 8
            const sq = squareId(fileIdx, rank);
            const cell = board[rankIdx][fileIdx];
            const isDark = (fileIdx + rankIdx) % 2 === 1;
            const isSelected = sq === selected;
            const isTarget = legalTargets.includes(sq);
            const isLeftEdge = fileIdx === displayFiles[0];
            const isBottomEdge = rankIdx === displayRanks[displayRanks.length - 1];
            return (
              <button key={sq} onClick={() => onSquareClick(sq)}
                className="aspect-square flex items-center justify-center relative select-none"
                style={{
                  background: isSelected ? `${c.accent}55` : isDark ? c.surfaceHover : c.surface,
                  cursor: myTurn ? "pointer" : "default",
                }}>
                {isTarget && <span className="absolute w-2.5 h-2.5 rounded-full" style={{ background: `${c.accent}99` }} />}
                {isLeftEdge && (
                  <span className="absolute top-0.5 left-1 font-mono text-[9px] font-bold leading-none" style={{ color: c.textFaint }}>{rank}</span>
                )}
                {isBottomEdge && (
                  <span className="absolute bottom-0.5 right-1 font-mono text-[9px] font-bold leading-none" style={{ color: c.textFaint }}>{FILES[fileIdx]}</span>
                )}
                {cell && (
                  <span className="text-2xl sm:text-3xl leading-none" style={{ color: cell.color === "w" ? c.text : c.textFaint, filter: cell.color === "w" ? "none" : "none" }}>
                    {PIECE_GLYPH[`${cell.color}${cell.type.toUpperCase()}`]}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {promotionChoice && (
        <div className="rounded-lg border p-3 flex items-center gap-2 justify-center" style={{ borderColor: c.border, background: c.surface }}>
          <span className="font-mono text-[10px] uppercase mr-1" style={{ color: c.textFaint }}>Promote to:</span>
          {["q", "r", "b", "n"].map((p) => (
            <button key={p} onClick={() => { attemptMove(promotionChoice.from, promotionChoice.to, p); setPromotionChoice(null); }}
              className="text-2xl px-2 py-1 rounded-lg" style={{ background: c.surfaceHover }}>
              {PIECE_GLYPH[`${myColor}${p.toUpperCase()}`]}
            </button>
          ))}
        </div>
      )}

      {/* Move commentary/narrative feed — vs-AI games get full move-quality
          analysis (commentOnHumanMove/explainAiMove); PvP only ever gets
          capture flavor text (describeCaptureNarrative — no evaluation,
          so it's never a one-sided edge over a real opponent). Either
          way, only ever about moves already committed. */}
      {commentary.length > 0 && (
        <div className="rounded-lg border p-3 flex flex-col gap-1.5" style={{ borderColor: c.border, background: c.surface }}>
          {commentary.map((line, i) => (
            <div key={i} className="font-body text-xs flex items-start gap-1.5" style={{ color: line.from === "bot" ? c.accent : c.text, opacity: i === commentary.length - 1 ? 1 : 0.55 }}>
              <span className="font-mono text-[9px] uppercase shrink-0 mt-0.5" style={{ color: c.textFaint }}>
                {line.from === "bot" ? "Bot" : line.from === "narrator" ? "•" : "You"}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      )}

      {isPlayer && game.status === "active" && (
        <button onClick={resign}
          className="self-start flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase px-3 py-1.5 rounded-full"
          style={{ color: c.red || "#EF4444", border: `1px solid ${c.red || "#EF4444"}55` }}>
          <Flag size={12} /> Resign
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Practice/Learn board — the tutorial's "see possible moves" sandbox.
// No account, no game row, no AI, no stakes: pure local chess.js state.
// Both colors move normally (turns alternate) so it still teaches real
// play, but nothing here is ever saved or affects a real game.

const PIECE_TIP = {
  p: "Pawns push straight, capture diagonally, and can promote if they reach the far end.",
  n: "Knights leap in an L-shape — the only piece that can jump clean over others.",
  b: "Bishops glide diagonally, forever, and never leave their starting color square.",
  r: "Rooks command straight lines — any distance, horizontal or vertical.",
  q: "Queens combine rook and bishop power — the strongest piece on the board.",
  k: "Kings move one square any direction. Keep this one safe above all else.",
};

function ChessPracticeBoard({ onBack, c }) {
  const [, forceRender] = useState(0);
  const chessRef = useRef(new Chess());
  const [selected, setSelected] = useState(null);
  const [legalTargets, setLegalTargets] = useState([]);
  const [promotionChoice, setPromotionChoice] = useState(null);
  const [tip, setTip] = useState("Tap any piece to see everywhere it can legally go.");
  const [learningMode, setLearningMode] = useState(true);
  const [speakingSquare, setSpeakingSquare] = useState(chessSpeech.speakingId);
  const [hdEnabled, setHdEnabled] = useState(isHdVoiceEnabled());
  const [hdTier, setHdTier] = useState(getVoiceTier()); // "hd" | "lite" — auto-detected, overridable
  const [hdLoading, setHdLoading] = useState(false);
  const [hdProgress, setHdProgress] = useState(0);
  const [hdReady, setHdReady] = useState(neuralVoiceReady());
  const [hdError, setHdError] = useState(null);

  const enableHdVoice = async () => {
    setHdEnabled(true);
    setHdVoiceEnabled(true);
    if (hdReady) return;
    setHdLoading(true);
    setHdError(null);
    try {
      await loadNeuralVoice((frac) => setHdProgress(frac));
      setHdReady(true);
    } catch (err) {
      setHdError("Couldn't download the HD voice — check your connection and try again.");
      setHdEnabled(false);
      setHdVoiceEnabled(false);
    } finally {
      setHdLoading(false);
    }
  };
  const disableHdVoice = () => { setHdEnabled(false); setHdVoiceEnabled(false); };
  const changeTier = (tier) => { setVoiceTierOverride(tier); setHdTier(getVoiceTier()); };

  useEffect(() => chessSpeech.subscribe(setSpeakingSquare), []);
  useEffect(() => () => chessSpeech.stop(), []); // stop talking if the player leaves this screen

  const chess = chessRef.current;
  const board = chess.board();

  const selectSquare = (sq, piece) => {
    setSelected(sq);
    setLegalTargets(chess.moves({ square: sq, verbose: true }).map((m) => m.to));
    setTip(PIECE_TIP[piece.type] || "Tap a highlighted square to move there.");
    if (learningMode) chessSpeech.speak(sq, dramatizeSquare(chess, sq), piece.type);
  };

  const resetBoard = () => {
    chessSpeech.stop();
    chessRef.current = new Chess();
    setSelected(null);
    setLegalTargets([]);
    setTip("Fresh board — tap a piece to explore its moves.");
    forceRender((n) => n + 1);
  };

  const applyMove = (from, to, promotion) => {
    chessSpeech.stop();
    let result;
    try { result = chess.move({ from, to, promotion: promotion || undefined }); } catch { result = null; }
    setSelected(null);
    setLegalTargets([]);
    if (!result) return;
    if (chess.isCheckmate()) setTip(`Checkmate! ${result.san} ends it.`);
    else if (chess.isStalemate()) setTip("Stalemate — no legal moves, and no check. That's a draw.");
    else if (chess.isCheck()) setTip(`${result.san} — check! The king has to get out of it immediately.`);
    else setTip(`${result.san} played. Tap another piece to keep exploring.`);
    forceRender((n) => n + 1);
  };

  const onSquareClick = (sq) => {
    if (selected) {
      if (legalTargets.includes(sq)) {
        const piece = chess.get(selected);
        const isPromotion = piece?.type === "p" && (sq[1] === "8" || sq[1] === "1");
        if (isPromotion) { setPromotionChoice({ from: selected, to: sq }); return; }
        applyMove(selected, sq, null);
        return;
      }
      const piece = chess.get(sq);
      if (piece) { selectSquare(sq, piece); return; }
      setSelected(null);
      setLegalTargets([]);
      return;
    }
    const piece = chess.get(sq);
    if (piece) selectSquare(sq, piece);
  };

  return (
    <div className="p-4 flex flex-col gap-4 max-w-lg mx-auto">
      <button onClick={onBack} className="flex items-center gap-1 font-mono text-xs" style={{ color: c.textFaint }}>
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GraduationCap size={20} style={{ color: c.accent }} />
          <h1 className="font-extrabold uppercase tracking-tight text-xl" style={{ color: c.text }}>Learn — practice board</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => { if (!learningMode) chessSpeech.stop(); setLearningMode((v) => !v); }}
            aria-label={learningMode ? "Mute piece narration" : "Unmute piece narration"}
            className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-full border"
            style={{ borderColor: learningMode ? c.accent : c.border, background: learningMode ? c.accent : "transparent", color: learningMode ? c.accentText : c.text }}>
            {learningMode ? <Volume2 size={12} /> : <VolumeX size={12} />} Talk
          </button>
          <button onClick={resetBoard}
            className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-full border"
            style={{ borderColor: c.border, color: c.text }}>
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      </div>

      {/* HD voice — strictly opt-in, real multi-MB download, never
          automatic. Tier (Piper vs Kokoro) is auto-picked from rough
          device capability, overridable below. */}
      <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: c.border, background: c.surface }}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase" style={{ color: c.textFaint }}>
            <Sparkles size={12} /> HD voice ({hdTier === "hd" ? "best quality, ~86MB" : "light, ~20-60MB"})
          </div>
          {hdEnabled ? (
            <button onClick={disableHdVoice}
              className="font-mono text-[10px] font-bold uppercase px-2.5 py-1 rounded-full border"
              style={{ borderColor: c.border, color: c.text }}>
              Turn off
            </button>
          ) : (
            <button onClick={enableHdVoice} disabled={hdLoading}
              className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase px-2.5 py-1 rounded-full disabled:opacity-60"
              style={{ background: c.accent, color: c.accentText }}>
              {hdLoading ? <Loader2 size={11} className="animate-spin" /> : null}
              {hdLoading ? `Downloading ${Math.round(hdProgress * 100)}%` : "Enable"}
            </button>
          )}
        </div>
        {!hdEnabled && !hdLoading && (
          <div className="font-mono text-[9px] flex items-center gap-2" style={{ color: c.textFaint }}>
            <span>Picked for your device — want the other one instead?</span>
            <button onClick={() => changeTier(hdTier === "hd" ? "lite" : "hd")} className="underline">
              Switch to {hdTier === "hd" ? "light" : "best quality"}
            </button>
          </div>
        )}
        {hdError && <div className="font-mono text-[9px]" style={{ color: c.red || "#EF4444" }}>{hdError}</div>}
      </div>

      <div className="rounded-lg border p-2.5 font-body text-xs" style={{ borderColor: c.border, background: c.surface, color: c.text }}>
        {tip}
      </div>

      <div className="grid grid-cols-8 rounded-lg overflow-hidden border" style={{ borderColor: c.border }}>
        {[...Array(8).keys()].map((rankIdx) =>
          [...Array(8).keys()].map((fileIdx) => {
            const rank = 8 - rankIdx;
            const sq = squareId(fileIdx, rank);
            const cell = board[rankIdx][fileIdx];
            const isDark = (fileIdx + rankIdx) % 2 === 1;
            const isSelected = sq === selected;
            const isTarget = legalTargets.includes(sq);
            return (
              <button key={sq} onClick={() => onSquareClick(sq)}
                className="aspect-square flex items-center justify-center relative select-none"
                style={{ background: isSelected ? `${c.accent}55` : isDark ? c.surfaceHover : c.surface, cursor: "pointer" }}>
                {isTarget && <span className="absolute w-2.5 h-2.5 rounded-full" style={{ background: `${c.accent}99` }} />}
                {fileIdx === 0 && (
                  <span className="absolute top-0.5 left-1 font-mono text-[9px] font-bold leading-none" style={{ color: c.textFaint }}>{rank}</span>
                )}
                {rankIdx === 7 && (
                  <span className="absolute bottom-0.5 right-1 font-mono text-[9px] font-bold leading-none" style={{ color: c.textFaint }}>{FILES[fileIdx]}</span>
                )}
                {cell && (
                  <span className="text-2xl sm:text-3xl leading-none" style={{ color: cell.color === "w" ? c.text : c.textFaint }}>
                    {PIECE_GLYPH[`${cell.color}${cell.type.toUpperCase()}`]}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {promotionChoice && (
        <div className="rounded-lg border p-3 flex items-center gap-2 justify-center" style={{ borderColor: c.border, background: c.surface }}>
          <span className="font-mono text-[10px] uppercase mr-1" style={{ color: c.textFaint }}>Promote to:</span>
          {["q", "r", "b", "n"].map((p) => (
            <button key={p} onClick={() => { applyMove(promotionChoice.from, promotionChoice.to, p); setPromotionChoice(null); }}
              className="text-2xl px-2 py-1 rounded-lg" style={{ background: c.surfaceHover }}>
              {PIECE_GLYPH[`${chess.get(promotionChoice.from)?.color || "w"}${p.toUpperCase()}`]}
            </button>
          ))}
        </div>
      )}

      <div className="font-mono text-[10px] uppercase text-center" style={{ color: c.textFaint }}>
        No account needed, nothing saved — this is just for exploring how the pieces move.
      </div>
    </div>
  );
}
