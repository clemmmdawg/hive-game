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
