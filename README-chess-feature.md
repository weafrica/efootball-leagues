# Chess — new feature for Matchday

Four files, all in this folder:

- **`20260940_chess.sql`** → goes in `supabase/migrations/`. New table (`chess_games`),
  RLS, and 5 RPCs (`create_chess_game`, `join_chess_game`, `cancel_chess_game`,
  `chess_submit_move`, `resign_chess_game`). Staking is optional per table (0 or a
  preset Nets amount) and settles through the same `_nets_credit_internal` /
  `_nets_debit_internal` functions every other paid feature in this repo uses —
  confirmed live against your Supabase project before writing this, not guessed.
- **`ChessGame.jsx`** → goes in `src/`. New standalone screen: a lobby (open tables,
  your own games, create/cancel) plus a live 1v1 board. Move legality, check,
  checkmate, and stalemate are handled by the `chess.js` npm package — I didn't
  reimplement chess rules by hand.
- **`chess-integration.patch`** → a single `git apply`-ready patch (regenerated
  against the *current* `main`, not an older snapshot — your repo had moved on
  since my first pass, so I re-pulled `App.jsx`/`package.json` fresh and rebuilt
  this against that) with the 4 small hunks: one new lazy import, one new Quick
  Actions tile ("Chess"), one new `view === "chess"` route, one new dependency
  (`chess.js`). Verified it applies cleanly with a plain `git apply`.

## What went wrong last time

Last round, the two new files (`ChessGame.jsx`, the SQL migration) made it into the
repo, but the *diff* files were only ever saved alongside them as extra untracked
files — never actually applied to `App.jsx`/`package.json`. That's why `git add`
had nothing to stage and `git push` said "Everything up-to-date": nothing in the
tracked files had changed, so there was nothing to commit. This patch fixes that by
being something `git apply` can act on directly, instead of something that has to
be applied by hand.

## What this deliberately leaves out (so you know it's a choice, not a gap)

- **No server-side chess rule validation.** The RPC checks whose turn it is and
  moves the money; it trusts the client's reported FEN, same trust model this repo
  already uses for eFootball scores (see `FINALS-PENALTIES-MIGRATION.md`). An
  admin-override RPC is a natural follow-up if that ever needs closing.
- **No spectators/investment, no clock/timer, no matchmaking queue** — just an open
  lobby, same shape as Rapid Cup's Phase 1 before its later phases landed.
- **No Home banner** — the tile lives in Quick Actions only, per what you asked for.

## Setup

1. Copy `ChessGame.jsx` into `src/` and `20260940_chess.sql` into
   `supabase/migrations/`.
2. From the repo root, apply the patch: `git apply chess-integration.patch`
   (put the patch file at the repo root first, or point the command at wherever
   you saved it). This edits `src/App.jsx` and `package.json` directly — no manual
   copy-pasting.
3. Run the migration against your live Supabase project (SQL editor, or
   `supabase db push` / the MCP `apply_migration` tool — whichever you already use).
4. `npm install` (pulls in `chess.js` and updates `package-lock.json`).

## Push it

```
cd $HOME\Downloads\efootball-leagues-repo
git apply chess-integration.patch
npm install
git add src/App.jsx src/ChessGame.jsx package.json package-lock.json supabase/migrations/20260940_chess.sql
git commit -m "Add Chess: 1v1 real-time chess with optional Nets stake, in Quick Actions"
git push
```

After this, `git status` should show clean — if `git add src/App.jsx` still shows
"nothing added to commit" afterward, the `git apply` step failed (it'll say so
loudly if so) rather than silently doing nothing.

