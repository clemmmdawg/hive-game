import test from 'node:test';
import assert from 'node:assert/strict';

import { ActionType, PieceType, createGame, getLegalPlacements } from '../js/game.js';
import { validateAction } from '../server/validator.js';
import { createRoom, joinRoom, removeSocket, resumeRoom } from '../server/rooms.js';

function socket() {
  return { readyState: 1, send() {}, close() {} };
}

test('room tokens reserve seats and reclaim the correct player', () => {
  const room = createRoom({});
  const host = socket();
  const guest = socket();
  const p1 = joinRoom(room.code, host);
  const p2 = joinRoom(room.code, guest);
  assert.equal(p1.playerNum, 1);
  assert.equal(p2.playerNum, 2);
  assert.equal(joinRoom(room.code, socket()).error, 'ROOM_FULL');

  host.readyState = 3;
  removeSocket(host);
  assert.equal(resumeRoom(room.code, 'wrong-token', socket()).error, 'INVALID_RESUME_TOKEN');
  const resumed = resumeRoom(room.code, p1.token, socket());
  assert.equal(resumed.playerNum, 1);
  assert.equal(resumed.room, room);
});

test('server validator enforces player turn and legal destinations', () => {
  const state = createGame({});
  const [to] = getLegalPlacements(state, PieceType.ANT);
  const action = { type: ActionType.PLACE, pieceType: PieceType.ANT, to };
  assert.deepEqual(validateAction(state, action, 1), { valid: true });
  assert.equal(validateAction(state, action, 2).reason, 'NOT_YOUR_TURN');
  assert.equal(validateAction(state, { ...action, to: '99,99' }, 1).reason, 'ILLEGAL_PLACEMENT');
});

test('pass is rejected while any legal action exists', () => {
  const state = createGame({});
  const result = validateAction(state, { type: ActionType.PASS }, 1);
  assert.equal(result.reason, 'CANNOT_PASS');
});

test('static server only resolves files meant for the browser', async () => {
  const { resolveStaticPath } = await import('../server/static.js');
  const root = '/srv/hive';
  assert.equal(resolveStaticPath(root, '/'), '/srv/hive/index.html');
  assert.equal(resolveStaticPath(root, '/index.html?room=ABCD'), '/srv/hive/index.html');
  assert.equal(resolveStaticPath(root, '/js/app.js'), '/srv/hive/js/app.js');
  assert.equal(resolveStaticPath(root, '/assets/pieces/ant.png'), '/srv/hive/assets/pieces/ant.png');
  for (const blocked of [
    '/.git/config', '/server/server.js', '/package.json', '/node_modules/ws/index.js',
    '/test/game.test.js', '/js/../server/rooms.js', '/js/%2e%2e/server/rooms.js',
    '/../hive2/index.html', '/CLAUDE.md',
  ]) {
    assert.equal(resolveStaticPath(root, blocked), null, blocked);
  }
});

test('resigning is rejected once the game already has a winner', async () => {
  const { resolveResign } = await import('../server/validator.js');
  const live = createGame({});
  assert.deepEqual(resolveResign(live, 1), { valid: true, winner: 2 });
  assert.deepEqual(resolveResign({ ...live, winner: 1 }, 2), { valid: false, reason: 'GAME_OVER' });
  assert.deepEqual(resolveResign(null, 1), { valid: false, reason: 'NO_ACTIVE_GAME' });
});

// ── Server hardening (real ws server on an ephemeral port) ───────────────────

import { WebSocket } from 'ws';
import { mock } from 'node:test';
import { createHiveServer } from '../server/server.js';
import { getRoom, WAIT_TIMEOUT, IDLE_TIMEOUT } from '../server/rooms.js';

async function startServer(opts) {
  const server = createHiveServer(opts);
  await new Promise(r => server.httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.httpServer.address().port}`;
  const clients = [];
  return {
    ...server,
    async client(wsOpts) {
      const ws = new WebSocket(url, wsOpts);
      ws.inbox = [];
      ws.on('message', d => ws.inbox.push(JSON.parse(d.toString())));
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      clients.push(ws);
      return ws;
    },
    async stop() {
      for (const c of clients) c.terminate();
      server.wss.close();
      await new Promise(r => server.httpServer.close(r));
    },
  };
}

async function next(ws, type, timeout = 2000) {
  const t0 = Date.now();
  for (;;) {
    const i = ws.inbox.findIndex(m => m.type === type);
    if (i >= 0) return ws.inbox.splice(i, 1)[0];
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${type}`);
    await new Promise(r => setTimeout(r, 10));
  }
}
const send = (ws, m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m));
const closed = ws => ws.readyState === 3 || new Promise(r => ws.once('close', () => r(true)));

async function startGame(srv) {
  const a = await srv.client();
  send(a, { type: 'CREATE_ROOM', settings: {} });
  const created = await next(a, 'ROOM_CREATED');
  const b = await srv.client();
  send(b, { type: 'JOIN_ROOM', code: created.code });
  await next(a, 'GAME_START');
  await next(b, 'GAME_START');
  return { a, b, code: created.code, tokenA: created.token, tokenB: (await next(b, 'PLAYER_ASSIGNMENT')).token };
}

test('malformed messages never crash the server and get an ERROR reply', async () => {
  const srv = await startServer();
  try {
    const ws = await srv.client();
    for (const bad of ['null', '42', '"x"', '[]', '{"type":5}', 'not json {']) {
      send(ws, bad);
      assert.equal((await next(ws, 'ERROR')).reason, 'INVALID_MESSAGE', bad);
    }
    send(ws, { type: 'CREATE_ROOM', settings: null });
    assert.equal((await next(ws, 'ROOM_CREATED')).player, 1);
    const ws2 = await srv.client();
    send(ws2, { type: 'CREATE_ROOM', settings: { expansions: null } });
    assert.ok((await next(ws2, 'ROOM_CREATED')).code);
    assert.equal(ws.readyState, 1);
  } finally { await srv.stop(); }
});

test('oversized frames are rejected by closing the socket (maxPayload 64 KB)', async () => {
  const srv = await startServer();
  try {
    const ws = await srv.client();
    const code = new Promise(r => ws.once('close', c => r(c)));
    send(ws, JSON.stringify({ type: 'CREATE_ROOM', pad: 'x'.repeat(70 * 1024) }));
    assert.equal(await code, 1009);
  } finally { await srv.stop(); }
});

test('two sockets resuming one token settle: the newer holds the seat, the older is told SEAT_TAKEN', async () => {
  const srv = await startServer();
  try {
    const { a, b, code, tokenA } = await startGame(srv);
    const a2 = await srv.client();
    const closeCode = new Promise(r => a.once('close', c => r(c)));
    send(a2, { type: 'RESUME_ROOM', code, token: tokenA });
    await next(a2, 'ROOM_RESUMED');
    assert.equal((await next(a, 'ERROR')).reason, 'SEAT_TAKEN');
    assert.equal(await closeCode, 4001);
    await next(b, 'OPPONENT_RECONNECTED');
    // The evicted socket stays out: nothing re-seats it, the seat stays with a2.
    await new Promise(r => setTimeout(r, 150));
    
    send(a2, { type: 'RESIGN' });
    assert.equal((await next(b, 'GAME_OVER')).winner, 2);
    assert.equal(b.inbox.some(m => m.type === 'OPPONENT_DISCONNECTED'), false);
    assert.equal(a2.readyState, 1);
  } finally { await srv.stop(); }
});

test('resume replaces a still-OPEN (half-open) old socket without telling the opponent it left', async () => {
  const srv = await startServer();
  try {
    const { a, b, code, tokenA } = await startGame(srv);
    const a2 = await srv.client();
    send(a2, { type: 'RESUME_ROOM', code, token: tokenA });
    const resumed = await next(a2, 'ROOM_RESUMED');
    assert.equal(resumed.player, 1);
    assert.equal(resumed.endReason, undefined);
    await closed(a);
    await next(b, 'OPPONENT_RECONNECTED');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(b.inbox.some(m => m.type === 'OPPONENT_DISCONNECTED'), false);
  } finally { await srv.stop(); }
});

test('host waiting timer stays 10 minutes after the host joins', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const room = createRoom({});
    joinRoom(room.code, socket());
    mock.timers.tick(WAIT_TIMEOUT - 1000);
    assert.ok(getRoom(room.code), 'still waiting just before 10 min');
    mock.timers.tick(2000);
    assert.equal(getRoom(room.code), undefined, 'expired at 10 min, not 30');
    assert.ok(IDLE_TIMEOUT > WAIT_TIMEOUT);
  } finally { mock.timers.reset(); }
});

test('resuming repeatedly does not extend the 10 minute wait for a second player', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const room = createRoom({});
    const host = joinRoom(room.code, socket());
    mock.timers.tick(WAIT_TIMEOUT - 60_000);
    resumeRoom(room.code, host.token, socket());   // each resume used to restart the wait
    mock.timers.tick(30_000);
    resumeRoom(room.code, host.token, socket());
    assert.ok(getRoom(room.code), 'alive 30s before the deadline');
    mock.timers.tick(31_000);
    assert.equal(getRoom(room.code), undefined, 'expired 10 min after creation');
  } finally { mock.timers.reset(); }
});

test('a seated socket cannot create or join another room', async () => {
  const srv = await startServer();
  try {
    const { a, code } = await startGame(srv);
    send(a, { type: 'CREATE_ROOM', settings: {} });
    assert.equal((await next(a, 'ERROR')).reason, 'ALREADY_IN_ROOM');
    send(a, { type: 'JOIN_ROOM', code });
    assert.equal((await next(a, 'ERROR')).reason, 'ALREADY_IN_ROOM');
  } finally { await srv.stop(); }
});

test('resign then resume reports endReason RESIGN', async () => {
  const srv = await startServer();
  try {
    const { a, b, code, tokenB } = await startGame(srv);
    send(a, { type: 'RESIGN' });
    const over = await next(b, 'GAME_OVER');
    assert.deepEqual([over.winner, over.reason], [2, 'RESIGN']);
    b.terminate();
    await closed(b);
    const b2 = await srv.client();
    send(b2, { type: 'RESUME_ROOM', code, token: tokenB });
    const resumed = await next(b2, 'ROOM_RESUMED');
    assert.equal(resumed.endReason, 'RESIGN');
    assert.equal(resumed.gameState.winner, 2);
  } finally { await srv.stop(); }
});

test('heartbeat terminates a client that never answers pings', async () => {
  const srv = await startServer({ heartbeatMs: 40 });
  try {
    const dead = await srv.client({ autoPong: false });
    const live = await srv.client();
    await closed(dead);
    assert.equal(live.readyState, 1);
  } finally { await srv.stop(); }
});
