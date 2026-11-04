import test from 'node:test';
import assert from 'node:assert/strict';

import { ActionType, PieceType, applyAction, createGame, getLegalPlacements, getLegalMoves, getLegalThrows } from '../js/game.js';
import { statusText, describeLastMove, inferAction, winReasonFromServer, resumedWinReason, turnChipText } from '../js/hints.js';
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

// ── inferAction ──────────────────────────────────────────────────────────────

function expansionGame(entries, turn = 1) {
  const state = createGame({ expansions: { mosquito: true, ladybug: true, pillbug: true } });
  state.board = new Map(entries);
  state.queenPlaced = { 1: true, 2: true };
  state.turn = turn;
  state.turnNumber = 10;
  return state;
}

test('inferAction recovers a placement from two snapshots', () => {
  const prev = place(createGame({}), PieceType.ANT);
  const action = { type: ActionType.PLACE, pieceType: PieceType.SPIDER, to: getLegalPlacements(prev, PieceType.SPIDER)[0] };
  assert.deepEqual(inferAction(prev, applyAction(prev, action)), action);
});

test('inferAction recovers a move, including a beetle climbing onto a stack', () => {
  const prev = expansionGame([
    ['0,0', [P(1, PieceType.BEETLE)]],
    ['1,0', [P(2, PieceType.QUEEN)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
  ]);
  for (const to of getLegalMoves(prev, '0,0')) {
    const action = { type: ActionType.MOVE, from: '0,0', to };
    assert.deepEqual(inferAction(prev, applyAction(prev, action)), action, `beetle to ${to}`);
  }
});

test('inferAction tells a pillbug throw from a move (own and opponent pieces)', () => {
  const prev = expansionGame([
    ['0,0', [P(1, PieceType.PILLBUG)]],
    ['1,0', [P(2, PieceType.ANT)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
    ['1,-1', [P(2, PieceType.QUEEN)]],
  ]);
  prev.lastOpponentMovedHex = null;
  const throws = getLegalThrows(prev);
  assert.ok(throws.some(t => t.from === '1,0') && throws.some(t => t.from === '-1,0'), 'both pieces are throwable');
  for (const t of throws) {
    const action = { type: ActionType.THROW, pillbugHex: t.pillbugHex, from: t.from, to: t.to };
    assert.deepEqual(inferAction(prev, applyAction(prev, action)), action, `throw ${t.from}→${t.to}`);
  }
});

test('inferAction returns null for passes and unrelated snapshots', () => {
  const a = place(createGame({}), PieceType.ANT);
  const b = place(a, PieceType.ANT);
  const c = place(b, PieceType.QUEEN);
  assert.equal(inferAction(null, a), null);
  assert.equal(inferAction(a, null), null);
  assert.equal(inferAction(a, a), null, 'same state');
  assert.equal(inferAction(a, c), null, 'two plies apart');
  assert.equal(inferAction(c, a), null, 'going backwards (undo / resume)');
  assert.equal(inferAction(b, applyAction(b, { type: ActionType.PASS })), null, 'pass');
  assert.equal(inferAction(createGame({}), c), null, 'a different game');
});

// ── end-of-game copy ─────────────────────────────────────────────────────────

test('statusText explains a stalemate draw, a queen draw and a resignation', () => {
  const state = createGame({});
  assert.match(statusText({ state: { ...state, winner: 'DRAW' }, winReason: 'STALEMATE' }), /NO MOVES/);
  assert.match(statusText({ state: { ...state, winner: 'DRAW' }, winReason: 'QUEEN' }), /BOTH QUEENS SURROUNDED/);
  assert.match(statusText({ state: { ...state, winner: 'DRAW' } }), /BOTH QUEENS SURROUNDED/);
  assert.match(statusText({ state: { ...state, winner: 1 }, winReason: 'RESIGN' }), /RESIGNED/);
  assert.match(statusText({ state: { ...state, winner: 2 }, winReason: 'RESIGN', mode: 'ONLINE', myPlayer: 2 }), /RESIGNED/);
  assert.match(statusText({ state: { ...state, winner: 1 }, winReason: 'RESIGN', mode: 'ONLINE', myPlayer: 2 }), /YOU RESIGNED/);
});

test('winReasonFromServer maps server end reasons onto client win reasons', () => {
  assert.equal(winReasonFromServer('QUEEN'), 'QUEEN');
  assert.equal(winReasonFromServer('RESIGN'), 'RESIGN');
  assert.equal(winReasonFromServer('DRAW'), 'QUEEN');
  assert.equal(winReasonFromServer(null), null);
  assert.equal(winReasonFromServer(undefined), null);
  assert.equal(winReasonFromServer('???'), null);
});

test('resumedWinReason keeps the server end reason only for a finished game', () => {
  assert.equal(resumedWinReason({ winner: 2 }, 'RESIGN'), 'RESIGN');
  assert.equal(resumedWinReason({ winner: 'DRAW' }, 'DRAW'), 'QUEEN');
  assert.equal(resumedWinReason({ winner: null }, 'RESIGN'), null);
  assert.equal(resumedWinReason({ winner: 1 }, undefined), null);
});

test('turnChipText shows the result once the game is over', () => {
  const live = { winner: null, turn: 2 };
  assert.equal(turnChipText({ state: live, mode: 'LOCAL' }), 'P2');
  assert.equal(turnChipText({ state: live, mode: 'ONLINE', myPlayer: 2 }), 'YOU');
  assert.equal(turnChipText({ state: live, mode: 'ONLINE', myPlayer: 1 }), 'OPP');
  assert.equal(turnChipText({ state: { winner: 1, turn: 2 }, mode: 'LOCAL' }), 'P1 WINS');
  assert.equal(turnChipText({ state: { winner: 1, turn: 2 }, mode: 'ONLINE', myPlayer: 1 }), 'YOU WIN');
  assert.equal(turnChipText({ state: { winner: 1, turn: 2 }, mode: 'ONLINE', myPlayer: 2 }), 'YOU LOSE');
  assert.equal(turnChipText({ state: { winner: 'DRAW', turn: 2 }, mode: 'LOCAL' }), 'DRAW');
});
