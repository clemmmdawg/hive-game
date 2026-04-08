# HIVE PWA — Claude Code Project Reference

A browser-based implementation of the Hive board game (© Gen42 Games). Two-player abstract strategy. No build step, no framework — vanilla HTML/CSS/ES modules. Designed as a PWA installable on mobile or desktop.

---

## Current State

### What Works
- Full pass-and-play local multiplayer
- Complete base game rules (Queen, Beetle, Ant, Spider, Grasshopper)
- All three expansion pieces (Mosquito, Ladybug, Pillbug) including throw mechanic
- One Hive Rule (articulation point detection via BFS)
- Freedom to Move / gate check (height-aware for beetle stacks)
- Forced queen placement by turn 4
- Tournament opening rule (optional toggle)
- Win/draw detection
- Must-pass turn handling (automatic with interstitial)
- Pan and pinch-zoom on the board canvas
- Per-player piece tray with legal-placement gating
- Green ghost hexes for legal placements/moves
- Amber ring highlights for pillbug-throwable pieces
- Two-phase throw UI (select piece → select destination)
- Beetle stack pyramid rendering with badge emoji for buried pieces
- Pass-and-play interstitial screen between turns
- Win screen with bug emoji confetti, Play Again + Main Menu buttons
- Main menu with mode selection, expansion toggles, tournament rule toggle
- Host/Join buttons (visible but disabled, "SOON" badge)
- Resign/quit button in HUD with confirmation overlay
- Piece description bar in HUD (slides in on selection)
- CRT scanline + vignette overlay
- Twinkling starfield background
- PWA manifest + service worker stubs (not yet wired)

### Known Limitations / Not Yet Built
- No networking (Phase 2)
- No clock/timer (designed in settings, not implemented)
- No AI opponent
- No persistent game state (room pause/resume deferred to v2)
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
│   ├── app.js          — Application state machine, UI wiring, tray, HUD
│   └── menu.js         — Main menu, settings panel, resign confirm overlay
```

---

## Architecture

### Separation of concerns
`game.js` has **zero DOM/canvas dependencies**. It exports pure functions that take and return state objects. This is load-bearing for Phase 2 — the Node.js server will `import` game.js directly to run authoritative validation without duplication.

`board.js` knows nothing about game rules. It receives `pieces`, `ghosts`, `throwTargets`, and `selectedHex` from `app.js` and renders them. It fires `onTap(q, r)` callbacks upward.

`app.js` is the glue layer. It owns `gameState` (a `game.js` GameState object) and `uiState` (interaction phase machine). After every user action it calls `applyAction()` → updates the board renderer → triggers interstitial or win screen.

### Canvas architecture
Two stacked canvases share the same fixed inset:
- `#board` — everything except emoji (hexes, glows, ghosts, stars). `touch-action: none`
- `#emoji-layer` — emoji only, `pointer-events: none`. Completely isolated 2D context to prevent animated `fillStyle` alpha from the board canvas bleeding into emoji rendering (a real browser bug we fixed)

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

## Board class (board.js)

```js
const board = new Board(canvas, emojiCanvas);
board.init();           // center viewport; call after setting canvas dimensions
board.resize(w, h);     // call on window resize
board.draw(t);          // call every RAF frame with DOMHighResTimeStamp

// Written by app.js each frame/action:
board.pieces        // Map<hexKey, Array<{player, type, emoji}>>  — full stacks
board.ghosts        // Set<hexKey>  — green placement/move highlights
board.throwTargets  // Set<hexKey>  — amber pillbug-throw highlights
board.selectedHex   // string|null  — white pulsing selection ring

// Input callback (set by app.js):
board.onTap = (q, r) => { /* handle tap in hex coords */ }
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
--hud-h:     52px
--tray-h:    96px
--font:      'Press Start 2P', monospace
```

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
| 19 | `#piece-desc` | Slides in below HUD |
| 20 | `#hud`, `#tray` | Game chrome; hidden until game starts |
| 50 | `#crt` | Scanline overlay, pointer-events: none |
| 90 | `#interstitial` | Pass-and-play turn screen |
| 95 | `#confetti-layer` | Win animation, pointer-events: none |
| 96 | `#win-screen` | Win screen with play again / menu buttons |
| 97 | `#resign-confirm` | Quit confirmation overlay |
| 98 | `#menu-screen` | Main menu |

HUD and tray are toggled via `.game-visible` class (opacity + pointer-events).

---

## Phase 2 — Multiplayer Networking Plan

### Stack
- **Server:** Node.js + `ws` (WebSocket) + `express` (static serve)
- **Transport:** WebSocket, server-authoritative
- **Room codes:** 4 chars from `BCDFGHJKLMNPQRSTVWXYZ23456789` (no vowels, no ambiguous chars)
- **State:** In-memory per room. No database needed for v1.

### Files to add
```
/server/
  server.js       — Express static + ws game server, room lifecycle
  rooms.js        — Room map, code generation, join/leave, idle cleanup
  validator.js    — Thin wrapper: import game.js, run server-side checks

/js/
  net.js          — WebSocket client wrapper, reconnect logic, message queue
```

### WebSocket message protocol
```
CLIENT → SERVER:
  JOIN_ROOM   { code }
  PLACE_PIECE { pieceType, to }
  MOVE_PIECE  { from, to }
  THROW_PIECE { pillbugHex, from, to }
  PASS_TURN   {}
  RESIGN      {}

SERVER → CLIENT:
  ROOM_JOINED         { code, player, gameState }
  GAME_START          { gameState, settings }
  GAME_STATE          { gameState }           — after every valid action
  INVALID_MOVE        { reason }
  GAME_OVER           { winner }
  OPPONENT_DISCONNECTED {}
  WAITING_FOR_OPPONENT {}
```

### app.js changes for online mode
`app.js` gets a `mode` flag (`'LOCAL'` vs `'ONLINE'`). In online mode, actions are sent through `net.js` instead of applied locally. The server broadcasts the new canonical `gameState` to both clients. The board renderer and tray are already decoupled from the game logic, so they need no changes.

### Reconnection
On game start, store a `playerToken` (random UUID) in `localStorage`. If the socket drops, reconnect and send the token to reclaim the seat.

### Room lifecycle
- Rooms expire after 30 minutes of inactivity
- A room with one player waits up to 10 minutes for the second to join
- Spectators (optional): any additional socket beyond 2 players receives `GAME_STATE` updates read-only

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
- [ ] Custom SVG/PNG piece icons (emoji are placeholders)
- [ ] Sound effects (place, move, win)
- [ ] Animated piece placement (scale-in pop)
- [ ] Board coordinate hints (toggle)
- [ ] Settings persistence via localStorage

---

## Known Bugs / Edge Cases to Watch

- **Mosquito-as-pillbug throw UI** — the throw flow works logically but the mosquito's amber highlight only appears if `getLegalThrows` finds it adjacent to a pillbug. Needs testing with real game positions.
- **Beetle on top of a stack gate check** — `canSlide` uses stack heights; a beetle moving laterally between two height-2 stacks requires height-2 gates to block it. This is correct per rules but visually confusing; worth a UI hint.
- **Spider backtrack prevention** — DFS uses a visited set per path, correctly prevents revisiting. However the spider cannot end on its starting hex even if 3 steps would bring it back; this is enforced but worth an explicit test.
- **Draw by repetition** — not implemented. Official rules allow agreeing to a draw if both players are stuck in a forced repetition loop. Low priority.
