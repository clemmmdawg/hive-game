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
  joinSpectator,
  resumeRoom,
  removeSocket,
  broadcast,
  broadcastSpectators,
  sendTo,
  touchActivity,
} from './rooms.js';

import { logEntry } from '../js/notation.js';
import {
  normalizeClockSettings, createClock, startTurn, endTurn, pause, flag, isFlagged, remainingFor,
} from '../js/clock.js';
import { validateAction, resolveResign } from './validator.js';
import { resolveStaticPath } from './static.js';

// ── Paths ────────────────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT      = join(__dirname, '..');
const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD  = 64 * 1024; // no legitimate message is anywhere near this

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
 * `clockOverride` ({ time, increment } ms) is a test hook: rooms created with a
 * clock preset get these numbers instead (short clocks for tests); never set in production.
 */
export function createHiveServer({ heartbeatMs = HEARTBEAT_MS, clockOverride = null } = {}) {
  const options = { clockOverride };
  const httpServer = createServer(serveStatic);
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { try { socket.send(err('INVALID_MESSAGE')); } catch {} return; }
      try {
        handleMessage(socket, msg, options);
      } catch (e) {
        console.error('[server] handler error:', e);
        try { socket.send(err('INVALID_MESSAGE')); } catch {}
      }
    });

    socket.on('close', () => handleClose(socket));

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

/** A socket closed: free its seat (and tell the others), or drop it from the spectators. */
export function handleClose(socket) {
  // A socket superseded by RESUME_ROOM has been detached (_hiveRoom null).
  const room = getRoom(socket._hiveRoom);
  if (!room) return;
  if (socket._hiveSpectator) {
    removeSocket(socket);
    broadcast(room, { type: 'SPECTATORS', count: room.spectators.size });
    return;
  }
  const playerNum = socket._hivePlayer;
  const opponent  = playerNum === 1 ? 2 : 1;
  removeSocket(socket);
  const gone = { type: 'OPPONENT_DISCONNECTED', player: playerNum };
  sendTo(room, opponent, gone);
  broadcastSpectators(room, gone);
}

// ── Message dispatch ─────────────────────────────────────────────────────────

/**
 * @param {object} [options] server options (see createHiveServer: `clockOverride`)
 */
export function handleMessage(socket, msg, options = {}) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    socket.send(err('INVALID_MESSAGE'));
    return;
  }
  switch (msg.type) {

    // ── Host creates a new room ────────────────────────────────────────────
    case 'CREATE_ROOM': {
      if (socket._hiveRoom) { socket.send(err('ALREADY_IN_ROOM')); return; }
      const settings = normalizeSettings(msg.settings, options);
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

      // Both seats taken: the game is on, so this socket watches. `spectate` (a watcher re-joining
      // after a drop) never takes a seat, whatever is free.
      if (msg.spectate === true || room.tokens.every(Boolean)) {
        if (!room.gameState) { socket.send(err('NO_ACTIVE_GAME')); return; }
        const watch = joinSpectator(code, socket);
        if (watch.error) { socket.send(err(watch.error)); return; }
        const away = [1, 2].filter(p => !room.sockets[p - 1]); // seats whose player is currently disconnected
        socket.send(JSON.stringify({ type: 'SPECTATING', code, ...roomSnapshot(room), away }));
        broadcast(room, { type: 'SPECTATORS', count: room.spectators.size });
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

      // Both players present — start the game. The side to move's clock runs from now.
      room.gameState = createGame(room.settings);
      room.history   = [];
      room.clock     = startTurn(createClock(room.settings.clock), Date.now());
      scheduleFlag(room);
      touchActivity(room); // the idle deadline now covers the running clock

      // Tell each player their assigned number
      sendTo(room, 1, { type: 'PLAYER_ASSIGNMENT', player: 1, token: room.tokens[0] });
      sendTo(room, 2, { type: 'PLAYER_ASSIGNMENT', player: 2, token: room.tokens[1] });

      // Broadcast the initial game state to both
      broadcast(room, { type: 'GAME_START', ...roomSnapshot(room) });

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
        ...roomSnapshot(result.room),
      }));

      console.log(`[server] Room ${code} player ${result.playerNum} resumed`);
      const opponent = result.playerNum === 1 ? 2 : 1;
      const back = { type: 'OPPONENT_RECONNECTED', player: result.playerNum };
      sendTo(result.room, opponent, back);
      broadcastSpectators(result.room, back);
      socket.send(JSON.stringify({ type: 'SPECTATORS', count: result.room.spectators.size })); // always, 0 included: clears a stale 👁
      break;
    }

    // ── Game actions ───────────────────────────────────────────────────────
    case 'PLACE_PIECE':
    case 'MOVE_PIECE':
    case 'THROW_PIECE':
    case 'PASS_TURN': {
      if (socket._hiveSpectator) { socket.send(err('NOT_A_PLAYER')); return; }
      const room = getRoom(socket._hiveRoom);
      if (!room?.gameState) { socket.send(err('NO_ACTIVE_GAME')); return; }

      const action = msgToAction(msg);
      if (!action) { socket.send(err('INVALID_MESSAGE')); return; }

      // The clock may have run out before its timer fired: that ends the game, not this move.
      const now = Date.now();
      if (!room.gameState.winner && isFlagged(room.clock, room.gameState.turn, now)) {
        flagRoom(room, now);
        return;
      }

      const { valid, reason } = validateAction(room.gameState, action, socket._hivePlayer);
      if (!valid) {
        socket.send(JSON.stringify({ type: 'INVALID_MOVE', reason }));
        return;
      }

      room.history.push(logEntry(room.gameState, action));
      room.gameState = applyAction(room.gameState, action);
      if (room.clock) room.clock = endTurn(room.clock, socket._hivePlayer, now);
      if (room.gameState.winner) stopClock(room, now);
      else scheduleFlag(room);
      touchActivity(room);

      broadcast(room, { type: 'GAME_STATE', ...stateFields(room, now) });

      if (room.gameState.winner) {
        const winner = room.gameState.winner;
        room.endReason = winner !== 'DRAW' ? 'QUEEN' : room.gameState.drawReason === 'REPETITION' ? 'REPETITION' : 'DRAW';
        broadcast(room, { type: 'GAME_OVER', winner, reason: room.endReason });
        console.log(`[server] Room ${room.code} game over — winner: ${room.gameState.winner}`);
      }
      break;
    }

    // ── Resign ─────────────────────────────────────────────────────────────
    case 'RESIGN': {
      if (socket._hiveSpectator) { socket.send(err('NOT_A_PLAYER')); return; }
      const room = getRoom(socket._hiveRoom);
      // A flag that fell before this message (its timer not yet run) decides the game first.
      if (room?.gameState && !room.gameState.winner && isFlagged(room.clock, room.gameState.turn, Date.now())) {
        flagRoom(room, Date.now());
        return;
      }
      const resign = resolveResign(room?.gameState ?? null, socket._hivePlayer);
      if (!resign.valid) { socket.send(err(resign.reason)); return; }

      const winner = resign.winner;
      room.gameState = { ...room.gameState, winner };
      room.endReason = 'RESIGN';
      stopClock(room, Date.now());
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

/**
 * Room settings from a client's CREATE_ROOM: booleans coerced, the clock limited to the presets
 * (js/clock.js). `options.clockOverride` (test hook) replaces an enabled preset's numbers.
 */
export function normalizeSettings(raw, { clockOverride = null } = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const expansions = input.expansions && typeof input.expansions === 'object' ? input.expansions : {};
  let clock = normalizeClockSettings(input.clock);
  if (clock.enabled && clockOverride) clock = { ...clock, time: clockOverride.time, increment: clockOverride.increment };
  return {
    expansions: {
      mosquito: !!expansions.mosquito,
      ladybug:  !!expansions.ladybug,
      pillbug:  !!expansions.pillbug,
    },
    tournamentRule: !!input.tournamentRule,
    clock,
  };
}

// ── Clock + snapshots ────────────────────────────────────────────────────────

/** `clock` + `serverNow` for a timed room (clients rebase the countdown onto their own time); {} otherwise. */
function clockFields(room, now = Date.now()) {
  return room.clock ? { clock: room.clock, serverNow: now } : {};
}

/** GAME_STATE body: the canonical state, the move log and the clock. */
function stateFields(room, now = Date.now()) {
  return { gameState: serializeState(room.gameState), history: room.history, ...clockFields(room, now) };
}

/**
 * Everything a client needs to show the room's game from scratch: GAME_START, ROOM_RESUMED (and
 * any later "join a game in progress" message). gameState is null before the game starts.
 */
export function roomSnapshot(room, now = Date.now()) {
  return {
    gameState: room.gameState ? serializeState(room.gameState) : null,
    settings:  room.settings,
    history:   room.history,
    ...clockFields(room, now),
    ...(room.endReason ? { endReason: room.endReason } : {}),
  };
}

function clearFlagTimer(room) {
  if (room.clockTimer) clearTimeout(room.clockTimer);
  room.clockTimer = null;
}

/** Arm the timeout for the side to move (re-armed after every move). Disconnects do not stop it. */
function scheduleFlag(room) {
  clearFlagTimer(room);
  if (!room.clock?.running || room.gameState?.winner) return;
  const left = remainingFor(room.clock, room.clock.active, Date.now());
  room.clockTimer = setTimeout(() => {
    room.clockTimer = null;
    const now = Date.now();
    if (room.gameState.winner) return;
    if (isFlagged(room.clock, room.clock.active, now)) flagRoom(room, now);
    else scheduleFlag(room); // fired a hair early
  }, left);
  room.clockTimer.unref?.();
}

/** The game ended some other way: freeze the clock where it stands. */
function stopClock(room, now) {
  clearFlagTimer(room);
  if (room.clock) room.clock = pause(room.clock, now);
}

/** The side to move ran out of time: the other side wins (reason TIMEOUT). */
function flagRoom(room, now) {
  clearFlagTimer(room);
  const loser  = room.clock.active;
  const winner = loser === 1 ? 2 : 1;
  room.clock     = flag(room.clock, now);
  room.gameState = { ...room.gameState, winner };
  room.endReason = 'TIMEOUT';
  touchActivity(room);
  broadcast(room, { type: 'GAME_OVER', winner, reason: 'TIMEOUT', ...clockFields(room, now) });
  console.log(`[server] Room ${room.code} — player ${loser} ran out of time`);
}
