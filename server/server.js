/**
 * server.js — Hive multiplayer game server.
 *
 * Static file server (Express-free, using Node's built-in http) + WebSocket
 * game server (ws). Server-authoritative: clients send actions, server
 * validates with game.js, broadcasts canonical state to both players.
 *
 * Usage:
 *   node server/server.js          # production
 *   node --watch server/server.js  # dev (auto-restart on file change)
 *
 * Environment:
 *   PORT  — TCP port (default 3000)
 */

import { createServer }       from 'http';
import { readFileSync }       from 'fs';
import { extname, join }      from 'path';
import { fileURLToPath }      from 'url';
import { WebSocketServer }    from 'ws';

import {
  createGame,
  applyAction,
  serializeState,
  ActionType,
} from '../js/game.js';

import {
  createRoom,
  getRoom,
  joinRoom,
  removeSocket,
  broadcast,
  sendTo,
  touchActivity,
} from './rooms.js';

import { validateAction } from './validator.js';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT      = join(__dirname, '..');
const PORT      = Number(process.env.PORT) || 3000;

// ── MIME types ───────────────────────────────────────────────────────────────

const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':         'image/png',
  '.ico':         'image/x-icon',
  '.svg':         'image/svg+xml',
  '.woff2':       'font/woff2',
};

// ── HTTP static server ───────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  // Strip query strings and anchors
  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // Prevent path traversal
  const filePath = join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const data = readFileSync(filePath);
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

// ── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(socket, msg);
  });

  socket.on('close', () => {
    const room = getRoom(socket._hiveRoom);
    if (room) {
      const playerNum  = socket._hivePlayer;
      const opponent   = playerNum === 1 ? 2 : 1;
      removeSocket(socket);
      sendTo(room, opponent, { type: 'OPPONENT_DISCONNECTED' });
    }
  });

  socket.on('error', () => {}); // suppress uncaught errors; 'close' fires after
});

// ── Message dispatch ─────────────────────────────────────────────────────────

function handleMessage(socket, msg) {
  switch (msg.type) {

    // ── Host creates a new room ────────────────────────────────────────────
    case 'CREATE_ROOM': {
      const settings = msg.settings ?? {};
      const room     = createRoom(settings);

      const result = joinRoom(room.code, socket);
      if (result.error) {
        socket.send(err(result.error));
        return;
      }

      socket.send(JSON.stringify({
        type:   'ROOM_CREATED',
        code:   room.code,
        player: result.playerNum,   // always 1 for the host
        token:  result.token,
      }));

      console.log(`[server] Room ${room.code} created`);
      break;
    }

    // ── Second player joins an existing room ───────────────────────────────
    case 'JOIN_ROOM': {
      const code = String(msg.code ?? '').toUpperCase().trim();
      const room = getRoom(code);

      if (!room) {
        socket.send(err('ROOM_NOT_FOUND'));
        return;
      }

      const result = joinRoom(code, socket);
      if (result.error) {
        socket.send(err(result.error));
        return;
      }

      const playerNum = result.playerNum;

      if (playerNum === 1) {
        // Host reconnecting / edge case — just acknowledge
        socket.send(JSON.stringify({ type: 'WAITING_FOR_OPPONENT', code }));
        return;
      }

      // Both players present — start the game
      room.gameState = createGame(room.settings);
      const snap     = serializeState(room.gameState);

      // Tell each player their assigned number
      sendTo(room, 1, { type: 'PLAYER_ASSIGNMENT', player: 1, token: room.tokens[0] });
      sendTo(room, 2, { type: 'PLAYER_ASSIGNMENT', player: 2, token: room.tokens[1] });

      // Broadcast the initial game state to both
      broadcast(room, { type: 'GAME_START', gameState: snap, settings: room.settings });

      console.log(`[server] Room ${room.code} game started`);
      break;
    }

    // ── Game actions ───────────────────────────────────────────────────────
    case 'PLACE_PIECE':
    case 'MOVE_PIECE':
    case 'THROW_PIECE':
    case 'PASS_TURN': {
      const room = getRoom(socket._hiveRoom);
      if (!room?.gameState) { socket.send(err('NO_ACTIVE_GAME')); return; }

      const action = msgToAction(msg);
      if (!action) { socket.send(err('INVALID_MESSAGE')); return; }

      const { valid, reason } = validateAction(room.gameState, action, socket._hivePlayer);
      if (!valid) {
        socket.send(JSON.stringify({ type: 'INVALID_MOVE', reason }));
        return;
      }

      room.gameState = applyAction(room.gameState, action);
      touchActivity(room);

      const snap = serializeState(room.gameState);
      broadcast(room, { type: 'GAME_STATE', gameState: snap });

      if (room.gameState.winner) {
        broadcast(room, { type: 'GAME_OVER', winner: room.gameState.winner });
        console.log(`[server] Room ${room.code} game over — winner: ${room.gameState.winner}`);
      }
      break;
    }

    // ── Resign ─────────────────────────────────────────────────────────────
    case 'RESIGN': {
      const room = getRoom(socket._hiveRoom);
      if (!room?.gameState) { socket.send(err('NO_ACTIVE_GAME')); return; }

      const winner = socket._hivePlayer === 1 ? 2 : 1;
      room.gameState = { ...room.gameState, winner };

      broadcast(room, { type: 'GAME_OVER', winner, reason: 'RESIGN' });
      console.log(`[server] Room ${room.code} — player ${socket._hivePlayer} resigned`);
      break;
    }

    default:
      socket.send(err('UNKNOWN_MESSAGE_TYPE'));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Map a client WebSocket message to a game.js action object. */
function msgToAction(msg) {
  switch (msg.type) {
    case 'PLACE_PIECE':
      return { type: ActionType.PLACE, pieceType: msg.pieceType, to: msg.to };
    case 'MOVE_PIECE':
      return { type: ActionType.MOVE, from: msg.from, to: msg.to };
    case 'THROW_PIECE':
      return { type: ActionType.THROW, pillbugHex: msg.pillbugHex, from: msg.from, to: msg.to };
    case 'PASS_TURN':
      return { type: ActionType.PASS };
    default:
      return null;
  }
}

function err(reason) {
  return JSON.stringify({ type: 'ERROR', reason });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`HIVE server listening on http://localhost:${PORT}`);
});
