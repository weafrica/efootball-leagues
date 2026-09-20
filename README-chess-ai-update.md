# Chess vs AI — update

Adds a "Play vs bot" mode to the Chess feature: instant single-player games at
three difficulties, with a Nets reward for winning.

## What changed

- **`chessAi.js`** (new) → goes in `src/`. A small dependency-free minimax/
  alpha-beta bot (no Stockfish/WASM — keeps the bundle light). Three
  difficulties: easy (depth 1, picks among top 5 near-equal moves), medium
  (depth 2, top 3), hard (depth 3, always the best move it finds). Tested
  against the real `chess.js` package — legal, sane moves, hard-difficulty
  move takes well under a second.
- **`ChessGame.jsx`** (replaces the one from the last round) → adds a
  "Play vs bot" card to the lobby (difficulty buttons showing the reward for
  each), and teaches the board screen to drive the bot's turns automatically
  after your move, with a "Bot is thinking…" indicator.
- **`20260941_chess_ai.sql`** → **already applied directly to your live
  Supabase project** (I ran it for you), so there's nothing to do here except
  keep the file for your migrations folder/history. It adds AI-specific
  columns to `chess_games` and three RPCs: `create_ai_chess_game`,
  `chess_submit_ai_move`, `resign_ai_chess_game`.

## Rewards

Win vs bot pays Nets on a genuine win: **Easy +3, Medium +7, Hard +15**. Losing
or drawing pays nothing. This is a reward, not a stake — there's no second
human to take money from, so it's funded the same way any other in-app reward
is.

**Anti-farming note, stated plainly:** AI moves are computed and reported by
the same client that reports the result, same trust model this repo already
accepts for the PvP table and for eFootball scores generally. For two real
people that's a mutual check; for a solo bot game it isn't, so I added a hard
cap of **5 rewarded AI wins per person per day** server-side — playing more is
always fine, it just stops paying past the cap. That limits how much a
cheated client could extract; it doesn't make cheating impossible. If this
ever needs to be airtight, the real fix is a server-side chess engine
validating the final PGN before paying out — a bigger piece of work I didn't
take on for this pass.

## Verified before handing this over

- Ran the AI engine against the real `chess.js` package — produces legal
  moves, reasonable timing.
- Applied the SQL directly against your live Supabase project and confirmed
  the new columns and all three RPCs exist.
- Bundled `ChessGame.jsx` + `chessAi.js` against your actual live `nets.js`/
  `supabaseClient.js` with esbuild — no import errors.
- Cloned your actual repo fresh, dropped these two files in, ran the *real*
  `npm install` + `vite build` — succeeds, `ChessGame` shows up as its own
  55 KB chunk in the output.

## Push it

```
cd $HOME\Downloads\efootball-leagues-repo
git add src/ChessGame.jsx src/chessAi.js supabase/migrations/20260941_chess_ai.sql
git commit -m "Add Chess vs AI: three difficulties, Nets reward for winning"
git push
```

Nothing else needs touching — `App.jsx`'s Chess route already points at
`ChessGame.jsx`, and this update lives entirely inside that file plus the new
`chessAi.js`.
