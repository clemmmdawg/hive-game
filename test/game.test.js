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
