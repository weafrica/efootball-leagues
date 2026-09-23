// Chess vs AI — a small, dependency-free minimax/alpha-beta bot. Not a
// real engine (no Stockfish/WASM — keeps the bundle light and the setup
// simple), just enough tactical awareness to be a believable casual
// opponent at three difficulty tiers. Runs entirely client-side; the AI's
// moves are submitted through chess_submit_ai_move exactly like a human's
// would be (see supabase/migrations/20260941_chess_ai.sql).

import { Chess } from "chess.js";

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Tiny piece-square tables (white's perspective; mirrored for black) so
// the bot doesn't just shuffle material around — pawns pushed, knights
// toward the center, king tucked away early. Deliberately coarse.
const PAWN_PST = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
const KNIGHT_PST = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];
const PST = { p: PAWN_PST, n: KNIGHT_PST };

function squareIndex(sq) {
  const file = sq.charCodeAt(0) - 97; // 'a' -> 0
  const rank = parseInt(sq[1], 10) - 1; // '1' -> 0
  return { file, rank };
}

function pstValue(type, sq, color) {
  const table = PST[type];
  if (!table) return 0;
  const { file, rank } = squareIndex(sq);
  const idx = color === "w" ? (7 - rank) * 8 + file : rank * 8 + file;
  return table[idx];
}

function evaluate(chess) {
  // Positive favors white, negative favors black — standard convention.
  if (chess.isCheckmate()) return chess.turn() === "w" ? -100000 : 100000;
  if (chess.isDraw() || chess.isStalemate()) return 0;

  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = board[r][f];
      if (!cell) continue;
      const file = "abcdefgh"[f];
      const rank = 8 - r;
      const sq = `${file}${rank}`;
      const val = PIECE_VALUE[cell.type] + pstValue(cell.type, sq, cell.color);
      score += cell.color === "w" ? val : -val;
    }
  }
  return score;
}

function minimax(chess, depth, alpha, beta, maximizing) {
  if (depth === 0 || chess.isGameOver()) return evaluate(chess);
  const moves = chess.moves({ verbose: true });
  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      chess.move(m);
      best = Math.max(best, minimax(chess, depth - 1, alpha, beta, false));
      chess.undo();
      alpha = Math.max(alpha, best);
      if (beta <= alpha) break;
    }
    return best;
  }
  let best = Infinity;
  for (const m of moves) {
    chess.move(m);
    best = Math.min(best, minimax(chess, depth - 1, alpha, beta, true));
    chess.undo();
    beta = Math.min(beta, best);
    if (beta <= alpha) break;
  }
  return best;
}

// difficulty -> { depth, randomness } — randomness picks among the top-N
// roughly-equal moves instead of always the single best, so "easy" makes
// human-plausible mistakes rather than playing perfectly-but-shallow.
const DIFFICULTY = {
  easy: { depth: 1, topN: 5 },
  medium: { depth: 2, topN: 3 },
  hard: { depth: 3, topN: 1 },
};

// pickAiMove — returns a chess.js move object ({from, to, promotion, ...})
// for the side to move. Synchronous; hard/depth-3 on an empty-ish board
// is a few thousand nodes at most, fine on a phone.
export function pickAiMove(chess, difficulty) {
  const { depth, topN } = DIFFICULTY[difficulty] || DIFFICULTY.medium;
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return null;

  const aiIsMaximizing = chess.turn() === "w";
  const scored = moves.map((m) => {
    chess.move(m);
    const score = minimax(chess, depth - 1, -Infinity, Infinity, !aiIsMaximizing);
    chess.undo();
    return { move: m, score };
  });
  scored.sort((a, b) => (aiIsMaximizing ? b.score - a.score : a.score - b.score));

  const pool = scored.slice(0, Math.min(topN, scored.length));
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { from: pick.move.from, to: pick.move.to, promotion: pick.move.promotion };
}

export const AI_DIFFICULTIES = ["easy", "medium", "hard"];
export const AI_REWARD_NETS = { easy: 3, medium: 7, hard: 15 };

// ---------------------------------------------------------------------
// Move commentary — praise/criticism for the human's moves and a plain-
// English reason for the bot's own moves. Deliberately runs AFTER a move
// has already been committed to the server (see ChessGame.jsx: this is
// called once the RPC round-trip resolves) — it's a courtesy caption,
// never a hint, undo, or anything that could change the outcome of the
// game it's commenting on.

const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

// classifyMove — compares the eval after the move that was actually
// played against the eval after the best move available at that point
// (same shallow search pickAiMove already uses, so this stays fast).
// Returns { tag, lossCp } from the mover's own perspective — lossCp is
// how many centipawns worse the played move was than the best one, 0 or
// negative meaning it basically *was* the best move.
export function classifyMove(fenBeforeMove, playedMove, depth = 2) {
  const chess = new Chess(fenBeforeMove);
  const moverIsWhite = chess.turn() === "w";
  const legal = chess.moves({ verbose: true });
  if (legal.length === 0) return { tag: "Only move", lossCp: 0 };

  let bestScore = -Infinity;
  let playedScore = null;
  for (const m of legal) {
    chess.move(m);
    const score = minimax(chess, depth - 1, -Infinity, Infinity, !moverIsWhite);
    const fromMoverPerspective = moverIsWhite ? score : -score;
    chess.undo();
    if (fromMoverPerspective > bestScore) bestScore = fromMoverPerspective;
    if (m.from === playedMove.from && m.to === playedMove.to && (m.promotion || null) === (playedMove.promotion || null)) {
      playedScore = fromMoverPerspective;
    }
  }
  if (playedScore === null) return { tag: "Move played", lossCp: 0 }; // shouldn't happen, defensive fallback

  const lossCp = Math.max(0, Math.round(bestScore - playedScore));
  let tag;
  if (lossCp === 0) tag = "Best move";
  else if (lossCp < 20) tag = "Excellent";
  else if (lossCp < 50) tag = "Good";
  else if (lossCp < 150) tag = "Inaccuracy";
  else if (lossCp < 300) tag = "Mistake";
  else tag = "Blunder";
  return { tag, lossCp };
}

const ENCOURAGING = {
  "Best move": ["That's the strongest move on the board.", "Engine agrees — best move available.", "Couldn't have played that better myself."],
  "Excellent": ["Excellent choice.", "Very strong — barely a hair off the best move.", "Sharp play."],
  "Good": ["Good move — keeps you in a solid spot.", "Solid, sensible choice."],
};
const CRITICAL = {
  "Inaccuracy": ["A slightly stronger move was available.", "Not the sharpest — worth a second look next time."],
  "Mistake": ["That gives your opponent a real opening.", "A stronger move was on the board there."],
  "Blunder": ["That one hands over a significant advantage.", "Ouch — that loses ground fast."],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const PIECE_FULL_NAME = { K: "King", Q: "Queen", R: "Rook", B: "Bishop", N: "Knight" };

// sanToSpeech — turns algebraic notation into something that reads
// naturally out loud. "Rd4" -> "Rook d4", "Qxe5" -> "Queen takes e5",
// "Nbd7" -> "Knight from b to d7", "O-O" -> "castles kingside",
// "e8=Q" -> "Pawn e8, promotes to Queen", "+"/"#" -> ", check"/", checkmate".
// Hearing "R D 4" spelled out letter by letter reads badly; the on-screen
// caption still shows plain SAN (chess players expect that), only the
// spoken version goes through this.
export function sanToSpeech(san) {
  if (!san) return "";
  if (san.startsWith("O-O-O")) return `castles queenside${san.includes("#") ? ", checkmate" : san.includes("+") ? ", check" : ""}`;
  if (san.startsWith("O-O")) return `castles kingside${san.includes("#") ? ", checkmate" : san.includes("+") ? ", check" : ""}`;

  const m = san.match(/^([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(=([QRBN]))?([+#])?$/);
  if (!m) return san; // unexpected shape — read the raw SAN rather than say nothing
  const [, piece, fromFile, fromRank, capture, toSquare, , promo, checkMark] = m;

  const pieceName = piece ? PIECE_FULL_NAME[piece] : "Pawn";
  const hasDisambig = Boolean(fromFile || fromRank);
  let text = pieceName;
  if (hasDisambig) text += ` from ${fromFile || ""}${fromRank || ""}`;
  text += capture ? ` takes ${toSquare}` : (hasDisambig ? ` to ${toSquare}` : ` ${toSquare}`);
  if (promo) text += `, promotes to ${PIECE_FULL_NAME[promo]}`;
  if (checkMark === "#") text += ", checkmate";
  else if (checkMark === "+") text += ", check";
  return text;
}

// commentOnHumanMove — the "praise/criticize" side. moveSan is the SAN
// of the move that was actually played (for referencing it by name).
// Returns { display, spoken } — the caption keeps standard notation
// (normal for a chess app), the spoken version expands it to words.
export function commentOnHumanMove(fenBeforeMove, playedMove, moveSan) {
  const { tag, lossCp } = classifyMove(fenBeforeMove, playedMove);
  if (tag === "Only move" || tag === "Move played") return null; // nothing useful to say
  const spokenMove = sanToSpeech(moveSan);
  if (tag === "Best move" || tag === "Excellent" || tag === "Good") {
    const line = pick(ENCOURAGING[tag] || ENCOURAGING["Good"]);
    return { display: `${tag}: ${line}`, spoken: `${spokenMove}. ${line}`, tag };
  }
  const line = pick(CRITICAL[tag]);
  return { display: `${tag} (${moveSan}): ${line} (~${lossCp}cp)`, spoken: `${spokenMove}. ${tag}. ${line}`, tag };
}

// explainAiMove — the "how I made my brilliant move" side. Template-based
// on the move's own tactical shape (capture/check/castle/promotion)
// rather than free-form generation — keeps it fast, accurate, and never
// makes claims about the position it can't back up.
export function explainAiMove(chessAfterMove, moveResult) {
  const bits = [];
  if (moveResult.captured) bits.push(`wins your ${PIECE_NAME[moveResult.captured] || "piece"}`);
  if (moveResult.flags?.includes("k") || moveResult.flags?.includes("q")) bits.push("castles its king to safety");
  if (moveResult.promotion) bits.push(`promotes to a ${PIECE_NAME[moveResult.promotion]}`);
  if (chessAfterMove.isCheckmate()) bits.push("that's checkmate");
  else if (chessAfterMove.inCheck?.() || moveResult.san.includes("+")) bits.push("puts your king in check");
  if (bits.length === 0) bits.push("improves its position and piece activity");
  const bitsText = bits.join(", ");
  return { display: `${moveResult.san} — ${bitsText}.`, spoken: `${sanToSpeech(moveResult.san)}. ${bitsText}.` };
}

// ---------------------------------------------------------------------
// Funny/ridiculous asides — pure comic relief, separate from the serious
// analysis above. Triggered some of the time (not every move — that
// would get old fast), keyed off things we already know cheaply: the
// move's quality tag, whether it took the queen, checkmate, or it's
// still the opening. Never claims anything analytical, just banter.
const FUNNY_ASIDES = {
  Blunder: [
    "Oof. My grandmother castles better than that.",
    "That one's going in my highlight reel. The bad kind.",
    "I almost feel bad taking that. Almost.",
    "Was that on purpose? Be honest.",
  ],
  Mistake: [
    "Bold strategy. Let's see if it pays off. (It won't.)",
    "Interesting choice. And by interesting I mean questionable.",
  ],
  "Best move": [
    "Okay, show-off.",
    "Wait, who taught you that?",
    "I did NOT see that coming.",
    "Rude. Playing well against me like that.",
  ],
  queenTaken: [
    "YOUR QUEEN. Gone. Anyway, moving on.",
    "That's going to leave a mark.",
    "RIP to your queen. She served admirably.",
  ],
  checkmate: [
    "GG. Try not to cry.",
    "And that's how it's done, folks.",
    "Good game! Rematch? I'll even give you a head start. Kidding.",
  ],
  opening: [
    "Ah, the classics. Bold choice.",
    "Textbook opening. I respect it.",
  ],
};
export function maybeFunnyAside(tag, moveResult, isCheckmate, moveCount) {
  const pool = [];
  if (tag && FUNNY_ASIDES[tag]) pool.push(...FUNNY_ASIDES[tag]);
  if (moveResult?.captured === "q") pool.push(...FUNNY_ASIDES.queenTaken);
  if (isCheckmate) pool.push(...FUNNY_ASIDES.checkmate);
  if (typeof moveCount === "number" && moveCount <= 2) pool.push(...FUNNY_ASIDES.opening);
  if (pool.length === 0) return null;
  if (Math.random() > 0.35 && !isCheckmate) return null; // most moves stay serious; checkmate always gets a line
  return pick(pool);
}

// ---------------------------------------------------------------------
// Piece "purpose" gamification — every capture gets a one-line story
// instead of just updating the board silently. Flavor only, no numeric
// evaluation in here (that's classifyMove's job, kept vs-AI-only for
// fairness) — so this is safe to show in PvP too, real opponent or not.
export function describeCaptureNarrative(chessAfterMove, moveResult) {
  if (!moveResult.captured) return null;
  const capturedVal = PIECE_VALUE[moveResult.captured];
  const capturerVal = PIECE_VALUE[moveResult.piece];
  const capturedName = PIECE_NAME[moveResult.captured];
  const capturerName = PIECE_NAME[moveResult.piece];
  // Can the side that just lost the piece immediately take back on the
  // same square? Cheap one-ply check, not a full tactical read — good
  // enough for flavor text, not meant to be engine-accurate.
  const canAvenge = chessAfterMove.moves({ verbose: true }).some((m) => m.to === moveResult.to);

  if (capturedVal > capturerVal) {
    return canAvenge
      ? `The ${capturedName} falls a hero — traded down to a mere ${capturerName}, but it can be avenged right back on ${moveResult.to}.`
      : `The ${capturedName} falls a hero, taking a bite out of the position on its way down — and nothing can answer for it.`;
  }
  if (capturedVal < capturerVal) {
    return `The ${capturedName} gave itself up for nothing more than a ${capturerName} — a quiet death, but it did its job drawing that piece in.`;
  }
  return canAvenge
    ? `A straight trade — ${capturedName} for ${capturerName}, evens out, and it's answerable immediately.`
    : `A clean, even trade — ${capturedName} for ${capturerName}.`;
}

// ---------------------------------------------------------------------
// The bot's forward-looking "plan" — what it says it's going for, not
// just what it just did. Honest framing: the bot's actual move choice
// comes from a shallow minimax (see pickAiMove) — it doesn't compute or
// store a real long-term plan. This reads cheap, real signals off the
// current position (material balance, whether your king has castled,
// how much is left on the board) and picks a plausible, grounded line —
// dramatized commentary, not a literal readout of deep search.

function findKingSquare(chess, color) {
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = board[r][f];
      if (cell && cell.type === "k" && cell.color === color) return `${"abcdefgh"[f]}${8 - r}`;
    }
  }
  return null;
}

const PLAN_LINES = {
  king_exposed: [
    "Your king's still stuck in the center — I'm coming for it.",
    "That king hasn't castled yet. I like my chances there.",
    "I'm going to keep opening lines toward your king. This won't be comfortable.",
  ],
  down_material: [
    "I'm behind on material, so I need to make this messy and find some tactics.",
    "Material's not on my side — time to complicate things and hope you slip.",
    "I'm down material. Watch for tricks — I've got nothing to lose here.",
  ],
  up_material: [
    "I'm ahead on material — I'll look to trade pieces and grind this out.",
    "With this material lead, simplifying toward an endgame suits me fine.",
    "I'm up material now. Trading down is the plan.",
  ],
  endgame: [
    "Not much left on the board — this comes down to whoever's pawns run faster.",
    "Endgame territory. I'm counting tempo from here.",
  ],
  balanced: [
    "Roughly even for now — I'm just hunting for the best move each turn.",
    "Nothing decisive yet. I'll keep probing for a weakness.",
  ],
};

// generateBotPlan — call with the position AFTER the bot's own move.
// Bot always plays black in vs-AI games (see 20260941_chess_ai.sql).
export function generateBotPlan(chess) {
  let whiteMaterial = 0, blackMaterial = 0, nonPawnMaterial = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const cell = board[r][f];
      if (!cell) continue;
      const val = PIECE_VALUE[cell.type];
      if (cell.color === "w") whiteMaterial += val; else blackMaterial += val;
      if (cell.type !== "p" && cell.type !== "k") nonPawnMaterial += val;
    }
  }
  const botDiff = blackMaterial - whiteMaterial; // positive = bot (black) ahead
  const isEndgame = nonPawnMaterial < 2600; // rough: most major/minor pieces traded off
  const whiteKing = findKingSquare(chess, "w");
  const kingExposed = !isEndgame && whiteKing === "e1" && chess.history().length > 6;

  let category;
  if (kingExposed) category = "king_exposed";
  else if (isEndgame) category = "endgame";
  else if (botDiff <= -200) category = "down_material";
  else if (botDiff >= 200) category = "up_material";
  else category = "balanced";

  const pool = PLAN_LINES[category];
  return { category, line: pool[Math.floor(Math.random() * pool.length)] };
}
