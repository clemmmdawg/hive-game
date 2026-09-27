import test from 'node:test';
import assert from 'node:assert/strict';

import { ActionType, PieceType, applyAction, createGame, getLegalPlacements } from '../js/game.js';
import { statusText, describeLastMove } from '../js/hints.js';
import { encodeLocalSave, decodeLocalSave, MAX_UNDO } from '../js/local-save.js';

const P = (player, type) => ({ player, type });

function place(state, pieceType) {
  const [to] = getLegalPlacements(state, pieceType);
  return applyAction(state, { type: ActionType.PLACE, pieceType, to });
}

// ── statusText ───────────────────────────────────────────────────────────────

test('status asks for the first piece on a fresh game', () => {
  assert.equal(statusText({ state: createGame({}), phase: 'IDLE' }), 'PLACE YOUR FIRST PIECE');
});

test('status warns when the queen must be placed this turn', () => {
  let state = createGame({});
  for (let i = 0; i < 6; i++) state = place(state, PieceType.ANT);
  assert.match(statusText({ state, phase: 'IDLE' }), /QUEEN NOW/);
});

test('status explains a pinned piece', () => {
  const state = createGame({});
  state.queenPlaced = { 1: true, 2: true };
  assert.match(statusText({ state, phase: 'BOARD', blocker: 'ONE_HIVE' }), /SPLIT THE HIVE/);
});

test('status prefers the throw hint over a blocker when throws exist', () => {
  const state = createGame({});
  state.queenPlaced = { 1: true, 2: true };
  assert.match(statusText({ state, phase: 'BOARD', blocker: 'ONE_HIVE', throwCount: 2 }), /AMBER/);
});

test('online status reflects whose turn it is and who won', () => {
  const state = createGame({});
  assert.match(statusText({ state, phase: 'IDLE', mode: 'ONLINE', myPlayer: 2 }), /OPPONENT/);
  assert.equal(statusText({ state: { ...state, winner: 2 }, mode: 'ONLINE', myPlayer: 2 }), 'YOU WIN');
  assert.equal(statusText({ state: { ...state, winner: 1 }, mode: 'ONLINE', myPlayer: 2 }), 'YOU LOSE');
  assert.equal(statusText({ state: { ...state, winner: 1 }, mode: 'LOCAL' }), 'PLAYER 1 WINS');
});

// ── local save ───────────────────────────────────────────────────────────────

test('a local save round-trips state, history and settings', () => {
  const settings = { expansions: { mosquito: true, ladybug: false, pillbug: false }, tournamentRule: true };
  const first = createGame(settings);
  const second = place(first, PieceType.ANT);
  const restored = decodeLocalSave(encodeLocalSave({ settings, state: second, history: [first] }));
  assert.deepEqual(restored.settings, settings);
  assert.ok(restored.state.board instanceof Map);
  assert.deepEqual([...restored.state.board], [...second.board]);
  assert.equal(restored.history.length, 1);
  assert.ok(restored.history[0].board instanceof Map);
});

test('undo history is capped', () => {
  const state = createGame({});
  const history = Array.from({ length: MAX_UNDO + 10 }, () => state);
  assert.equal(decodeLocalSave(encodeLocalSave({ settings: {}, state, history })).history.length, MAX_UNDO);
});

test('corrupt, foreign or finished saves are ignored', () => {
  assert.equal(decodeLocalSave(null), null);
  assert.equal(decodeLocalSave('{not json'), null);
  assert.equal(decodeLocalSave(JSON.stringify({ v: 999 })), null);
  const done = { ...createGame({}), winner: 1 };
  assert.equal(decodeLocalSave(encodeLocalSave({ settings: {}, state: done, history: [] })), null);
  const badBoard = createGame({});
  badBoard.board = new Map([['0,0', [P(1, 'DRAGON')]]]);
  assert.equal(decodeLocalSave(encodeLocalSave({ settings: {}, state: badBoard, history: [] })), null);
});

// ── describeLastMove ─────────────────────────────────────────────────────────

test('last move marks a placement with no source hex', () => {
  const prev = createGame({});
  const next = place(prev, PieceType.ANT);
  assert.deepEqual(describeLastMove(prev, next), { from: null, to: '0,0', player: 1 });
});

test('last move finds the source of a move, including a beetle leaving a stack', () => {
  const prev = createGame({});
  prev.queenPlaced = { 1: true, 2: true };
  prev.board = new Map([
    ['0,0', [P(2, PieceType.QUEEN), P(1, PieceType.BEETLE)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
  ]);
  const next = applyAction(prev, { type: ActionType.MOVE, from: '0,0', to: '0,1' });
  assert.deepEqual(describeLastMove(prev, next), { from: '0,0', to: '0,1', player: 1 });
});

test('last move is null after a pass and falls back to lastMovedHex on resume', () => {
  const prev = place(createGame({}), PieceType.ANT);
  const passed = { ...prev, turn: 1 };
  assert.equal(describeLastMove(prev, passed), null);
  assert.deepEqual(describeLastMove(null, prev), { from: null, to: '0,0', player: 1 });
  assert.equal(describeLastMove(null, createGame({})), null);
});
