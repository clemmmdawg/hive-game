/**
 * server.js — Hive multiplayer game server.
 *
 * Static file server (Express-free, using Node's built-in http) + WebSocket
 * game server (ws). Server-authoritative: clients send actions, server
 * validates with game.js, broadcasts canonical state to both players.
 *
 * Usage:
 *   node server/server.js          # production (port 3000)
 *   node server/server.js 4000     # choose a port
 *   node server/server.js --port 4000
 *   node --watch server/server.js  # dev (auto-restart on file change)
 *
 * Environment:
 *   PORT  — TCP port (default 3000; overridden by a CLI argument)
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
  resumeRoom,
  removeSocket,
  broadcast,
  sendTo,
  touchActivity,
} from './rooms.js';

import { validateAction, resolveResign } from './validator.js';
import { resolveStaticPath } from './static.js';

const DEFAULT_SETTINGS = Object.freeze({
  expansions: { mosquito: false, ladybug: false, pillbug: false },
  tournamentRule: false,
  clock: { enabled: false },
});

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT      = join(__dirname, '..');
const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD  = 64 * 1024; // no legitimate message is anywhere near this

function readPort(args, envPort) {
  const flagIndex = args.findIndex(arg => arg === '--port' || arg === '-p');
  const raw = flagIndex >= 0 ? args[flagIndex + 1] : args[0] ?? envPort ?? '3000';
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(`Invalid port: ${raw}. Use an integer from 1 to 65535.`);
    process.exit(1);
  }

  return port;
}

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

// ── HTTP static server + WebSocket server ────────────────────────────────────

function serveStatic(req, res) {
  const filePath = resolveStaticPath(ROOT, req.url);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  try {
    const data = readFileSync(filePath);
    const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

/**
 * Build the HTTP + WebSocket servers (not yet listening). A heartbeat pings
 * every client each `heartbeatMs`; a client that has not answered the previous
 * ping is terminated so half-open TCP connections free their seat.
 */
export function createHiveServer({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const httpServer = createServer(serveStatic);
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { try { socket.send(err('INVALID_MESSAGE')); } catch {} return; }
      try {
        handleMessage(socket, msg);
      } catch (e) {
        console.error('[server] handler error:', e);
        try { socket.send(err('INVALID_MESSAGE')); } catch {}
      }
    });

    socket.on('close', () => {
      // A socket superseded by RESUME_ROOM has been detached (_hiveRoom null).
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

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      try { client.ping(); } catch {}
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));
  httpServer.on('close', () => clearInterval(heartbeat));

  return { httpServer, wss };
}

// ── Message dispatch ─────────────────────────────────────────────────────────

export function handleMessage(socket, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    socket.send(err('INVALID_MESSAGE'));
    return;
  }
  switch (msg.type) {

    // ── Host creates a new room ────────────────────────────────────────────
    case 'CREATE_ROOM': {
      if (socket._hiveRoom) { socket.send(err('ALREADY_IN_ROOM')); return; }
      const settings = normalizeSettings(msg.settings);
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
      if (socket._hiveRoom) { socket.send(err('ALREADY_IN_ROOM')); return; }
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

    // Reclaim a reserved seat after a network interruption.
    case 'RESUME_ROOM': {
      const code  = String(msg.code ?? '').toUpperCase().trim();
      const token = String(msg.token ?? '');
      if (socket._hiveRoom && socket._hiveToken !== token) {
        socket.send(err('ALREADY_IN_ROOM'));
        return;
      }
      const result = resumeRoom(code, token, socket);
      if (result.error) { socket.send(err(result.error)); return; }

      socket.send(JSON.stringify({
        type: 'ROOM_RESUMED',
        code,
        player: result.playerNum,
        token: result.token,
        gameState: result.room.gameState ? serializeState(result.room.gameState) : null,
        settings: result.room.settings,
        ...(result.room.endReason ? { endReason: result.room.endReason } : {}),
      }));

      console.log(`[server] Room ${code} player ${result.playerNum} resumed`);
      const opponent = result.playerNum === 1 ? 2 : 1;
      sendTo(result.room, opponent, { type: 'OPPONENT_RECONNECTED' });
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
        const winner = room.gameState.winner;
        room.endReason = winner === 'DRAW' ? 'DRAW' : 'QUEEN';
        broadcast(room, { type: 'GAME_OVER', winner, reason: room.endReason });
        console.log(`[server] Room ${room.code} game over — winner: ${room.gameState.winner}`);
      }
      break;
    }

    // ── Resign ─────────────────────────────────────────────────────────────
    case 'RESIGN': {
      const room = getRoom(socket._hiveRoom);
      const resign = resolveResign(room?.gameState ?? null, socket._hivePlayer);
      if (!resign.valid) { socket.send(err(resign.reason)); return; }

      const winner = resign.winner;
      room.gameState = { ...room.gameState, winner };
      room.endReason = 'RESIGN';
      touchActivity(room);

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

function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const expansions = input.expansions && typeof input.expansions === 'object' ? input.expansions : {};
  return {
    expansions: {
      mosquito: !!expansions.mosquito,
      ladybug:  !!expansions.ladybug,
      pillbug:  !!expansions.pillbug,
    },
    tournamentRule: !!input.tournamentRule,
    // Clocks are not implemented yet; never trust arbitrary client shapes.
    clock: { ...DEFAULT_SETTINGS.clock },
  };
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const PORT = readPort(process.argv.slice(2), process.env.PORT);
  const { httpServer } = createHiveServer();
  httpServer.listen(PORT, () => {
    console.log(`HIVE server listening on http://localhost:${PORT}`);
  });
}
