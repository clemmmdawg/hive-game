/**
 * net.js — WebSocket client wrapper for Hive online multiplayer.
 *
 * Handles connection, automatic reconnection with exponential backoff,
 * and a simple typed-message event system.
 *
 * Usage:
 *   import * as net from './net.js';
 *
 *   net.on('GAME_STATE', ({ gameState }) => { ... });
 *   net.connect();
 *   net.send('PLACE_PIECE', { pieceType: 'ANT', to: '0,0' });
 *   net.disconnect();
 */

// ── State ─────────────────────────────────────────────────────────────────────

let _socket          = null;
let _url             = null;
let _handlers        = {};   // type → handler function
let _reconnectDelay  = 2000;
let _reconnecting    = false;
let _intentionalClose = false;

const MAX_DELAY = 16_000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Connect (or reconnect) to the game server.
 * Derives the WebSocket URL from the current page origin if not given.
 *
 * @param {string} [url] - e.g. 'ws://localhost:3000' — defaults to same origin
 */
export function connect(url) {
  _url              = url ?? location.origin.replace(/^http/, 'ws');
  _intentionalClose = false;
  _reconnectDelay   = 2000;
  _open();
}

/** Send a typed message to the server. No-ops if socket is not open. */
export function send(type, payload = {}) {
  if (!_socket || _socket.readyState !== WebSocket.OPEN) {
    console.warn('[net] send() called while not connected:', type);
    return;
  }
  _socket.send(JSON.stringify({ type, ...payload }));
}

/** Close the connection without triggering reconnect logic. */
export function disconnect() {
  _intentionalClose = true;
  if (_socket) {
    _socket.close();
    _socket = null;
  }
  _reconnecting = false;
}

/**
 * Register a handler for a message type.
 * The handler receives the full parsed message object.
 * Use type '*' to catch any message not handled by a specific handler.
 *
 * @param {string}   type    - Message type (e.g. 'GAME_STATE') or '*'
 * @param {Function} handler - Called with the parsed message object
 */
export function on(type, handler) {
  _handlers[type] = handler;
}

/** Remove a previously registered handler. */
export function off(type) {
  delete _handlers[type];
}

/** True while the socket is open and ready. */
export function isConnected() {
  return _socket?.readyState === WebSocket.OPEN;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _open() {
  if (_reconnecting) return;

  _socket = new WebSocket(_url);

  _socket.addEventListener('open', () => {
    _reconnectDelay = 2000; // reset backoff on success
    _reconnecting   = false;
    console.log('[net] Connected to', _url);
    _dispatch('_connected', {});
  });

  _socket.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    _dispatch(msg.type, msg);
  });

  _socket.addEventListener('close', () => {
    if (_intentionalClose) return;
    _dispatch('_disconnected', {});
    _scheduleReconnect();
  });

  _socket.addEventListener('error', () => {
    // 'error' is always followed by 'close'; handle everything there.
  });
}

function _scheduleReconnect() {
  if (_reconnecting) return;
  _reconnecting = true;
  const delay   = _reconnectDelay;
  _reconnectDelay = Math.min(_reconnectDelay * 2, MAX_DELAY);

  console.log(`[net] Reconnecting in ${delay}ms…`);
  setTimeout(() => {
    _reconnecting = false;
    if (!_intentionalClose) _open();
  }, delay);
}

function _dispatch(type, data) {
  if (_handlers[type]) {
    _handlers[type](data);
  } else if (_handlers['*']) {
    _handlers['*'](type, data);
  }
}
