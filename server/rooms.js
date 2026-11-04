/**
 * rooms.js — Room lifecycle management for the Hive multiplayer server.
 *
 * Rooms are identified by a 4-character code drawn from a consonant-only
 * alphabet (no vowels, no visually ambiguous characters). In-memory only —
 * rooms disappear on server restart.
 *
 * Room lifecycle:
 *   - Created by HOST player; waits up to WAIT_TIMEOUT ms for a second player.
 *   - Becomes active when a second player joins (gameState is set).
 *   - Expires after IDLE_TIMEOUT ms of no game activity.
 *   - Cleaned up when both sockets disconnect.
 */

import { randomUUID } from 'crypto';

const CODE_CHARS   = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
export const WAIT_TIMEOUT = 10 * 60 * 1000; // 10 min — waiting for 2nd player
export const IDLE_TIMEOUT = 30 * 60 * 1000; // 30 min — game inactivity

/** @type {Map<string, Room>} */
const rooms = new Map();

// ── Code generation ──────────────────────────────────────────────────────────

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

// ── Room creation ────────────────────────────────────────────────────────────

/**
 * Create a new room for the given settings. Returns the Room object.
 * The host socket must then be registered via joinRoom().
 */
export function createRoom(settings) {
  const code = generateCode();
  const room = {
    code,
    sockets:      [null, null],   // index 0 = player 1, index 1 = player 2
    tokens:       [null, null],   // reconnect UUIDs parallel to sockets
    gameState:    null,           // set to a live GameState when game starts
    settings,
    endReason:    null,           // 'QUEEN' | 'RESIGN' | 'DRAW' once finished
    idleTimer:    null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);

  // Expire the room if no second player arrives
  room.idleTimer = setTimeout(() => {
    if (!room.tokens[1]) cleanupRoom(code);
  }, WAIT_TIMEOUT);
  room.idleTimer.unref?.();

  return room;
}

// ── Socket registration ──────────────────────────────────────────────────────

/**
 * Assign a socket to the next available slot in the room.
 * Returns { playerNum, token } on success or { error } on failure.
 */
export function joinRoom(code, socket) {
  const room = rooms.get(code);
  if (!room) return { error: 'ROOM_NOT_FOUND' };

  // Tokens reserve seats across disconnects. A normal join may only claim a
  // seat that has never been assigned; reconnects must use resumeRoom().
  const slot = room.tokens.findIndex(token => token === null);
  if (slot === -1) return { error: 'ROOM_FULL' };

  const playerNum = slot + 1; // 1 or 2
  const token     = randomUUID();

  room.sockets[slot] = socket;
  room.tokens[slot]  = token;

  // Tag the socket for O(1) reverse lookup
  socket._hiveRoom   = code;
  socket._hivePlayer = playerNum;
  socket._hiveToken  = token;

  touchActivity(room);
  return { playerNum, token, room };
}

/** Reclaim a reserved player seat using the token issued on initial join. */
export function resumeRoom(code, token, socket) {
  const room = rooms.get(code);
  if (!room) return { error: 'ROOM_NOT_FOUND' };

  const slot = room.tokens.findIndex(saved => saved === token);
  if (slot === -1) return { error: 'INVALID_RESUME_TOKEN' };

  const current = room.sockets[slot];
  // The old socket may be half-open (dead TCP the server hasn't noticed yet):
  // the token holder wins. Detach it so its late 'close' is a no-op.
  if (current && current !== socket) {
    current._hiveRoom   = null;
    current._hivePlayer = null;
    current._hiveToken  = null;
    current.terminate?.();
  }

  const playerNum = slot + 1;
  room.sockets[slot] = socket;
  socket._hiveRoom   = code;
  socket._hivePlayer = playerNum;
  socket._hiveToken  = token;
  touchActivity(room);
  return { playerNum, token, room };
}

// ── Socket removal ───────────────────────────────────────────────────────────

/**
 * Remove a socket from its room (called on 'close').
 * If both slots are vacant, schedule room cleanup.
 */
export function removeSocket(socket) {
  const code = socket._hiveRoom;
  if (!code) return;

  const room = rooms.get(code);
  if (!room) return;

  const slot = socket._hivePlayer - 1;
  if (room.sockets[slot] === socket) room.sockets[slot] = null;

  // Both gone — clean up after a short grace period (allow reconnect)
  if (!room.sockets[0] && !room.sockets[1]) {
    const cleanupTimer = setTimeout(() => {
      // Only delete if still vacant
      const r = rooms.get(code);
      if (r && !r.sockets[0] && !r.sockets[1]) cleanupRoom(code);
    }, 30_000);
    cleanupTimer.unref?.();
  }
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getRoom(code) {
  return rooms.get(code);
}

// ── Broadcast helpers ────────────────────────────────────────────────────────

const WS_OPEN = 1;

/** Send a message to all connected players in the room. */
export function broadcast(room, message) {
  const json = JSON.stringify(message);
  for (const sock of room.sockets) {
    if (sock && sock.readyState === WS_OPEN) sock.send(json);
  }
}

/** Send a message to a specific player (1 or 2). */
export function sendTo(room, playerNum, message) {
  const sock = room.sockets[playerNum - 1];
  if (sock && sock.readyState === WS_OPEN) sock.send(JSON.stringify(message));
}

// ── Activity tracking ────────────────────────────────────────────────────────

function touchActivity(room) {
  room.lastActivity = Date.now();
  if (room.idleTimer) clearTimeout(room.idleTimer);
  // Until a second player has claimed a seat the room is only waiting for them.
  const delay = room.tokens[1] ? IDLE_TIMEOUT : WAIT_TIMEOUT;
  room.idleTimer = setTimeout(() => cleanupRoom(room.code), delay);
  room.idleTimer.unref?.();
}

export { touchActivity };

// ── Cleanup ──────────────────────────────────────────────────────────────────

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (!room) return;

  if (room.idleTimer) clearTimeout(room.idleTimer);

  for (const sock of room.sockets) {
    if (sock && sock.readyState === WS_OPEN) {
      try { sock.send(JSON.stringify({ type: 'ROOM_CLOSED' })); } catch {}
      try { sock.close(); } catch {}
    }
  }

  rooms.delete(code);
  console.log(`[rooms] Room ${code} cleaned up. Active rooms: ${rooms.size}`);
}
