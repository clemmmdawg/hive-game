import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PieceType,
  createGame,
  getLegalMoves,
  getLegalThrows,
  getMoveBlocker,
} from '../js/game.js';

const ANT_EDGE_SET = ['-1,0', '-1,3', '-2,1', '-2,2', '-2,3', '0,1', '0,3', '1,0', '1,2', '2,0', '2,1'];
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

// ── Ground slides keep hive contact ──────────────────────────────────────────

function isolatedMover(type) {
  // 0,0 touches the hive only through the far side; 1,0 touches nothing.
  return position([
    ['0,0',  [P(1, type)]],
    ['-1,1', [P(2, PieceType.QUEEN)]],
    ['-1,2', [P(1, PieceType.QUEEN)]],
    ['0,2',  [P(2, PieceType.ANT)]],
    ['1,1',  [P(1, PieceType.ANT)]],
  ], { pillbug: true });
}

test('beetle may still climb, but cannot slide to a hex that loses contact', () => {
  const moves = getLegalMoves(isolatedMover(PieceType.BEETLE), '0,0').sort();
  assert.deepEqual(moves, ['-1,0', '-1,1', '0,1']);
});

for (const type of [PieceType.QUEEN, PieceType.PILLBUG]) {
  test(`${type} cannot slide to a hex that loses contact with the hive`, () => {
    const moves = getLegalMoves(isolatedMover(type), '0,0').sort();
    assert.deepEqual(moves, ['-1,0', '0,1']);
  });
}

test('spider cannot take a step that loses contact with the hive', () => {
  assert.deepEqual(getLegalMoves(isolatedMover(PieceType.SPIDER), '0,0').sort(), ['-2,2', '2,0']);
});

test('ant reaches 1,0 only by walking around the hive edge', () => {
  const moves = getLegalMoves(isolatedMover(PieceType.ANT), '0,0').sort();
  assert.ok(moves.includes('1,0'));
  assert.ok(!moves.includes('0,0'));
  assert.deepEqual(moves, ANT_EDGE_SET);
});

test('ladybug cannot cross between two height-2 stacks', () => {
  // Step 2 from 1,0 to 2,0 passes between 1,1 and 2,-1 (both height 2, level 2).
  const gate = (a, b) => [P(a, PieceType.QUEEN), P(b, PieceType.BEETLE)];
  const build = (g1, g2) => position([
    ['0,0',  [P(1, PieceType.LADYBUG)]],
    ['1,0',  [P(2, PieceType.ANT)]],
    ['2,0',  [P(1, PieceType.ANT)]],
    ['1,1',  g1],
    ['2,-1', g2],
  ]);
  assert.ok(!getLegalMoves(build(gate(1, 2), gate(2, 1)), '0,0').includes('3,0'));
  // One single-height gate leaves the crossing open.
  assert.ok(getLegalMoves(build([P(1, PieceType.QUEEN)], gate(2, 1)), '0,0').includes('3,0'));
});

test('pillbug cannot throw the piece the opponent just placed', () => {
  const state = position([
    ['0,0',  [P(1, PieceType.PILLBUG)]],
    ['1,0',  [P(2, PieceType.ANT)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
  ], { pillbug: true });
  state.turn = 1;
  state.lastOpponentMovedHex = '1,0';
  assert.ok(!getLegalThrows(state).some(t => t.from === '1,0'));
  state.lastOpponentMovedHex = null;
  assert.ok(getLegalThrows(state).some(t => t.from === '1,0'));
});
