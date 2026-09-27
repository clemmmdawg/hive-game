import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PieceType,
  createGame,
  getLegalMoves,
  getLegalThrows,
  getMoveBlocker,
} from '../js/game.js';

const P = (player, type) => ({ player, type });

/** Build a mid-game state with both queens flagged as placed. */
function position(entries, { pillbug = false } = {}) {
  const state = createGame({ expansions: { mosquito: false, ladybug: false, pillbug } });
  state.board = new Map(entries);
  state.queenPlaced = { 1: true, 2: true };
  return state;
}

// ── Beetle gates ─────────────────────────────────────────────────────────────

test('a ground beetle can climb onto a piece between two single-height gates', () => {
  // Gates for 0,0 → 1,0 are 1,-1 and 0,1.
  const state = position([
    ['0,0',  [P(1, PieceType.BEETLE)]],
    ['1,0',  [P(2, PieceType.ANT)]],
    ['1,-1', [P(1, PieceType.QUEEN)]],
    ['0,1',  [P(2, PieceType.QUEEN)]],
  ]);
  assert.ok(getLegalMoves(state, '0,0').includes('1,0'));
});

test('a ground beetle cannot climb between two taller stacks', () => {
  const state = position([
    ['0,0',  [P(1, PieceType.BEETLE)]],
    ['1,0',  [P(2, PieceType.ANT)]],
    ['1,-1', [P(1, PieceType.QUEEN), P(2, PieceType.BEETLE)]],
    ['0,1',  [P(2, PieceType.QUEEN), P(1, PieceType.BEETLE)]],
  ]);
  assert.ok(!getLegalMoves(state, '0,0').includes('1,0'));
});

test('a ground slide is still blocked by a single-height gate', () => {
  // Queen at 0,0 wants to slide W to -1,0; gates are -1,1 and 0,-1.
  const state = position([
    ['0,0',  [P(1, PieceType.QUEEN)]],
    ['-1,1', [P(1, PieceType.ANT)]],
    ['0,-1', [P(2, PieceType.QUEEN)]],
  ]);
  assert.ok(!getLegalMoves(state, '0,0').includes('-1,0'));
});

// ── Pillbug throws ───────────────────────────────────────────────────────────

test('a pillbug cannot throw a piece that is part of a stack', () => {
  const state = position([
    ['0,0',  [P(1, PieceType.PILLBUG)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
    ['1,0',  [P(2, PieceType.QUEEN), P(2, PieceType.BEETLE)]],
  ], { pillbug: true });
  assert.deepEqual(getLegalThrows(state).filter(t => t.from === '1,0'), []);
});

test('a pillbug cannot lift a piece through a gate of stacks', () => {
  // Ant at 1,0 must rise onto the pillbug at 0,0; gates 1,-1 and 0,1 are stacks.
  const state = position([
    ['0,0',  [P(1, PieceType.PILLBUG)]],
    ['1,0',  [P(2, PieceType.ANT)]],
    ['0,1',  [P(1, PieceType.QUEEN), P(2, PieceType.BEETLE)]],
    ['1,-1', [P(2, PieceType.QUEEN), P(1, PieceType.BEETLE)]],
  ], { pillbug: true });
  assert.deepEqual(getLegalThrows(state).filter(t => t.from === '1,0'), []);
});

test('a pillbug can throw an unpinned neighbor to an open adjacent hex', () => {
  const state = position([
    ['0,0',  [P(1, PieceType.PILLBUG)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
    ['1,0',  [P(2, PieceType.ANT)]],
  ], { pillbug: true });
  const dests = getLegalThrows(state).filter(t => t.from === '1,0').map(t => t.to).sort();
  assert.deepEqual(dests, ['-1,1', '0,-1', '0,1', '1,-1'].sort());
});

test('a pillbug that was just thrown cannot use its ability', () => {
  const state = position([
    ['0,0',  [P(1, PieceType.PILLBUG)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
    ['1,0',  [P(2, PieceType.ANT)]],
  ], { pillbug: true });
  state.pillbugThrewHex = '0,0';
  assert.deepEqual(getLegalThrows(state), []);
});

// ── Move blockers (UI explanations) ─────────────────────────────────────────

test('getMoveBlocker explains why a piece cannot move', () => {
  const opening = createGame({});
  opening.board = new Map([['0,0', [P(1, PieceType.ANT)]], ['1,0', [P(2, PieceType.ANT)]]]);
  assert.equal(getMoveBlocker(opening, '0,0'), 'QUEEN_NOT_PLACED');
  assert.equal(getMoveBlocker(opening, '1,0'), 'NOT_YOUR_PIECE');

  const pinned = position([
    ['-1,0', [P(1, PieceType.ANT)]],
    ['0,0',  [P(1, PieceType.QUEEN)]],
    ['1,0',  [P(2, PieceType.QUEEN)]],
  ]);
  assert.equal(getMoveBlocker(pinned, '0,0'), 'ONE_HIVE');
  assert.equal(getMoveBlocker(pinned, '-1,0'), null);

  pinned.pillbugThrewHex = '-1,0';
  assert.equal(getMoveBlocker(pinned, '-1,0'), 'JUST_THROWN');
});

test('getMoveBlocker reports a piece with no legal destinations', () => {
  // Queen at 0,0 is boxed in: every empty neighbor is gated.
  const ring = ['1,0', '1,-1', '0,-1', '-1,0', '-1,1'];
  const state = position([
    ['0,0', [P(1, PieceType.QUEEN)]],
    ...ring.map((k, i) => [k, [P(i % 2 ? 1 : 2, PieceType.ANT)]]),
    ['0,2', [P(2, PieceType.QUEEN)]],
    ['-1,2', [P(2, PieceType.ANT)]],
    ['1,1', [P(2, PieceType.ANT)]],
  ]);
  // 0,1 is the only empty neighbor; its gates -1,1 and 1,0 are both occupied.
  assert.equal(getMoveBlocker(state, '0,0'), 'NO_MOVES');
});
