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
