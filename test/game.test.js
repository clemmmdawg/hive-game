import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionType,
  PieceType,
  applyAction,
  createGame,
  deserializeState,
  getAllLegalActions,
  getLegalPlacements,
  queenPressure,
  queenSides,
  serializeState,
} from '../js/game.js';

const settings = (tournamentRule = false) => ({
  expansions: { mosquito: false, ladybug: false, pillbug: false },
  tournamentRule,
  clock: { enabled: false },
});

function placeFirst(state, pieceType) {
  const [to] = getLegalPlacements(state, pieceType);
  assert.ok(to, `${pieceType} should have a legal placement`);
  return applyAction(state, { type: ActionType.PLACE, pieceType, to });
}

test('tournament opening blocks the queen for both players', () => {
  let state = createGame(settings(true));
  assert.deepEqual(getLegalPlacements(state, PieceType.QUEEN), []);
  state = placeFirst(state, PieceType.ANT);
  assert.equal(state.turn, 2);
  assert.deepEqual(getLegalPlacements(state, PieceType.QUEEN), []);
});

test('standard opening allows either player to lead with the queen', () => {
  let state = createGame(settings(false));
  assert.ok(getLegalPlacements(state, PieceType.QUEEN).length > 0);
  state = placeFirst(state, PieceType.ANT);
  assert.ok(getLegalPlacements(state, PieceType.QUEEN).length > 0);
});

test('a fourth placement is forced to be the queen', () => {
  let state = createGame(settings());
  for (let round = 0; round < 3; round++) {
    state = placeFirst(state, round === 0 ? PieceType.ANT : PieceType.BEETLE);
    state = placeFirst(state, round === 0 ? PieceType.ANT : PieceType.BEETLE);
  }
  const actions = getAllLegalActions(state);
  assert.deepEqual([...actions.placements.keys()], [PieceType.QUEEN]);
});

test('serialized game state round-trips its board map and metadata', () => {
  const original = placeFirst(createGame(settings()), PieceType.ANT);
  const restored = deserializeState(JSON.parse(JSON.stringify(serializeState(original))));
  assert.ok(restored.board instanceof Map);
  assert.deepEqual([...restored.board], [...original.board]);
  assert.equal(restored.turn, original.turn);
  assert.deepEqual(restored.supply, original.supply);
});

// ── queenPressure ────────────────────────────────────────────────────────────

function boardOf(layout) {
  return new Map(Object.entries(layout).map(([k, stack]) => [k, stack.map(([player, type]) => ({ player, type }))]));
}

test('queenPressure: null for a queen that is not on the board yet', () => {
  assert.deepEqual(queenPressure(createGame(settings())), { 1: null, 2: null });
});

test('queenPressure counts the occupied neighbours of each queen', () => {
  const state = createGame(settings());
  state.board = boardOf({
    '0,0': [[1, 'QUEEN']],
    '1,0': [[2, 'QUEEN']], '0,1': [[2, 'ANT']], '-1,0': [[1, 'ANT']],
    '0,-1': [[2, 'SPIDER'], [1, 'BEETLE']],             // a stack is one neighbour
    '2,0': [[1, 'SPIDER']],                              // touches only the P2 queen
  });
  // P1 queen at 0,0: 1,0  0,1  -1,0  0,-1 → 4.  P2 queen at 1,0: 0,0  2,0  0,1 → 3.
  assert.deepEqual(queenPressure(state), { 1: 4, 2: 3 });
});

test('queenPressure finds a queen buried under a beetle and counts all six sides', () => {
  const state = createGame(settings());
  state.board = boardOf({
    '0,0': [[2, 'QUEEN'], [1, 'BEETLE']],
    '1,0': [[1, 'ANT']], '1,-1': [[1, 'ANT']], '0,-1': [[2, 'ANT']],
    '-1,0': [[2, 'ANT']], '-1,1': [[1, 'SPIDER']], '0,1': [[2, 'SPIDER']],
  });
  assert.deepEqual(queenPressure(state), { 1: null, 2: 6 });
});

test('queenSides: each queen with its six sides in neighbors() order; isOccupied decides what counts', () => {
  const board = boardOf({ '0,0': [[1, 'QUEEN']], '1,0': [[2, 'ANT']], '0,-1': [[2, 'ANT']] });
  const [q] = queenSides(board);
  assert.equal(q.key, '0,0');
  assert.equal(q.player, 1);
  assert.deepEqual(q.sides, ['1,0', '1,-1', '0,-1', '-1,0', '-1,1', '0,1']);
  assert.deepEqual(q.lit, [true, false, true, false, false, false]);
  const [h] = queenSides(board, key => key === '1,0');
  assert.deepEqual(h.lit, [true, false, false, false, false, false]);
});
