// Chess vs AI — a small, dependency-free minimax/alpha-beta bot. Not a
// real engine (no Stockfish/WASM — keeps the bundle light and the setup
// simple), just enough tactical awareness to be a believable casual
// opponent at three difficulty tiers. Runs entirely client-side; the AI's
// moves are submitted through chess_submit_ai_move exactly like a human's
// would be (see supabase/migrations/20260941_chess_ai.sql).

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
