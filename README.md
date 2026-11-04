# Hive

A browser-based implementation of the [Hive](https://gen42.com/games/hive) board game (© Gen42 Games). Two-player abstract strategy — no board, no captures, just surround the queen. Playable as pass-and-play locally or online via WebSocket with a friend.

No build step, no framework — vanilla HTML, CSS, and ES modules.

---

## Features

- Full base game rules: Queen Bee, Beetle, Ant, Spider, Grasshopper
- All three expansions: Mosquito, Ladybug, Pillbug (including throw mechanic)
- One Hive Rule (connectivity enforced via articulation point detection)
- Freedom to Move / gate check (height-aware for beetle stacks)
- Forced queen placement by turn 4
- Tournament opening rule (optional toggle)
- Win and draw detection
- Must-pass turn handling (automatic with interstitial)
- Online multiplayer via 4-character room codes
- Automatic seat recovery after transient disconnects
- Pass-and-play interstitial screen between turns
- Pan and pinch-zoom on the board canvas
- Piece tooltips in the tray and on the board
- Built-in How to Play reference on the main menu
- Responsive neon interface with reduced-motion and keyboard focus support

---

## Getting Started

**Requirements:** Node.js 18+

```bash
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

If port 3000 is already in use, pass another port directly:

```bash
npm start -- 3001
# or: npm start -- --port 3001
# or: PORT=3001 npm start
```

The game uses system emoji for pieces by default. To opt into the generated PNG
piece set for a session, add `?pieceArt=png` to the URL:

```text
http://localhost:3001/?pieceArt=png
```

Edge uses a built-in letter tile for the beetle when PNG artwork is disabled,
avoiding the missing beetle glyph found in some Windows emoji fonts.

For development with auto-restart on file changes:

```bash
npm run dev
```

Run the rule and multiplayer regression suite with:

```bash
npm test
```

---

## Online Multiplayer

One player selects **Host** and shares the 4-character room code. The other selects **Join** and enters the code. The host's expansion and rule settings are used for the game.

The server is authoritative — all moves are validated server-side using the same game logic as the client.

---

## File Structure

```
/
├── index.html          — Single-page shell; all screens as divs
├── styles.css          — All styles; no external CSS dependencies
├── js/
│   ├── hex.js          — Pure hex math (axial coords, neighbors, pixel conversion)
│   ├── game.js         — Pure game logic (no DOM). Also used by the server.
│   ├── board.js        — Canvas renderer + pointer/touch input
│   ├── app.js          — Application state machine, UI wiring, tray, HUD
│   ├── menu.js         — Main menu, settings panel, online flow
│   └── net.js          — WebSocket client wrapper with reconnect logic
└── server/
    ├── server.js       — HTTP static server + WebSocket game server
    ├── rooms.js        — Room lifecycle, code generation, idle cleanup
    └── validator.js    — Server-side action validation wrapping game.js
```

`game.js` has zero DOM or canvas dependencies and is imported directly by the server for authoritative validation — no logic duplication.

---

## WebSocket Protocol

```
CLIENT → SERVER
  CREATE_ROOM   { settings }
  JOIN_ROOM     { code }
  RESUME_ROOM   { code, token }
  PLACE_PIECE   { pieceType, to }
  MOVE_PIECE    { from, to }
  THROW_PIECE   { pillbugHex, from, to }
  PASS_TURN     {}
  RESIGN        {}

SERVER → CLIENT
  ROOM_CREATED          { code, player, token }
  ROOM_RESUMED          { code, player, token, gameState, settings }
  PLAYER_ASSIGNMENT     { player, token }
  GAME_START            { gameState, settings }
  GAME_STATE            { gameState }
  INVALID_MOVE          { reason }
  GAME_OVER             { winner }
  OPPONENT_DISCONNECTED {}
  OPPONENT_RECONNECTED  {}
  WAITING_FOR_OPPONENT  {}
```

---

## License

[GNU Affero General Public License v3.0](LICENSE)

Hive is a board game © Gen42 Games. This project is an unofficial digital implementation for personal use.
