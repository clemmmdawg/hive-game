// Pure seams of js/review.js (game review + move sheet) and js/win-fx.js (win sequence + card).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, ActionType, PieceType } from '../js/game.js';
import { logEntry } from '../js/notation.js';
import { reviewStatusText, sheetRounds, returnLabel, playerName, pieceOwnerName } from '../js/review.js';
import { winCopy, surroundedQueens } from '../js/win-fx.js';

const P = (player, type) => ({ player, type });
const NAMES = { QUEEN: 'QUEEN BEE', ANT: 'SOLDIER ANT', BEETLE: 'BEETLE', PILLBUG: 'PILLBUG' };

function record(actions) {
  let state = createGame({ expansions: { pillbug: true } });
  const log = [];
  for (const a of actions) { log.push(logEntry(state, a)); state = applyAction(state, a); }
  return { state, log };
}

test('reviewStatusText: empty board, placements, moves and passes, from either side', () => {
  const { log } = record([
    { type: ActionType.PLACE, pieceType: PieceType.QUEEN, to: '0,0' },
    { type: ActionType.PLACE, pieceType: PieceType.ANT, to: '1,0' },
    { type: ActionType.MOVE, from: '0,0', to: '1,-1' },
  ]);
  assert.equal(reviewStatusText(null), 'OPENING · EMPTY BOARD');
  assert.equal(reviewStatusText(log[0], { mode: 'LOCAL', pieceNames: NAMES }), 'P1 PLACED QUEEN BEE');
  assert.equal(reviewStatusText(log[1], { mode: 'ONLINE', myPlayer: 1, pieceNames: NAMES }), 'OPPONENT PLACED SOLDIER ANT');
  assert.equal(reviewStatusText(log[2], { mode: 'ONLINE', myPlayer: 1, pieceNames: NAMES }), 'YOU MOVED QUEEN BEE');
  const pass = { notation: 'pass', player: 2, turnNumber: 4, action: { type: ActionType.PASS } };
  assert.equal(reviewStatusText(pass, { mode: 'LOCAL' }), 'P2 PASSED');
});

test('reviewStatusText: a throw names whose piece flew', () => {
  const entry = { notation: 'wA1 bP/', player: 2, turnNumber: 9, action: { type: ActionType.THROW, pillbugHex: '1,0', from: '0,0', to: '2,0' } };
  assert.equal(reviewStatusText(entry, { mode: 'LOCAL', pieceNames: NAMES }), 'P2 THREW P1 SOLDIER ANT');
  assert.equal(reviewStatusText(entry, { mode: 'ONLINE', myPlayer: 1, pieceNames: NAMES }), 'OPPONENT THREW YOUR SOLDIER ANT');
});

test('sheetRounds: one row per round, P1 left, P2 right, 1-based indices', () => {
  const log = [
    { notation: 'wQ', player: 1, turnNumber: 1 }, { notation: 'bQ -wQ', player: 2, turnNumber: 2 },
    { notation: 'wA1 wQ-', player: 1, turnNumber: 3 },
  ];
  const rows = sheetRounds(log);
  assert.deepEqual(rows.map(([round]) => round), [1, 2]);
  assert.equal(rows[0][1][1].index, 1);
  assert.equal(rows[0][1][2].index, 2);
  assert.equal(rows[1][1][1].entry, log[2]);
  assert.equal(rows[1][1][2], undefined);
  assert.deepEqual(sheetRounds([]), []);
});

test('review labels and names', () => {
  assert.equal(returnLabel('game'), 'BACK TO GAME');
  assert.equal(returnLabel('card'), 'CLOSE REPLAY');
  assert.equal(returnLabel('board'), 'BACK TO BOARD');
  assert.equal(playerName(2, 'LOCAL'), 'P2');
  assert.equal(playerName(2, 'ONLINE', 2), 'YOU');
  assert.equal(pieceOwnerName(1, 'ONLINE', 2), "OPPONENT'S");
});

/** P2 queen at 0,0 with `n` occupied sides; P1 queen out at 3,0. */
function surrounded(n) {
  const ring = ['1,0', '1,-1', '0,-1', '-1,0', '-1,1', '0,1'];
  const board = new Map([['0,0', [P(2, 'QUEEN')]], ['3,0', [P(1, 'QUEEN')]], ['2,0', [P(1, 'ANT')]]]);
  ring.slice(0, n).forEach(k => board.set(k, [P(1, 'ANT')]));
  return board;
}

test('surroundedQueens: only a queen with all six sides covered', () => {
  assert.deepEqual(surroundedQueens(surrounded(6)), ['0,0']);
  assert.deepEqual(surroundedQueens(surrounded(5)), []);
});

test('winCopy: local and online wins, resignations, both draws', () => {
  const state = { winner: 1, turnNumber: 16 };
  assert.deepEqual(winCopy({ state, mode: 'LOCAL', reason: 'QUEEN' }),
    { headline: 'PLAYER 1 WINS!', reason: "Player 2's queen was surrounded after 8 rounds.", emblem: 'QUEEN' });
  assert.equal(winCopy({ state, mode: 'ONLINE', myPlayer: 1 }).headline, 'YOU WIN!');
  assert.equal(winCopy({ state, mode: 'ONLINE', myPlayer: 2 }).headline, 'YOU LOSE');
  assert.equal(winCopy({ state, mode: 'ONLINE', myPlayer: 2 }).reason, 'Your queen was surrounded after 8 rounds.');
  assert.equal(winCopy({ state: { winner: 1, turnNumber: 2 }, mode: 'LOCAL' }).reason, "Player 2's queen was surrounded after 1 round.");
  assert.equal(winCopy({ state, mode: 'ONLINE', myPlayer: 2, reason: 'RESIGN' }).reason, 'You resigned the game.');
  assert.equal(winCopy({ state, mode: 'ONLINE', myPlayer: 1, reason: 'RESIGN' }).reason, 'Your opponent resigned.');
  assert.equal(winCopy({ state, mode: 'LOCAL', reason: 'RESIGN' }).reason, 'Player 2 resigned.');
  const draw = { winner: 'DRAW', turnNumber: 20 };
  assert.equal(winCopy({ state: draw, mode: 'LOCAL', reason: 'STALEMATE' }).reason, 'Neither player has a legal move left.');
  assert.equal(winCopy({ state: draw, mode: 'LOCAL' }).headline, "IT'S A DRAW");
  assert.equal(winCopy({ state: draw, mode: 'LOCAL' }).reason, 'Both queens were surrounded on the same move.');
});

test('winCopy: running out of time', () => {
  const state = { winner: 1, turnNumber: 16 };
  assert.deepEqual(winCopy({ state, mode: 'LOCAL', reason: 'TIMEOUT' }),
    { headline: 'PLAYER 1 WINS!', reason: 'Player 2 ran out of time.', emblem: 'STOPWATCH' });
  assert.equal(winCopy({ state, mode: 'ONLINE', myPlayer: 2, reason: 'TIMEOUT' }).reason, 'You ran out of time.');
  assert.equal(winCopy({ state, mode: 'ONLINE', myPlayer: 1, reason: 'TIMEOUT' }).reason, 'Your opponent ran out of time.');
});
