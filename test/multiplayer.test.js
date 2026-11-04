import test from 'node:test';
import assert from 'node:assert/strict';

import { ActionType, PieceType, applyAction, createGame, getLegalPlacements } from '../js/game.js';
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

async function startGame(srv, settings = {}) {
  const a = await srv.client();
  send(a, { type: 'CREATE_ROOM', settings });
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

test('GAME_STATE and ROOM_RESUMED carry the growing move history; resign adds no entry', async () => {
  const srv = await startServer();
  try {
    const { a, b, code, tokenB } = await startGame(srv);
    let state = createGame({});
    const [to1] = getLegalPlacements(state, PieceType.ANT);
    send(a, { type: 'PLACE_PIECE', pieceType: PieceType.ANT, to: to1 });
    const first = await next(b, 'GAME_STATE');
    assert.deepEqual(first.history.map(e => e.notation), ['wA1']);
    assert.deepEqual(first.history[0].action, { type: 'PLACE', pieceType: 'ANT', to: to1 });
    assert.equal(first.history[0].player, 1);

    state = applyAction(state, first.history[0].action);
    const [to2] = getLegalPlacements(state, PieceType.BEETLE);
    send(b, { type: 'PLACE_PIECE', pieceType: PieceType.BEETLE, to: to2 });
    await next(a, 'GAME_STATE'); // a's copy of the first broadcast
    const second = await next(a, 'GAME_STATE');
    assert.deepEqual(second.history.map(e => e.notation), ['wA1', second.history[1].notation]);
    assert.equal(second.history[1].player, 2);

    send(a, { type: 'PLACE_PIECE', pieceType: PieceType.ANT, to: '99,99' }); // rejected: not logged
    await next(a, 'INVALID_MOVE');

    const b2 = await srv.client();
    send(b2, { type: 'RESUME_ROOM', code, token: tokenB });
    const resumed = await next(b2, 'ROOM_RESUMED');
    assert.deepEqual(resumed.history, second.history);

    send(a, { type: 'RESIGN' });
    await next(b2, 'GAME_OVER');
    assert.equal(getRoom(code).history.length, 2);
  } finally { await srv.stop(); }
});

test('GAME_START carries an empty history', async () => {
  const srv = await startServer();
  try {
    const a = await srv.client();
    send(a, { type: 'CREATE_ROOM', settings: {} });
    const { code } = await next(a, 'ROOM_CREATED');
    const b = await srv.client();
    send(b, { type: 'JOIN_ROOM', code });
    assert.deepEqual((await next(b, 'GAME_START')).history, []);
  } finally { await srv.stop(); }
});

test('a threefold repetition ends the online game with reason REPETITION (and resumes with it)', async () => {
  const srv = await startServer();
  try {
    const { a, b, code, tokenB } = await startGame(srv);
    const plays = [
      ['PLACE_PIECE', { pieceType: 'QUEEN', to: '0,0' }], ['PLACE_PIECE', { pieceType: 'QUEEN', to: '1,0' }],
      ['PLACE_PIECE', { pieceType: 'BEETLE', to: '-1,0' }], ['PLACE_PIECE', { pieceType: 'BEETLE', to: '2,0' }],
    ];
    const cycle = [
      ['MOVE_PIECE', { from: '-1,0', to: '-1,1' }], ['MOVE_PIECE', { from: '2,0', to: '2,-1' }],
      ['MOVE_PIECE', { from: '-1,1', to: '-1,0' }], ['MOVE_PIECE', { from: '2,-1', to: '2,0' }],
    ];
    const seq = [...plays, ...cycle, ...cycle];
    for (let i = 0; i < seq.length; i++) {
      send(i % 2 === 0 ? a : b, { type: seq[i][0], ...seq[i][1] });
      await next(a, 'GAME_STATE');
    }
    const over = await next(a, 'GAME_OVER');
    assert.equal(over.winner, 'DRAW');
    assert.equal(over.reason, 'REPETITION');
    const b2 = await srv.client();
    send(b2, { type: 'RESUME_ROOM', code, token: tokenB });
    assert.equal((await next(b2, 'ROOM_RESUMED')).endReason, 'REPETITION');
  } finally { await srv.stop(); }
});

// ── Game clock (server-authoritative) ────────────────────────────────────────

import { handleMessage, normalizeSettings } from '../server/server.js';
import { remainingFor } from '../js/clock.js';

test('normalizeSettings keeps only the clock presets', () => {
  const ok = { enabled: true, type: 'FISCHER', time: 15 * 60_000, increment: 10_000 };
  assert.deepEqual(normalizeSettings({ clock: ok }).clock, ok);
  assert.deepEqual(normalizeSettings({ clock: { ...ok, time: 1000 } }).clock, { enabled: false });
  assert.deepEqual(normalizeSettings({ clock: { ...ok, increment: 1 } }).clock, { enabled: false });
  assert.deepEqual(normalizeSettings({}).clock, { enabled: false });
  // The test hook swaps the preset's numbers for short ones; an off clock stays off.
  assert.deepEqual(normalizeSettings({ clock: ok }, { clockOverride: { time: 900, increment: 100 } }).clock,
    { enabled: true, type: 'FISCHER', time: 900, increment: 100 });
  assert.deepEqual(normalizeSettings({}, { clockOverride: { time: 900, increment: 100 } }).clock, { enabled: false });
});

function fakeSocket() {
  const s = { readyState: 1, inbox: [], send(m) { s.inbox.push(JSON.parse(m)); }, close() {} };
  return s;
}
const last = (s, type) => s.inbox.filter(m => m.type === type).at(-1);
const TEN_FIVE = { enabled: true, type: 'FISCHER', time: 10 * 60_000, increment: 5000 };

test('server clock: runs from GAME_START, deducts + increments per move, flags on timeout with nobody moving', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const a = fakeSocket(), b = fakeSocket();
    handleMessage(a, { type: 'CREATE_ROOM', settings: { clock: TEN_FIVE } });
    const { code } = last(a, 'ROOM_CREATED');
    handleMessage(b, { type: 'JOIN_ROOM', code });
    const start = last(b, 'GAME_START');
    assert.equal(start.serverNow, 1_000_000);
    assert.deepEqual(start.clock.remaining, { 1: 600_000, 2: 600_000 });
    assert.equal(start.clock.running, true);
    assert.equal(start.clock.active, 1);

    mock.timers.tick(7000);
    handleMessage(a, { type: 'PLACE_PIECE', pieceType: 'ANT', to: '0,0' });
    const st = last(b, 'GAME_STATE');
    assert.equal(st.serverNow, 1_007_000);
    assert.equal(st.clock.remaining[1], 600_000 - 7000 + 5000);
    assert.equal(st.clock.active, 2);
    assert.equal(remainingFor(st.clock, 2, 1_007_000), 600_000);

    // Client-sent clock values are ignored: only the server's elapsed time counts.
    mock.timers.tick(2000);
    handleMessage(b, { type: 'PLACE_PIECE', pieceType: 'ANT', to: '1,0', clock: { remaining: { 2: 9e9 } } });
    assert.equal(last(a, 'GAME_STATE').clock.remaining[2], 600_000 - 2000 + 5000);

    // P1 now thinks forever: the room's timer ends the game.
    mock.timers.tick(598_000 - 1); // P1 has 600 000 - 7000 + 5000 left
    assert.equal(last(a, 'GAME_OVER'), undefined);
    mock.timers.tick(2);
    const over = last(b, 'GAME_OVER');
    assert.deepEqual([over.winner, over.reason], [2, 'TIMEOUT']);
    assert.equal(over.clock.remaining[1], 0);
    assert.equal(over.clock.running, false);
    assert.equal(getRoom(code).endReason, 'TIMEOUT');
    assert.equal(getRoom(code).clockTimer, null);

    // Moves after the flag are rejected.
    handleMessage(a, { type: 'PLACE_PIECE', pieceType: 'ANT', to: '-1,0' });
    assert.equal(last(a, 'INVALID_MOVE').reason, 'GAME_OVER');
  } finally { mock.timers.reset(); }
});

test('server clock: a move that arrives after the deadline (timer not yet run) flags instead of counting', () => {
  mock.timers.enable({ apis: ['Date'], now: 5_000 }); // setTimeout stays real but far off: the action path must flag
  try {
    const a = fakeSocket(), b = fakeSocket();
    handleMessage(a, { type: 'CREATE_ROOM', settings: { clock: { enabled: true, type: 'FISCHER', time: 5 * 60_000, increment: 0 } } });
    handleMessage(b, { type: 'JOIN_ROOM', code: last(a, 'ROOM_CREATED').code });
    const room = getRoom(last(a, 'ROOM_CREATED').code);
    mock.timers.tick(5 * 60_000 + 10);
    handleMessage(a, { type: 'PLACE_PIECE', pieceType: 'ANT', to: '0,0' });
    assert.equal(last(b, 'GAME_STATE'), undefined);
    assert.equal(last(b, 'GAME_OVER').reason, 'TIMEOUT');
    assert.equal(room.clockTimer, null);
  } finally { mock.timers.reset(); }
});

test('server clock: resign stops the clock; clock off sends no clock fields', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const a = fakeSocket(), b = fakeSocket();
    handleMessage(a, { type: 'CREATE_ROOM', settings: { clock: TEN_FIVE } });
    const { code } = last(a, 'ROOM_CREATED');
    handleMessage(b, { type: 'JOIN_ROOM', code });
    mock.timers.tick(3000);
    handleMessage(b, { type: 'RESIGN' });
    const room = getRoom(code);
    assert.equal(room.clockTimer, null);
    assert.equal(room.clock.running, false);
    assert.equal(room.clock.remaining[1], 600_000 - 3000);
    mock.timers.tick(700_000);
    assert.equal(last(a, 'GAME_OVER').reason, 'RESIGN', 'no TIMEOUT after a resign');

    const c = fakeSocket(), d = fakeSocket();
    handleMessage(c, { type: 'CREATE_ROOM', settings: {} });
    handleMessage(d, { type: 'JOIN_ROOM', code: last(c, 'ROOM_CREATED').code });
    const start = last(d, 'GAME_START');
    assert.equal('clock' in start, false);
    assert.equal('serverNow' in start, false);
  } finally { mock.timers.reset(); }
});

test('online clock over real sockets: timeout ends the game unprompted; resume restores time and endReason', async () => {
  const srv = await startServer({ clockOverride: { time: 400, increment: 0 } });
  try {
    const a = await srv.client();
    send(a, { type: 'CREATE_ROOM', settings: { clock: TEN_FIVE } });
    const created = await next(a, 'ROOM_CREATED');
    const b = await srv.client();
    send(b, { type: 'JOIN_ROOM', code: created.code });
    const start = await next(a, 'GAME_START');
    assert.deepEqual(start.clock.remaining, { 1: 400, 2: 400 });
    const tokenB = (await next(b, 'PLAYER_ASSIGNMENT')).token;
    // P2 drops; the clock keeps running for P1 regardless.
    b.terminate();
    await closed(b);
    const over = await next(a, 'GAME_OVER', 3000);
    assert.deepEqual([over.winner, over.reason], [2, 'TIMEOUT']);
    const b2 = await srv.client();
    send(b2, { type: 'RESUME_ROOM', code: created.code, token: tokenB });
    const resumed = await next(b2, 'ROOM_RESUMED');
    assert.equal(resumed.endReason, 'TIMEOUT');
    assert.equal(resumed.clock.remaining[1], 0);
    assert.equal(resumed.clock.remaining[2], 400);
    assert.equal(typeof resumed.serverNow, 'number');
  } finally { await srv.stop(); }
});

test('online clock: a reconnect mid-turn gets the running clock with the right remaining time', async () => {
  const srv = await startServer({ clockOverride: { time: 5000, increment: 0 } });
  try {
    const { a, code, tokenA } = await startGame(srv, { clock: TEN_FIVE });
    await new Promise(r => setTimeout(r, 300));
    a.terminate();
    await closed(a);
    const a2 = await srv.client();
    send(a2, { type: 'RESUME_ROOM', code, token: tokenA });
    const resumed = await next(a2, 'ROOM_RESUMED');
    assert.equal(resumed.clock.running, true);
    const left = remainingFor(resumed.clock, 1, resumed.serverNow);
    assert.ok(left <= 5000 - 300 && left > 5000 - 1500, `left ${left}`);
  } finally { await srv.stop(); }
});

test('server clock: a 30+0 game nobody moves in ends on TIMEOUT, not an idle ROOM_CLOSED', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const a = fakeSocket(), b = fakeSocket();
    handleMessage(a, { type: 'CREATE_ROOM', settings: { clock: { enabled: true, type: 'FISCHER', time: 30 * 60_000, increment: 0 } } });
    const { code } = last(a, 'ROOM_CREATED');
    handleMessage(b, { type: 'JOIN_ROOM', code });
    mock.timers.tick(30 * 60_000 + 5);
    assert.equal(last(b, 'GAME_OVER')?.reason, 'TIMEOUT');
    assert.equal(last(b, 'ROOM_CLOSED'), undefined);
    assert.ok(getRoom(code), 'the room outlives the flag (players can still see the result)');
  } finally { mock.timers.reset(); }
});

test('server clock: banked time over 30 min (15+10) still ends on TIMEOUT, not idle cleanup', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    const a = fakeSocket(), b = fakeSocket();
    handleMessage(a, { type: 'CREATE_ROOM', settings: { clock: { enabled: true, type: 'FISCHER', time: 15 * 60_000, increment: 10_000 } } });
    const { code } = last(a, 'ROOM_CREATED');
    handleMessage(b, { type: 'JOIN_ROOM', code });
    const room = getRoom(code);
    room.clock = { ...room.clock, remaining: { 1: 35 * 60_000, 2: 15 * 60_000 } }; // P1 banked increments
    handleMessage(a, { type: 'PLACE_PIECE', pieceType: 'ANT', to: '0,0' }); // re-arms both deadlines
    handleMessage(b, { type: 'PLACE_PIECE', pieceType: 'ANT', to: '1,0' });
    const p1Left = remainingFor(room.clock, 1, Date.now());
    assert.ok(p1Left > 30 * 60_000);
    mock.timers.tick(p1Left + 5);
    assert.equal(last(a, 'GAME_OVER')?.reason, 'TIMEOUT');
    assert.equal(last(a, 'ROOM_CLOSED'), undefined);
  } finally { mock.timers.reset(); }
});

test('server clock: RESIGN after the side to move has flagged (timer not yet run) resolves as TIMEOUT', () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    const a = fakeSocket(), b = fakeSocket();
    handleMessage(a, { type: 'CREATE_ROOM', settings: { clock: { enabled: true, type: 'FISCHER', time: 5 * 60_000, increment: 0 } } });
    handleMessage(b, { type: 'JOIN_ROOM', code: last(a, 'ROOM_CREATED').code });
    mock.timers.tick(5 * 60_000 + 10);
    handleMessage(b, { type: 'RESIGN' }); // P2 resigns, but P1 already ran out
    const over = last(a, 'GAME_OVER');
    assert.deepEqual([over.winner, over.reason], [2, 'TIMEOUT']);
  } finally { mock.timers.reset(); }
});
