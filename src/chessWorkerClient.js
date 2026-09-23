// Talks to chessWorker.js so ChessGame.jsx never has to know it's a
// worker underneath — just await pickAiMoveAsync()/classifyMoveAsync()
// like any other async call. One worker, created lazily on first use and
// reused for the rest of the session (spinning up a new thread per move
// would be wasteful).
//
// Falls back to running the same computation directly on the main
// thread if the Worker can't be created at all (very old/unusual
// browser, or a hosting setup that blocks module workers) — slower and
// can still cause the freeze this file exists to fix, but the feature
// keeps working rather than breaking outright.
import { pickAiMove as pickAiMoveSync, classifyMove as classifyMoveSync } from "./chessAi.js";
import { Chess } from "chess.js";

let worker = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./chessWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
    worker.onerror = (event) => {
      // A worker-level failure (e.g. it threw during its own module
      // load) — reject everything still waiting rather than hang them
      // forever, and stop trying to use this worker again this session.
      console.warn("Chess worker failed, falling back to main-thread computation:", event.message);
      pending.forEach((p) => p.reject(new Error("chess worker failed")));
      pending.clear();
      workerFailed = true;
      worker = null;
    };
  } catch (err) {
    console.warn("Couldn't create chess worker, falling back to main-thread computation:", err);
    workerFailed = true;
    worker = null;
  }
  return worker;
}

function callWorker(type, payload) {
  const w = getWorker();
  if (!w) return null; // caller falls back to sync
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
  });
}

export async function pickAiMoveAsync(fen, difficulty) {
  const viaWorker = callWorker("pickAiMove", { fen, difficulty });
  if (viaWorker) {
    try { return await viaWorker; }
    catch { /* fall through to main-thread computation below */ }
  }
  return pickAiMoveSync(new Chess(fen), difficulty);
}

export async function classifyMoveAsync(fenBeforeMove, playedMove, depth) {
  const viaWorker = callWorker("classifyMove", { fenBeforeMove, playedMove, depth });
  if (viaWorker) {
    try { return await viaWorker; }
    catch { /* fall through to main-thread computation below */ }
  }
  return classifyMoveSync(fenBeforeMove, playedMove, depth);
}
