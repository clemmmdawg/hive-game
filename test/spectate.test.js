import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { PieceType, getLegalPlacements, createGame } from '../js/game.js';
import { createHiveServer, handleMessage, handleClose } from '../server/server.js';
import { getRoom, IDLE_TIMEOUT, MAX_SPECTATORS } from '../server/rooms.js';

function fakeSocket() {
  const s = { readyState: 1, inbox: [], send(m) { s.inbox.push(JSON.parse(m)); }, close() { s.readyState = 3; s.closed = true; } };
  return s;
}
const all  = (s, type) => s.inbox.filter(m => m.type === type);
const last = (s, type) => all(s, type).at(-1);

function startRoom(settings = {}) {
  const a = fakeSocket(), b = fakeSocket();
  handleMessage(a, { type: 'CREATE_ROOM', settings });
  const { code } = last(a, 'ROOM_CREATED');
  handleMessage(b, { type: 'JOIN_ROOM', code });
  return { a, b, code, room: getRoom(code) };
}
const watch = code => {
  const s = fakeSocket();
  handleMessage(s, { type: 'JOIN_ROOM', code });
  return s;
};

test('a third JOIN_ROOM becomes a spectator and gets the room snapshot', () => {
  const { a, b, code } = startRoom();
  const w = watch(code);
  const snap = last(w, 'SPECTATING');
  assert.equal(snap.code, code);
  assert.ok(snap.gameState && snap.settings && Array.isArray(snap.history));
  assert.equal(last(w, 'PLAYER_ASSIGNMENT'), undefined);
  assert.equal(last(w, 'GAME_START'), undefined);
  // everyone hears the count
  for (const s of [a, b, w]) assert.equal(last(s, 'SPECTATORS').count, 1);
});

test('SPECTATING carries the clock, serverNow and endReason like ROOM_RESUMED', () => {
  const { a, code } = startRoom({ clock: { enabled: true, type: 'FISCHER', time: 300_000, increment: 0 } });
  let w = watch(code);
  assert.equal(typeof last(w, 'SPECTATING').serverNow, 'number');
  assert.ok(last(w, 'SPECTATING').clock.running);
  handleMessage(a, { type: 'RESIGN' });
  w = watch(code);
  assert.equal(last(w, 'SPECTATING').endReason, 'RESIGN');
});

test('spectators receive every broadcast; their actions are refused with NOT_A_PLAYER', () => {
  const { a, code, room } = startRoom();
  const w = watch(code);
  const [to] = getLegalPlacements(createGame({}), PieceType.ANT);
  handleMessage(a, { type: 'PLACE_PIECE', pieceType: PieceType.ANT, to });
  assert.equal(last(w, 'GAME_STATE').history.length, 1);

  for (const msg of [
    { type: 'PLACE_PIECE', pieceType: PieceType.ANT, to: '3,3' },
    { type: 'MOVE_PIECE', from: '0,0', to: '1,0' },
    { type: 'THROW_PIECE', pillbugHex: '0,0', from: '1,0', to: '2,0' },
    { type: 'PASS_TURN' },
    { type: 'RESIGN' },
  ]) {
    const before = all(w, 'ERROR').length;
    handleMessage(w, msg);
    assert.equal(all(w, 'ERROR').length, before + 1, msg.type);
    assert.equal(last(w, 'ERROR').reason, 'NOT_A_PLAYER');
  }
  assert.equal(room.history.length, 1, 'nothing was applied');
  assert.equal(room.gameState.winner, null);

  handleMessage(a, { type: 'RESIGN' });
  assert.equal(last(w, 'GAME_OVER').reason, 'RESIGN');
});

test('at most 16 spectators per room; the 17th gets ROOM_FULL and is not counted', () => {
  const { a, code } = startRoom();
  assert.equal(MAX_SPECTATORS, 16);
  const watchers = Array.from({ length: 16 }, () => watch(code));
  assert.equal(last(a, 'SPECTATORS').count, 16);
  const extra = watch(code);
  assert.equal(last(extra, 'ERROR').reason, 'ROOM_FULL');
  assert.equal(last(extra, 'SPECTATING'), undefined);
  assert.equal(last(a, 'SPECTATORS').count, 16);
  // a freed slot can be taken again
  handleClose(watchers[0]);
  assert.equal(last(a, 'SPECTATORS').count, 15);
  assert.ok(last(watch(code), 'SPECTATING'));
});

test('spectators never take a seat, and a spectator reconnecting with spectate stays one', () => {
  const { code, room } = startRoom();
  const w = watch(code);
  const again = fakeSocket();
  handleMessage(again, { type: 'JOIN_ROOM', code, spectate: true });
  assert.ok(last(again, 'SPECTATING'));
  assert.deepEqual(room.sockets.map(Boolean), [true, true]);
  assert.equal(room.tokens.filter(Boolean).length, 2);
  // spectate:true to a room that still has a free seat never seats the caller
  const h = fakeSocket();
  handleMessage(h, { type: 'CREATE_ROOM', settings: {} });
  const { code: open } = last(h, 'ROOM_CREATED');
  const s = fakeSocket();
  handleMessage(s, { type: 'JOIN_ROOM', code: open, spectate: true });
  assert.equal(last(s, 'ERROR').reason, 'NO_ACTIVE_GAME');
  assert.equal(getRoom(open).tokens[1], null);
  assert.equal(w.closed, undefined);
});

test('a spectator cannot create or join another room or resume a seat', () => {
  const { code } = startRoom();
  const w = watch(code);
  handleMessage(w, { type: 'CREATE_ROOM', settings: {} });
  assert.equal(last(w, 'ERROR').reason, 'ALREADY_IN_ROOM');
  handleMessage(w, { type: 'JOIN_ROOM', code });
  assert.equal(all(w, 'ERROR').at(-1).reason, 'ALREADY_IN_ROOM');
});

test('player disconnects / reconnects reach spectators with the player number; leaving updates the count', () => {
  const { a, b, code } = startRoom();
  const tokenA = getRoom(code).tokens[0];
  const w1 = watch(code), w2 = watch(code);
  assert.deepEqual(all(a, 'SPECTATORS').map(m => m.count), [1, 2]);

  handleClose(w2);
  assert.equal(last(a, 'SPECTATORS').count, 1);
  assert.equal(last(w1, 'SPECTATORS').count, 1);

  a.readyState = 3;
  handleClose(a);
  assert.equal(last(w1, 'OPPONENT_DISCONNECTED').player, 1);
  assert.equal(last(b, 'OPPONENT_DISCONNECTED').player, 1);

  const a2 = fakeSocket();
  handleMessage(a2, { type: 'RESUME_ROOM', code, token: tokenA });
  assert.ok(last(a2, 'ROOM_RESUMED'));
  assert.equal(last(a2, 'SPECTATORS').count, 1, 'a resuming player learns the count');
  assert.equal(last(w1, 'OPPONENT_RECONNECTED').player, 1);
  assert.equal(last(b, 'OPPONENT_RECONNECTED').player, 1);

  handleClose(w1);
  assert.equal(last(a2, 'SPECTATORS').count, 0);
  assert.equal(last(b, 'SPECTATORS').count, 0);
});

test('over a real socket: a spectator joins, hears the next move, and its close updates the players', async () => {
  const srv = createHiveServer();
  await new Promise(r => srv.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${srv.httpServer.address().port}`;
  const clients = [];
  const client = async () => {
    const ws = new WebSocket(url); ws.inbox = [];
    ws.on('message', d => ws.inbox.push(JSON.parse(d.toString())));
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    clients.push(ws); return ws;
  };
  const next = async (ws, type) => {
    for (let i = 0; i < 300; i++) {
      const k = ws.inbox.findIndex(m => m.type === type);
      if (k >= 0) return ws.inbox.splice(k, 1)[0];
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`timeout ${type}`);
  };
  const send = (ws, m) => ws.send(JSON.stringify(m));
  try {
    const a = await client(); send(a, { type: 'CREATE_ROOM', settings: {} });
    const { code } = await next(a, 'ROOM_CREATED');
    const b = await client(); send(b, { type: 'JOIN_ROOM', code });
    await next(a, 'GAME_START');
    const w = await client(); send(w, { type: 'JOIN_ROOM', code });
    assert.equal((await next(w, 'SPECTATING')).code, code);
    assert.equal((await next(a, 'SPECTATORS')).count, 1);
    const [to] = getLegalPlacements(createGame({}), PieceType.ANT);
    send(a, { type: 'PLACE_PIECE', pieceType: PieceType.ANT, to });
    assert.equal((await next(w, 'GAME_STATE')).history.length, 1);
    assert.equal((await next(b, 'SPECTATORS')).count, 1);
    w.close();
    assert.equal((await next(b, 'SPECTATORS')).count, 0);
  } finally {
    for (const c of clients) c.terminate();
    srv.wss.close();
    await new Promise(r => srv.httpServer.close(r));
  }
});

test('spectators do not refresh the idle timer and are told ROOM_CLOSED on cleanup', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const { code, room } = startRoom();
    const idleTimer = room.idleTimer;
    const w = watch(code);
    assert.equal(room.idleTimer, idleTimer, 'joining as a spectator re-armed nothing');
    const activity = room.lastActivity;
    mock.timers.tick(IDLE_TIMEOUT - 1000);
    handleMessage(w, { type: 'PLACE_PIECE', pieceType: 'ANT', to: '0,0' }); // refused
    assert.equal(room.lastActivity, activity);
    assert.ok(getRoom(code));
    mock.timers.tick(2000);
    assert.equal(getRoom(code), undefined, 'idle cleanup is not delayed by a spectator');
    assert.ok(last(w, 'ROOM_CLOSED'));
    assert.equal(w.closed, true);
  } finally { mock.timers.reset(); }
});

test('both players gone: the room still cleans up although a spectator remains, and tells it', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const { a, b, code } = startRoom();
    const w = watch(code);
    a.readyState = 3; b.readyState = 3;
    handleClose(a); handleClose(b);
    mock.timers.tick(31_000);
    assert.equal(getRoom(code), undefined);
    assert.ok(last(w, 'ROOM_CLOSED'));
  } finally { mock.timers.reset(); }
});

// ── Client copy: a spectator (online, myPlayer null) never reads as "you" ─────

import { statusText, dangerText, turnChipText, resumeBanner, isSpectator } from '../js/hints.js';
import { winCopy } from '../js/win-fx.js';
import { reviewStatusText, playerName, pieceOwnerName } from '../js/review.js';

test('spectator copy is neutral: PLAYER N, never YOU / OPPONENT', () => {
  const state = createGame({});
  const spec = { mode: 'ONLINE', myPlayer: null };
  assert.equal(isSpectator('ONLINE', null), true);
  assert.equal(isSpectator('ONLINE', 2), false);
  assert.equal(isSpectator('LOCAL', null), false);

  assert.equal(statusText({ state, ...spec }), 'P1 TO MOVE');
  assert.equal(statusText({ state: { ...state, turn: 2 }, ...spec }), 'P2 TO MOVE');
  assert.equal(statusText({ state: { ...state, winner: 1 }, ...spec }), 'PLAYER 1 WINS');
  assert.equal(statusText({ state: { ...state, winner: 2 }, ...spec, winReason: 'RESIGN' }), 'PLAYER 1 RESIGNED — PLAYER 2 WINS');
  assert.equal(statusText({ state: { ...state, winner: 2 }, ...spec, winReason: 'TIMEOUT' }), 'P1 RAN OUT OF TIME');
  assert.equal(dangerText(2, spec), 'P2 QUEEN IN DANGER');
  assert.equal(turnChipText({ state, ...spec }), 'P1');
  assert.equal(turnChipText({ state: { ...state, winner: 2 }, ...spec }), 'P2 WINS');
  assert.deepEqual(resumeBanner({ state, myPlayer: null }), { text: "PLAYER 1'S TURN", color: 'p1' });

  const won = { winner: 1, turnNumber: 17 };
  const copy = winCopy({ state: won, mode: 'ONLINE', myPlayer: null, reason: 'QUEEN' });
  assert.equal(copy.headline, 'PLAYER 1 WINS!');
  assert.equal(copy.reason, "Player 2's queen was surrounded after 8 rounds.");
  assert.equal(winCopy({ state: won, mode: 'ONLINE', myPlayer: null, reason: 'RESIGN' }).reason, 'Player 2 resigned.');
  assert.equal(winCopy({ state: won, mode: 'ONLINE', myPlayer: null, reason: 'TIMEOUT' }).reason, 'Player 2 ran out of time.');

  assert.equal(playerName(1, 'ONLINE', null), 'P1');
  assert.equal(pieceOwnerName(2, 'ONLINE', null), 'P2');
  const entry = { player: 2, turnNumber: 2, notation: 'bQ', action: { type: 'PLACE', pieceType: 'QUEEN', to: '0,0' } };
  assert.match(reviewStatusText(entry, { mode: 'ONLINE', myPlayer: null, pieceNames: { QUEEN: 'QUEEN' } }), /^P2 PLACED/);
});
