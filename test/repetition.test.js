import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionType, PieceType, applyAction, createGame, deserializeState, positionKey, serializeState,
} from '../js/game.js';
import { statusText, winReasonFromServer, resumedWinReason } from '../js/hints.js';
import { winCopy } from '../js/win-fx.js';
import { createReplay, replayForGame } from '../js/replay.js';
import { logEntry } from '../js/notation.js';

const settings = { expansions: { mosquito: false, ladybug: false, pillbug: false }, tournamentRule: false, clock: { enabled: false } };
const place = (pieceType, to) => ({ type: ActionType.PLACE, pieceType, to });
const move = (from, to) => ({ type: ActionType.MOVE, from, to });

// Queens side by side, a beetle each; the beetles then shuffle out and back. The position after P2's
// second placement (P1 to move) recurs every four plies.
const SETUP = [place('QUEEN', '0,0'), place('QUEEN', '1,0'), place('BEETLE', '-1,0'), place('BEETLE', '2,0')];
const CYCLE = [move('-1,0', '-1,1'), move('2,0', '2,-1'), move('-1,1', '-1,0'), move('2,-1', '2,0')];

function play(actions, state = createGame(settings)) {
  return actions.reduce((s, a) => applyAction(s, a), state);
}

test('createGame seeds the opening position once', () => {
  const s = createGame(settings);
  assert.deepEqual(s.positionCounts, { [positionKey(s)]: 1 });
});

test('positionKey ignores piece ids and distinguishes side to move and supply', () => {
  const a = play(SETUP);
  const b = { ...a, board: new Map([...a.board].map(([k, st]) => [k, st.map(({ id, ...p }) => p)])) };
  assert.equal(positionKey(a), positionKey(b));
  assert.notEqual(positionKey(a), positionKey({ ...a, turn: 2 }));
  assert.notEqual(positionKey(a), positionKey({ ...a, supply: { ...a.supply, 1: { ...a.supply[1], ANT: 0 } } }));
});

test('the third occurrence of a position is a repetition draw; the second only counts', () => {
  const start = play(SETUP);
  const key = positionKey(start);
  assert.equal(start.positionCounts[key], 1);
  const once = play(CYCLE, start);
  assert.equal(once.positionCounts[key], 2);
  assert.equal(once.winner, null);
  assert.equal(once.drawReason, null);
  const twice = play(CYCLE.slice(0, 3), once);
  assert.equal(twice.winner, null);
  const done = applyAction(twice, CYCLE[3]);
  assert.equal(done.positionCounts[key], 3);
  assert.equal(done.winner, 'DRAW');
  assert.equal(done.drawReason, 'REPETITION');
});

test('applyAction does not mutate the previous counts (undo restores them)', () => {
  const start = play(SETUP);
  const before = JSON.stringify(start.positionCounts);
  play(CYCLE, start);
  assert.equal(JSON.stringify(start.positionCounts), before);
});

test('a queen surround on the move that would repeat wins instead of drawing', () => {
  // P1 queen at 0,0 with five neighbours filled; P2's ant slides into the sixth.
  const P = (player, type) => ({ player, type });
  const s = createGame(settings);
  s.board = new Map([
    ['0,0', [P(1, PieceType.QUEEN)]], ['1,0', [P(2, PieceType.ANT)]], ['1,-1', [P(2, PieceType.BEETLE)]],
    ['0,-1', [P(2, PieceType.SPIDER)]], ['-1,0', [P(2, PieceType.GRASSHOPPER)]], ['-1,1', [P(1, PieceType.BEETLE)]],
    ['2,1', [P(2, PieceType.QUEEN)]],
  ]);
  s.queenPlaced = { 1: true, 2: true };
  s.turn = 2;
  const action = move('2,1', '0,1'); // not legal for a queen, but applyAction does not validate
  const probe = applyAction(s, action);
  assert.equal(probe.winner, 2);
  s.positionCounts = { ...s.positionCounts, [positionKey(probe)]: 2 };
  const again = applyAction(s, action);
  assert.equal(again.positionCounts[positionKey(probe)], 3);
  assert.equal(again.winner, 2);
  assert.equal(again.drawReason, null);
});

test('counts survive serialize / deserialize; old saves rebuild { currentKey: 1 }', () => {
  const s = play([...SETUP, ...CYCLE]);
  const back = deserializeState(JSON.parse(JSON.stringify(serializeState(s))));
  assert.deepEqual(back.positionCounts, s.positionCounts);
  assert.equal(back.drawReason, s.drawReason);
  const old = JSON.parse(JSON.stringify(serializeState(s)));
  delete old.positionCounts; delete old.drawReason;
  const loaded = deserializeState(old);
  assert.deepEqual(loaded.positionCounts, { [positionKey(loaded)]: 1 });
  assert.equal(loaded.drawReason ?? null, null);
});

test('PASS and THROW count too', () => {
  const s = play(SETUP);
  const passed = applyAction(s, { type: ActionType.PASS });
  assert.equal(passed.positionCounts[positionKey(passed)], 1);
  assert.equal(Object.values(passed.positionCounts).reduce((a, b) => a + b, 0), 6);
});

test('replay of a repetition game ends in the same draw state', () => {
  const actions = [...SETUP, ...CYCLE, ...CYCLE];
  let s = createGame(settings); const log = [];
  for (const a of actions) { log.push(logEntry(s, a)); s = applyAction(s, a); }
  assert.equal(s.winner, 'DRAW');
  const replay = createReplay(s.settings, actions, { index: actions.length });
  assert.equal(replay.state.winner, 'DRAW');
  assert.equal(replay.state.drawReason, 'REPETITION');
  assert.ok(replayForGame(log, s));
});

test('status line warns at 2/3 and names the draw', () => {
  const start = play(SETUP);
  const once = play(CYCLE, start);
  assert.match(statusText({ state: once }), /REPETITION 2\/3/);
  assert.doesNotMatch(statusText({ state: start }), /REPETITION/);
  const drawn = { ...once, winner: 'DRAW', drawReason: 'REPETITION' };
  assert.equal(statusText({ state: drawn }), 'DRAW — THREEFOLD REPETITION');
  assert.equal(statusText({ state: { ...once, winner: 'DRAW' }, winReason: 'REPETITION' }), 'DRAW — THREEFOLD REPETITION');
});

test('server reason maps to a REPETITION win reason and win card copy', () => {
  assert.equal(winReasonFromServer('REPETITION'), 'REPETITION');
  assert.equal(resumedWinReason({ winner: 'DRAW' }, 'REPETITION'), 'REPETITION');
  const copy = winCopy({ state: { winner: 'DRAW', turnNumber: 20 }, mode: 'LOCAL', reason: 'REPETITION' });
  assert.equal(copy.headline, "IT'S A DRAW");
  assert.match(copy.reason, /three times/i);
});

test('the online waiting seat sees the 2/3 warning too', () => {
  const once = play(CYCLE, play(SETUP));
  assert.match(statusText({ state: once, mode: 'ONLINE', myPlayer: 2 }), /REPETITION 2\/3/);
  assert.equal(statusText({ state: play(SETUP), mode: 'ONLINE', myPlayer: 2 }), "OPPONENT'S TURN…");
});
