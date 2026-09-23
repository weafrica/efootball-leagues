// Runs the two expensive chess computations (picking the bot's move,
// classifying how good a human move was) on a background thread. Before
// this file existed, both ran directly on the main thread — the same
// thread that draws the screen and plays audio — so a few seconds of
// "hard" difficulty thinking meant the whole app visibly froze and the
// voice queue stalled with it. Nothing here changes what gets computed,
// only where: chessAi.js's pickAiMove/classifyMove are unmodified pure
// functions, just called from inside this worker instead of directly
// from ChessGame.jsx.
import { Chess } from "chess.js";
import { pickAiMove, classifyMove } from "./chessAi.js";

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  try {
    let result;
    if (type === "pickAiMove") {
      const chess = new Chess(payload.fen);
      result = pickAiMove(chess, payload.difficulty);
    } else if (type === "classifyMove") {
      result = classifyMove(payload.fenBeforeMove, payload.playedMove, payload.depth);
    } else {
      throw new Error(`chessWorker: unknown message type "${type}"`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
