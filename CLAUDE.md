# HIVE PWA — Claude Code Project Reference

A browser-based implementation of the Hive board game (© Gen42 Games). Two-player abstract strategy. No build step, no framework — vanilla HTML/CSS/ES modules. Designed as a PWA installable on mobile or desktop.

Run with `npm start` (starts `server/index.js`; port 3000), `npm start -- 3001`, or `npm start -- --port 3001`. The `PORT` environment variable is also supported.

---

## Current State

### What Works
- Full pass-and-play local multiplayer
- Complete base game rules (Queen, Beetle, Ant, Spider, Grasshopper)
- All three expansion pieces (Mosquito, Ladybug, Pillbug) including throw mechanic
- One Hive Rule (articulation point detection via BFS)
- Freedom to Move / gate check (height-aware for beetle stacks)
- Forced queen placement by turn 4 (gold-pulsing queen in the tray + HUD warning)
- Tournament opening rule (optional toggle)
- Win/draw detection, including automatic threefold-repetition draw (status line shows `REPETITION 2/3` once a position has occurred twice; draw copy "DRAW — THREEFOLD REPETITION")
- Must-pass turn handling (auto-pass banner locally; explicit PASS button online; mutual no-move = draw locally)
- Pan and pinch-zoom on the board canvas
- Per-player piece tray with legal-placement gating
- Green ghost hexes for legal placements/moves
- Amber ring highlights for pillbug-throwable pieces
- Two-phase throw UI (select piece → select destination)
- Neon Bestiary SVG insect sprites for every piece (`js/sprites.js`), each in its species colour (`SPECIES_COLOR`), shared by the canvas board and all DOM UI
- Board tiles: dark bevelled face, thick glowing player-colour rim (P1 magenta / P2 cyan), species-coloured glyph; tray, reserve and stack inspector use the same player-frame / species-glyph split
- Beetle stacks drawn as stepped 3D slabs (`stackLayers`) with a `×N` pill and sprite chips for buried pieces
- Stack inspector: hover (desktop) or tap an opponent stack to list every piece top→bottom
- Non-blocking turn banner between turns (replaced the full-screen interstitial)
- Last-move marker (gold corner ticks on the destination, dashed outline on the source)
- Move animation: pieces fly along their real route (`getMovePath`) — slides glide, hops/climbs/throws arc, placements drop in with squash; landing ripple (player colour), species-colour sparks, camera nudge on climbs/throws. Opponent moves animate online (`inferAction`). Undo and reduced motion are instant
- Gentle camera follow (`board.reveal`): pans (zooms out only if needed) to show off-screen move targets and the moved piece, never while the user is panning. Zoom-out floor: tiles never below `REVEAL_MIN_TILE_PX` (17 px) and never below an already smaller zoom; a pinch/wheel/key zoom is kept until the next recenter. Targets that don't fit are framed nearest-first around the selected/moved piece
- Off-screen target chevrons: legal targets (green ghosts, amber throw targets) outside the playable area get a neon edge chevron per edge cluster (count badge, arrow toward them, the halo breathes three times when one appears; `offscreenTargets` in board.js, DOM buttons in `#edge-hints`); tapping one pans them into view (`board.showTargets`, instant under reduced motion). The buttons are `pointer-events: none` so a drag starting on one still pans: `board.onTap` hit-tests them first (`tapEdgeHint`, 24 px), keyboard Enter/Space clicks them. Clear of the piece bar and the recenter button
- Airborne pieces occlude the hive: each floating tile cuts its footprint out of `#emoji-layer` before its own glyph is drawn; pips and rings are painted under floating pieces
- Landscape phones (`max-height: 500px` + landscape): 44 px HUD with the piece description inline under the status line, single-row 64 px tray with the opponent's reserve beside your pieces
- HiDPI canvas rendering, animated recenter/fit (⌖ button, `C` key), piece pop-in animation
- Status line explains why a selected piece can't move (`getMoveBlocker` + `js/hints.js`)
- Local undo (↶ button, `Z` key) and autosave/resume of the local game (CONTINUE GAME on the menu)
- Opponent reserve strip above the tray; online tray always shows your own pieces
- Win screen with reason, species-colour sprite confetti, Rematch (local) / View Board / Main Menu
- Queen danger meter: six pips on each queen's rim (lit per occupied side; gold, amber pulse at 4, red pulse + halo + face wash at 5), mirrored by two HUD meters (`#queen-meters`); stepping up to 5 plays `danger` once at touchdown (from `board.onLand`, or when the flight is snapped home) with a red banner — the 12 ms landing buzz is skipped whenever an alarm (danger or win) fires on that landing — and the endangered mover's status reads "P1 QUEEN IN DANGER"
- Win sequence: the winning move flies at 0.4× (capped at 1 s), a white shockwave + camera punch at touchdown, the board dims 45% round the fallen queen (`#board-dim`; an even dim when no queen is surrounded), then confetti + card — card ≤ 1.6 s (`winTiming`); the HUD holds the result until impact. Reduced motion: card after 300 ms, no slow-mo/shockwave. A finished game opened by reload/resume shows the card calmly (no sting, no confetti). If ☰ is open when the card is due, the card waits until it closes
- Settings (expansions, tournament rule, clock preset) remembered in localStorage
- Game clock (Fischer): menu CLOCK chips OFF / 5+0 / 10+5 / 15+10 / 30+0 (minutes + seconds per move). Each HUD queen meter becomes a player plate (meter + time, `#plate-N` / `#clock-N`; stacked P1-over-P2 on phones and landscape phones, side by side on wider screens); mm:ss, tenths (`09.4`) under 10 s; the side to move is lit in its colour; under 10 s the plate pulses red (none under reduced motion) and a soft `tick` plays once a second (online: only your own clock). Flag → the win sequence with "P1 RAN OUT OF TIME" (online "YOU / OPPONENT RAN OUT OF TIME"); the card's emblem is a red `STOPWATCH` sprite (menu-icon recipe). A local forced pass is charged only up to its banner (`announcedPass`). Local: the clock runs once the game screen shows and pauses while ☰, How to Play, a confirm dialog, the move sheet, a review/replay or a hidden page covers it (`clockHeld`, MutationObserver + visibilitychange); undo restores the clock snapshot kept with each history entry; autosave keeps the (paused) clock. Online: server-authoritative (see Multiplayer). Clock OFF → no clock UI. The display is written from the RAF loop only when its text/class changes (never touches the board layer)
- The REPETITION 2/3 banner shows once per game (`repetitionWarned`, reset on new game / rematch / continue / online start)
- Room share: COPY CODE + SHARE/COPY LINK; `?room=CODE` opens JOIN with the code filled in
- Main menu with mode selection, expansion toggles, tournament rule toggle
- Server-authoritative online multiplayer with room codes
- Token-based seat recovery after transient disconnects; after ROOM_RESUMED the turn banner says whose move it is (`resumeBanner` in hints.js)
- Responsive refined-neon UI with reduced-motion and focus-visible support
- Move list + game review: ☰ MOVES opens a slide-up sheet (numbered rounds, sprite + notation, COPY MOVES); tapping a move previews that position read-only (BACK TO GAME pill); REPLAY on the win card (or the sheet, mid-game) holds the empty board ~600 ms then autoplays the game (900 ms/move, steps fly along getMovePath routes) with a scrubber bar (⏮ ◀ ▶/❚❚ ▶ ⏭, slider); Esc / ✕ returns to where review began. The HUD chip reads PREVIEW for a tapped move and REPLAY once autoplay has run; the sheet hides its REPLAY button while reviewing; a throw reads "P2 THREW P1 BEETLE"; the landscape replay bar shows a compact "19/38" so the full notation fits. Logs that do not rebuild the live game (resumed v1 saves) are listed but not previewable
- ☰ game menu: Moves, How to Play, Recenter, Restart/Rematch (local), Quit (local, keeps save) / Resign (online)
- Piece description bar (`#piece-desc`, inside `#hud-center`; hangs below the HUD, inline on landscape phones) slides in on selection
- Hover/focus/tap piece tooltips for tray and board pieces
- Accessible How to Play dialog, reachable from the menu and in-game (`?` key)
- Keyboard: `Esc` cancel/close, `Z` undo, `C` recenter, `+`/`-` zoom, `M` sound on/off; in review `←`/`→` step, `Home`/`End`, `Space`/`K` play/pause; in the move sheet arrows move between moves
- Synthesised sound effects (`js/audio.js`, WebAudio, no asset files) synced to piece motion, plus `navigator.vibrate` haptics; one mute toggle (☰ SOUND row, main-menu corner button, `M`) persisted as `hiveMuted`
- CRT scanline + vignette overlay
- Twinkling starfield background
- Automated rule, validator, room lifecycle, net reconnect, board input/camera, audio, UI-logic and move-history replay tests
- Installable PWA: `manifest.json` (standalone, theme `#05050f`, 192/512/maskable icons), offline shell via `sw.js`, update toast with RELOAD (stacks above every screen, re-shown after transient toasts); Press Start 2P self-hosted in `assets/fonts/` (latin woff2 + OFL.txt) so the pixel font works offline after one visit
- Hidden `#win-screen` / `#resign-confirm` / `#moves-sheet` are `inert` (not in the Tab order) until opened
- Static server serves only an allowlist (`index.html`, `styles.css`, `js/`, `assets/`, PWA files)

### Known Limitations / Not Yet Built
- No AI opponent
- No persistent online rooms (room pause/resume deferred to v2); local games autosave
- No spectator mode
- Mosquito throw (mosquito adjacent to pillbug) UI not fully tested
- Online play needs the network: offline, HOST/JOIN show "OFFLINE — LOCAL PLAY ONLY" (local play, CONTINUE and the pixel font work from cache)

---

## File Structure

```
/
├── index.html          — Single page shell; all screens live here as divs
├── styles.css          — All styles; no external CSS dependencies
├── js/
│   ├── hex.js          — Pure hex math (axial coords, neighbors, pixel conversion)
│   ├── game.js         — Pure game logic (no DOM). Safe to import on the Node server (ESM)
│   ├── board.js        — Canvas renderer + pointer/touch input (Board class)
│   ├── app.js          — Application state machine, UI wiring, tray, HUD, undo, autosave; creates winFx + reviewer
│   ├── win-fx.js       — createWinFx(ctx): win sequence (impact, board dim, confetti) + result card + deferred card; pure winCopy / surroundedQueens
│   ├── review.js       — createReview(ctx): game review (preview / replay bar / autoplay) + move-list sheet; pure reviewStatusText / sheetRounds / returnLabel
│   ├── menu.js         — Main menu, settings panel, rules dialog, confirm dialog
│   ├── sprites.js      — Insect sprite path data + spriteSVG() (DOM) / drawSprite() (canvas)
│   ├── hints.js        — Pure: HUD status copy (statusText, dangerText, newDangers, resumeBanner) + last-move diff (describeLastMove, inferAction)
│   ├── notation.js     — Pure: toNotation / pieceIds / logEntry / undoLogEntry; BoardSpace-style move text and move-log entries, imports only game.js
│   ├── replay.js       — Pure: createReplay / replayForGame / sameBoard / plyInfo (player, owner, type) / movesText / notationHTML; rebuilds positions from the move log (game review), imports only game.js
│   ├── local-save.js   — Pure: encode/decode the local game + undo history + move log + clock (and a clock snapshot per undo step) for localStorage (save VERSION 3; v1 loads with an empty log, v1/v2 as clock-off games)
│   ├── clock.js        — Pure Fischer clock (injected `now`; server-importable): presets, createClock/startTurn/endTurn/remainingFor/isFlagged/pause/resume/flag, rebaseClock (server → local time), restoreClock, formatClock
│   ├── audio.js        — WebAudio synth sound effects + haptics + persisted mute (`sfx`)
│   └── net.js          — WebSocket client (see Multiplayer)
├── assets/fonts/       — press-start-2p-latin.woff2 (self-hosted, precached) + OFL.txt (its SIL OFL 1.1 licence)
├── assets/icons/       — App icons (icon.svg + PNGs), generated by `node scripts/make-icons.mjs` from the queen sprite
├── scripts/make-icons.mjs — Renders the icon set via Playwright (dev-only)
├── scripts/sw-hash.mjs — Hashes the sw.js PRECACHE files into sw-manifest.json (`npm run sw:stamp`)
├── sw-manifest.json    — Recorded CACHE name + precache content hash (checked by test/pwa.test.js)
├── server/             — see Multiplayer
└── test/               — node --test suites (rules, game, board, net, ui-logic, multiplayer, audio, history, review-winfx, offscreen, pwa, boot)
```

---

## PWA / service worker

`sw.js` precaches the shell (`PRECACHE`: `/`, `index.html`, `styles.css`, `manifest.json`, every `js/*.js`, icons, the self-hosted font) into cache `hive-vN` and serves it cache-first (query strings ignored, so `/?room=CODE` works offline). There are no third-party requests (the font is an `@font-face` in styles.css, preloaded by index.html). It never touches non-GET requests or `/ws`. A new worker waits; `app.js` shows a persistent toast with RELOAD (`pendingUpdate`: a transient `toast()` replaces it only until `clearToast()`, which re-shows the offer). RELOAD sets `reloadRequested`, posts `SKIP_WAITING` and reloads on `controllerchange` (also in the session that first installed the worker). The toast pill is `pointer-events: none`; only its button takes taps. On the main menu the offer is shown in the menu's own layout instead (`#menu-update`, between the tagline and the setup card, pushing the card down), and the floating toast with the action is hidden there, so it never covers the logo, CONTINUE or START; it floats again only while How to Play covers the menu. Other toasts over the menu dock at the bottom. While reviewing with the move sheet open it sits under the exit pill (beside it on landscape phones).

**Every deploy that changes a precached file must bump `CACHE` in `sw.js` (`hive-v4` -> `hive-v5`) and then run `npm run sw:stamp`**, which records a content hash of all `PRECACHE` files in `sw-manifest.json` (and refuses if files changed but `CACHE` did not). Text files are hashed with CRLF normalised to LF (a Windows checkout stamps the same hash); the script's main-module check is realpath-based, so it also runs through a symlinked checkout. `test/pwa.test.js` fails when the precached files no longer match the recorded hash, so a forgotten bump is caught; otherwise returning visitors keep the old files. **When adding a runtime module, add it to `PRECACHE`** (`test/pwa.test.js` fails if a module reachable from `index.html` is missing). Optional `assets/pieces/*.png` art is not precached.

## Architecture

### Separation of concerns
`game.js` has **zero DOM/canvas dependencies**. It exports pure functions that take and return state objects. This is load-bearing for Phase 2 — the Node.js server will `import` game.js directly to run authoritative validation without duplication.

`board.js` knows nothing about game rules. It receives `pieces`, `ghosts`, `throwTargets`, and `selectedHex` from `app.js` and renders them. It fires `onTap(q, r)` callbacks upward.

`app.js` is the glue layer. It owns `gameState` (a `game.js` GameState object) and `uiState` (interaction phase machine). Every action goes through `act()` → `applyAction()` (or the server) → `onStateChanged()`, which updates the renderer and last-move marker, autosaves local games, and shows the turn banner or win screen.

**app.js seams (win-fx.js, review.js).** Both modules export a factory that takes an explicit context object — getters for live state (`state()`, `mode()`, `myPlayer()`, `moveLog()`, `reason()`) plus callbacks into app.js (`syncUI`, `toast`, `clearSelection`, …) — and keep only their own state; no module-level globals touch the DOM, so their pure helpers import in node tests (`test/review-winfx.test.js`). app.js creates `winFx = createWinFx({...})` (section "Win sequence + result card") and `reviewer = createReview({...})` (section "Game review + move list sheet"); the context literal there is the full list of what each module may reach. Add new win/draw reasons to `winCopy` (it reads app's `winReason` via `reason()`), new live timers that must not fire inside a review to `holdLive()`, and new pieces of live UI that the review must hide to `reviewer.sync()`'s caller (`syncUI`).
- `winFx`: `play(move)` (slow-mo impact → card), `showCard({calm})`, `scheduleCard(ms, opts)`, `cardPending`, `presented`, `reset()` (new game/undo), `cancel()` (drop timers/touchdown/deferred), `settle()`, `openCard()`, `hide()`, `hideDim()`, `flushDeferred()` (call when something that covered the board closes), `touchdown` (board.onLand runs it), `holdResult` (get/set: HUD blank while the winning piece flies). `covered()` in its context decides deferral (☰ menu, sheet, review).
- `reviewer`: `enter(index, {returnTo})`, `exit()`, `end()`, `leaveForLive()`, `seek(i)`, `startAutoplay({hold})`, `handleKey(event)` (false when not reviewing), `openSheet()`, `closeSheet({restoreFocus})`, `sheetOpen()`, `sync()`, `active`, `shownState` (what `syncBoardRenderer` draws while reviewing).

### Canvas architecture
Two stacked canvases share the same fixed inset:
- `#board` — everything except piece glyphs (hexes, glows, ghosts, stars). `touch-action: none`
- `#emoji-layer` — piece sprites (or opt-in PNG art), `pointer-events: none`. Completely isolated 2D context to prevent animated canvas state from bleeding into glyph rendering. (The id predates the sprites.)

**Hive layer cache.** `draw()` does not repaint the hive every frame. Grid hints, tiles, stacks, the last-move marks and the static parts of ghosts go into an offscreen board layer. Glyphs and stack badges go into a separate offscreen glyph layer, so the glyph context stays isolated. The layers re-render only when `hiveLayerKey()` changes (pieces, ghosts, selection, throw pick, last move, hidden pieces), when scale or dpr changes, when a pan uncovers hive that was clipped out (`layerCovers()`), or after `invalidate()`. Each frame blits the board layer over the stars, then draws the animated overlays: loose pieces (the arrival pop and `floating`), the selection and throw-pick rings, ghost pulses and amber throw rings. The rings are pre-rendered glow sprites, so no frame uses `shadowBlur`. `#emoji-layer` is only rewritten when its layer moved or a loose piece is live. While the camera moves (recenter/reveal/pinch/wheel), the stale layer is blitted scaled for zoom ratios 0.4–2.5 and re-rendered once it settles; a piece that lands mid-camera-move is drawn loose over the old layer instead of forcing a re-render. In-flight pieces use a pre-rendered tile sprite, and `#emoji-layer` only restores the patches the live glyphs covered last frame. Landing FX (ripple, flash, sparks) are drawn additively on `#board` each frame and culled when spent. Stack badges size from `badgeLayout(r)`: full chips and a ×N pill at r ≥ 22 screen px, a compact numeral disc below that, and nothing under 9 px.

A third canvas `#confetti-layer` is `display:none` except during the win animation.

### Coordinate system
Axial coordinates `(q, r)`. Flat-top hexagons. Hex keys are `"q,r"` strings used as Map keys throughout. The direction array in `game.js` is ordered clockwise from East — **do not reorder**, the gate check math depends on index arithmetic `(di+1)%6` and `(di+5)%6`.

### Board state
`board` in GameState is `Map<string, Array<{player:1|2, type:PieceType}>>`. Each array is a stack — index 0 is bottom, last index is top. The beetle stacks. The renderer draws every layer as a stepped slab (each rises and shrinks a little, deeper ones shaded) via `stackLayers`, plus a `×N` pill and owner-rimmed sprite chips for buried pieces.

### Interaction phases
`uiState.phase` is one of:
- `'IDLE'` — nothing selected
- `'TRAY'` — tray piece selected, green ghosts show legal placements
- `'BOARD'` — on-board piece selected, green ghosts show legal moves, amber rings show pillbug throwable neighbors
- `'THROW'` — throwable neighbor tapped, green ghosts show throw destinations

---

## game.js API

```js
// Create a new game
createGame(settings) → GameState

// settings shape:
{
  expansions:     { mosquito: bool, ladybug: bool, pillbug: bool },
  tournamentRule: bool,
  clock:          { enabled: false } | { enabled: true, type: 'FISCHER', time: ms, increment: ms }  // only CLOCK_PRESETS (js/clock.js)
}

// Query legal actions
getLegalPlacements(state, pieceType) → string[]      // hex keys
getLegalMoves(state, fromKey)        → string[]      // hex keys
getLegalThrows(state)                → { pillbugHex, from, to }[]
getAllLegalActions(state)            → { placements: Map, moves: Map, throws: [], mustPass: bool }
getMoveBlocker(state, fromKey)       → null | 'EMPTY' | 'NOT_YOUR_PIECE' | 'QUEEN_NOT_PLACED'
                                       | 'JUST_THROWN' | 'ONE_HIVE' | 'NO_MOVES'   // UI explanations

// Animation route for an action (null if illegal, and always for PASS)
getMovePath(state, action)           → { path: string[], kind: 'slide'|'hop'|'climb'|'throw'|'place' } | null
                                       // path includes start+end; PLACE → [to]; THROW → [from, pillbugHex, to];
                                       // hop lists every jumped hex; spider/ladybug length 4; ant = BFS shortest slide

// Apply an action (immutable — returns new state)
applyAction(state, action) → GameState

// action shapes:
{ type: 'PLACE', pieceType, to }
{ type: 'MOVE',  from, to }
{ type: 'THROW', pillbugHex, from, to }
{ type: 'PASS' }

// Check win condition
checkWin(state) → null | 1 | 2 | 'DRAW'
positionKey(state) → string                       // board stacks (no ids) + side to move + both supplies; REPETITION_LIMIT = 3
queenPressure(state) → { 1: n|null, 2: n|null }   // occupied sides of each queen (null = not placed)
queenSides(board, isOccupied?) → [{ key, player, sides[6], lit[6] }] // per-queen side occupancy in neighbors() order — the one source for queenPressure and board queenPips

// Utilities (also exported)
isArticulationPoint(board, key) → bool
canSlide(board, fromQ, fromR, toQ, toR, fromHOverride?) → bool
hexKey(q, r) → string
parseKey(key) → { q, r }
neighbors(q, r) → { q, r }[]
```

Pieces placed via `applyAction` carry a stable `id` (`wA1`, `bQ`; `w`=P1, `b`=P2, numbered by placement order per type, Q/M/L/P unnumbered) that follows the piece through MOVE/THROW; `deserializeState` calls `stampPieceIds()` (game.js) once on load, assigning ids deterministically (sorted hex keys, bottom-to-top) to id-less pieces from old saves, so later notation never renumbers.

**Move log:** `moveLog: Array<{ notation, player, turnNumber, action }>` (`logEntry(prevState, action)` in notation.js; `action` is kept so a log can be replayed from `createGame(settings)`). Local: app.js appends on every action including automatic forced passes, `undo` drops the last move plus any forced pass after it (`undoLogEntry`), and `encodeLocalSave({settings, state, history, moveLog})` / `decodeLocalSave → {..., moveLog}` persist it (a pre-v2 save has no log: `[]`, so its log does not start at the opening). Online: the server's `room.history` is authoritative (see protocol); resign is not an entry.

**Notation markers:** the `MARKERS` table in notation.js is a deliberate fixed rotation/reflection of BoardSpace's pointy-top orientation onto this game's flat-top grid. Hive positions are invariant under rotation and reflection, so exported games replay as equivalent games elsewhere; do not "fix" the table to match one tool's orientation without changing `MARKERS` and its tests together.

**Game review (replay.js + review.js):** `createReplay(settings, actions, {index}) → { states, index, state, atEnd, step(±n), seek(i) }` (states[0] = empty board, N actions → N+1 states, clamped). `replayForGame(moveLog, liveState)` returns a replay only when re-applying the log from `createGame(liveState.settings)` reproduces the live board and turnNumber (else null — the UI shows "history unavailable"). review.js `review` state: `reviewer.enter(index, {returnTo:'game'|'board'|'card'})`, `reviewer.exit()`, `reviewer.end()` (teardown, restores the live board/lastMove and recenters). While reviewing, `syncBoardRenderer` draws the reviewed position, taps/hover/undo/pass/keys that act are ignored, nothing autosaves or is sent, and any live state change (`onStateChanged`, ROOM_RESUMED, GAME_OVER) leaves the review first. The result card and the ☰ menu/sheet defer each other via win-fx's `deferred` + `winFx.flushDeferred()`.

### GameState shape
```js
{
  board:                Map<string, Array<{player, type, id}>>,   // id e.g. 'wA1', 'bQ'
  supply:               { 1: { QUEEN: n, ... }, 2: { ... } },
  turn:                 1 | 2,
  turnNumber:           number,
  queenPlaced:          { 1: bool, 2: bool },
  lastMovedHex:         string | null,
  lastOpponentMovedHex: string | null,   // pillbug cannot throw this hex
  pillbugThrewHex:      string | null,   // this hex cannot move next turn
  winner:               null | 1 | 2 | 'DRAW',
  positionCounts:       { [positionKey]: n },   // maintained by applyAction (incl. PASS/THROW); created by createGame, rebuilt as {current: 1} for old saves
  drawReason:           null | 'REPETITION',    // set with winner 'DRAW' when a position is reached the 3rd time (a queen surround on that move wins instead)
  settings:             { expansions, tournamentRule, clock }
}
```

---

## Audio (audio.js)

```js
sfx.unlock();               // create/resume the AudioContext — app.js calls it on every pointerdown/keydown/touchend
sfx.resume();               // resume an existing suspended context only (never creates one) — app.js calls it on visibilitychange → visible
sfx.play(name, { haptic, duration }?) // no-op before unlock, while muted, for unknown names, or the same name again within 30 ms; duration (ms) holds the slide whoosh for the flight
sfx.setMuted(bool); sfx.toggle() → muted; sfx.muted   // persisted under localStorage `hiveMuted`; mutes haptics too
SOUND_NAMES                 // select deselect invalid place slide hop climb throw tick turn danger win lose draw
```

Voices are synthesised per play (oscillators + gain envelopes + filtered noise) into a bus: lowpass 8 kHz + a small convolver plate send → master gain `MASTER_GAIN` 0.35 → `softClip` WaveShaper (linear to 0.7, ceiling −1 dBFS). Per-voice `TRIM_DB` balances loudness. Do not put a DynamicsCompressor back in: Chrome ducks short transients by ~10 dB. Haptics: 12 ms for place/slide/hop/climb/throw, `[30,40,30]` danger, `[40,60,80]` win, `[30,30]` draw.

How app.js uses it: selecting a piece plays `select`; a piece with no moves plays `invalid`, and so does a disabled tray slot or a server rejection. Backing out plays `deselect`. A flying move plays its kind (`slide`/`hop`/`climb`/`throw`, with no haptic; the slide stretched to `board.flightMs()`) at departure, and `board.onLand` plays `place` with the haptic at touchdown (no haptic when the landing raises the danger alarm or the win impact). A move that does not fly (reduced motion) plays `place` straight away. `turn` plays online when it becomes your turn, after the opponent's piece lands, and locally on a forced pass. The win card plays `win`, `lose` (the online loser) or `draw`. `danger` is for the queen-danger meter.

## Sprites (sprites.js)

All eight insects (plus menu icons `HOUSE`, `SIGNAL`, `GAMEPAD` for the mode buttons, `CROWN` for the tournament toggle and `STOPWATCH` for the lost-on-time card) are SVG path data on a 64×64 grid. Pieces are top-down with the head up, except the grasshopper, ant and mosquito, which are side-on with the head left. Each has three layers drawn in order — `body` (fill = 40% ink over the dark page + ink outline), `line` (open strokes), `dot` (ink fills, `evenodd`, so a shape inside another in the same path is a hole — the ladybug's spots) — at one stroke width (`STROKE = 2.6`). Keep new art to that recipe so the set stays consistent; `pair()` mirrors left/right limbs across x = 32.

Every species has a glyph colour, `SPECIES_COLOR[type]` (mirrored as `--sp-queen` … `--sp-pillbug` in CSS): Queen `#ffd23f`, Beetle `#b07cff`, Grasshopper `#a6ff3d`, Ant `#4d8dff`, Spider `#ff7a3d`, Mosquito `#d8dcef`, Ladybug `#ff4040`, Pillbug `#2fe0a8`. Player ownership is shown by rims/frames/glow, never by recolouring the glyph.

```js
SPECIES_COLOR[type]                           → '#rrggbb'
spriteSVG(type, cls?)                         → '<svg class="sprite …" style="color:<species>">…</svg>'
                                                 // no inline colour when cls includes `mono` or type is a menu icon
drawSprite(ctx, type, x, y, size, {ink, fill, glow}) → bool  // ink = species colour; false without Path2D
bodyFill(ink)                                 → 'rgb(…)'     // opaque body fill matching the CSS (40% ink)
```

In CSS, `.p1`/`.p2`/`.p1-piece`/`.p2-piece` ancestors only add a player-colour drop-shadow to sprites; `--ink` is the colour of `mono` sprites and menu icons. Static markup can use `<span data-sprite="TYPE">` — app.js fills these at boot.

---

## Board class (board.js)

```js
const board = new Board(canvas, emojiCanvas);
board.resize(w, h);       // CSS px; backing stores scale by devicePixelRatio (capped at 2)
board.insets = { top, bottom }; // px covered by HUD / tray — recenter fits the hive between them
board.recenter(animate);  // fit the whole hive (or origin) into view
board.zoomBy(ratio);      // keyboard / button zoom around the playable center
board.markArrival(key);   // pop-in animation for a piece that just arrived
board.reveal(keys, context?, { anchor }?); // animated minimal pan (zoom-out only if needed, floored at REVEAL_MIN_TILE_PX / the user's own zoom) to show keys; frames anchor + nearest keys when they can't all fit; also fits context when it all fits; no-op while the user pans
board.flightMs();          // tween duration (ms) of the running flight, 0 when idle
board.animateMove({ path, kind, piece?, player?, toKey?, speed? }) → Promise // fly the top piece of toKey along a getMovePath route, then landing FX; speed < 1 = slow motion (win)
board.shockwave(keys);    // win: white flash, expanding hex rings, sparks and a camera punch from each queen key
board.finishAnimations({ clearFx? }); // snap running flights home (act/undo/new GAME_STATE); clearFx also drops sparks/ripples/nudge/shockwaves
board.reducedMotion       // true → animateMove/markArrival/recenter/reveal/showTargets are instant, no FX, no shockwave
board.showTargets(keys, context?, opts?); // reveal() on the player's request (an off-screen chevron): runs even right after a user pan
// Off-screen target chevrons: a live overlay, never in the cached layer. Each frame (after drawing) the board
// computes offscreenTargets() for ghosts + throwTargets from the camera (none while the camera animates) and calls
// onIndicators(list) only when the list changes; app.js renders them as buttons in #edge-hints.
board.onIndicators = list => {};  // list = offscreenTargets() result (screen px)
board.indicators                  // the last list passed to onIndicators (buttons index into it)
board.overlayInsets               // { top, bottom, cornerBR? } | null — chevron area when more chrome covers the board
                                  // (app.js: piece bar under the HUD, recenter button keep-out); null = insets
// Queen danger pips are drawn every frame as a live overlay (never in the cached layer).
board.draw(t);            // call every RAF frame with DOMHighResTimeStamp

// Pure helper (exported): stack geometry, bottom first. Top layer scale ≥ 0.8, shade 0.
stackLayers(height, size) → [{ dx, dy, scale, shade }]
queenPips(pieces, hidden?) → [{ key, player, count, lit[6], dirs[6], height }] // danger-meter geometry (counts via game.js queenSides); hexes in `hidden` (in flight) don't count yet
pipPulse(count, t, reducedMotion?) → 0..1    // pip pulse; steady under reduced motion
REVEAL_MIN_TILE_PX, PIP_DIST                 // reveal zoom floor (17 px tile radius); pip centre 0.72 × face radius
offscreenTargets(points, rect, { inset, gap, corner, slack, cornerBR }?) → [{ edge, x, y, angle, count, keys, kind }]
  // points [{key, x, y, kind:'ghost'|'throw'}] in screen px; rect = playable area. Edge = where a ray from the rect
  // centre exits; chevron level with the targets along that edge (OFFSCREEN_INSET px in, clear of corners); targets
  // within `slack` px of the rect count as visible; clusters split when > max(gap, 30% of the edge) apart
winTiming(kind, steps, { reducedMotion }?) → { flightMs, landMs, cardMs }      // win-sequence timeline; cardMs ≤ WIN_REVEAL_MAX_MS (1600)

// Written by app.js each frame/action:
board.pieces        // Map<hexKey, Array<{player, type, emoji, image?}>> — full stacks (emoji is the no-Path2D fallback)
board.ghosts        // Set<hexKey>  — green placement/move highlights
board.throwTargets  // Set<hexKey>  — amber pillbug-throw highlights
board.selectedHex   // string|null  — white pulsing selection ring
board.throwPick     // string|null  — piece picked for a pillbug throw (lifted, bright ring)
board.lastMove      // {from, to, player}|null — last-move marker
board.hiddenTop     // Set<hexKey> — top piece left out of the cached layer (in flight)
board.floating      // [{piece, x, y, lift?, scale?, sx?, sy?, alpha?}] — pieces drawn live in board space

// Pure helpers (exported): tweenPoint(points, t, kind) → {x, y, lift 0..1}; moveDuration(kind, steps) (ms, ~120/hex,
// tween + LAND_MS settle ≤ 700)
board.invalidate(); // force the cached hive layer to re-render next frame

// Input callbacks (set by app.js):
board.onTap = (q, r, clientX, clientY) => {}  // clean single-pointer tap (never fired after a pinch)
board.onHover = (q, r, clientX, clientY) => {} // mouse hover; (null) when leaving
board.onViewChange = () => {}                  // user panned or zoomed
board.onLand = (kind, player) => {}            // an animateMove flight touched down (landing FX frame); not fired on finishAnimations snaps
```

---

## CSS Variables

```css
--bg:        #05050f   /* near-black page background */
--p1:        #ff2d78   /* player 1 neon magenta */
--p1-dim:    rgba(255,45,120,.15)
--p1-mid:    rgba(255,45,120,.35)
--p2:        #00f5ff   /* player 2 electric cyan */
--p2-dim:    rgba(0,245,255,.12)
--p2-mid:    rgba(0,245,255,.30)
--ghost:     #39ff14   /* acid green for placement targets */
--gold:      #ffd700   /* UI accents, win screen, start button */
--ui-border: rgba(255,255,255,.10)
--ui-text:   rgba(255,255,255,.55)
--amber:     #ffb300   /* pillbug throw targets, warnings */
--sp-queen … --sp-pillbug  /* species glyph colours = SPECIES_COLOR */
--danger:    #ff4d5e
--hud-h:     52px      /* plus safe-area inset */
--tray-h:    108px     /* reserve strip + piece row; plus safe-area inset */
--radius:    12px
--font:      'Press Start 2P', monospace
```

Buttons share `.btn` + `.btn-primary | .btn-ghost | .btn-danger | .btn-small`; icons are inline SVG `.icon`.
`.mini-tile` is a small bevelled hex tile that matches the board tiles. Its rim takes the `--rim` colour and its width comes from `--rim-w`. It is used by the stack inspector chips, the How to Play piece guide and the win emblem.

### User-applied CSS overrides (do not revert)
- `.toggle-pill` font-size: 6px
- `.toggle-label` font-size: 8px
- `.settings-label` font-size: 12px, display: flex, justify-content: center
- `#status-text` font-size: 8px
- `#piece-desc` font-size: 8px

---

## Screen / UI Layers (z-index)

| z-index | Element | Notes |
|---|---|---|
| 1 | `#board` canvas | Main render surface |
| 2 | `#emoji-layer` canvas | Isolated emoji rendering |
| 3 | `#board-dim` | Win-sequence dim with a spotlight on the fallen queen, pointer-events: none |
| 15 | `#edge-hints` | Off-screen target chevrons (focusable buttons, pointer-events: none — taps are hit-tested in board.onTap) |
| 18 | `#board-hint`, `#btn-recenter` | First-run hint, floating recenter button |
| 20 | `#piece-desc` | Inside `#hud` (its stacking context); hangs below it, inline on landscape phones |
| 20 | `#hud`, `#tray` | Game chrome; hidden until game starts |
| 25 | `#turn-banner` | Non-blocking turn announcement, pointer-events: none |
| 20–21 | `#replay-bar`, `#review-pill` | Review controls (replace the tray) and exit pill |
| 30 | `#game-menu` | ☰ popover |
| 45 | `#moves-sheet` | Move list sheet (opaque footer); other body children `inert` while open |
| 50 | `#crt` | Scanline overlay, pointer-events: none |
| 60 | `#piece-tooltip` | Piece tooltip / stack inspector |
| 95 | `#win-screen` | Result card: rematch / view board / menu |
| 96 | `#confetti-layer` | Win animation above the card (crisp, not under its blur), pointer-events: none |
| 97 | `#resign-confirm` | Generic confirm dialog (`showConfirm` in menu.js) |
| 98 | `#menu-screen` | Main menu |
| 99 | `#rules-overlay` | How to Play; `inert` while closed, makes everything else except `#toast` `inert` while open |
| 100 | `#toast` | Notices (undo, reconnect, errors) and the update RELOAD offer. Above every screen; moves under the HUD while the move sheet is open |

HUD, tray and recenter button are toggled via `.game-visible` class (opacity + pointer-events).

---

## Multiplayer Networking

### Stack
- **Server:** Node.js built-in HTTP server + `ws`
- **Transport:** WebSocket, server-authoritative
- **Room codes:** 4 chars from `BCDFGHJKLMNPQRSTVWXYZ23456789` (no vowels, no ambiguous chars)
- **State:** In-memory per room. No database needed for v1.

### Files
```
/server/
  index.js        — Process entry (`npm start`): parses port / PORT / --port, listens
  server.js       — Static HTTP + ws game server, room lifecycle; exports createHiveServer(), never auto-starts
  rooms.js        — Room map, code generation, join/leave, idle cleanup
  validator.js    — Thin wrapper: import game.js, run server-side checks (+ resolveResign)
  static.js       — URL → file allowlist for the static server

/js/
  net.js          — WebSocket client wrapper, reconnect logic, message queue
```

### WebSocket message protocol
```
CLIENT → SERVER:
  CREATE_ROOM { settings }
  JOIN_ROOM   { code }
  RESUME_ROOM { code, token }
  PLACE_PIECE { pieceType, to }
  MOVE_PIECE  { from, to }
  THROW_PIECE { pillbugHex, from, to }
  PASS_TURN   {}
  RESIGN      {}

SERVER → CLIENT:
  ROOM_CREATED        { code, player, token }
  ROOM_RESUMED        { code, player, token, gameState, settings, endReason?, history, clock?, serverNow? }  — endReason 'QUEEN'|'RESIGN'|'DRAW'|'REPETITION'|'TIMEOUT' if finished
  PLAYER_ASSIGNMENT   { player, token }
  GAME_START          { gameState, settings, history: [], clock?, serverNow? }
  GAME_STATE          { gameState, history, clock?, serverNow? }  — after every valid action; history = full move log so far
                        (entries { notation, player, turnNumber, action }, PASS included, appended server-side)
  INVALID_MOVE        { reason }
  ERROR               { reason }              — e.g. INVALID_MESSAGE; SEAT_TAKEN (+ close code 4001) when a newer
                                                connection resumed your seat: net.js does not reconnect, the app
                                                shows GAME OPENED IN ANOTHER TAB and keeps the saved token
  GAME_OVER           { winner, reason, clock?, serverNow? } — reason 'QUEEN'|'RESIGN'|'DRAW'|'REPETITION'|'TIMEOUT'  (REPETITION = automatic threefold draw; TIMEOUT = the side to move's clock ran out, carries the final clock)

  clock (timed rooms only) = js/clock.js clock in server time; clients rebaseClock(clock, serverNow, Date.now()).
  Body built by server.js roomSnapshot(room) (GAME_START / ROOM_RESUMED; reusable for any full-state message) / stateFields (GAME_STATE).
  OPPONENT_DISCONNECTED {}
  OPPONENT_RECONNECTED  {}
  ROOM_CLOSED         {}                      — room expired or was closed; the server then closes the socket
  WAITING_FOR_OPPONENT {}
```

### Client behavior
`app.js` uses a mode flag (`'LOCAL'` vs `'ONLINE'`). All actions go through `act()`: online they are sent via `net.js` and the server broadcasts canonical state; locally they are applied and pushed onto the undo history. A player with no legal action gets an explicit PASS control online. `net.on()` keeps one handler per message type — menu.js registers the pre-game handlers and app.js (`initNetHandlers`) replaces them at game start. Fatal in-game `ERROR`s (room gone, seat invalid) return to the menu with a notice. `net.js` ignores events from superseded sockets and cancels pending reconnect timers on `disconnect()`.

### Reconnection
The server pings every 30 s and terminates silent sockets; `RESUME_ROOM` with a valid token replaces a still-open old socket (no `SEAT_OCCUPIED`). A seated socket sending CREATE/JOIN gets `ERROR ALREADY_IN_ROOM`. `server.js` exports `createHiveServer()` and never listens by itself; `server/index.js` is the entry point (a "run directly" guard in server.js silently exited 0 through symlinked paths).
Room code and player token are stored in `localStorage`. If the socket drops, `RESUME_ROOM` reclaims the reserved seat and returns the authoritative state; the client then shows RECONNECTED and the turn banner (`resumeBanner`: YOUR TURN / OPPONENT'S TURN / NO MOVES — TAP PASS; none if the game is over or a review is open). Persistence across a server restart is not supported.

### Game clock (server)
`normalizeSettings` (exported) accepts only the clock presets. The room's clock starts when GAME_START is sent; each valid action applies `endTurn` (client clock values are never read) and re-arms `room.clockTimer` for the side to move; it keeps running while a player is disconnected. On expiry (or any action or RESIGN arriving after the deadline, before the timer ran) → `GAME_OVER {reason:'TIMEOUT'}`, `endReason 'TIMEOUT'`. Win / resign stop it; room cleanup clears the timer. While a timed game runs, `touchActivity` (rooms.js) keeps the idle deadline at ≥ the side to move's remaining time + `CLOCK_GRACE` (60 s), so a 30+0 turn or banked increments flag instead of being idle-closed. Test hook: `createHiveServer({ clockOverride: { time, increment } })` swaps an enabled preset's numbers for short ones (never set by `server/index.js`).

### Room lifecycle
- Rooms expire after 30 minutes of inactivity
- A room with one player waits up to 10 minutes (absolute from creation; resuming does not extend it) for the second to join
- WebSocket frames are capped at 64 KB; non-JSON frames get ERROR INVALID_MESSAGE

---

## Planned Features (Backlog)

### v1.1
- [x] Clock/timer — Fischer presets (`js/clock.js`, HUD player plates, server-authoritative online)
- [ ] Spectator mode — broadcast game state to extra room sockets read-only
- [x] PWA install — `sw.js` + `manifest.json`

### v2
- [ ] Persistent rooms — pause/resume games across sessions (Litestream JSON)
- [x] Move history panel — move list sheet, preview and replay
- [ ] AI opponent — minimax or MCTS; start with random-legal-move bot for testing

### Polish
- [x] SVG insect sprites (default); optional PNG piece icons via `?pieceArt=png`
- [x] Sound effects (place, move, win) + haptics — `js/audio.js`
- [x] Animated piece placement (drop-in with squash) and move animation
- [ ] Board coordinate hints (toggle)
- [x] Settings persistence via localStorage

---

## Known Bugs / Edge Cases to Watch

- **Mosquito-as-pillbug throw UI** — the throw flow works logically but the mosquito's amber highlight only appears if `getLegalThrows` finds it adjacent to a pillbug. Needs testing with real game positions.
- **Beetle gate check** — `canSlide` blocks a move only when both gate stacks reach `max(fromH, toH + 1)` (fromH includes the moving piece). A ground beetle can climb onto a piece between two single pieces; two height-2 stacks block it. Pillbug throws apply the same rule to the lift and the drop. Ground-to-ground slides into an empty hex additionally require at least one occupied gate (hive contact); the ladybug applies `canSlide` at each step using its level (stack height + 1).
- **Spider backtrack prevention** — DFS uses a visited set per path, correctly prevents revisiting. However the spider cannot end on its starting hex even if 3 steps would bring it back; this is enforced but worth an explicit test.
- **Draw by repetition** — automatic threefold draw (`positionKey` / `positionCounts` / `drawReason`). The key ignores piece ids and the pillbug throw restrictions (`lastOpponentMovedHex`, `pillbugThrewHex`), so two positions that differ only in those still count as the same.
