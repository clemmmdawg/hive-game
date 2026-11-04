# Polish, Repetition Draw, Game Clock, Spectators — Spec + Plan

> Execution: one builder + one combined reviewer/critic per package (user-approved to save credits), final whole-branch review. Branch `upgrade/polish-clock-spectate` from `main` @ c777d19.

**User decisions:** clock = Fischer presets OFF / 5+0 / 10+5 / 15+10 / 30+0 (minutes + seconds increment), server-authoritative online; spectators = joining a full/in-progress room watches automatically (share link works for both); repetition = automatic threefold draw, warning at 2/3. AI opponent out of scope.

## Global Constraints

- No build step, no framework, no new runtime dependencies. `js/game.js` stays DOM-free and server-importable; do not reorder `DIRS`.
- Preserve CLAUDE.md "User-applied CSS overrides". Honour `prefers-reduced-motion`.
- Every change to a precached file: bump `CACHE` in `sw.js` and run `npm run sw:stamp` (test/pwa.test.js enforces). New runtime modules go into `PRECACHE`.
- `npm test` + `npm run check` green; zero browser console errors; idle ≥ 50 fps with ~22 pieces under CDP CPU throttle ×4 (iPhone 13 viewport).
- Update CLAUDE.md for every API/protocol/UI change. Commit messages end with the session attribution lines.
- Playwright: `/opt/node-tools/node_modules/playwright/index.js` (Chromium preinstalled; never install).

---

## Package A — Polish & refactor

1. **Split app.js** (~2060 lines): move the game-review state machine + moves sheet (app.js "Game review" section) into `js/review.js`, and the win sequence (playWinSequence, settle/open/flush win card, board dim, deferred-win logic) into `js/win-fx.js`. Use an explicit injected context (getters for live state, callbacks) — no hidden globals; app.js keeps orchestration. Pure behaviour-preserving refactor: no UI change. Existing tests stay green; add unit tests for any newly pure-testable seams. Add both modules to PRECACHE.
2. **Off-screen target indicators**: when legal targets (ghosts / throw targets) lie outside the playable area (between `board.insets`), draw small edge chevrons on the board overlay pointing toward them with a count badge per edge cluster; tapping one pans (animated) to bring those targets in view. Live overlay only (not in the cached layer); reduced motion → instant pan. Pure geometry helper exported + tested.
3. **Leftovers**: update toast must not cover the HIVE logo on the menu (place it clear of logo and START); the replay COPY toast must not sit over the CLOSE REPLAY pill; moves-sheet footer opaque; an online opponent move that ends a preview should animate (not snap) after returning to live; announce whose turn it is after ROOM_RESUMED (online reconnect) via the existing turn banner; draw result gets a haptic (e.g. [30,30]); sw-hash: normalise CRLF→LF before hashing and replace its `process.argv[1]` main-module guard with a realpath-safe one.

## Package B — Draw by repetition

- Position key (pure, game.js): canonical string of board stacks (hex key + bottom→top `player+type`, ids excluded), side to move, and both supplies. `positionKey(state)`.
- GameState gains `positionCounts: { [key]: n }` maintained by `applyAction` (incl. PASS and THROW); serialized/deserialized (old saves: rebuilt as `{ currentKey: 1 }`). `createGame` seeds the initial key.
- `checkWin`/applyAction: when a key reaches 3 → `winner: 'DRAW'`, `winReason`-style field `drawReason: 'REPETITION'` on state (or equivalent) so UI and server can tell it apart from a both-queens draw. Queen-surround win takes precedence if it happens on the same move.
- Server: GAME_OVER reason `'REPETITION'`; endReason likewise; client maps it (hints `winReasonFromServer`) → copy "DRAW — THREEFOLD REPETITION". Status line warns "REPETITION 2/3" when the position about to be (or just) reached has count 2 (show after a move produces count 2).
- Undo restores counts (they live in state). Replay/notation unaffected.
- Tests: forced back-and-forth sequence draws on the 3rd occurrence; counts survive serialize; old save loads; server reason; status copy.

## Package C — Game clock (Fischer)

- Settings: chips OFF / 5+0 / 10+5 / 15+10 / 30+0 in the main menu settings panel (follow existing toggle/chip styles), persisted with other settings; `settings.clock = { enabled, type: 'FISCHER', time: ms, increment: ms }`. Server `normalizeSettings` accepts only these presets.
- State: `clock: { remaining: {1: ms, 2: ms}, turnStartedAt: epoch ms | null, running: bool }` — kept outside game.js purity concerns by a new pure module `js/clock.js`: `createClock(settings)`, `startTurn(clock, now)`, `endTurn(clock, player, now) → clock` (deduct elapsed, add increment), `remainingFor(clock, player, now)`, `isFlagged(clock, player, now)`, `pause(clock, now)`, `resume(clock, now)`. Fully unit-tested with injected `now`.
- Start rule: the side to move's clock runs from the moment the game starts (online: when GAME_START is sent; local: when the game screen first shows).
- Online (server-authoritative): server keeps the clock per room, applies `endTurn` on each valid action, schedules a timeout timer for the side to move; on expiry → GAME_OVER `{winner: other, reason: 'TIMEOUT'}` and endReason TIMEOUT. Every GAME_STATE/GAME_START/ROOM_RESUMED carries `clock` plus `serverNow` so clients compute skew-corrected countdowns. Clock keeps running while a player is disconnected.
- Local: pauses while ☰ menu, How to Play, confirm dialog, review/replay, or page hidden; resumes after. Undo restores the clock snapshot stored with the undo history (store clock alongside history states). Autosave stores the clock; CONTINUE resumes paused (starts on first interaction / when the game screen shows).
- UI: remaining time in each HUD player chip area (mm:ss, tenths under 10 s), active side highlighted; ≤10 s red pulse + soft `tick` sfx each second (add `tick` voice to audio.js, respects mute); flag → existing win sequence with copy "P1 RAN OUT OF TIME". Reduced motion: no pulse.
- Tests: clock.js unit tests; server timeout test with mock timers; local pause/undo logic where pure.

## Package D — Spectators

- Server: JOIN_ROOM to a room whose two seats are taken (or game started) → join as spectator: `SPECTATING { code, gameState, settings, history, clock?, serverNow?, endReason? }`; spectators receive all broadcasts (GAME_STATE, GAME_OVER, OPPONENT_* adapted, ROOM_CLOSED) but every action message from them → `ERROR NOT_A_PLAYER`. Max 16 spectators/room (`ERROR ROOM_FULL` beyond). Spectators do not refresh room activity timers and are dropped on room cleanup. Broadcast `SPECTATORS { count }` to everyone on change.
- Client: menu JOIN handles SPECTATING → `startOnlineGame` in spectator mode (myPlayer = null): tray hidden (show both reserve strips), no undo/pass/resign (☰ shows Leave instead), board taps only inspect stacks, HUD chip "WATCHING", 👁 N indicator for all participants. Moves sheet, previews and replay work. Reconnect for spectators: re-JOIN by code (no token).
- `?room=CODE` link → JOIN prefilled (existing) → watch if full.
- Tests: server spectator join/limit/no-actions/broadcast/count; client pure helpers where possible; Playwright: 2 players + 1 spectator, moves animate on the spectator, count updates on leave.

## Review gates
Per package: builder → one combined reviewer/critic (code review + browser verification; verdict WOWED or findings) → fix loop. Final whole-branch review at the end.
