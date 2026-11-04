# HIVE PWA — Claude Code Project Reference

A browser-based implementation of the Hive board game (© Gen42 Games). Two-player abstract strategy. No build step, no framework — vanilla HTML/CSS/ES modules. Designed as a PWA installable on mobile or desktop.

Run with `npm start` (port 3000), `npm start -- 3001`, or `npm start -- --port 3001`. The `PORT` environment variable is also supported.

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
- Win/draw detection
- Must-pass turn handling (auto-pass banner locally; explicit PASS button online; mutual no-move = draw locally)
- Pan and pinch-zoom on the board canvas
- Per-player piece tray with legal-placement gating
- Green ghost hexes for legal placements/moves
- Amber ring highlights for pillbug-throwable pieces
- Two-phase throw UI (select piece → select destination)
- Neon line-art SVG insect sprites for every piece (`js/sprites.js`), shared by the canvas board and all DOM UI
- Beetle stack pyramid rendering with sprite badges for buried pieces
- Stack inspector: hover (desktop) or tap an opponent stack to list every piece top→bottom
- Non-blocking turn banner between turns (replaced the full-screen interstitial)
- Last-move marker (gold corner ticks on the destination, dashed outline on the source)
- HiDPI canvas rendering, animated recenter/fit (⌖ button, `C` key), piece pop-in animation
- Status line explains why a selected piece can't move (`getMoveBlocker` + `js/hints.js`)
- Local undo (↶ button, `Z` key) and autosave/resume of the local game (CONTINUE GAME on the menu)
- Opponent reserve strip above the tray; online tray always shows your own pieces
- Win screen with reason, bug emoji confetti, Rematch (local) / View Board / Main Menu
- Settings (expansions, tournament rule) remembered in localStorage
- Room share: COPY CODE + SHARE/COPY LINK; `?room=CODE` opens JOIN with the code filled in
- Main menu with mode selection, expansion toggles, tournament rule toggle
- Server-authoritative online multiplayer with room codes
- Token-based seat recovery after transient disconnects
- Responsive refined-neon UI with reduced-motion and focus-visible support
- ☰ game menu: How to Play, Recenter, Restart/Rematch (local), Quit (local, keeps save) / Resign (online)
- Piece description bar in HUD (slides in on selection)
- Hover/focus/tap piece tooltips for tray and board pieces
- Accessible How to Play dialog, reachable from the menu and in-game (`?` key)
- Keyboard: `Esc` cancel/close, `Z` undo, `C` recenter, `+`/`-` zoom
- CRT scanline + vignette overlay
- Twinkling starfield background
- Automated rule, validator, room lifecycle, net reconnect, board input/camera, and UI-logic tests
- Static server serves only an allowlist (`index.html`, `styles.css`, `js/`, `assets/`, PWA files)

### Known Limitations / Not Yet Built
- No clock/timer (designed in settings, not implemented)
- No AI opponent
- No persistent online rooms (room pause/resume deferred to v2); local games autosave
- `assets/pieces/queen.png` and `spider.png` are missing (`?pieceArt=png` falls back to emoji for those)
- No spectator mode
- Mosquito throw (mosquito adjacent to pillbug) UI not fully tested
- `sw.js` and `manifest.json` not yet created (PWA install not functional)

---

## File Structure

```
/
├── index.html          — Single page shell; all screens live here as divs
├── styles.css          — All styles; no external CSS dependencies
├── js/
│   ├── hex.js          — Pure hex math (axial coords, neighbors, pixel conversion)
│   ├── game.js         — Pure game logic (no DOM). Safe to require() on Node server
│   ├── board.js        — Canvas renderer + pointer/touch input (Board class)
│   ├── app.js          — Application state machine, UI wiring, tray, HUD, undo, autosave
│   ├── menu.js         — Main menu, settings panel, rules dialog, confirm dialog
│   ├── sprites.js      — Insect sprite path data + spriteSVG() (DOM) / drawSprite() (canvas)
│   ├── hints.js        — Pure: HUD status copy (statusText) + last-move diff (describeLastMove)
│   ├── local-save.js   — Pure: encode/decode the local game + undo history for localStorage
│   └── net.js          — WebSocket client (see Multiplayer)
├── server/             — see Multiplayer
└── test/               — node --test suites (rules, game, board, net, ui-logic, multiplayer)
```

---

## Architecture

### Separation of concerns
`game.js` has **zero DOM/canvas dependencies**. It exports pure functions that take and return state objects. This is load-bearing for Phase 2 — the Node.js server will `import` game.js directly to run authoritative validation without duplication.

`board.js` knows nothing about game rules. It receives `pieces`, `ghosts`, `throwTargets`, and `selectedHex` from `app.js` and renders them. It fires `onTap(q, r)` callbacks upward.

`app.js` is the glue layer. It owns `gameState` (a `game.js` GameState object) and `uiState` (interaction phase machine). Every action goes through `act()` → `applyAction()` (or the server) → `onStateChanged()`, which updates the renderer and last-move marker, autosaves local games, and shows the turn banner or win screen.

### Canvas architecture
Two stacked canvases share the same fixed inset:
- `#board` — everything except piece glyphs (hexes, glows, ghosts, stars). `touch-action: none`
- `#emoji-layer` — piece sprites (or opt-in PNG art), `pointer-events: none`. Completely isolated 2D context to prevent animated canvas state from bleeding into glyph rendering. (The id predates the sprites.)

A third canvas `#confetti-layer` is `display:none` except during the win animation.

### Coordinate system
Axial coordinates `(q, r)`. Flat-top hexagons. Hex keys are `"q,r"` strings used as Map keys throughout. The direction array in `game.js` is ordered clockwise from East — **do not reorder**, the gate check math depends on index arithmetic `(di+1)%6` and `(di+5)%6`.

### Board state
`board` in GameState is `Map<string, Array<{player:1|2, type:PieceType}>>`. Each array is a stack — index 0 is bottom, last index is top. The beetle stacks. The renderer draws all layers as a pyramid (bottom=full size, top=65% scaled) with badge emoji for buried pieces.

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
  clock:          { enabled: bool, type: 'ABSOLUTE'|'FISCHER'|'BRONSTEIN', time: number, increment: number }
}

// Query legal actions
getLegalPlacements(state, pieceType) → string[]      // hex keys
getLegalMoves(state, fromKey)        → string[]      // hex keys
getLegalThrows(state)                → { pillbugHex, from, to }[]
getAllLegalActions(state)            → { placements: Map, moves: Map, throws: [], mustPass: bool }
getMoveBlocker(state, fromKey)       → null | 'EMPTY' | 'NOT_YOUR_PIECE' | 'QUEEN_NOT_PLACED'
                                       | 'JUST_THROWN' | 'ONE_HIVE' | 'NO_MOVES'   // UI explanations

// Apply an action (immutable — returns new state)
applyAction(state, action) → GameState

// action shapes:
{ type: 'PLACE', pieceType, to }
{ type: 'MOVE',  from, to }
{ type: 'THROW', pillbugHex, from, to }
{ type: 'PASS' }

// Check win condition
checkWin(state) → null | 1 | 2 | 'DRAW'

// Utilities (also exported)
isArticulationPoint(board, key) → bool
canSlide(board, fromQ, fromR, toQ, toR, fromHOverride?) → bool
hexKey(q, r) → string
parseKey(key) → { q, r }
neighbors(q, r) → { q, r }[]
```

### GameState shape
```js
{
  board:                Map<string, Array<{player, type}>>,
  supply:               { 1: { QUEEN: n, ... }, 2: { ... } },
  turn:                 1 | 2,
  turnNumber:           number,
  queenPlaced:          { 1: bool, 2: bool },
  lastMovedHex:         string | null,
  lastOpponentMovedHex: string | null,   // pillbug cannot throw this hex
  pillbugThrewHex:      string | null,   // this hex cannot move next turn
  winner:               null | 1 | 2 | 'DRAW',
  settings:             { expansions, tournamentRule, clock }
}
```

---

## Sprites (sprites.js)

All eight insects (plus menu icons `HOUSE`, `SIGNAL`, `GAMEPAD` for the mode buttons and `CROWN` for the tournament toggle) are SVG path data on a 64×64 grid, top-down, head up. Each has three layers drawn in order — `body` (dark tinted fill + ink outline), `line` (open strokes), `dot` (ink fills) — at one stroke width (`STROKE = 2.6`). Keep new art to that recipe so the set stays consistent; `pair()` mirrors left/right limbs across x = 32.

```js
spriteSVG(type, cls?)                         → '<svg class="sprite …">…</svg>'  // colour via CSS `color`
drawSprite(ctx, type, x, y, size, {ink, fill, glow}) → bool                       // false without Path2D
```

In CSS, `.p1`/`.p2`/`.p1-piece`/`.p2-piece` ancestors tint sprites with `--p1-ink`/`--p2-ink` plus a neon drop-shadow; `--ink` is the neutral colour. Static markup can use `<span data-sprite="TYPE">` — app.js fills these at boot.

---

## Board class (board.js)

```js
const board = new Board(canvas, emojiCanvas);
board.resize(w, h);       // CSS px; backing stores scale by devicePixelRatio (capped at 2)
board.insets = { top, bottom }; // px covered by HUD / tray — recenter fits the hive between them
board.recenter(animate);  // fit the whole hive (or origin) into view
board.ensureHiveVisible();// recenter only if a piece drifted off-screen
board.zoomBy(ratio);      // keyboard / button zoom around the playable center
board.markArrival(key);   // pop-in animation for a piece that just arrived
board.draw(t);            // call every RAF frame with DOMHighResTimeStamp

// Written by app.js each frame/action:
board.pieces        // Map<hexKey, Array<{player, type, emoji, image?}>> — full stacks (emoji is the no-Path2D fallback)
board.ghosts        // Set<hexKey>  — green placement/move highlights
board.throwTargets  // Set<hexKey>  — amber pillbug-throw highlights
board.selectedHex   // string|null  — white pulsing selection ring
board.lastMove      // {from, to, player}|null — last-move marker

// Input callbacks (set by app.js):
board.onTap = (q, r, clientX, clientY) => {}  // clean single-pointer tap (never fired after a pinch)
board.onHover = (q, r, clientX, clientY) => {} // mouse hover; (null) when leaving
board.onViewChange = () => {}                  // user panned or zoomed
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
--danger:    #ff4d5e
--hud-h:     52px      /* plus safe-area inset */
--tray-h:    108px     /* reserve strip + piece row; plus safe-area inset */
--radius:    12px
--font:      'Press Start 2P', monospace
```

Buttons share `.btn` + `.btn-primary | .btn-ghost | .btn-danger | .btn-small`; icons are inline SVG `.icon`.

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
| 18 | `#board-hint`, `#btn-recenter` | First-run hint, floating recenter button |
| 19 | `#piece-desc` | Slides in below HUD |
| 20 | `#hud`, `#tray` | Game chrome; hidden until game starts |
| 25 | `#turn-banner` | Non-blocking turn announcement, pointer-events: none |
| 30 | `#game-menu` | ☰ popover |
| 50 | `#crt` | Scanline overlay, pointer-events: none |
| 60 | `#piece-tooltip` | Piece tooltip / stack inspector |
| 70 | `#toast` | Transient notices (undo, reconnect, errors) |
| 95 | `#confetti-layer` | Win animation, pointer-events: none |
| 96 | `#win-screen` | Result card: rematch / view board / menu |
| 97 | `#resign-confirm` | Generic confirm dialog (`showConfirm` in menu.js) |
| 98 | `#menu-screen` | Main menu |
| 99 | `#rules-overlay` | How to Play; makes everything else `inert` while open |

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
  server.js       — Static HTTP + ws game server, room lifecycle
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
  ROOM_RESUMED        { code, player, token, gameState, settings }
  PLAYER_ASSIGNMENT   { player, token }
  GAME_START          { gameState, settings }
  GAME_STATE          { gameState }           — after every valid action
  INVALID_MOVE        { reason }
  GAME_OVER           { winner }
  OPPONENT_DISCONNECTED {}
  OPPONENT_RECONNECTED  {}
  WAITING_FOR_OPPONENT {}
```

### Client behavior
`app.js` uses a mode flag (`'LOCAL'` vs `'ONLINE'`). All actions go through `act()`: online they are sent via `net.js` and the server broadcasts canonical state; locally they are applied and pushed onto the undo history. A player with no legal action gets an explicit PASS control online. `net.on()` keeps one handler per message type — menu.js registers the pre-game handlers and app.js (`initNetHandlers`) replaces them at game start. Fatal in-game `ERROR`s (room gone, seat invalid) return to the menu with a notice. `net.js` ignores events from superseded sockets and cancels pending reconnect timers on `disconnect()`.

### Reconnection
Room code and player token are stored in `localStorage`. If the socket drops, `RESUME_ROOM` reclaims the reserved seat and returns the authoritative state. Persistence across a server restart is not supported.

### Room lifecycle
- Rooms expire after 30 minutes of inactivity
- A room with one player waits up to 10 minutes for the second to join

---

## Planned Features (Backlog)

### v1.1
- [ ] Clock/timer (Absolute, Fischer, Bronstein) — UI already in settings, needs `clock.js` and HUD display
- [ ] Spectator mode — broadcast game state to extra room sockets read-only
- [ ] PWA install — wire up `sw.js` (service worker) and `manifest.json`

### v2
- [ ] Persistent rooms — pause/resume games across sessions (Litestream JSON)
- [ ] Move history panel — log of moves with undo for local play
- [ ] AI opponent — minimax or MCTS; start with random-legal-move bot for testing

### Polish
- [x] SVG insect sprites (default); optional PNG piece icons via `?pieceArt=png`
- [ ] Sound effects (place, move, win)
- [ ] Animated piece placement (scale-in pop)
- [ ] Board coordinate hints (toggle)
- [ ] Settings persistence via localStorage

---

## Known Bugs / Edge Cases to Watch

- **Mosquito-as-pillbug throw UI** — the throw flow works logically but the mosquito's amber highlight only appears if `getLegalThrows` finds it adjacent to a pillbug. Needs testing with real game positions.
- **Beetle gate check** — `canSlide` blocks a move only when both gate stacks reach `max(fromH, toH + 1)` (fromH includes the moving piece). A ground beetle can climb onto a piece between two single pieces; two height-2 stacks block it. Pillbug throws apply the same rule to the lift and the drop.
- **Spider backtrack prevention** — DFS uses a visited set per path, correctly prevents revisiting. However the spider cannot end on its starting hex even if 3 steps would bring it back; this is enforced but worth an explicit test.
- **Draw by repetition** — not implemented. Official rules allow agreeing to a draw if both players are stuck in a forced repetition loop. Low priority.
